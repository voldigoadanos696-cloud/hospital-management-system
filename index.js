require("dotenv").config();
const { validatePatientAdmission, validatePatientDischarge } = require("./validators/patientValidator");
const {
    allocateBedOnAdmission,
    dischargePatient,
    manualAssignWard,
    updateBedMaintenanceStatus,
    getHospitalBedSummary,
    classifyWardSuitability,
    addCustomWard,
    getWardDetails,
    transferPatient,
    getDischargedPatients
} = require("./services/bedAllocationService");

class PriorityQueue {
    constructor() {
        this.heap = [];
    }

    add(patient) {
        this.heap.push(patient);
        // Max-Heap sorting:
        // Primary sort: score descending (higher priority first)
        // Secondary sort: queue_entry_time ascending (first-come, first-served for ties)
        this.heap.sort((a, b) => {
            if (b.score !== a.score) {
                return b.score - a.score;
            }
            const timeA = a.queue_entry_time ? new Date(a.queue_entry_time).getTime() : 0;
            const timeB = b.queue_entry_time ? new Date(b.queue_entry_time).getTime() : 0;
            return timeA - timeB;
        });
    }

    remove(p_id) {
        let idx = -1;
        for (let i = 0; i < this.heap.length; i++) {
            if (this.heap[i].id == p_id || this.heap[i].pid == p_id) {
                idx = i;
                break;
            }
        }
        if (idx !== -1) {
            this.heap.splice(idx, 1);
        }
    }
}




function getScore(age, dis, wait) {
    let score = 0;
    dis = (dis || "").toLowerCase().trim();
    age = Number(age);
    wait = Number(wait);

    // Age Based Scoring
    if (age >= 60) {
        score += 20;
    } else if (age <= 16) {
        score += 15;
    } else {
        score += 10;
    }

    // Disease Based Scoring
    switch (dis) {
        case "fever": score += 5;
            break;
        case "cold": score += 5;
            break;
        case "heart attack": score += 25;
            break;
        case "cancer": score += 20;
            break;
        case "accident": score += 25;
            break;
        case "diarrhea": score += 10;
            break;
        case "typhoid": score += 15;
            break;
        case "malaria": score += 15;
            break;
        case "dengue": score += 15;
            break;
        case "stroke": score += 25;
            break;

    }

    // Based on wait-time
    if (wait < 2) {
        score += 5;
    } else if (wait < 4) {
        score += 10;
    } else if (wait <= 8) {
        score += 15;
    } else {
        score += 20;
    }

    return score;
}

const mysql = require("mysql2");

const connection = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ssl: {
        rejectUnauthorized: false
    }
});


const express = require("express");
const app = express();
const path = require("path");
const methodOverride = require("method-override");
app.use(methodOverride("_method"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());


app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "/views"));
app.use(express.static("public"));
app.use(express.static(path.join(__dirname, "public/CSS")));
app.use(express.static(path.join(__dirname, "public/JS")));

// LOGIN PAGE
app.get("/", (req, res) => {
    res.render("login.ejs");
});

// LOGIN
app.post("/login", (req, res) => {
    let { uname, upass } = req.body;
    let q = `SELECT * FROM login WHERE uname=?`;

    connection.query(q, [uname], (err, result) => {

        if (err) {
            console.error("Login database error:", err);
            return res.send("DATABASE ERROR");
        }

        if (result.length === 0) {
            return res.send("INCORRECT PASSWORD OR USERNAME");
        }

        if (result[0].upass !== upass) {
            return res.send("INCORRECT PASSWORD OR USERNAME");
        }

        res.redirect(`/home/${uname}`);
    });
});

// register page 
app.get("/register", (req, res) => {
    res.render("register.ejs");
});

// register post
app.post("/register", (req, res) => {
    let { uname, upass } = req.body;
    console.log(uname, upass);
    try {
        let q = `INSERT INTO login VALUES (?,?);`
        connection.query(q, [uname, upass], (err, result) => {
            console.log(result);
            res.redirect("/");
        });
    } catch (err) {
        res.send("An Error Has Occurred");
    }
});

