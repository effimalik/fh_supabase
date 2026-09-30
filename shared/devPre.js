// 1. Disable Right-Click Context Menu
document.addEventListener('contextmenu', function(e) {
  e.preventDefault();
});

// 2. Disable F12 and standard DevTool keyboard combinations
document.addEventListener('keydown', function(e) {
  // Disable F12
  if (e.key === 'F12') {
    e.preventDefault();
    return false;
  }

  // Disable Ctrl+Shift+I (Inspect Element)
  if (e.ctrlKey && e.shiftKey && e.key === 'I') {
    e.preventDefault();
    return false;
  }

  // Disable Ctrl+Shift+J (Open Console)
  if (e.ctrlKey && e.shiftKey && e.key === 'J') {
    e.preventDefault();
    return false;
  }

  // Disable Ctrl+U (View Page Source)
  if (e.ctrlKey && e.key === 'U') {
    e.preventDefault();
    return false;
  }
}); // ← FIX: keydown listener correctly closed here

// ── DataLayer helper functions — defined in global scope (outside the event listener) ──

async function loadEmployees() {
  const employees = await AdminPro.getEmployees();
  // employees is the cached or freshly fetched array
  renderTable(employees);
}

async function loadBikes() {
  const bikes = await AdminPro.getBikes();
  renderBikeList(bikes);
}

// Force refresh (e.g. after user saves a record):
async function refreshAfterSave() {
  await AdminPro.forceRefresh('employee'); // clears cache + re-fetches
  loadEmployees();                          // reads fresh data from refilled cache
}
