const mysql = require('mysql2/promise');
require('dotenv').config();

async function checkPatient() {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'railway',
        port: process.env.DB_PORT || 3306,
        ssl: { rejectUnauthorized: false }
    });

    try {
        console.log("=== Patients with id 102 or name red john ===");
        const [patients] = await conn.query("SELECT * FROM patient WHERE id = 102 OR name LIKE '%red john%'");
        console.log(JSON.stringify(patients, null, 2));

        console.log("=== Bed Allocations for patient 102 ===");
        const [allocs] = await conn.query("SELECT * FROM bed_allocation WHERE patient_id = 102");
        console.log(JSON.stringify(allocs, null, 2));

        console.log("=== Bed ICU-01 rows ===");
        const [beds] = await conn.query("SELECT b.*, w.code as ward_code FROM bed b LEFT JOIN ward w ON b.ward_id = w.id WHERE b.bed_number = 'ICU-01'");
        console.log(JSON.stringify(beds, null, 2));

        console.log("=== All Bed Allocations for any bed named ICU-01 ===");
        const [bedAllocs] = await conn.query(`
            SELECT a.*, p.name as patient_name, b.bed_number 
            FROM bed_allocation a 
            JOIN bed b ON a.bed_id = b.id 
            JOIN patient p ON a.patient_id = p.id AND a.uname = p.uname
            WHERE b.bed_number = 'ICU-01'
        `);
        console.log(JSON.stringify(bedAllocs, null, 2));

    } finally {
        await conn.end();
    }
}

checkPatient().catch(console.error);