// home page
app.get("/home/:uname", async (req, res) => {
    let { uname } = req.params;
    let bedSummary = { wards: [], totals: {} };
    let totalPatients = 0;
    let criticalPatients = 0;
    try {
        bedSummary = await getHospitalBedSummary(connection, uname);
        const [counts] = await new Promise((resolve) => {
            connection.query(
                `SELECT 
                    COUNT(DISTINCT p.id) as total,
                    COUNT(DISTINCT CASE WHEN p.score >= 50 THEN p.id END) as critical
                 FROM patient p
                 LEFT JOIN bed_allocation a ON p.id = a.patient_id AND p.uname = a.uname
                 WHERE p.uname = ? AND COALESCE(a.status, 'WAITING') IN ('ALLOCATED', 'WAITING', 'NEEDS_REVIEW')`,
                [uname],
                (err, rows) => resolve(rows || [{ total: 0, critical: 0 }])
            );
        });
        totalPatients = counts ? Number(counts.total || 0) : 0;
        criticalPatients = counts ? Number(counts.critical || 0) : 0;
    } catch (bErr) {
        console.error("Bed summary error in home route:", bErr);
    }
    res.render("home.ejs", {
        uname,
        bedSummary,
        totalPatients,
        criticalPatients,
        alert: null
    });
});

app.get("/home/patient/:uname", async (req, res) => {
    let { uname } = req.params;
    let bedSummary = { wards: [], totals: {} };
    try {
        bedSummary = await getHospitalBedSummary(connection, uname);
    } catch (bErr) {
        console.error("Bed summary error in patient route:", bErr);
    }

    res.render("list.ejs", {
        uname,
        errors: {},
        formData: {},
        dischargeData: {},
        alert: null,
        bedSummary
    });
});

// ADD PATIENT(POST)
app.post("/list/:uname", async (req, res) => {
    let { uname } = req.params;
    const { isValid, errors, sanitized } = validatePatientAdmission(req.body);

    let bedSummary = { wards: [], totals: {} };
    try {
        bedSummary = await getHospitalBedSummary(connection, uname);
    } catch (bErr) {}

    if (!isValid) {
        return res.status(422).render("list.ejs", {
            uname,
            errors,
            formData: req.body,
            dischargeData: {},
            alert: { type: "error", message: "Please correct the highlighted form errors below." },
            bedSummary
        });
    }

    const { pid, pname, page, pdis, pwait, descp } = sanitized;
    const score = getScore(page, pdis, pwait);
    const q = `INSERT INTO patient (id,name,age,dis,wait,score,descp,uname) VALUES (?,?,?,?,?,?,?,?)`;

    connection.query(q, [pid, pname, page, pdis, pwait, score, descp, uname], async (err, result) => {
        if (err) {
            console.error("Patient admission database error:", err);
            // Handle duplicate primary key (id, uname)
            if (err.code === "ER_DUP_ENTRY" || err.errno === 1062) {
                return res.status(422).render("list.ejs", {
                    uname,
                    errors: { pid: `Patient ID #${pid} is already registered in the queue.` },
                    formData: req.body,
                    dischargeData: {},
                    alert: { type: "error", message: `Patient ID #${pid} already exists. Please choose a unique Patient ID.` },
                    bedSummary
                });
            }
            return res.status(500).render("list.ejs", {
                uname,
                errors: {},
                formData: req.body,
                dischargeData: {},
                alert: { type: "error", message: "A database error occurred while saving the patient record. Please try again." },
                bedSummary
            });
        }

        try {
            // Smart Hospital Bed Allocation on admission
            await allocateBedOnAdmission(connection, {
                patientId: pid,
                uname,
                age: page,
                condition: pdis,
                score
            });
        } catch (allocErr) {
            console.error("Bed allocation processing error:", allocErr);
        }

        res.redirect(`/history/${uname}`);
    });
});

