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

module.exports = {
    queryAsync,
    withTransaction,
    classifyWardSuitability,
    allocateBedOnAdmission,
    dischargePatient,
    manualAssignWard,
    updateBedMaintenanceStatus,
    getHospitalBedSummary
};
