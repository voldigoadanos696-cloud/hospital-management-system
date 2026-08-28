require("dotenv").config();

class PriorityQueue {
    constructor() {
        this.heap = [];
    }

    add(patient) {
        this.heap.push(patient);
        this.heap.sort((a, b) => b.score - a.score);
    }

    remove(p_id) {
        let idx = 0;
        for (let i = 0; i < this.heap.length; i++) {
            if (this.heap[i].pid == p_id) {
                idx = i;
                break;
            }
        }
        this.heap.splice(idx, 1);
    }
}




function getScore(age, dis, wait) {
    let score = 0;
    dis = dis.toLowerCase();

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

const connection = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
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
app.get("/home/:uname", (req, res) => {
    let { uname } = req.params;
    res.render("home.ejs", { uname });
});

app.get("/home/patient/:uname", (req, res) => {
    let { uname } = req.params;
    res.render("list.ejs", { uname });
});

// ADD PATIENT(POST)
app.post("/list/:uname", (req, res) => {
    let { uname } = req.params;
    let { pid, pname, page, pdis, pwait, descp } = req.body;
    let score = getScore(page, pdis, pwait);
    let q = `INSERT INTO patient (id,name,age,dis,wait,score,descp,uname) VALUES (?,?,?,?,?,?,?,?)`;
    try {
        connection.query(q, [pid, pname, page, pdis, pwait, score, descp, uname], (err, result) => {
            res.redirect(`/history/${uname}`);
        });
    } catch (err) {
        res.send("ERROR HAS OCCURRED PLEASE TRY AGAIN");
    }
});
// REMOVE PATIENT (DELETE REQUEST)
app.delete("/list/:uname", (req, res) => {
    let { uname } = req.params;
    let { pid } = req.body;
    let q = `DELETE FROM patient WHERE (id = ? AND uname = ?)`;
    try {
        connection.query(q, [pid, uname], (err, result) => {
            res.redirect(`/history/${uname}`);
        });
    } catch (err) {
        res.send("SOME ERROR HAS OCCURRED");
    }
});

app.get("/history/:uname", (req, res) => {
    let { uname } = req.params;
    const patients = new PriorityQueue();
    let q = `SELECT * FROM patient where uname=?`;
    try {
        connection.query(q, uname, (err, result) => {
            for (ele of result) {
                patients.add(ele);
            }
            res.render("history.ejs", { patient: patients.heap, uname });

        });
    } catch (err) {
        res.send("SOME ERROR HAS OCCURRED");
    }
});

app.get("/history/:id/:uname", (req, res) => {
    let { id, uname } = req.params;
    let q = `SELECT * FROM patient WHERE (id=? AND uname=?)`;
    try {
        connection.query(q, [id, uname], (err, result) => {
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


