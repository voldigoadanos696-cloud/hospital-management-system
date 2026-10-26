require('dotenv').config();
const mysql = require('mysql2/promise');

async function migrate04() {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        port: process.env.DB_PORT || 3306,
        ssl: { rejectUnauthorized: false }
    });

    console.log('Connected to MySQL. Running Migration 04...');

    await conn.query(`
        CREATE TABLE IF NOT EXISTS hospital_settings (
            uname VARCHAR(50) NOT NULL PRIMARY KEY,
            discharge_retention_days INT NOT NULL DEFAULT 90,
            auto_cleanup_enabled BOOLEAN NOT NULL DEFAULT FALSE,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (uname) REFERENCES login(uname) ON DELETE CASCADE
        )
    `);
    console.log('Table hospital_settings ready.');

    await conn.query(`
        CREATE TABLE IF NOT EXISTS retention_cleanup_audit (
            id INT AUTO_INCREMENT PRIMARY KEY,
            uname VARCHAR(50) NOT NULL,
            trigger_type ENUM('MANUAL', 'SCHEDULED_DAILY') NOT NULL,
            retention_days INT NOT NULL,
            patients_purged_count INT NOT NULL DEFAULT 0,
            details TEXT NULL,
            executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_retention_uname (uname),
            INDEX idx_retention_exec (executed_at)
        )
    `);
    console.log('Table retention_cleanup_audit ready.');

    console.log('MIGRATION 04 COMPLETED SUCCESSFULLY');
    await conn.end();
}

migrate04().catch(err => {
    console.error('Migration 04 failed:', err);
    process.exit(1);
});