// REMOVE / DISCHARGE PATIENT (DELETE REQUEST)
app.delete("/list/:uname", async (req, res) => {
    let { uname } = req.params;
    const { isValid, errors, sanitized } = validatePatientDischarge(req.body);

    let bedSummary = { wards: [], totals: {} };
    try {
        bedSummary = await getHospitalBedSummary(connection, uname);
    } catch (bErr) {}

    if (!isValid) {
        return res.status(422).render("list.ejs", {
            uname,
            errors,
            formData: {},
            dischargeData: req.body,
            alert: { type: "error", message: "Please provide a valid Patient ID to discharge." },
            bedSummary
        });
    }

    const { pid } = sanitized;

    try {
        const dischargeResult = await dischargePatient(connection, {
            patientId: pid,
            uname
        });

        if (dischargeResult.notFound) {
            return res.status(404).render("list.ejs", {
                uname,
                errors: { dischargePid: `No active patient found with ID #${pid} in your queue.` },
                formData: {},
                dischargeData: req.body,
                alert: { type: "error", message: `Patient ID #${pid} was not found in your active queue.` },
                bedSummary
            });
        }

        res.redirect(`/history/${uname}`);
    } catch (err) {
        console.error("Patient discharge database error:", err);
        return res.status(500).render("list.ejs", {
            uname,
            errors: {},
            formData: {},
            dischargeData: req.body,
            alert: { type: "error", message: "A database error occurred while discharging the patient. Please try again." },
            bedSummary
        });
    }
});

// MANUAL CLINICAL WARD ASSIGNMENT (FOR AMBIGUOUS / NEEDS_REVIEW CONDITIONS)
app.post("/allocation/assign-ward/:uname", async (req, res) => {
    let { uname } = req.params;
    let { patientId, wardCode } = req.body;

    if (!patientId || !wardCode) {
        return res.redirect(`/history/${uname}`);
    }

    try {
        await manualAssignWard(connection, {
            patientId: Number(patientId),
            uname,
            wardCode: String(wardCode).trim().toUpperCase()
        });
    } catch (err) {
        console.error("Manual ward assignment error:", err);
    }

    res.redirect(`/history/${uname}`);
});

// BED STATUS TOGGLE (AVAILABLE <-> MAINTENANCE)
app.post("/allocation/bed-status/:uname", async (req, res) => {
    let { uname } = req.params;
    let { bedId, status } = req.body;

    if (bedId && status) {
        try {
            await updateBedMaintenanceStatus(connection, {
                bedId: Number(bedId),
                uname,
                status: String(status).trim().toUpperCase()
            });
        } catch (err) {
            console.error("Bed status update error:", err);
        }
    }

    res.redirect(`/history/${uname}`);
});

// CREATE DYNAMIC WARD CATEGORY
app.post("/wards/create/:uname", async (req, res) => {
    let { uname } = req.params;
    let { name, code, totalBeds, description } = req.body;
    try {
        await addCustomWard(connection, {
            uname,
            name,
            code,
            totalBeds,
            description
        });
        res.redirect(`/home/${uname}`);
    } catch (err) {
        console.error("Ward creation error:", err.message);
        let bedSummary = { wards: [], totals: {} };
        try { bedSummary = await getHospitalBedSummary(connection, uname); } catch (e) {}
        res.status(400).render("home.ejs", {
            uname,
            bedSummary,
            totalPatients: 0,
            criticalPatients: 0,
            alert: { type: "error", message: `Failed to create ward: ${err.message}` }
        });
    }
});

// WARD DETAIL ALLOCATION PAGE
app.get("/wards/:uname/:wardCode", async (req, res) => {
    let { uname, wardCode } = req.params;
    try {
        const details = await getWardDetails(connection, uname, wardCode);
        if (!details) {
            return res.redirect(`/home/${uname}`);
        }
        res.render("ward_detail.ejs", {
            uname,
            ward: details.ward,
            beds: details.beds,
            inpatients: details.inpatients,
            waitingQueue: details.waitingQueue,
            allWards: details.allWards,
            stats: details.stats,
            alert: null
        });
    } catch (err) {
        console.error("Ward detail route error:", err);
        res.redirect(`/home/${uname}`);
    }
});

