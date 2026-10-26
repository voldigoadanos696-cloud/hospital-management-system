/**
 * Smart Hospital Bed Allocation Service
 * Implements clinical ward classification, transaction-safe concurrency control,
 * immutable queue timestamps, Max-Heap + FCFS priority promotion, and historical preservation.
 */

const { ensureHospitalWards } = require("../scripts/seedWards");

// Helper to wrap connection.query in a Promise
function queryAsync(connection, sql, params = []) {
    return new Promise((resolve, reject) => {
        connection.query(sql, params, (err, results) => {
            if (err) reject(err);
            else resolve(results);
        });
    });
}

/**
 * Executes a callback within a dedicated database connection and transaction.
 * Works seamlessly whether `db` is a Pool or Connection.
 *
 * @param {Object} db - mysql2 pool or connection
 * @param {Function} callback - async (conn) => Promise<any>
 * @returns {Promise<any>}
 */
async function withTransaction(db, callback) {
    let conn = db;
    let shouldRelease = false;

    if (typeof db.getConnection === "function") {
        conn = await new Promise((resolve, reject) => {
            db.getConnection((err, connection) => {
                if (err) reject(err);
                else resolve(connection);
            });
        });
        shouldRelease = true;
    }

    try {
        await queryAsync(conn, "START TRANSACTION");
        const result = await callback(conn);
        await queryAsync(conn, "COMMIT");
        return result;
    } catch (err) {
        await queryAsync(conn, "ROLLBACK").catch(() => {});
        throw err;
    } finally {
        if (shouldRelease && conn && typeof conn.release === "function") {
            conn.release();
        }
    }
}

/**
 * Explicit Clinical Ward Classification Precedence
 * Evaluates patient clinical criteria without relying solely on priority scores.
 * Ambiguous conditions return requiresReview = true.
 *
 * @param {number} age - Patient age in years
 * @param {string} condition - Disease or clinical condition
 * @returns {Object} { wardCode: string|null, wardName: string|null, requiresReview: boolean }
 */
function classifyWardSuitability(age, condition) {
    const cond = (condition || "").toLowerCase().trim();
    const ageNum = Number(age);

    // Precedence Level 1: Pediatric Precedence (age <= 16)
    if (Number.isInteger(ageNum) && ageNum <= 16) {
        return {
            wardCode: "PED",
            wardName: "Pediatric Care Ward",
            requiresReview: false
        };
    }

    // Precedence Level 2: High-Acuity Cardiovascular / Neurological
    if (cond === "heart attack" || cond === "stroke") {
        return {
            wardCode: "ICU",
            wardName: "Intensive Care Unit",
            requiresReview: false
        };
    }

    // Precedence Level 3: Acute Trauma / Surgical
    if (cond === "accident") {
        return {
            wardCode: "EMG",
            wardName: "Emergency & Trauma Ward",
            requiresReview: false
        };
    }

    // Precedence Level 4: Infectious Diseases & Isolation
    if (cond === "malaria" || cond === "dengue" || cond === "typhoid") {
        return {
            wardCode: "INF",
            wardName: "Infectious Disease Ward",
            requiresReview: false
        };
    }

    // Precedence Level 5: General Medical Inpatient Conditions
    if (cond === "fever" || cond === "cold" || cond === "diarrhea" || cond === "cancer") {
        return {
            wardCode: "GEN",
            wardName: "General Medical Ward",
            requiresReview: false
        };
    }

    // Precedence Level 6: Ambiguous / Custom / Unrecognized condition
    // Flagged explicitly for staff clinical review rather than arbitrary ward placement
    return {
        wardCode: null,
        wardName: null,
        requiresReview: true
    };
}

/**
 * Allocates a bed on patient admission inside a concurrency-safe transaction.
 *
 * @param {Object} connection - mysql2 connection instance
 * @param {Object} patient - { patientId, uname, age, condition, score }
 * @returns {Promise<Object>} Allocation outcome
 */
async function allocateBedOnAdmission(connection, { patientId, uname, age, condition, score }) {
    await ensureHospitalWards(connection, uname);

    const classification = classifyWardSuitability(age, condition);

    // If condition cannot be confidently matched, flag for staff review without guessing
    if (classification.requiresReview) {
        await queryAsync(
            connection,
            `INSERT INTO bed_allocation (patient_id, uname, ward_id, bed_id, status)
             VALUES (?, ?, NULL, NULL, 'NEEDS_REVIEW')`,
            [patientId, uname]
        );
        return {
            allocated: false,
            status: "NEEDS_REVIEW",
            wardCode: null,
            wardName: null,
            bedNumber: null,
            message: "Clinical condition is unmapped and requires staff review for ward placement."
        };
    }

    // Execute atomic bed acquisition within an isolated connection transaction
    return await withTransaction(connection, async (conn) => {
        // 1. Locate suitable ward ID for this staff hospital account
        const wards = await queryAsync(
            conn,
            "SELECT id, name, code FROM ward WHERE uname = ? AND code = ? LIMIT 1",
            [uname, classification.wardCode]
        );

        if (wards.length === 0) {
            throw new Error(`Ward profile for ${classification.wardCode} not found.`);
        }

        const ward = wards[0];

        // 2. Select next available bed with row lock to avoid race conditions
        const availableBeds = await queryAsync(
            conn,
            `SELECT id, bed_number FROM bed
             WHERE ward_id = ? AND uname = ? AND status = 'AVAILABLE'
             ORDER BY id ASC LIMIT 1 FOR UPDATE`,
            [ward.id, uname]
        );

        if (availableBeds.length > 0) {
            const bed = availableBeds[0];

            // 3. Conditional bed update: verifies status was still AVAILABLE
            const updateResult = await queryAsync(
                conn,
                `UPDATE bed SET status = 'OCCUPIED'
                 WHERE id = ? AND status = 'AVAILABLE' AND uname = ?`,
                [bed.id, uname]
            );

            if (updateResult.affectedRows === 1) {
                // Successfully secured bed: create active ALLOCATED record
                await queryAsync(
                    conn,
                    `INSERT INTO bed_allocation
                     (patient_id, uname, ward_id, bed_id, status, allocated_at)
                     VALUES (?, ?, ?, ?, 'ALLOCATED', NOW())`,
                    [patientId, uname, ward.id, bed.id]
                );

                return {
                    allocated: true,
                    status: "ALLOCATED",
                    wardCode: ward.code,
                    wardName: ward.name,
                    bedId: bed.id,
                    bedNumber: bed.bed_number,
                    message: `Bed ${bed.bed_number} in ${ward.name} allocated successfully.`
                };
            }
        }

        // 4. Ward is full or bed was claimed concurrently: place in priority waiting queue
        await queryAsync(
            conn,
            `INSERT INTO bed_allocation (patient_id, uname, ward_id, bed_id, status)
             VALUES (?, ?, ?, NULL, 'WAITING')`,
            [patientId, uname, ward.id]
        );

        return {
            allocated: false,
            status: "WAITING",
            wardCode: ward.code,
            wardName: ward.name,
            bedNumber: null,
            message: `All beds in ${ward.name} are currently occupied. Patient queued by priority score & arrival order.`
        };
    });
}

