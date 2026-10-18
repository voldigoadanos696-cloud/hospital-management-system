/**
 * Patient Form Validation & Sanitization Module
 * Implements Phase 1 server-side validation rules.
 */

// Unicode regex matching international letters, diacritics/marks, spaces, periods, hyphens, and apostrophes
const NAME_REGEX = /^[\p{L}\p{M}\s.'-]{2,100}$/u;
const HAS_LETTER_REGEX = /\p{L}/u;

/**
 * Validates and sanitizes patient admission form inputs
 * @param {Object} data - req.body from patient admission form
 * @returns {Object} { isValid: boolean, errors: Object, sanitized: Object }
 */
function validatePatientAdmission(data) {
    const errors = {};
    const sanitized = {};

    // 1. Patient ID (pid)
    const rawPid = typeof data.pid === "string" ? data.pid.trim() : String(data.pid || "");
    if (!rawPid) {
        errors.pid = "Patient ID is required.";
    } else {
        const pidNum = Number(rawPid);
        if (!Number.isInteger(pidNum) || pidNum <= 0) {
            errors.pid = "Patient ID must be a positive whole number.";
        } else if (pidNum > 2147483647) {
            errors.pid = "Patient ID exceeds maximum permitted limit.";
        } else {
            sanitized.pid = pidNum;
        }
    }

    // 2. Patient Name (pname)
    const rawName = typeof data.pname === "string" ? data.pname.trim() : "";
    if (!rawName) {
        errors.pname = "Patient full name is required.";
    } else if (rawName.length < 2 || rawName.length > 100) {
        errors.pname = "Patient name must be between 2 and 100 characters.";
    } else {
        sanitized.pname = rawName;
    }

    // 3. Age (page)
    const rawAge = typeof data.page === "string" ? data.page.trim() : String(data.page ?? "");
    if (rawAge === "") {
        errors.page = "Patient age is required.";
    } else {
        const ageNum = Number(rawAge);
        if (!Number.isInteger(ageNum) || ageNum < 0 || ageNum > 130) {
            errors.page = "Age must be a valid whole number between 0 and 130 years.";
        } else {
            sanitized.page = ageNum;
        }
    }

    // 4. Wait Time (pwait)
    const rawWait = typeof data.pwait === "string" ? data.pwait.trim() : String(data.pwait ?? "");
    if (rawWait === "") {
        errors.pwait = "Wait time is required.";
    } else {
        const waitNum = Number(rawWait);
        if (!Number.isInteger(waitNum) || waitNum < 0) {
            errors.pwait = "Wait time must be a non-negative whole number (hours).";
        } else {
            sanitized.pwait = waitNum;
        }
    }

    // 5. Disease / Condition (pdis)
    const rawDis = typeof data.pdis === "string" ? data.pdis.trim() : "";
    if (!rawDis) {
        errors.pdis = "Disease or condition is required.";
    } else if (rawDis.length < 1 || rawDis.length > 100) {
        errors.pdis = "Disease or condition must be between 1 and 100 characters.";
    } else {
        sanitized.pdis = rawDis;
    }

    // 6. Clinical Description / Notes (descp)
    const rawDescp = typeof data.descp === "string" ? data.descp.trim() : "";
    if (!rawDescp) {
        errors.descp = "Clinical description is required.";
    } else if (rawDescp.length < 1 || rawDescp.length > 200) {
        errors.descp = "Clinical notes must be between 1 and 200 characters.";
    } else {
        sanitized.descp = rawDescp;
    }

    return {
        isValid: Object.keys(errors).length === 0,
        errors,
        sanitized
    };
}

/**
 * Validates patient discharge input
 * @param {Object} data - req.body from discharge form
 * @returns {Object} { isValid: boolean, errors: Object, sanitized: Object }
 */
function validatePatientDischarge(data) {
    const errors = {};
    const sanitized = {};

    const rawPid = typeof data.pid === "string" ? data.pid.trim() : String(data.pid || "");
    if (!rawPid) {
        errors.dischargePid = "Patient ID is required for discharge.";
    } else {
        const pidNum = Number(rawPid);
        if (!Number.isInteger(pidNum) || pidNum <= 0 || pidNum > 2147483647) {
            errors.dischargePid = "Please enter a valid positive Patient ID.";
        } else {
            sanitized.pid = pidNum;
        }
    }

    return {
        isValid: Object.keys(errors).length === 0,
        errors,
        sanitized
    };
}

module.exports = {
    validatePatientAdmission,
    validatePatientDischarge
};
