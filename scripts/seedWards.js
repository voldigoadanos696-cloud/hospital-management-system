/**
 * Idempotent Ward & Bed Seeder
 * Configures default hospital wards and physical beds for a staff/hospital account (uname).
 * Guarantees zero duplicate entries if run multiple times.
 */

const DEFAULT_WARD_PROFILES = [
    {
        name: "Intensive Care Unit",
        code: "ICU",
        totalBeds: 4,
        prefix: "ICU"
    },
    {
        name: "Emergency & Trauma Ward",
        code: "EMG",
        totalBeds: 6,
        prefix: "EMG"
    },
    {
        name: "Pediatric Care Ward",
        code: "PED",
        totalBeds: 6,
        prefix: "PED"
    },
    {
        name: "Infectious Disease Ward",
        code: "INF",
        totalBeds: 6,
        prefix: "INF"
    },
    {
        name: "General Medical Ward",
        code: "GEN",
        totalBeds: 8,
        prefix: "GEN"
    },
    {
        name: "Maternity Ward",
        code: "MAT",
        totalBeds: 6,
        prefix: "MAT"
    },
    {
        name: "Surgical Ward",
        code: "SUR",
        totalBeds: 6,
        prefix: "SUR"
    }
];

/**
 * Ensures default wards and beds exist for the given hospital staff account (uname).
 * @param {Object} connection - mysql2 connection instance
 * @param {string} uname - Staff username / hospital account
 * @returns {Promise<void>}
 */
async function ensureHospitalWards(connection, uname) {
    if (!uname) return;

    for (const wardProfile of DEFAULT_WARD_PROFILES) {
        // 1. Insert ward idempotently using unique key (uname, code)
        await new Promise((resolve, reject) => {
            const q = `
                INSERT INTO ward (uname, name, code, total_beds)
                VALUES (?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    name = VALUES(name),
                    total_beds = VALUES(total_beds)
            `;
            connection.query(q, [uname, wardProfile.name, wardProfile.code, wardProfile.totalBeds], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        // 2. Retrieve ward ID
        const wardId = await new Promise((resolve, reject) => {
            const q = `SELECT id FROM ward WHERE uname = ? AND code = ?`;
            connection.query(q, [uname, wardProfile.code], (err, rows) => {
                if (err) reject(err);
                else resolve(rows[0] ? rows[0].id : null);
            });
        });

        if (!wardId) continue;

        // 3. Insert beds idempotently using unique key (ward_id, bed_number)
        for (let i = 1; i <= wardProfile.totalBeds; i++) {
            const bedNumber = `${wardProfile.prefix}-${String(i).padStart(2, "0")}`;
            await new Promise((resolve, reject) => {
                const q = `
                    INSERT INTO bed (ward_id, uname, bed_number, status)
                    VALUES (?, ?, ?, 'AVAILABLE')
                    ON DUPLICATE KEY UPDATE uname = VALUES(uname)
                `;
                connection.query(q, [wardId, uname, bedNumber], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        }
    }
}

module.exports = {
    DEFAULT_WARD_PROFILES,
    ensureHospitalWards
};
