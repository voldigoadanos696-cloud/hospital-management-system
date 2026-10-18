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

async function testMaintenance() {
    const testUname = "test_hospital_unit";
    console.log("Testing maintenance toggle for test account:", testUname);

    // Find an available bed
    const availBeds = await queryAsync(
        conn,
        "SELECT id, bed_number, ward_id, status FROM bed WHERE uname = ? AND status = 'AVAILABLE' LIMIT 1",
        [testUname]
    );

    if (availBeds.length === 0) {
        console.log("No available bed found for test.");
        conn.end();
        return;
    }

    const testBed = availBeds[0];
    console.log("Initial bed state:", testBed);

    // 1. Set to MAINTENANCE
    await queryAsync(conn, "START TRANSACTION");
    const res1 = await queryAsync(
        conn,
        "UPDATE bed SET status = 'MAINTENANCE' WHERE id = ? AND uname = ? AND status = 'AVAILABLE'",
        [testBed.id, testUname]
    );
    await queryAsync(conn, "COMMIT");
    console.log("Updated to MAINTENANCE affectedRows:", res1.affectedRows);

    // Verify bed is now MAINTENANCE
    const check1 = await queryAsync(conn, "SELECT status FROM bed WHERE id = ?", [testBed.id]);
    console.log("Bed status is now:", check1[0].status);
    console.assert(check1[0].status === "MAINTENANCE", "Expected status to be MAINTENANCE");

    // 2. Set back to AVAILABLE
    await queryAsync(conn, "START TRANSACTION");
    const res2 = await queryAsync(
        conn,
        "UPDATE bed SET status = 'AVAILABLE' WHERE id = ? AND uname = ? AND status = 'MAINTENANCE'",
        [testBed.id, testUname]
    );
    await queryAsync(conn, "COMMIT");
    console.log("Restored to AVAILABLE affectedRows:", res2.affectedRows);

    const check2 = await queryAsync(conn, "SELECT status FROM bed WHERE id = ?", [testBed.id]);
    console.log("Bed status restored to:", check2[0].status);
    console.assert(check2[0].status === "AVAILABLE", "Expected status to be AVAILABLE");

    console.log("Maintenance flow verified successfully!");
    conn.end();
}

testMaintenance().catch(err => {
    console.error("Test failed:", err);
    conn.end();
});
