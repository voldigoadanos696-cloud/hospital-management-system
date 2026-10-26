-- Migration 04: Hospital Retention Policy & Scheduled Cleanup Audit Log
-- Additive & Non-Destructive

-- 1. Hospital Settings Table for Configurable Retention Policy
CREATE TABLE IF NOT EXISTS hospital_settings (
    uname VARCHAR(50) NOT NULL PRIMARY KEY,
    discharge_retention_days INT NOT NULL DEFAULT 90,
    auto_cleanup_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (uname) REFERENCES login(uname) ON DELETE CASCADE
);

-- 2. Audit Log Table for Cleanup History & Transparency
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
);
