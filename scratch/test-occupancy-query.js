require("dotenv").config();
const mysql = require("mysql2");

const conn = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    ssl: { rejectUnauthorized: false }
});

function queryAsync(conn, sql, params = []) {
    return new Promise((resolve, reject) => {
        conn.query(sql, params, (err, res) => {
            if (err) reject(err);
            else resolve(res);
        });
    });
}

async function run() {
    const uname = "sies";

    // 1. Fetch wards
    const wards = await queryAsync(
        conn,
        "SELECT id, name, code, total_beds FROM ward WHERE uname = ? ORDER BY id ASC",
        [uname]
    );

    // 2. Fetch bed aggregations per ward
    const bedCounts = await queryAsync(
        conn,
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

    // 3. Fetch waiting patients per ward
    const waitingCounts = await queryAsync(
        conn,
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

    // 4. Waiting requiring review
    const reviewRows = await queryAsync(
        conn,
        "SELECT COUNT(id) as count FROM bed_allocation WHERE uname = ? AND status = 'NEEDS_REVIEW'",
        [uname]
    );
    const totalNeedsReview = Number(reviewRows[0]?.count || 0);

    // 5. Unassigned beds check
    const unassignedRows = await queryAsync(
        conn,
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

    // 6. Fetch individual beds per ward
    const beds = await queryAsync(
        conn,
        "SELECT id, ward_id, bed_number, status FROM bed WHERE uname = ? ORDER BY id ASC",
        [uname]
    );
    const bedsByWard = {};
    for (const bed of beds) {
        if (!bedsByWard[bed.ward_id]) bedsByWard[bed.ward_id] = [];
        bedsByWard[bed.ward_id].push(bed);
    }

    // Combine ward objects
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

    console.log("Ward List Summary:");
    wardList.forEach(w => {
        console.log(`- ${w.ward_code} (${w.ward_name}): Total=${w.total_beds}, Occ=${w.occupied_beds}, Avail=${w.available_beds}, Maint=${w.maintenance_beds}, Wait=${w.waiting_patients}, OccRate=${w.occupancy_rate}%, isFull=${w.is_full}`);
        console.log(`  Verification: ${w.occupied_beds} + ${w.available_beds} + ${w.maintenance_beds} === ${w.total_beds} =>`, (w.occupied_beds + w.available_beds + w.maintenance_beds === w.total_beds));
    });

    console.log("\nOverall Totals:");
    console.log({
        total_beds: sumTotal,
        total_occupied: sumOccupied,
        total_available: sumAvailable,
        total_maintenance: sumMaintenance,
        total_waiting: sumWaiting,
        total_needs_review: totalNeedsReview,
        unassigned_beds: unassignedBeds
    });
    console.log(`Verification: ${sumOccupied} + ${sumAvailable} + ${sumMaintenance} === ${sumTotal} =>`, (sumOccupied + sumAvailable + sumMaintenance === sumTotal));

    conn.end();
}

run().catch(console.error);