/**
 * Discharges a patient, marks bed available, preserves historical records,
 * and auto-promotes the next eligible waiting patient in that ward.
 *
 * @param {Object} connection - mysql2 connection instance
 * @param {Object} params - { patientId, uname }
 * @returns {Promise<Object>}
 */
async function dischargePatient(connection, { patientId, uname }) {
    return await withTransaction(connection, async (conn) => {
        // 1. Locate active allocation for this patient
        const activeAllocations = await queryAsync(
            conn,
            `SELECT id, patient_id, uname, ward_id, bed_id, status
             FROM bed_allocation
             WHERE patient_id = ? AND uname = ? AND status IN ('ALLOCATED', 'WAITING', 'NEEDS_REVIEW')
             LIMIT 1 FOR UPDATE`,
            [patientId, uname]
        );

        if (activeAllocations.length === 0) {
            return { success: false, notFound: true, message: `No active allocation found for patient #${patientId}.` };
        }

        const alloc = activeAllocations[0];
        const freedBedId = alloc.bed_id;
        const freedWardId = alloc.ward_id;

        // 2. Mark allocation as DISCHARGED (preserving historical records)
        await queryAsync(
            conn,
            `UPDATE bed_allocation
             SET status = 'DISCHARGED', discharged_at = NOW()
             WHERE id = ?`,
            [alloc.id]
        );

        let freedBedNumber = null;
        let promotedPatient = null;

        // 3. If a physical bed was held, release it
        if (freedBedId) {
            const bedRows = await queryAsync(
                conn,
                "SELECT bed_number FROM bed WHERE id = ? AND uname = ?",
                [freedBedId, uname]
            );
            if (bedRows.length > 0) freedBedNumber = bedRows[0].bed_number;

            await queryAsync(
                conn,
                "UPDATE bed SET status = 'AVAILABLE' WHERE id = ? AND uname = ?",
                [freedBedId, uname]
            );

            // 4. Auto-promote next eligible waiting patient for that ward
            // Ordering strictly by: 1) Triage Score Descending, 2) Immutable Queue Entry Time Ascending (FCFS)
            const waitingCandidates = await queryAsync(
                conn,
                `SELECT a.id as allocation_id, a.patient_id, a.queue_entry_time, p.name as patient_name, p.score
                 FROM bed_allocation a
                 JOIN patient p ON a.patient_id = p.id AND a.uname = p.uname
                 WHERE a.ward_id = ? AND a.uname = ? AND a.status = 'WAITING'
                 ORDER BY p.score DESC, a.queue_entry_time ASC
                 LIMIT 1 FOR UPDATE`,
                [freedWardId, uname]
            );

            if (waitingCandidates.length > 0) {
                const nextPatient = waitingCandidates[0];

                // Re-claim the bed for the promoted patient
                const bedClaimResult = await queryAsync(
                    conn,
                    `UPDATE bed SET status = 'OCCUPIED'
                     WHERE id = ? AND status = 'AVAILABLE' AND uname = ?`,
                    [freedBedId, uname]
                );

                if (bedClaimResult.affectedRows === 1) {
                    await queryAsync(
                        conn,
                        `UPDATE bed_allocation
                         SET bed_id = ?, status = 'ALLOCATED', allocated_at = NOW()
                         WHERE id = ?`,
                        [freedBedId, nextPatient.allocation_id]
                    );

                    promotedPatient = {
                        patientId: nextPatient.patient_id,
                        patientName: nextPatient.patient_name,
                        score: nextPatient.score,
                        bedNumber: freedBedNumber
                    };
                }
            }
        }

        return {
            success: true,
            notFound: false,
            freedBed: freedBedNumber,
            promotedPatient,
            message: `Patient #${patientId} discharged. Bed released and history preserved.`
        };
    });
}

/**
 * Allows staff to review ambiguous conditions and manually assign a target ward.
 *
 * @param {Object} connection - mysql2 connection instance
 * @param {Object} params - { patientId, uname, wardCode }
 * @returns {Promise<Object>}
 */
