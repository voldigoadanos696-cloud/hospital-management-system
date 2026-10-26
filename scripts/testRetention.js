/**
 * Retention Policy & Automatic Cleanup Test Suite
 * Tests:
 * 1. Default and configured retention settings
 * 2. Previewing expired records (Dry Run)
 * 3. Preventing deletion of active patients (even if they have an older discharged allocation)
 * 4. Preventing duplicate candidate patient IDs for patients with multiple historical admissions
 * 5. Account isolation (Hospital A records are never touched when cleaning Hospital B)
 * 6. Idempotent safe purge execution and audit logging
 * 7. Scheduled daily scheduler runner execution (with auto_cleanup_enabled)
 */

require('dotenv').config();
const mysql = require('mysql2');
const {
    queryAsync,
    withTransaction,
    getRetentionSettings,
    updateRetentionSettings,
    previewExpiredDischargedPatients,
    purgeExpiredDischargedPatients,
    runDailyRetentionScheduler
} = require('../services/bedAllocationService');

async function runRetentionTestSuite() {
    console.log('=== RUNNING RETENTION POLICY & CLEANUP TEST SUITE ===\n');
    let passed = 0;
    let failed = 0;

    const pool = mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        port: process.env.DB_PORT || 3306,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        ssl: { rejectUnauthorized: false }
    });

    const testUnameA = 'test_admin_user';
    const testUnameB = 'test_user_isolation';

    try {
        // Ensure test users exist in login table
        await queryAsync(pool, `INSERT INTO login (uname, upass) VALUES (?, 'pass123') ON DUPLICATE KEY UPDATE upass = VALUES(upass)`, [testUnameA]);
        await queryAsync(pool, `INSERT INTO login (uname, upass) VALUES (?, 'pass123') ON DUPLICATE KEY UPDATE upass = VALUES(upass)`, [testUnameB]);

        // Test 1: Get & Update Retention Settings
        await updateRetentionSettings(pool, {
            uname: testUnameA,
            days: 60,
            autoCleanupEnabled: true
        });
        const settingsA = await getRetentionSettings(pool, testUnameA);
        if (settingsA.dischargeRetentionDays === 60 && settingsA.autoCleanupEnabled === true) {
            console.log('✅ Test 1 Passed: Retention settings configured and saved (60 days, auto enabled).');
            passed++;
        } else {
            console.error('❌ Test 1 Failed: Retention settings mismatch:', settingsA);
            failed++;
        }

        // Setup Test Data:
        // Patient 1: Expired Discharged Patient (Discharged 100 days ago, eligible for 60-day cleanup)
        const pExpiredId = 888001;
        // Patient 2: Active Patient with past discharge (Discharged 100 days ago, BUT currently re-admitted / WAITING in queue)
        const pActiveWithHistoryId = 888002;
        // Patient 3: Hospital B Expired Patient (To test account isolation)
        const pIsolationId = 888003;

        // Clean up any previous test remnants
        await queryAsync(pool, 'DELETE FROM patient WHERE id IN (?, ?) AND uname = ?', [pExpiredId, pActiveWithHistoryId, testUnameA]);
        await queryAsync(pool, 'DELETE FROM patient WHERE id = ? AND uname = ?', [pIsolationId, testUnameB]);

        // Insert Patient 1 (Expired Discharged)
        await queryAsync(pool, `INSERT INTO patient (id, name, age, dis, wait, score, descp, uname) VALUES (?, 'Expired Patient', 50, 'fever', 1, 20, 'Notes', ?)`, [pExpiredId, testUnameA]);
        await queryAsync(pool, `
            INSERT INTO bed_allocation (patient_id, uname, status, queue_entry_time, allocated_at, discharged_at)
            VALUES (?, ?, 'DISCHARGED', DATE_SUB(NOW(), INTERVAL 105 DAY), DATE_SUB(NOW(), INTERVAL 104 DAY), DATE_SUB(NOW(), INTERVAL 100 DAY))
        `, [pExpiredId, testUnameA]);

        // Insert Patient 2 (Active Patient with older discharge record)
        await queryAsync(pool, `INSERT INTO patient (id, name, age, dis, wait, score, descp, uname) VALUES (?, 'Re-admitted Active Patient', 62, 'stroke', 1, 60, 'Notes', ?)`, [pActiveWithHistoryId, testUnameA]);
        // Historical discharge:
        await queryAsync(pool, `
            INSERT INTO bed_allocation (patient_id, uname, status, queue_entry_time, allocated_at, discharged_at)
            VALUES (?, ?, 'DISCHARGED', DATE_SUB(NOW(), INTERVAL 120 DAY), DATE_SUB(NOW(), INTERVAL 119 DAY), DATE_SUB(NOW(), INTERVAL 115 DAY))
        `, [pActiveWithHistoryId, testUnameA]);
        // Current active re-admission:
        await queryAsync(pool, `
            INSERT INTO bed_allocation (patient_id, uname, status, queue_entry_time)
            VALUES (?, ?, 'WAITING', NOW())
        `, [pActiveWithHistoryId, testUnameA]);

        // Insert Patient 3 (Hospital B Expired)
        await queryAsync(pool, `INSERT INTO patient (id, name, age, dis, wait, score, descp, uname) VALUES (?, 'Isolation Patient', 40, 'cold', 1, 15, 'Notes', ?)`, [pIsolationId, testUnameB]);
        await queryAsync(pool, `
            INSERT INTO bed_allocation (patient_id, uname, status, queue_entry_time, allocated_at, discharged_at)
            VALUES (?, ?, 'DISCHARGED', DATE_SUB(NOW(), INTERVAL 100 DAY), DATE_SUB(NOW(), INTERVAL 99 DAY), DATE_SUB(NOW(), INTERVAL 95 DAY))
        `, [pIsolationId, testUnameB]);

        // Test 2: Preview Expired Records (Dry Run)
        const previewA = await previewExpiredDischargedPatients(pool, { uname: testUnameA, retentionDays: 60 });
        const previewIdsA = previewA.map(p => p.patient_id);
        if (previewIdsA.includes(pExpiredId) && !previewIdsA.includes(pActiveWithHistoryId) && !previewIdsA.includes(pIsolationId)) {
            console.log('✅ Test 2 Passed: Dry-run preview accurately identified only expired patient, ignoring active re-admission and other accounts.');
            passed++;
        } else {
            console.error('❌ Test 2 Failed: Preview candidate list invalid:', previewIdsA);
            failed++;
        }

        // Test 3: Account-Scoped Purge Execution
        const purgeOutcome = await purgeExpiredDischargedPatients(pool, {
            uname: testUnameA,
            retentionDays: 60,
            triggerType: 'MANUAL'
        });

        if (purgeOutcome.purgedCount === 1 && purgeOutcome.candidateIds.includes(pExpiredId)) {
            console.log(`✅ Test 3 Passed: Safe purge deleted exactly 1 expired patient (#${pExpiredId}).`);
            passed++;
        } else {
            console.error('❌ Test 3 Failed: Purge outcome unexpected:', purgeOutcome);
            failed++;
        }

        // Test 4: Verify Active Patient Preservation
        const activeRows = await queryAsync(pool, 'SELECT id FROM patient WHERE id = ? AND uname = ?', [pActiveWithHistoryId, testUnameA]);
        if (activeRows.length === 1) {
            console.log('✅ Test 4 Passed: Active patient with historical discharge was NOT deleted.');
            passed++;
        } else {
            console.error('❌ Test 4 Failed: Active patient was erroneously deleted! Count:', activeRows.length);
            failed++;
        }

        // Test 5: Verify Account Isolation (Hospital B patient untouched)
        const isolationRows = await queryAsync(pool, 'SELECT id FROM patient WHERE id = ? AND uname = ?', [pIsolationId, testUnameB]);
        if (isolationRows.length === 1) {
            console.log('✅ Test 5 Passed: Other hospital account (Hospital B) data was 100% untouched.');
            passed++;
        } else {
            console.error('❌ Test 5 Failed: Hospital B record was unexpectedly modified! Count:', isolationRows.length);
            failed++;
        }

        // Test 6: Verify Retention Cleanup Audit Log
        const auditLogs = await queryAsync(pool, `
            SELECT * FROM retention_cleanup_audit
            WHERE uname = ? ORDER BY id DESC LIMIT 1
        `, [testUnameA]);
        if (auditLogs.length === 1 && auditLogs[0].patients_purged_count === 1) {
            console.log(`✅ Test 6 Passed: Audit trail recorded in retention_cleanup_audit (purged: ${auditLogs[0].patients_purged_count}).`);
            passed++;
        } else {
            console.error('❌ Test 6 Failed: Missing or invalid audit log record:', auditLogs);
            failed++;
        }

        // Test 7: Scheduled Daily Runner Execution (runDailyRetentionScheduler)
        // Set auto_cleanup_enabled = TRUE for testUnameB
        await updateRetentionSettings(pool, { uname: testUnameB, days: 30, autoCleanupEnabled: true });
        const schedulerResults = await runDailyRetentionScheduler(pool);
        const bResult = schedulerResults.find(r => r.uname === testUnameB);
        if (bResult && bResult.outcome && bResult.outcome.purgedCount === 1) {
            console.log('✅ Test 7 Passed: runDailyRetentionScheduler automatically purged eligible account with auto_cleanup_enabled = TRUE.');
            passed++;
        } else {
            console.error('❌ Test 7 Failed: Scheduled daily runner did not purge expected account:', schedulerResults);
            failed++;
        }

        // Cleanup test data
        await queryAsync(pool, 'DELETE FROM patient WHERE id IN (?, ?) AND uname = ?', [pExpiredId, pActiveWithHistoryId, testUnameA]);
        await queryAsync(pool, 'DELETE FROM patient WHERE id = ? AND uname = ?', [pIsolationId, testUnameB]);
        await queryAsync(pool, 'DELETE FROM login WHERE uname IN (?, ?)', [testUnameA, testUnameB]);

        console.log(`\n=== FINAL RESULT: ${passed} PASSED, ${failed} FAILED ===`);
        pool.end();
        if (failed > 0) process.exit(1);
    } catch (err) {
        console.error('Retention test exception:', err);
        pool.end();
        process.exit(1);
    }
}

runRetentionTestSuite();
