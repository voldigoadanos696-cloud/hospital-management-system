require('dotenv').config();
const mysql = require('mysql2/promise');

async function migrate() {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        port: process.env.DB_PORT || 3306,
        ssl: { rejectUnauthorized: false }
    });

    console.log('Connected to MySQL. Inspecting columns in ward table...');
    const [cols] = await conn.query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ward'");
    const existing = cols.map(c => c.COLUMN_NAME);
    console.log('Existing columns in ward:', existing);
    
    if (!existing.includes('description')) {
        console.log('Adding column description to ward...');
        await conn.query("ALTER TABLE ward ADD COLUMN description VARCHAR(255) DEFAULT ''");
    } else {
        console.log('Column description already exists.');
    }

    if (!existing.includes('is_custom')) {
        console.log('Adding column is_custom to ward...');
        await conn.query("ALTER TABLE ward ADD COLUMN is_custom BOOLEAN DEFAULT FALSE");
    } else {
        console.log('Column is_custom already exists.');
    }

    console.log('Creating bed_transfer_history table if not exists...');
    await conn.query(`
        CREATE TABLE IF NOT EXISTS bed_transfer_history (
            id INT AUTO_INCREMENT PRIMARY KEY,
            patient_id INT NOT NULL,
            uname VARCHAR(50) NOT NULL,
            from_ward_id INT NULL,
            from_bed_id INT NULL,
            to_ward_id INT NOT NULL,
            to_bed_id INT NOT NULL,
            transferred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            reason VARCHAR(255) NULL,
            FOREIGN KEY (patient_id, uname) REFERENCES patient(id, uname) ON DELETE CASCADE,
            FOREIGN KEY (from_ward_id) REFERENCES ward(id) ON DELETE SET NULL,
            FOREIGN KEY (to_ward_id) REFERENCES ward(id) ON DELETE CASCADE,
            FOREIGN KEY (from_bed_id) REFERENCES bed(id) ON DELETE SET NULL,
            FOREIGN KEY (to_bed_id) REFERENCES bed(id) ON DELETE CASCADE,
            INDEX idx_transfer_patient (patient_id, uname),
            INDEX idx_transfer_uname (uname)
        )
    `);
    console.log('MIGRATION_SUCCESSFUL');
    await conn.end();
}

migrate().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
