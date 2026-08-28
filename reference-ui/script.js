/* ============================================================
   HOSPITAL BED ALLOCATION SYSTEM — SCRIPT.JS
   Plain vanilla JavaScript — no frameworks, no backend.
   Sections:
     1. Page loader
     2. Navbar (mobile menu, scroll shadow, smooth scroll, back-to-top)
     3. Dark / light theme toggle
     4. Toast / popup notifications
     5. Patient registration form + validation + table
     6. Priority queue simulation (core DSA logic)
     7. Queue visualization (waiting + allocated cards)
     8. Hospital statistics dashboard (animated counters)
     9. Misc: footer year
   ============================================================ */

document.addEventListener("DOMContentLoaded", () => {

  /* ============================================================
     1. PAGE LOADER
     Hide the loading screen shortly after the page has painted.
     ============================================================ */

  const pageLoader = document.getElementById("page-loader");
  window.addEventListener("load", () => {
    setTimeout(() => pageLoader.classList.add("hide"), 500);
  });

  /* ============================================================
     2. NAVBAR: mobile menu + smooth scroll + back to top
     ============================================================ */
  const hamburger = document.getElementById("hamburger");
  const navLinks = document.getElementById("nav-links");

  hamburger.addEventListener("click", () => {
    const isOpen = navLinks.classList.toggle("open");
    hamburger.classList.toggle("open", isOpen);
    hamburger.setAttribute("aria-expanded", String(isOpen));
  });

  // Close the mobile menu whenever a nav link is clicked (smooth scroll handled natively via CSS)
  document.querySelectorAll(".nav-link").forEach((link) => {
    link.addEventListener("click", () => {
      navLinks.classList.remove("open");
      hamburger.classList.remove("open");
      hamburger.setAttribute("aria-expanded", "false");
    });
  });

  // Back-to-top button: show after scrolling down, scroll smoothly to top on click
  const backToTop = document.getElementById("back-to-top");
  window.addEventListener("scroll", () => {
    backToTop.classList.toggle("visible", window.scrollY > 500);
  });
  backToTop.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  /* ============================================================
     3. DARK / LIGHT MODE TOGGLE
     Preference is remembered using localStorage so it persists
     between visits (this is just browser storage, no server).
     ============================================================ */
  const themeToggle = document.getElementById("theme-toggle");
  const themeIcon = document.getElementById("theme-icon");
  const root = document.documentElement;

  function applyTheme(theme) {
    if (theme === "dark") {
      root.setAttribute("data-theme", "dark");
      themeIcon.textContent = "☀️";
    } else {
      root.removeAttribute("data-theme");
      themeIcon.textContent = "🌙";
    }
  }

  const savedTheme = localStorage.getItem("hbas-theme") || "light";
  applyTheme(savedTheme);

  themeToggle.addEventListener("click", () => {
    const current = root.getAttribute("data-theme") === "dark" ? "dark" : "light";
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next);
    localStorage.setItem("hbas-theme", next);
  });

  /* ============================================================
     4. TOAST / POPUP NOTIFICATIONS
     A single reusable function used across the whole app.
     type: "success" | "error" | "info"
     ============================================================ */
  const toastEl = document.getElementById("toast");
  let toastTimer = null;

  function showToast(message, type = "success") {
    clearTimeout(toastTimer);
    toastEl.textContent = message;
    toastEl.className = "toast show"; // reset classes then re-add
    if (type === "error") toastEl.classList.add("toast-error");
    if (type === "success") toastEl.classList.add("toast-success");

    toastTimer = setTimeout(() => {
      toastEl.classList.remove("show");
    }, 3000);
  }

  /* ============================================================
     5. PATIENT REGISTRATION FORM
     Frontend-only: validates input, shows a popup, and appends
     the entered data to a table. Nothing is persisted or sent
     to any server.
     ============================================================ */
  const form = document.getElementById("registration-form");
  const tableWrap = document.getElementById("registration-table-wrap");
  const tableBody = document.getElementById("registration-table-body");
  let registrationCount = 0;

  // Map of field id -> validation rule. Each rule returns an error string, or "" if valid.
  const validators = {
    "patient-name": (v) => (v.trim().length < 2 ? "Enter a valid name" : ""),
    "patient-age": (v) => (v === "" || v < 0 || v > 120 ? "Enter a valid age (0–120)" : ""),
    "patient-gender": (v) => (v === "" ? "Select a gender" : ""),
    "patient-contact": (v) => (/^\d{10}$/.test(v) ? "" : "Enter a valid 10-digit number"),
    "patient-blood": (v) => (v === "" ? "Select a blood group" : ""),
    "patient-disease": (v) => (v.trim().length < 2 ? "Enter the condition" : ""),
    "patient-hospital": (v) => (v.trim().length < 2 ? "Enter the hospital name" : ""),
    "patient-ward": (v) => (v === "" ? "Select a ward" : ""),
    "patient-priority": (v) => (v === "" ? "Select an emergency level" : ""),
    "patient-arrival": (v) => (v === "" ? "Select arrival time" : ""),
  };

  // Runs all validators, shows/hides inline error messages, returns true if the whole form is valid.
  function validateForm() {
    let isValid = true;
    Object.keys(validators).forEach((id) => {
      const input = document.getElementById(id);
      const errorSpan = document.querySelector(`[data-error-for="${id}"]`);
      const message = validators[id](input.value);

      if (message) {
        isValid = false;
        errorSpan.textContent = message;
        input.closest(".form-field").classList.add("invalid");
      } else {
        errorSpan.textContent = "";
        input.closest(".form-field").classList.remove("invalid");
      }
    });
    return isValid;
  }

  // Human-readable label for a priority number, used across the whole app.
  const PRIORITY_LABELS = {
    1: "Critical",
    2: "Serious",
    3: "Moderate",
    4: "Normal",
    5: "Low",
  };

  function priorityBadge(priority) {
    return `<span class="priority-badge badge-p${priority}">P${priority} · ${PRIORITY_LABELS[priority]}</span>`;
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();

    if (!validateForm()) {
      showToast("Please fix the highlighted fields.", "error");
      return;
    }

    // Gather form data into a plain object (this shape is easy to POST to a real backend later)
    const data = {
      name: document.getElementById("patient-name").value.trim(),
      age: document.getElementById("patient-age").value,
      gender: document.getElementById("patient-gender").value,
      contact: document.getElementById("patient-contact").value.trim(),
      bloodGroup: document.getElementById("patient-blood").value,
      disease: document.getElementById("patient-disease").value.trim(),
      hospitalName: document.getElementById("patient-hospital").value.trim(),
      ward: document.getElementById("patient-ward").value,
      priority: Number(document.getElementById("patient-priority").value),
      arrivalTime: document.getElementById("patient-arrival").value,
    };

    registrationCount += 1;

    // Add a row to the registration table
    tableWrap.hidden = false;
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${registrationCount}</td>
      <td>${data.name}</td>
      <td>${data.age}</td>
      <td>${data.gender}</td>
      <td>${data.contact}</td>
      <td>${data.bloodGroup}</td>
      <td>${data.disease}</td>
      <td>${data.hospitalName}</td>
      <td>${data.ward}</td>
      <td class="priority-cell">${priorityBadge(data.priority)}</td>
      <td>${data.arrivalTime}</td>
    `;
    tableBody.appendChild(row);

    // Also push this patient into the live priority queue so it shows up in the simulation
    addPatientToQueue({
      name: data.name,
      priority: data.priority,
      ward: data.ward,
      arrivalTime: data.arrivalTime,
      arrivalOrder: patientQueue.length + allocatedPatients.length, // for stable FCFS tie-breaking
    });

    showToast(`${data.name} registered successfully!`, "success");
    form.reset();
  });

  /* ============================================================
     6. PRIORITY QUEUE SIMULATION (core data-structure logic)
     patientQueue    -> array of waiting patients
     allocatedPatients -> array of patients already given a bed
     ============================================================ */
  let patientQueue = [];
  let allocatedPatients = [];
  let arrivalCounter = 0; // increases every time a patient is added, used for FCFS tie-breaking

  const sampleNames = [
    "Rohan Mehta", "Priya Iyer", "Amit Kulkarni", "Sara Khan", "Devansh Rao",
    "Neha Joshi", "Vikram Singh", "Anjali Gupta", "Farhan Ali", "Meera Pillai",
  ];
  const sampleWards = ["ICU", "Emergency", "General", "Pediatric", "Surgery Recovery"];

  function addPatientToQueue(patient) {
    arrivalCounter += 1;
    patientQueue.push({
      id: arrivalCounter,
      name: patient.name,
      priority: patient.priority,
      ward: patient.ward,
      arrivalTime: patient.arrivalTime || currentTimeString(),
      arrivalOrder: patient.arrivalOrder ?? arrivalCounter, // used as the FCFS tie-breaker
    });
    renderWaitingCards();
    updateDashboard();
  }

  function currentTimeString() {
    const now = new Date();
    return now.toTimeString().slice(0, 5); // "HH:MM"
  }

  // "Add Sample Patient" button — generates a random demo patient for the queue.
  document.getElementById("add-sample-btn").addEventListener("click", () => {
    const name = sampleNames[Math.floor(Math.random() * sampleNames.length)];
    const priority = Math.floor(Math.random() * 5) + 1; // 1 to 5
    const ward = sampleWards[Math.floor(Math.random() * sampleWards.length)];

    addPatientToQueue({ name, priority, ward, arrivalTime: currentTimeString() });
    showToast(`${name} added to the waiting queue.`, "success");
  });

  // "Allocate Bed" button — this is the heart of the priority-queue algorithm.
  document.getElementById("allocate-btn").addEventListener("click", () => {
    if (patientQueue.length === 0) {
      showToast("No patients in the queue to allocate.", "error");
      return;
    }

    // STEP 1: Sort by priority (ascending — 1 is most urgent).
    // STEP 2: If priorities are equal, sort by arrival order (FCFS).
    const sortedQueue = [...patientQueue].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.arrivalOrder - b.arrivalOrder;
    });

    // Move every sorted patient into "allocated" and clear the waiting queue.
    allocatedPatients = [...allocatedPatients, ...sortedQueue];
    patientQueue = [];

    renderAllocationTable(sortedQueue);
    renderWaitingCards();
    renderAllocatedCards();
    updateDashboard();

    showToast(`${sortedQueue.length} bed(s) allocated in priority order.`, "success");
  });

  // "Reset Queue" button — clears both waiting and allocated lists (fresh simulation).
  document.getElementById("reset-queue-btn").addEventListener("click", () => {
    patientQueue = [];
    allocatedPatients = [];
    arrivalCounter = 0;

    document.getElementById("allocation-table-body").innerHTML =
      `<tr class="empty-row"><td colspan="6">No allocations yet — add patients to the queue below.</td></tr>`;

    renderWaitingCards();
    renderAllocatedCards();
    updateDashboard();

    showToast("Queue and allocations have been reset.", "success");
  });

  // Renders the "Bed Allocation Order" table with serial numbers.
  function renderAllocationTable(sortedList) {
    const body = document.getElementById("allocation-table-body");
    body.innerHTML = ""; // clear previous rows (we show the latest allocation run)

    sortedList.forEach((patient, index) => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${index + 1}</td>
        <td>${patient.name}</td>
        <td class="priority-cell">${priorityBadge(patient.priority)}</td>
        <td>${patient.arrivalTime}</td>
        <td>${patient.ward}</td>
        <td>Allocated ✅</td>
      `;
      body.appendChild(row);
    });
  }

  /* ============================================================
     7. QUEUE VISUALIZATION (color-coded patient cards)
     ============================================================ */
  function buildPatientCard(patient, isAllocated) {
    const card = document.createElement("div");
    card.className = `patient-card pc-p${patient.priority}${isAllocated ? " allocated" : ""}`;
    card.innerHTML = `
      <h4>${patient.name}</h4>
      <p>${priorityBadge(patient.priority)}</p>
      <p>Ward: ${patient.ward}</p>
      <p>Arrival: ${patient.arrivalTime}</p>
      ${isAllocated ? "<p>Status: Bed Allocated</p>" : "<p>Status: Waiting</p>"}
    `;
    return card;
  }

  function renderWaitingCards() {
    const container = document.getElementById("waiting-cards");
    const emptyState = document.getElementById("waiting-empty");
    container.innerHTML = "";

    if (patientQueue.length === 0) {
      container.appendChild(emptyState);
      return;
    }

    // Show waiting patients sorted the same way allocation would sort them,
    // so the visual order previews what will happen on the next allocation.
    const preview = [...patientQueue].sort((a, b) =>
      a.priority !== b.priority ? a.priority - b.priority : a.arrivalOrder - b.arrivalOrder
    );
    preview.forEach((patient) => container.appendChild(buildPatientCard(patient, false)));
  }

  function renderAllocatedCards() {
    const container = document.getElementById("allocated-cards");
    const emptyState = document.getElementById("allocated-empty");
    container.innerHTML = "";

    if (allocatedPatients.length === 0) {
      container.appendChild(emptyState);
      return;
    }
    allocatedPatients.forEach((patient) => container.appendChild(buildPatientCard(patient, true)));
  }

  /* ============================================================
     8. HOSPITAL STATISTICS DASHBOARD (animated counters)
     ============================================================ */
  const TOTAL_BEDS = 50;
  const BASE_OCCUPIED = 22; // beds already occupied before our simulation starts

  const statEls = {
    total: document.getElementById("stat-total"),
    occupied: document.getElementById("stat-occupied"),
    available: document.getElementById("stat-available"),
    waiting: document.getElementById("stat-waiting"),
    critical: document.getElementById("stat-critical"),
  };

  // Animates a counter element from its current displayed value to a new target value.
  function animateCounterTo(el, target) {
    const start = Number(el.textContent) || 0;
    if (start === target) return;

    const duration = 600; // ms
    const startTime = performance.now();

    function step(now) {
      const progress = Math.min((now - startTime) / duration, 1);
      const value = Math.round(start + (target - start) * progress);
      el.textContent = value;
      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // Recalculates all dashboard numbers from the current queue state and animates them in.
  function updateDashboard() {
    const occupied = BASE_OCCUPIED + allocatedPatients.length;
    const available = TOTAL_BEDS - occupied;
    const waiting = patientQueue.length;
    const critical = patientQueue.filter((p) => p.priority === 1).length;

    animateCounterTo(statEls.total, TOTAL_BEDS);
    animateCounterTo(statEls.occupied, occupied);
    animateCounterTo(statEls.available, available);
    animateCounterTo(statEls.waiting, waiting);
    animateCounterTo(statEls.critical, critical);
  }

  // Run the counters once when the dashboard section first scrolls into view.
  const dashboardSection = document.getElementById("dashboard");
  const dashboardObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          updateDashboard();
          dashboardObserver.disconnect(); // only trigger the initial count-up once
        }
      });
    },
    { threshold: 0.3 }
  );
  dashboardObserver.observe(dashboardSection);

  /* ============================================================
     9. MISC
     ============================================================ */
  document.getElementById("footer-year").textContent = new Date().getFullYear();

  // Initial render in case the queue already has data (e.g. after a registration before scroll)
  renderWaitingCards();
  renderAllocatedCards();
});
