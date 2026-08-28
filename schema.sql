
CREATE DATABASE IF NOT EXISTS hospital;
USE hospital;

-- Login table
CREATE TABLE IF NOT EXISTS login (
    uname VARCHAR(50) NOT NULL,
    upass VARCHAR(100) NOT NULL,
    PRIMARY KEY (uname)
);

-- Patient table
CREATE TABLE IF NOT EXISTS patient (
    id INT NOT NULL,
    name VARCHAR(100) NOT NULL,
    dis VARCHAR(100) NOT NULL,
    age INT NOT NULL,
    wait INT NOT NULL,
    descp VARCHAR(200) NOT NULL,
    score INT NOT NULL,
    uname VARCHAR(50) NOT NULL,
    PRIMARY KEY (id, uname)
);