async function manualAssignWard(connection, { patientId, uname, wardCode }) {
    return await withTransaction(connection, async (conn) => {
        const activeAllocations = await queryAsync(
            conn,
            `SELECT a.id, a.queue_entry_time, p.score, p.age
             FROM bed_allocation a
             JOIN patient p ON a.patient_id = p.id AND a.uname = p.uname
             WHERE a.patient_id = ? AND a.uname = ? AND a.status = 'NEEDS_REVIEW'
             LIMIT 1 FOR UPDATE`,
            [patientId, uname]
        );

        if (activeAllocations.length === 0) {
            return { success: false, message: `No patient with ID #${patientId} awaiting clinical review.` };
        }

        const alloc = activeAllocations[0];

        const wards = await queryAsync(
            conn,
            "SELECT id, name, code FROM ward WHERE uname = ? AND code = ? LIMIT 1",
            [uname, wardCode]
        );

        if (wards.length === 0) {
            return { success: false, message: `Ward ${wardCode} does not exist.` };
        }

        const targetWard = wards[0];

        // Check if bed is available in the manually assigned ward
        const availableBeds = await queryAsync(
            conn,
            `SELECT id, bed_number FROM bed
             WHERE ward_id = ? AND uname = ? AND status = 'AVAILABLE'
             ORDER BY id ASC LIMIT 1 FOR UPDATE`,
            [targetWard.id, uname]
        );

        if (availableBeds.length > 0) {
            const bed = availableBeds[0];
            const updateResult = await queryAsync(
                conn,
                `UPDATE bed SET status = 'OCCUPIED'
                 WHERE id = ? AND status = 'AVAILABLE' AND uname = ?`,
                [bed.id, uname]
            );

            if (updateResult.affectedRows === 1) {
                await queryAsync(
                    conn,
                    `UPDATE bed_allocation
                     SET ward_id = ?, bed_id = ?, status = 'ALLOCATED', allocated_at = NOW()
                     WHERE id = ?`,
                    [targetWard.id, bed.id, alloc.id]
                );

                return {
                    success: true,
                    status: "ALLOCATED",
                    wardName: targetWard.name,
                    bedNumber: bed.bed_number,
                    message: `Patient #${patientId} assigned to ${targetWard.name} (Bed ${bed.bed_number}).`
                };
            }
        }

        // Ward is currently full: move patient into WAITING status for this ward, preserving original queue time
        await queryAsync(
            conn,
            `UPDATE bed_allocation
             SET ward_id = ?, bed_id = NULL, status = 'WAITING'
             WHERE id = ?`,
            [targetWard.id, alloc.id]
        );

        return {
            success: true,
            status: "WAITING",
            wardName: targetWard.name,
            bedNumber: null,
            message: `Patient #${patientId} assigned to ${targetWard.name}. All beds currently occupied; patient queued.`
        };
    });
}

/**
 * Updates bed maintenance status (AVAILABLE <-> MAINTENANCE).
 * If restored to AVAILABLE, automatically checks for and promotes any waiting patient.
 *
 * @param {Object} connection - mysql2 connection instance
 * @param {Object} params - { bedId, uname, status }
 * @returns {Promise<Object>}
 */
async function updateBedMaintenanceStatus(connection, { bedId, uname, status }) {
    const targetStatus = String(status || "").trim().toUpperCase();
    if (targetStatus !== "MAINTENANCE" && targetStatus !== "AVAILABLE") {
        return { success: false, message: "Status must be either 'MAINTENANCE' or 'AVAILABLE'." };
    }

    return await withTransaction(connection, async (conn) => {
        const bedRows = await queryAsync(
            conn,
            "SELECT id, ward_id, bed_number, status FROM bed WHERE id = ? AND uname = ? FOR UPDATE",
            [bedId, uname]
        );

        if (bedRows.length === 0) {
            return { success: false, notFound: true, message: `Bed #${bedId} not found.` };
        }

        const bed = bedRows[0];

        if (targetStatus === "MAINTENANCE") {
            if (bed.status === "OCCUPIED") {
                return {
                    success: false,
                    message: `Bed ${bed.bed_number} is currently occupied. Discharge patient before scheduling maintenance.`
                };
            }
            if (bed.status === "MAINTENANCE") {
                return { success: true, message: `Bed ${bed.bed_number} is already in maintenance.` };
            }

            await queryAsync(
                conn,
                "UPDATE bed SET status = 'MAINTENANCE' WHERE id = ? AND uname = ?",
                [bed.id, uname]
            );

            return {
                success: true,
                status: "MAINTENANCE",
                bedNumber: bed.bed_number,
                message: `Bed ${bed.bed_number} placed under maintenance.`
            };
        } else {
            // targetStatus === "AVAILABLE"
            if (bed.status === "AVAILABLE") {
                return { success: true, message: `Bed ${bed.bed_number} is already available.` };
            }

            await queryAsync(
                conn,
                "UPDATE bed SET status = 'AVAILABLE' WHERE id = ? AND uname = ?",
                [bed.id, uname]
            );

            let promotedPatient = null;

            // Auto-promote next eligible waiting patient for that ward
            if (bed.ward_id) {
                const waitingCandidates = await queryAsync(
                    conn,
                    `SELECT a.id as allocation_id, a.patient_id, a.queue_entry_time, p.name as patient_name, p.score
                     FROM bed_allocation a
                     JOIN patient p ON a.patient_id = p.id AND a.uname = p.uname
                     WHERE a.ward_id = ? AND a.uname = ? AND a.status = 'WAITING'
                     ORDER BY p.score DESC, a.queue_entry_time ASC
                     LIMIT 1 FOR UPDATE`,
                    [bed.ward_id, uname]
                );

                if (waitingCandidates.length > 0) {
                    const nextPatient = waitingCandidates[0];
                    const bedClaimResult = await queryAsync(
                        conn,
                        `UPDATE bed SET status = 'OCCUPIED'
                         WHERE id = ? AND status = 'AVAILABLE' AND uname = ?`,
                        [bed.id, uname]
                    );

                    if (bedClaimResult.affectedRows === 1) {
                        await queryAsync(
                            conn,
                            `UPDATE bed_allocation
                             SET bed_id = ?, status = 'ALLOCATED', allocated_at = NOW()
                             WHERE id = ?`,
                            [bed.id, nextPatient.allocation_id]
                        );

                        promotedPatient = {
                            patientId: nextPatient.patient_id,
                            patientName: nextPatient.patient_name,
                            score: nextPatient.score,
                            bedNumber: bed.bed_number
                        };
                    }
                }
            }

            return {
                success: true,
                status: promotedPatient ? "OCCUPIED" : "AVAILABLE",
                bedNumber: bed.bed_number,
                promotedPatient,
                message: promotedPatient
                    ? `Bed ${bed.bed_number} restored from maintenance and immediately allocated to waiting patient ${promotedPatient.patientName} (#${promotedPatient.patientId}).`
                    : `Bed ${bed.bed_number} restored to available status.`
            };
        }
    });
}

