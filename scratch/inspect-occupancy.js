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

conn.query("SELECT status, count(id) as count FROM bed_allocation WHERE uname = 'sies' GROUP BY status", (err, res) => {
    if (err) console.error("Err:", err);
    else console.log("Allocations for sies:", res);
    conn.query("SELECT id, name, dis, age, wait, score FROM patient WHERE uname = 'sies'", (err2, res2) => {
        if (err2) console.error("Err2:", err2);
        else console.log("Patients for sies:", res2);
        conn.end();
    });
});
