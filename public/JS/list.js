// Client-side Triage Score Estimator & UI Helpers
// Matches index.js getScore(age, dis, wait) exactly
document.addEventListener("DOMContentLoaded", () => {
    // Elements
    const addBtn = document.querySelector("#l-btn1");
    const remBtn = document.querySelector("#l-btn2");

    const idEl = document.querySelector("#l-id");
    const nameEl = document.querySelector("#l-name");
    const ageEl = document.querySelector("#l-age");
    const disEl = document.querySelector("#l-dis");
    const waitEl = document.querySelector("#l-wait");
    const ridEl = document.querySelector("#l-rem");

    const previewEl = document.querySelector("#estimated-score-val");

    // 1. Original button click handlers for UI field clearing
    if (addBtn) {
        addBtn.addEventListener("click", () => {
            if (idEl) idEl.innerText = "";
            if (nameEl) nameEl.innerText = "";
            if (ageEl) ageEl.innerText = "";
            if (disEl) disEl.innerText = "";
            if (waitEl) waitEl.innerText = "";
        });
    }

    if (remBtn) {
        remBtn.addEventListener("click", () => {
            if (ridEl) ridEl.innerText = "";
        });
    }

    // 2. Client-side score preview logic
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

    function updatePreview() {
        if (!previewEl) return;
        if (!ageEl?.value && !disEl?.value && !waitEl?.value) {
            previewEl.textContent = "--";
            return;
        }
        const score = getBackendMatchingScore(ageEl?.value, disEl?.value, waitEl?.value);
        previewEl.textContent = score + " pts";
    }

    if (ageEl) ageEl.addEventListener("input", updatePreview);
    if (disEl) disEl.addEventListener("input", updatePreview);
    if (waitEl) waitEl.addEventListener("input", updatePreview);
});