/**
 * Retrieves hospital-wide ward occupancy metrics, bed statuses, and waiting counts.
 * Calculates every figure strictly from the database scoped to `uname`.
 * Guarantees occupied + available + maintenance === total for every ward and overall hospital.
 *
 * @param {Object} connection - mysql2 connection instance
 * @param {string} uname - Staff username / hospital account
 * @returns {Promise<Object>}
 */
async function getHospitalBedSummary(connection, uname) {
    await ensureHospitalWards(connection, uname);

    // 1. Fetch all configured wards for this hospital account
    const wards = await queryAsync(
        connection,
        "SELECT id, name, code, total_beds FROM ward WHERE uname = ? ORDER BY id ASC",
        [uname]
    );

    // 2. Fetch bed aggregations per ward
    const bedCounts = await queryAsync(
        connection,
        `SELECT
            ward_id,
            COUNT(id) as total_beds,
            COUNT(CASE WHEN status = 'OCCUPIED' THEN 1 END) as occupied_beds,
            COUNT(CASE WHEN status = 'AVAILABLE' THEN 1 END) as available_beds,
            COUNT(CASE WHEN status = 'MAINTENANCE' THEN 1 END) as maintenance_beds
         FROM bed
         WHERE uname = ?
         GROUP BY ward_id`,
        [uname]
    );
    const bedCountMap = {};
    for (const b of bedCounts) {
        bedCountMap[b.ward_id] = b;
    }

    // 3. Fetch waiting patients count per ward
    const waitingCounts = await queryAsync(
        connection,
        `SELECT
            ward_id,
            COUNT(id) as waiting_count
         FROM bed_allocation
         WHERE uname = ? AND status = 'WAITING' AND ward_id IS NOT NULL
         GROUP BY ward_id`,
        [uname]
    );
    const waitingMap = {};
    for (const w of waitingCounts) {
        waitingMap[w.ward_id] = Number(w.waiting_count);
    }

    // 4. Fetch waiting patients requiring staff clinical review
    const reviewRows = await queryAsync(
        connection,
        "SELECT COUNT(id) as count FROM bed_allocation WHERE uname = ? AND status = 'NEEDS_REVIEW'",
        [uname]
    );
    const totalNeedsReview = Number(reviewRows[0]?.count || 0);

    // 5. Check for any explicitly unassigned beds (ward_id IS NULL or unmapped)
    const unassignedRows = await queryAsync(
        connection,
        `SELECT
            COUNT(id) as total_beds,
            COUNT(CASE WHEN status = 'OCCUPIED' THEN 1 END) as occupied_beds,
            COUNT(CASE WHEN status = 'AVAILABLE' THEN 1 END) as available_beds,
            COUNT(CASE WHEN status = 'MAINTENANCE' THEN 1 END) as maintenance_beds
         FROM bed
         WHERE uname = ? AND (ward_id IS NULL OR ward_id NOT IN (SELECT id FROM ward WHERE uname = ?))`,
        [uname, uname]
    );
    const unassignedBeds = unassignedRows[0]?.total_beds > 0 ? {
        total_beds: Number(unassignedRows[0].total_beds),
        occupied_beds: Number(unassignedRows[0].occupied_beds),
        available_beds: Number(unassignedRows[0].available_beds),
        maintenance_beds: Number(unassignedRows[0].maintenance_beds)
    } : null;

    // 6. Fetch individual physical beds grouped by ward for detailed bed management
    const beds = await queryAsync(
        connection,
        "SELECT id, ward_id, bed_number, status FROM bed WHERE uname = ? ORDER BY id ASC",
        [uname]
    );
    const bedsByWard = {};
    for (const bed of beds) {
        if (!bedsByWard[bed.ward_id]) bedsByWard[bed.ward_id] = [];
        bedsByWard[bed.ward_id].push(bed);
    }

    // 7. Assemble ward occupancy profiles and compute exact hospital-wide totals
    let sumTotal = unassignedBeds ? unassignedBeds.total_beds : 0;
    let sumOccupied = unassignedBeds ? unassignedBeds.occupied_beds : 0;
    let sumAvailable = unassignedBeds ? unassignedBeds.available_beds : 0;
    let sumMaintenance = unassignedBeds ? unassignedBeds.maintenance_beds : 0;
    let sumWaiting = 0;

    const wardList = wards.map(w => {
        const counts = bedCountMap[w.id] || { total_beds: 0, occupied_beds: 0, available_beds: 0, maintenance_beds: 0 };
        const total = Number(counts.total_beds);
        const occupied = Number(counts.occupied_beds);
        const available = Number(counts.available_beds);
        const maintenance = Number(counts.maintenance_beds);
        const waiting = waitingMap[w.id] || 0;

        sumTotal += total;
        sumOccupied += occupied;
        sumAvailable += available;
        sumMaintenance += maintenance;
        sumWaiting += waiting;

        const occupancyRate = total > 0 ? Math.round((occupied / total) * 100) : 0;
        const isFull = available === 0;

        return {
            ward_id: w.id,
            ward_name: w.name,
            ward_code: w.code,
            total_beds: total,
            occupied_beds: occupied,
            available_beds: available,
            maintenance_beds: maintenance,
            waiting_patients: waiting,
            occupancy_rate: occupancyRate,
            is_full: isFull,
            beds: bedsByWard[w.id] || []
        };
    });

    return {
        wards: wardList,
        totals: {
            total_beds: sumTotal,
            total_occupied: sumOccupied,
            total_available: sumAvailable,
            total_maintenance: sumMaintenance,
            total_waiting: sumWaiting,
            total_needs_review: totalNeedsReview,
            unassigned_beds: unassignedBeds
        }
    };
}

