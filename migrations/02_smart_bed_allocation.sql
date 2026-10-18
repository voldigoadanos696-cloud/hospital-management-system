-- Smart Hospital Bed Allocation Migration
-- Non-destructive additive tables with account-scoped composite foreign keys

-- 1. Hospital Wards Table
CREATE TABLE IF NOT EXISTS ward (
    id INT AUTO_INCREMENT PRIMARY KEY,
    uname VARCHAR(50) NOT NULL,
    name VARCHAR(50) NOT NULL,
    code VARCHAR(10) NOT NULL,
    total_beds INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ward_uname (uname),
    UNIQUE KEY uq_ward_uname_code (uname, code)
);

-- 2. Hospital Beds Table
CREATE TABLE IF NOT EXISTS bed (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ward_id INT NOT NULL,
    uname VARCHAR(50) NOT NULL,
    bed_number VARCHAR(20) NOT NULL,
    status ENUM('AVAILABLE', 'OCCUPIED', 'MAINTENANCE') NOT NULL DEFAULT 'AVAILABLE',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (ward_id) REFERENCES ward(id) ON DELETE CASCADE,
    INDEX idx_bed_uname_status (uname, status),
    INDEX idx_bed_ward (ward_id),
    UNIQUE KEY uq_bed_ward_number (ward_id, bed_number)
);

-- 3. Bed Allocations Table (Tracking Current Active Allocations and Completed History)
CREATE TABLE IF NOT EXISTS bed_allocation (
    id INT AUTO_INCREMENT PRIMARY KEY,
    patient_id INT NOT NULL,
    uname VARCHAR(50) NOT NULL,
    ward_id INT NULL,
    bed_id INT NULL,
    status ENUM('ALLOCATED', 'WAITING', 'DISCHARGED', 'NEEDS_REVIEW') NOT NULL DEFAULT 'WAITING',
    queue_entry_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    allocated_at DATETIME NULL,
    discharged_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- Generated column for database-enforced single active allocation per patient
    active_patient_id INT GENERATED ALWAYS AS (
        CASE WHEN status IN ('ALLOCATED', 'WAITING', 'NEEDS_REVIEW') THEN patient_id ELSE NULL END
    ) VIRTUAL,
    FOREIGN KEY (ward_id) REFERENCES ward(id) ON DELETE SET NULL,
    FOREIGN KEY (bed_id) REFERENCES bed(id) ON DELETE SET NULL,
    FOREIGN KEY (patient_id, uname) REFERENCES patient(id, uname) ON DELETE CASCADE,
    INDEX idx_alloc_patient (patient_id, uname),
    INDEX idx_alloc_uname_status (uname, status),
    UNIQUE KEY uq_active_patient_allocation (uname, active_patient_id)
);
