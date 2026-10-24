-- Phase 1 Migration: Additive Non-Destructive Extension for Dynamic Wards & Transfers
-- Database: MySQL 8.4+

-- 1. Extend ward table with metadata columns (additive)
ALTER TABLE ward 
ADD COLUMN IF NOT EXISTS description VARCHAR(255) DEFAULT '',
ADD COLUMN IF NOT EXISTS is_custom BOOLEAN DEFAULT FALSE;

-- 2. Create decoupled transfer history table
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
);