/**
 * Creates a new custom ward for this hospital staff account and generates initial physical beds.
 *
 * @param {Object} connection - mysql2 pool or connection
 * @param {Object} params - { uname, name, code, totalBeds, description }
 * @returns {Promise<Object>}
 */
async function addCustomWard(connection, { uname, name, code, totalBeds, description }) {
    const cleanCode = String(code || "").trim().toUpperCase();
    const cleanName = String(name || "").trim();
    const bedsCount = Math.max(1, Math.min(100, parseInt(totalBeds, 10) || 5));
    const cleanDesc = String(description || "").trim();

    if (!cleanCode || !cleanName) {
        throw new Error("Ward Name and Code are required.");
    }

    return await withTransaction(connection, async (conn) => {
        // Check for duplicate ward code under this user account
        const existing = await queryAsync(
            conn,
            "SELECT id FROM ward WHERE uname = ? AND code = ? LIMIT 1",
            [uname, cleanCode]
        );

        if (existing.length > 0) {
            throw new Error(`Ward with code '${cleanCode}' already exists.`);
        }

        const insertRes = await queryAsync(
            conn,
            `INSERT INTO ward (uname, name, code, total_beds, description, is_custom)
             VALUES (?, ?, ?, ?, ?, TRUE)`,
            [uname, cleanName, cleanCode, bedsCount, cleanDesc]
        );
        const wardId = insertRes.insertId;

        // Automatically provision physical beds for this new ward
        for (let i = 1; i <= bedsCount; i++) {
            const bedNumber = `${cleanCode}-${String(i).padStart(2, "0")}`;
            await queryAsync(
                conn,
                `INSERT INTO bed (ward_id, uname, bed_number, status)
                 VALUES (?, ?, ?, 'AVAILABLE')`,
                [wardId, uname, bedNumber]
            );
        }

        return {
            success: true,
            wardId,
            wardCode: cleanCode,
            wardName: cleanName,
            totalBeds: bedsCount
        };
    });
}

/**
 * Retrieves detailed information, beds, inpatients, and waiting queue for a specific ward.
 *
 * @param {Object} connection - mysql2 pool or connection
 * @param {string} uname - Staff username
 * @param {string} wardCode - Ward code (e.g. ICU, PED)
 * @returns {Promise<Object|null>}
 */
async function getWardDetails(connection, uname, wardCode) {
    await ensureHospitalWards(connection, uname);

    const cleanCode = String(wardCode || "").trim().toUpperCase();
    const wardRows = await queryAsync(
        connection,
        "SELECT id, name, code, total_beds, description, is_custom FROM ward WHERE uname = ? AND code = ? LIMIT 1",
        [uname, cleanCode]
    );

    if (wardRows.length === 0) return null;
    const ward = wardRows[0];

    // All physical beds in this ward with active occupant details if any
    const beds = await queryAsync(
        connection,
        `SELECT
            b.id as bed_id,
            b.bed_number,
            b.status as bed_status,
            p.id as patient_id,
            p.name as patient_name,
            p.age as patient_age,
            p.dis as patient_condition,
            p.score as patient_score,
            a.allocated_at,
            a.id as allocation_id
         FROM bed b
         LEFT JOIN bed_allocation a ON b.id = a.bed_id AND a.status = 'ALLOCATED' AND a.uname = b.uname
         LEFT JOIN patient p ON a.patient_id = p.id AND a.uname = p.uname
         WHERE b.ward_id = ? AND b.uname = ?
         ORDER BY b.id ASC`,
        [ward.id, uname]
    );

    // Patients currently admitted in this ward
    const inpatients = beds
        .filter(b => b.patient_id != null)
        .map(b => ({
            allocationId: b.allocation_id,
            patientId: b.patient_id,
            patientName: b.patient_name,
            age: b.patient_age,
            condition: b.patient_condition,
            score: b.patient_score,
            bedId: b.bed_id,
            bedNumber: b.bed_number,
            allocatedAt: b.allocated_at
        }));

    // Patients waiting specifically for this ward (or needs review)
    const waitingQueue = await queryAsync(
        connection,
        `SELECT
            a.id as allocation_id,
            a.patient_id,
            a.status as allocation_status,
            a.queue_entry_time,
            p.name as patient_name,
            p.age as patient_age,
            p.dis as patient_condition,
            p.wait as patient_wait,
            p.score as patient_score
         FROM bed_allocation a
         JOIN patient p ON a.patient_id = p.id AND a.uname = p.uname
         WHERE a.ward_id = ? AND a.uname = ? AND a.status = 'WAITING'
         ORDER BY p.score DESC, a.queue_entry_time ASC`,
        [ward.id, uname]
    );

    const totalBeds = beds.length;
    const occupiedBeds = beds.filter(b => b.bed_status === 'OCCUPIED').length;
    const availableBeds = beds.filter(b => b.bed_status === 'AVAILABLE').length;
    const maintenanceBeds = beds.filter(b => b.bed_status === 'MAINTENANCE').length;
    const occupancyRate = totalBeds > 0 ? Math.round((occupiedBeds / totalBeds) * 100) : 0;

    // All available wards for transfer target dropdown
    const allWards = await queryAsync(
        connection,
        "SELECT id, name, code FROM ward WHERE uname = ? ORDER BY name ASC",
        [uname]
    );

    return {
        ward,
        beds,
        inpatients,
        waitingQueue,
        allWards,
        stats: {
            totalBeds,
            occupiedBeds,
            availableBeds,
            maintenanceBeds,
            waitingCount: waitingQueue.length,
            occupancyRate,
            isFull: availableBeds === 0
        }
    };
}

