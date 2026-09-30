/* ════════════════════════════════════════════════════════════
   accessGuard.js — shared Add / Edit / Delete permission guard

   Wraps window.Auth.canDo() (from auth.js) with UI feedback so every
   module (userAdmin.html, finQue.html, penReq.html, inOut.html,
   allEmp.html, allBike.html, allSim.html, dedPivot.html, …) can gate
   its Save/Add/Edit/Delete buttons with one call instead of each page
   re-implementing the same check + toast/alert logic.

   Fails closed everywhere: if Auth isn't loaded, or permissions
   haven't been fetched yet, every check returns false.

   Load order matters — include this AFTER auth.js:
     <script src="auth.js"></script>
     <script src="accessGuard.js"></script>

   ── Usage ──────────────────────────────────────────────────────

   // 1) Silent check, no UI — e.g. deciding whether to render a button:
   if (AccessGuard.canAdd('ap2_employee')) { renderAddButton(); }

   // 2) Check + auto-toast on denial — call right before an action fires:
   function onSaveClick() {
     if (!AccessGuard.require('ap2_employee', 'add')) return; // toast shown, stop here
     doTheActualSave();
   }

   // 3) Auto disable/enable a button element based on permission:
   AccessGuard.gate(document.getElementById('save-btn'), 'ap2_employee', 'add');
════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  function _hasAuth() {
    return !!(global.Auth && typeof global.Auth.canDo === 'function');
  }

  /**
   * can(dataset, action) — silent boolean check, no UI side effects.
   * dataset: e.g. 'ap2_employee' | 'ap2_bike' | 'ap2_loginData'
   * action : 'view' | 'add' | 'editDelete'
   */
  function can(dataset, action) {
    if (!_hasAuth()) {
      console.warn('[AccessGuard] Auth.canDo not available — failing closed');
      return false;
    }
    return global.Auth.canDo(dataset, action) === true;
  }

  const canView = (dataset) => can(dataset, 'view');
  const canAdd  = (dataset) => can(dataset, 'add');
  const canEdit = (dataset) => can(dataset, 'editDelete'); // covers edit AND delete — same bit

  /**
   * require(dataset, action, label?) — same check as can(), but shows a
   * toast/alert on denial. Use this as the first line inside a
   * Save/Add/Edit/Delete click handler; if it returns false, stop.
   */
  function require(dataset, action, label) {
    const ok = can(dataset, action);
    if (!ok) _deny(dataset, action, label);
    return ok;
  }

  function _deny(dataset, action, label) {
    const verbs = { add: 'add', editDelete: 'edit or delete', view: 'view' };
    const verb  = verbs[action] || action;
    const msg   = `⛔ Not authorized to ${verb}: ${label || dataset}`;

    // Reuses a page's existing toast function if it has one (e.g. showToast()
    // in userAdmin.html); otherwise falls back to alert() so it's never silent.
    if (typeof global.showToast === 'function') {
      global.showToast(msg, 'error');
    } else if (typeof global.toast === 'function') {
      global.toast(msg, 'error');
    } else {
      console.warn('[AccessGuard]', msg);
      alert(msg);
    }
  }

  /**
   * gate(el, dataset, action) — disables an element (button, etc.) if the
   * user lacks the given permission, and marks it with a title/tooltip
   * explaining why. Call once after rendering the element. Returns the
   * boolean result so you can branch on it too if needed.
   */
  function gate(el, dataset, action) {
    if (!el) return false;
    const ok = can(dataset, action);
    el.disabled = !ok;
    el.classList.toggle('ag-disabled', !ok);
    el.title = ok ? '' : `You don't have ${action} access for ${dataset}`;
    return ok;
  }

  /**
   * gateAll(selectorOrList, dataset, action) — convenience for gating a
   * whole group of elements at once, e.g. every '.edit-btn' in a table
   * after it renders.
   */
  function gateAll(selectorOrList, dataset, action) {
    const els = typeof selectorOrList === 'string'
      ? document.querySelectorAll(selectorOrList)
      : selectorOrList;
    els.forEach(el => gate(el, dataset, action));
  }

  global.AccessGuard = { can, canView, canAdd, canEdit, require, gate, gateAll };

})(window);