// PATIENT TRANSFER BETWEEN WARDS
app.post("/allocation/transfer/:uname", async (req, res) => {
    let { uname } = req.params;
    let { patientId, targetWardId, targetBedId, reason, currentWardCode } = req.body;
    try {
        await transferPatient(connection, {
            patientId: Number(patientId),
            uname,
            targetWardId: Number(targetWardId),
            targetBedId: targetBedId ? Number(targetBedId) : null,
            reason: reason || "Clinical ward transfer"
        });
        if (currentWardCode) {
            return res.redirect(`/wards/${uname}/${currentWardCode}`);
        }
        res.redirect(`/history/${uname}`);
    } catch (err) {
        console.error("Patient transfer error:", err.message);
        if (currentWardCode) {
            return res.redirect(`/wards/${uname}/${currentWardCode}?error=${encodeURIComponent(err.message)}`);
        }
        res.redirect(`/history/${uname}`);
    }
});

// DISCHARGED PATIENTS HISTORY PAGE
app.get("/discharged/:uname", async (req, res) => {
    let { uname } = req.params;
    try {
        const dischargedPatients = await getDischargedPatients(connection, uname);
        res.render("discharged.ejs", {
            uname,
            dischargedPatients,
            alert: null
        });
    } catch (err) {
        console.error("Discharged route error:", err);
        res.send("An error occurred while loading discharge history.");
    }
});

// JSON API FOR LIVE WARD OCCUPANCY METRICS
app.get("/api/wards/:uname", async (req, res) => {
    let { uname } = req.params;
    try {
        const bedSummary = await getHospitalBedSummary(connection, uname);
        res.json({ success: true, bedSummary });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// TRACK PATIENTS & LIVE PRIORITY BED QUEUE
app.get("/history/:uname", async (req, res) => {
    let { uname } = req.params;
    const patients = new PriorityQueue();

    const q = `
        SELECT
            p.*,
            COALESCE(a.status, 'WAITING') as allocation_status,
            a.queue_entry_time,
            a.allocated_at,
            a.discharged_at,
            b.bed_number,
            w.name as ward_name,
            w.code as ward_code
        FROM patient p
        LEFT JOIN bed_allocation a ON p.id = a.patient_id AND p.uname = a.uname
        LEFT JOIN bed b ON a.bed_id = b.id AND a.uname = b.uname
        LEFT JOIN ward w ON a.ward_id = w.id AND a.uname = w.uname
        WHERE p.uname = ? AND COALESCE(a.status, 'WAITING') IN ('ALLOCATED', 'WAITING', 'NEEDS_REVIEW')
        ORDER BY p.score DESC, COALESCE(a.queue_entry_time, '2099-01-01') ASC
    `;

    try {
        let bedSummary = { wards: [], totals: {} };
        try {
            bedSummary = await getHospitalBedSummary(connection, uname);
        } catch (bErr) {
            console.error("Bed summary error:", bErr);
        }

        connection.query(q, [uname], (err, result) => {
            if (err) {
                console.error("History query error:", err);
                return res.send("SOME ERROR HAS OCCURRED");
            }

            for (const ele of result) {
                patients.add(ele);
            }

            res.render("history.ejs", {
                patient: patients.heap,
                bedSummary,
                uname
            });
        });
    } catch (err) {
        console.error("History route error:", err);
        res.send("SOME ERROR HAS OCCURRED");
    }
});

// PATIENT DOSSIER WITH WARD & BED DETAILS
app.get("/history/:id/:uname", (req, res) => {
    let { id, uname } = req.params;
    const q = `
        SELECT
            p.*,
            COALESCE(a.status, 'WAITING') as allocation_status,
            a.queue_entry_time,
            a.allocated_at,
            a.discharged_at,
            b.bed_number,
            w.name as ward_name,
            w.code as ward_code
        FROM patient p
        LEFT JOIN bed_allocation a ON p.id = a.patient_id AND p.uname = a.uname
        LEFT JOIN bed b ON a.bed_id = b.id AND a.uname = b.uname
        LEFT JOIN ward w ON a.ward_id = w.id AND a.uname = w.uname
        WHERE (p.id = ? AND p.uname = ?)
        ORDER BY a.id DESC LIMIT 1
    `;

    try {
        connection.query(q, [id, uname], (err, result) => {
            if (err) {
                console.error("Dossier query error:", err);
                return res.send("SOME ERROR HAS OCCURRED");
            }
            let data = result[0];
            res.render("phist.ejs", { p: data, uname });
        });
    } catch (err) {
        res.send("SOME ERROR HAS OCCURRED");
    }
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});