/**
 * Transfers a patient from one ward/bed to another atomically.
 * Releases previous bed, auto-promotes waiting patient in source ward,
 * acquires target bed, updates allocation, and records transfer history.
 *
 * @param {Object} connection - mysql2 pool or connection
 * @param {Object} params - { patientId, uname, targetWardId, targetBedId, reason }
 * @returns {Promise<Object>}
 */
async function transferPatient(connection, { patientId, uname, targetWardId, targetBedId, reason }) {
    return await withTransaction(connection, async (conn) => {
        // 1. Locate active ALLOCATED record for this patient
        const activeAllocs = await queryAsync(
            conn,
            `SELECT id, ward_id, bed_id
             FROM bed_allocation
             WHERE patient_id = ? AND uname = ? AND status = 'ALLOCATED'
             LIMIT 1 FOR UPDATE`,
            [patientId, uname]
        );

        if (activeAllocs.length === 0) {
            throw new Error(`Patient #${patientId} does not have an active bed allocation to transfer.`);
        }

        const currentAlloc = activeAllocs[0];
        const sourceWardId = currentAlloc.ward_id;
        const sourceBedId = currentAlloc.bed_id;

        // 2. Locate target ward
        const targetWards = await queryAsync(
            conn,
            "SELECT id, name, code FROM ward WHERE id = ? AND uname = ? LIMIT 1",
            [targetWardId, uname]
        );
        if (targetWards.length === 0) {
            throw new Error("Target destination ward does not exist.");
        }
        const targetWard = targetWards[0];

        // 3. Acquire available bed in target ward
        let destBed = null;
        if (targetBedId) {
            const specificBeds = await queryAsync(
                conn,
                `SELECT id, bed_number FROM bed
                 WHERE id = ? AND ward_id = ? AND uname = ? AND status = 'AVAILABLE'
                 LIMIT 1 FOR UPDATE`,
                [targetBedId, targetWard.id, uname]
            );
            if (specificBeds.length === 0) {
                throw new Error("Selected target bed is no longer available.");
            }
            destBed = specificBeds[0];
        } else {
            const anyAvailable = await queryAsync(
                conn,
                `SELECT id, bed_number FROM bed
                 WHERE ward_id = ? AND uname = ? AND status = 'AVAILABLE'
                 ORDER BY id ASC LIMIT 1 FOR UPDATE`,
                [targetWard.id, uname]
            );
            if (anyAvailable.length === 0) {
                throw new Error(`Target ward ${targetWard.name} has no available beds.`);
            }
            destBed = anyAvailable[0];
        }

        // 4. Mark destination bed as OCCUPIED
        await queryAsync(
            conn,
            "UPDATE bed SET status = 'OCCUPIED' WHERE id = ? AND uname = ?",
            [destBed.id, uname]
        );

        // 5. Release source bed to AVAILABLE
        if (sourceBedId) {
            await queryAsync(
                conn,
                "UPDATE bed SET status = 'AVAILABLE' WHERE id = ? AND uname = ?",
                [sourceBedId, uname]
            );

            // Auto-promote next waiting patient in source ward if any
            const waitingInSource = await queryAsync(
                conn,
                `SELECT a.id as allocation_id, a.patient_id, p.name as patient_name, p.score
                 FROM bed_allocation a
                 JOIN patient p ON a.patient_id = p.id AND a.uname = p.uname
                 WHERE a.ward_id = ? AND a.uname = ? AND a.status = 'WAITING'
                 ORDER BY p.score DESC, a.queue_entry_time ASC
                 LIMIT 1 FOR UPDATE`,
                [sourceWardId, uname]
            );

            if (waitingInSource.length > 0) {
                const nextInSource = waitingInSource[0];
                const claimSource = await queryAsync(
                    conn,
                    `UPDATE bed SET status = 'OCCUPIED'
                     WHERE id = ? AND status = 'AVAILABLE' AND uname = ?`,
                    [sourceBedId, uname]
                );
                if (claimSource.affectedRows === 1) {
                    await queryAsync(
                        conn,
                        `UPDATE bed_allocation
                         SET bed_id = ?, status = 'ALLOCATED', allocated_at = NOW()
                         WHERE id = ?`,
                        [sourceBedId, nextInSource.allocation_id]
                    );
                }
            }
        }

        // 6. Update current patient allocation to new ward and bed
        await queryAsync(
            conn,
            `UPDATE bed_allocation
             SET ward_id = ?, bed_id = ?, allocated_at = NOW()
             WHERE id = ?`,
            [targetWard.id, destBed.id, currentAlloc.id]
        );

        // 7. Record immutable transfer audit log
        await queryAsync(
            conn,
            `INSERT INTO bed_transfer_history
             (patient_id, uname, from_ward_id, from_bed_id, to_ward_id, to_bed_id, reason)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [patientId, uname, sourceWardId, sourceBedId, targetWard.id, destBed.id, reason || "Clinical ward transfer"]
        );

        return {
            success: true,
            targetWardName: targetWard.name,
            targetBedNumber: destBed.bed_number,
            message: `Patient #${patientId} transferred to ${targetWard.name} (${destBed.bed_number}).`
        };
    });
}

