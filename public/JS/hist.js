// Priority Queue Table Client-Side Search Filter
document.addEventListener("DOMContentLoaded", () => {
    const searchInput = document.getElementById("queue-search");
    const table = document.getElementById("priority-queue-table");

    if (searchInput && table) {
        searchInput.addEventListener("input", (e) => {
            const query = e.target.value.toLowerCase().trim();
            const rows = table.querySelectorAll("tbody tr");

            rows.forEach((row) => {
                const text = row.textContent.toLowerCase();
                row.style.display = text.includes(query) ? "" : "none";
            });
        });
    }
});
