// Client-side Triage Score Estimator, Real-time Validation & UI Feedback
document.addEventListener("DOMContentLoaded", () => {
    // Admission Form Elements
    const addForm = document.querySelector("#add-patient-form");
    const addBtn = document.querySelector("#l-btn1");

    const idEl = document.querySelector("#l-id");
    const nameEl = document.querySelector("#l-name");
    const ageEl = document.querySelector("#l-age");
    const waitEl = document.querySelector("#l-wait");
    const disEl = document.querySelector("#l-dis");
    const descpEl = document.querySelector("#l-descp");
    const descpCountEl = document.querySelector("#descp-count");

    // Discharge Form Elements
    const dischargeForm = document.querySelector("#discharge-form");
    const dischargeBtn = document.querySelector("#l-btn2");
    const ridEl = document.querySelector("#l-rem");

    // Score Preview Element
    const previewEl = document.querySelector("#estimated-score-val");

    // Helper functions for field validation UI
    function setFieldError(inputEl, errorId, message) {
        if (!inputEl) return;
        inputEl.classList.add("is-invalid");
        inputEl.classList.remove("is-valid");
        inputEl.setAttribute("aria-invalid", "true");
        const errSpan = document.getElementById(errorId);
        if (errSpan) {
            errSpan.textContent = message;
        }
    }

    function clearFieldError(inputEl, errorId) {
        if (!inputEl) return;
        inputEl.classList.remove("is-invalid");
        inputEl.classList.add("is-valid");
        inputEl.removeAttribute("aria-invalid");
        const errSpan = document.getElementById(errorId);
        if (errSpan) {
            errSpan.textContent = "";
        }
    }

    // Individual field validators
    function validateIdField(showFeedback = true) {
        if (!idEl) return true;
        const val = idEl.value.trim();
        if (!val) {
            if (showFeedback) setFieldError(idEl, "error-pid", "Patient ID is required.");
            return false;
        }
        const num = Number(val);
        if (!Number.isInteger(num) || num <= 0) {
            if (showFeedback) setFieldError(idEl, "error-pid", "Patient ID must be a positive whole number.");
            return false;
        }
        if (num > 2147483647) {
            if (showFeedback) setFieldError(idEl, "error-pid", "Patient ID exceeds maximum limit.");
            return false;
        }
        if (showFeedback) clearFieldError(idEl, "error-pid");
        return true;
    }

    function validateNameField(showFeedback = true) {
        if (!nameEl) return true;
        const val = nameEl.value.trim();
        if (!val) {
            if (showFeedback) setFieldError(nameEl, "error-pname", "Patient full name is required.");
            return false;
        }
        if (val.length < 2 || val.length > 100) {
            if (showFeedback) setFieldError(nameEl, "error-pname", "Patient name must be between 2 and 100 characters.");
            return false;
        }
        if (showFeedback) clearFieldError(nameEl, "error-pname");
        return true;
    }

    function validateAgeField(showFeedback = true) {
        if (!ageEl) return true;
        const val = ageEl.value.trim();
        if (val === "") {
            if (showFeedback) setFieldError(ageEl, "error-page", "Patient age is required.");
            return false;
        }
        const num = Number(val);
        if (!Number.isInteger(num) || num < 0 || num > 130) {
            if (showFeedback) setFieldError(ageEl, "error-page", "Age must be a valid whole number between 0 and 130 years.");
            return false;
        }
        if (showFeedback) clearFieldError(ageEl, "error-page");
        return true;
    }

    function validateWaitField(showFeedback = true) {
        if (!waitEl) return true;
        const val = waitEl.value.trim();
        if (val === "") {
            if (showFeedback) setFieldError(waitEl, "error-pwait", "Wait time is required.");
            return false;
        }
        const num = Number(val);
        if (!Number.isInteger(num) || num < 0) {
            if (showFeedback) setFieldError(waitEl, "error-pwait", "Wait time must be a non-negative whole number (hours).");
            return false;
        }
        if (showFeedback) clearFieldError(waitEl, "error-pwait");
        return true;
    }

    function validateDisField(showFeedback = true) {
        if (!disEl) return true;
        const val = disEl.value.trim();
        if (!val) {
            if (showFeedback) setFieldError(disEl, "error-pdis", "Disease or condition is required.");
            return false;
        }
        if (val.length < 1 || val.length > 100) {
            if (showFeedback) setFieldError(disEl, "error-pdis", "Disease or condition must be between 1 and 100 characters.");
            return false;
        }
        if (showFeedback) clearFieldError(disEl, "error-pdis");
        return true;
    }

    function validateDescpField(showFeedback = true) {
        if (!descpEl) return true;
        const val = descpEl.value.trim();
        if (!val) {
            if (showFeedback) setFieldError(descpEl, "error-descp", "Clinical description is required.");
            return false;
        }
        if (val.length < 1 || val.length > 200) {
            if (showFeedback) setFieldError(descpEl, "error-descp", "Clinical notes must be between 1 and 200 characters.");
            return false;
        }
        if (showFeedback) clearFieldError(descpEl, "error-descp");
        return true;
    }

    function validateDischargePid(showFeedback = true) {
        if (!ridEl) return true;
        const val = ridEl.value.trim();
        if (!val) {
            if (showFeedback) setFieldError(ridEl, "error-dischargePid", "Patient ID is required for discharge.");
            return false;
        }
        const num = Number(val);
        if (!Number.isInteger(num) || num <= 0 || num > 2147483647) {
            if (showFeedback) setFieldError(ridEl, "error-dischargePid", "Please enter a valid positive Patient ID.");
            return false;
        }
        if (showFeedback) clearFieldError(ridEl, "error-dischargePid");
        return true;
    }

    // Attach interactive event listeners for blur (show error) and input (clear error if corrected)
    function attachFieldValidation(inputEl, validatorFn) {
        if (!inputEl) return;
        let hasInteracted = false;

        inputEl.addEventListener("blur", () => {
            hasInteracted = true;
            validatorFn(true);
        });

        inputEl.addEventListener("input", () => {
            if (hasInteracted || inputEl.classList.contains("is-invalid")) {
                validatorFn(true);
            }
        });
    }

    attachFieldValidation(idEl, validateIdField);
    attachFieldValidation(nameEl, validateNameField);
    attachFieldValidation(ageEl, validateAgeField);
    attachFieldValidation(waitEl, validateWaitField);
    attachFieldValidation(disEl, validateDisField);
    attachFieldValidation(descpEl, validateDescpField);
    attachFieldValidation(ridEl, validateDischargePid);

    // Character counter for clinical description
    function updateDescpCount() {
        if (!descpEl || !descpCountEl) return;
        const len = descpEl.value.length;
        descpCountEl.textContent = `${len} / 200`;
        if (len > 200) {
            descpCountEl.style.color = "var(--urgency-critical)";
        } else {
            descpCountEl.style.color = "var(--text-muted)";
        }
    }
    if (descpEl) {
        descpEl.addEventListener("input", updateDescpCount);
        updateDescpCount();
    }

    // Client-side score preview logic matching backend getScore
    function getBackendMatchingScore(age, dis, wait) {
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
            case "fever": score += 5; break;
            case "cold": score += 5; break;
            case "heart attack": score += 25; break;
            case "cancer": score += 20; break;
            case "accident": score += 25; break;
            case "diarrhea": score += 10; break;
            case "typhoid": score += 15; break;
            case "malaria": score += 15; break;
            case "dengue": score += 15; break;
            case "stroke": score += 25; break;
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

    const wardPreviewEl = document.querySelector("#estimated-ward-val");

    function getClinicalWard(age, dis) {
        const cond = (dis || "").toLowerCase().trim();
        const a = Number(age);
        if (Number.isInteger(a) && a > 0 && a <= 16) {
            return "Pediatric Care Ward (PED)";
        }
        if (cond === "heart attack" || cond === "stroke") {
            return "Intensive Care Unit (ICU)";
        }
        if (cond === "accident") {
            return "Emergency & Trauma Ward (EMG)";
        }
        if (cond === "malaria" || cond === "dengue" || cond === "typhoid") {
            return "Infectious Disease Ward (INF)";
        }
        if (cond === "fever" || cond === "cold" || cond === "diarrhea" || cond === "cancer") {
            return "General Medical Ward (GEN)";
        }
        if (cond) {
            return "Clinical Review Required ⚠️";
        }
        return "Enter condition & age";
    }

    function updatePreview() {
        if (!previewEl) return;
        if (!ageEl?.value && !disEl?.value && !waitEl?.value) {
            previewEl.textContent = "--";
            if (wardPreviewEl) wardPreviewEl.textContent = "Ward: Enter condition & age";
            return;
        }
        const score = getBackendMatchingScore(ageEl?.value, disEl?.value, waitEl?.value);
        previewEl.textContent = score + " pts";
        if (wardPreviewEl) {
            wardPreviewEl.textContent = "Ward: " + getClinicalWard(ageEl?.value, disEl?.value);
        }
    }

    if (ageEl) ageEl.addEventListener("input", updatePreview);
    if (disEl) disEl.addEventListener("input", updatePreview);
    if (waitEl) waitEl.addEventListener("input", updatePreview);
    updatePreview(); // Run once in case values are already populated

    // Admission Form Submit Listener
    let isSubmitting = false;
    if (addForm) {
        addForm.addEventListener("submit", (e) => {
            if (isSubmitting) {
                e.preventDefault();
                return;
            }

            const v1 = validateIdField(true);
            const v2 = validateNameField(true);
            const v3 = validateAgeField(true);
            const v4 = validateWaitField(true);
            const v5 = validateDisField(true);
            const v6 = validateDescpField(true);

            if (!v1 || !v2 || !v3 || !v4 || !v5 || !v6) {
                e.preventDefault();
                // Focus the first invalid field
                const firstInvalid = addForm.querySelector(".is-invalid");
                if (firstInvalid) firstInvalid.focus();
                return;
            }

            // Valid: Set submitting flag and defer button UI change so browser submits form
            isSubmitting = true;
            setTimeout(() => {
                if (addBtn) {
                    addBtn.disabled = true;
                    const span = addBtn.querySelector("span");
                    if (span) span.textContent = "Admitting Patient...";
                }
            }, 0);
        });
    }

    // Discharge Form Submit Listener
    let isDischarging = false;
    if (dischargeForm) {
        dischargeForm.addEventListener("submit", (e) => {
            if (isDischarging) {
                e.preventDefault();
                return;
            }

            const v = validateDischargePid(true);
            if (!v) {
                e.preventDefault();
                if (ridEl) ridEl.focus();
                return;
            }

            isDischarging = true;
            setTimeout(() => {
                if (dischargeBtn) {
                    dischargeBtn.disabled = true;
                    const span = dischargeBtn.querySelector("span");
                    if (span) span.textContent = "Discharging...";
                }
            }, 0);
        });
    }
});