/**
 * Retrieves all discharged patients and their historical admission/discharge records.
 *
 * @param {Object} connection - mysql2 pool or connection
 * @param {string} uname - Staff username
 * @returns {Promise<Array>}
 */
async function getDischargedPatients(connection, uname) {
    const q = `
        SELECT
            p.id as patient_id,
            p.name as patient_name,
            p.age as patient_age,
            p.dis as patient_condition,
            p.score as patient_score,
            w.name as previous_ward_name,
            w.code as previous_ward_code,
            b.bed_number as previous_bed_number,
            a.queue_entry_time as admission_date,
            a.allocated_at,
            a.discharged_at,
            ROUND(TIMESTAMPDIFF(MINUTE, a.allocated_at, a.discharged_at) / 60, 1) as length_of_stay_hours
        FROM bed_allocation a
        JOIN patient p ON a.patient_id = p.id AND a.uname = p.uname
        LEFT JOIN ward w ON a.ward_id = w.id AND a.uname = w.uname
        LEFT JOIN bed b ON a.bed_id = b.id AND a.uname = b.uname
        WHERE a.uname = ? AND a.status = 'DISCHARGED'
        ORDER BY a.discharged_at DESC
    `;
    return await queryAsync(connection, q, [uname]);
}

/**
 * Retrieves the retention policy settings for a hospital staff account.
 * Defaults to 90 days if not yet customized.
 *
 * @param {Object} connection - mysql2 pool or connection
 * @param {string} uname - Staff username
 * @returns {Promise<Object>}
 */
async function getRetentionSettings(connection, uname) {
    const rows = await queryAsync(
        connection,
        "SELECT discharge_retention_days, auto_cleanup_enabled, updated_at FROM hospital_settings WHERE uname = ? LIMIT 1",
        [uname]
    );

    if (rows.length > 0) {
        return {
            dischargeRetentionDays: Number(rows[0].discharge_retention_days),
            autoCleanupEnabled: Boolean(rows[0].auto_cleanup_enabled),
            updatedAt: rows[0].updated_at
        };
    }

    const defaultDays = parseInt(process.env.DISCHARGE_RETENTION_DAYS, 10) || 90;
    return {
        dischargeRetentionDays: defaultDays,
        autoCleanupEnabled: false,
        updatedAt: null
    };
}

/**
 * Updates or sets the retention policy settings for a hospital staff account.
 *
 * @param {Object} connection - mysql2 pool or connection
 * @param {Object} params - { uname, days, autoCleanupEnabled }
 * @returns {Promise<Object>}
 */
async function updateRetentionSettings(connection, { uname, days, autoCleanupEnabled }) {
    const cleanDays = Math.max(1, Math.min(3650, parseInt(days, 10) || 90));
    const isAuto = Boolean(autoCleanupEnabled);

    await queryAsync(
        connection,
        `INSERT INTO hospital_settings (uname, discharge_retention_days, auto_cleanup_enabled)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
             discharge_retention_days = VALUES(discharge_retention_days),
             auto_cleanup_enabled = VALUES(auto_cleanup_enabled)`,
        [uname, cleanDays, isAuto]
    );

    return {
        success: true,
        dischargeRetentionDays: cleanDays,
        autoCleanupEnabled: isAuto
    };
}

/**
 * Previews expired discharged patients eligible for retention cleanup without deleting anything.
 * Guarantees distinct patient IDs, ignores patients with any active allocation, and scopes strictly to uname.
 *
 * @param {Object} connection - mysql2 pool or connection
 * @param {Object} params - { uname, retentionDays }
 * @returns {Promise<Array>}
 */
async function previewExpiredDischargedPatients(connection, { uname, retentionDays }) {
    const days = Math.max(1, parseInt(retentionDays, 10) || 90);

    const q = `
        SELECT 
            p.id as patient_id,
            p.name as patient_name,
            p.dis as patient_condition,
            MAX(a.discharged_at) as latest_discharge_date,
            DATEDIFF(NOW(), MAX(a.discharged_at)) as days_since_discharge
        FROM patient p
        JOIN bed_allocation a ON p.id = a.patient_id AND p.uname = a.uname
        WHERE p.uname = ?
          AND a.status = 'DISCHARGED'
          AND a.discharged_at <= DATE_SUB(NOW(), INTERVAL ? DAY)
          AND p.id NOT IN (
              SELECT DISTINCT active_a.patient_id
              FROM bed_allocation active_a
              WHERE active_a.uname = ?
                AND active_a.status IN ('ALLOCATED', 'WAITING', 'NEEDS_REVIEW')
          )
        GROUP BY p.id, p.name, p.dis
        ORDER BY latest_discharge_date ASC
    `;
    return await queryAsync(connection, q, [uname, days, uname]);
}

/**
 * Idempotently and safely purges expired discharged patients beyond the retention period.
 * Strictly transactional: guarantees distinct candidate IDs, never deletes active patients,
 * cascades cleanly to allocations and transfer history, and records an auditable cleanup log.
 *
 * @param {Object} connection - mysql2 pool or connection
 * @param {Object} params - { uname, retentionDays, triggerType }
 * @returns {Promise<Object>}
 */
async function purgeExpiredDischargedPatients(connection, { uname, retentionDays, triggerType = 'MANUAL' }) {
    const days = Math.max(1, parseInt(retentionDays, 10) || 90);

    return await withTransaction(connection, async (conn) => {
        // Step 1: Select distinct candidate patient IDs eligible for deletion
        const candidates = await queryAsync(conn, `
            SELECT 
                p.id as patient_id,
                p.name as patient_name,
                MAX(a.discharged_at) as latest_discharge_date
            FROM patient p
            JOIN bed_allocation a ON p.id = a.patient_id AND p.uname = a.uname
            WHERE p.uname = ?
              AND a.status = 'DISCHARGED'
              AND a.discharged_at <= DATE_SUB(NOW(), INTERVAL ? DAY)
              AND p.id NOT IN (
                  SELECT DISTINCT active_a.patient_id
                  FROM bed_allocation active_a
                  WHERE active_a.uname = ?
                    AND active_a.status IN ('ALLOCATED', 'WAITING', 'NEEDS_REVIEW')
              )
            GROUP BY p.id, p.name
            ORDER BY latest_discharge_date ASC
        `, [uname, days, uname]);

        if (candidates.length === 0) {
            return {
                purgedCount: 0,
                candidateIds: [],
                retentionDays: days,
                message: `No discharged patient records older than ${days} days found for cleanup.`
            };
        }

        const candidateIds = candidates.map(c => c.patient_id);
        const placeholders = candidateIds.map(() => '?').join(',');

        // Step 2: Delete expired patient records (cascades cleanly to bed_allocation & bed_transfer_history)
        const deleteParams = [uname, ...candidateIds];
        const deleteRes = await queryAsync(conn, `
            DELETE FROM patient
            WHERE uname = ? AND id IN (${placeholders})
        `, deleteParams);

        const purgedCount = deleteRes.affectedRows || 0;

        // Step 3: Record immutable audit log
        await queryAsync(conn, `
            INSERT INTO retention_cleanup_audit
            (uname, trigger_type, retention_days, patients_purged_count, details)
            VALUES (?, ?, ?, ?, ?)
        `, [
            uname,
            triggerType,
            days,
            purgedCount,
            `Purged patient IDs: ${candidateIds.join(', ')}`
        ]);

        return {
            purgedCount,
            candidateIds,
            retentionDays: days,
            triggerType,
            message: `Successfully cleaned up ${purgedCount} expired patient records older than ${days} days.`
        };
    });
}

/**
 * Scheduled Daily Retention Cleanup Runner.
 * Inspects all hospital accounts where auto_cleanup_enabled is TRUE,
 * reads each account's configured retention period, and executes safe cleanup.
 *
 * @param {Object} connection - mysql2 pool or connection
 * @returns {Promise<Object>}
 */
async function runDailyRetentionScheduler(connection) {
    const activeAccounts = await queryAsync(
        connection,
        "SELECT uname, discharge_retention_days FROM hospital_settings WHERE auto_cleanup_enabled = TRUE"
    );

    const results = [];
    for (const acc of activeAccounts) {
        try {
            const outcome = await purgeExpiredDischargedPatients(connection, {
                uname: acc.uname,
                retentionDays: acc.discharge_retention_days,
                triggerType: 'SCHEDULED_DAILY'
            });
            results.push({ uname: acc.uname, outcome });
        } catch (err) {
            console.error(`[SCHEDULED CLEANUP ERROR] Account '${acc.uname}':`, err.message);
            results.push({ uname: acc.uname, error: err.message });
        }
    }
    return results;
}

/**
 * Starts an in-process daily interval timer to trigger runDailyRetentionScheduler.
 * Runs once every 24 hours (86,400,000 ms).
 *
 * @param {Object} connection - mysql2 pool
 * @returns {NodeJS.Timeout}
 */
function startRetentionCron(connection) {
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    const timer = setInterval(async () => {
        try {
            console.log('[RETENTION SCHEDULER] Running daily automatic retention check...');
            await runDailyRetentionScheduler(connection);
        } catch (e) {
            console.error('[RETENTION SCHEDULER ERROR]:', e);
        }
    }, TWENTY_FOUR_HOURS);

    // Ensure timer doesn't prevent Node process from graceful exit if needed
    if (timer.unref) timer.unref();
    return timer;
}

module.exports = {
    queryAsync,
    withTransaction,
    classifyWardSuitability,
    allocateBedOnAdmission,
    dischargePatient,
    manualAssignWard,
    updateBedMaintenanceStatus,
    getHospitalBedSummary,
    addCustomWard,
    getWardDetails,
    transferPatient,
    getDischargedPatients,
    getRetentionSettings,
    updateRetentionSettings,
    previewExpiredDischargedPatients,
    purgeExpiredDischargedPatients,
    runDailyRetentionScheduler,
    startRetentionCron
};

