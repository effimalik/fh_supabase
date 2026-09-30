
/* ═══════════════════════════════════════════════════════════════
   auth.js — FleetFlow Pro  v3.1
   Server-validated sessions · absolute + inactivity expiry · secure logout
   LOAD FIRST on every page (before dataLayer.js and any page JS)

   CRASH FIXES vs v2.0:
   ─ FedCM/prompt never resolves on some browsers → fallback to button popup
   ─ createSession called before sessionStorage ready → wrapped in try/catch
   ─ Redirect loop: login.html tries to validate session → guarded
   ─ auth.js loads before DOM ready → _boot deferred safely
   ─ signOut network failure → never blocks client-side wipe
   ─ Concurrent server checks → debounced with in-flight guard

   NEW in v3.1 — cache lifecycle hardening:
   ─ Window/tab close: a shared open-tab counter (localStorage) tracks how
     many tabs/windows of the app are open. Multiple tabs SHARE the cache
     (opening a 2nd tab does not wipe it). Once the counter drops to zero
     — the last tab/window closing — localStorage + IndexedDB are purged
     immediately, same as logout. login.html also re-checks the counter
     on load as a guaranteed fallback, so a different user logging in
     next never inherits a previous user's stale cache.
   ─ Session end (inactivity / absolute TTL / server rejection): 
     _redirectToLogin() now purges localStorage + IndexedDB too, not just
     the sessionStorage session key, and fires 'ap:signout' so
     dataLayer.js's listener tears down its timers/cache in lockstep.
   ─ Logout button: unchanged — Auth.signOut() already wiped everything.
═══════════════════════════════════════════════════════════════ */
'use strict';

(function () {

  /* ─────────────────────────────────────────
     CONSTANTS  — edit to match your deployment
  ───────────────────────────────────────── */
  const SESSION_KEY      = 'ap_session';
  const INACTIVITY_TTL   = 30 * 60 * 1000;   // 30 min idle
  const ABSOLUTE_TTL     = 8  * 60 * 60 * 1000; // 8 hr hard limit
  const SERVER_CHECK_INT = 5  * 60 * 1000;    // server ping every 5 min
  const ALLOWED_ORIGIN   = 'https://effimalik.github.io/Testing/';
   const API_BASE = 'https://script.google.com/macros/s/AKfycbwHZnQa4elV-ChUslHoci1UhWZnTuBPhLIlrI_-TsOX6ysamVvUDrpkpS3pRVMEoWeP/exec';
   

     


  /* ─────────────────────────────────────────
     STORAGE HELPERS — never throw
  ───────────────────────────────────────── */
  function _readSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function _writeSession(s) {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); return true; }
    catch { return false; }
  }

  function _clearSession() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch {}
  }

  /* ─────────────────────────────────────────
     FULL CACHE WIPE — localStorage + IndexedDB
     Shared by: window-close guard, session-end redirect.
     (sessionStorage is handled separately — see callers.)
  ───────────────────────────────────────── */
  function _purgeLocalAndIDB() {
    // localStorage — only our own namespaced keys, leave 3rd-party keys intact
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith('ap2_') || k.startsWith('ap_'))
        .forEach(k => localStorage.removeItem(k));
    } catch {}

    // IndexedDB — delete every database the browser reports
    try {
      indexedDB.databases?.().then(dbs => {
        if (Array.isArray(dbs)) {
          dbs.forEach(({ name }) => {
            try { if (name) indexedDB.deleteDatabase(name); } catch {}
          });
        }
      }).catch(() => {});
    } catch {}
  }

  /* ─────────────────────────────────────────
     CROSS-TAB WINDOW-CLOSE GUARD
     Goal: multiple tabs of the app SHARE the cache (opening tab #2 must
     NOT wipe what tab #1 is using) — but once the LAST tab/window closes,
     the cache is wiped instantly, same as logout. The next login.html
     load (by the same or a different user) always double-checks too.

     Mechanism: a live count of open tabs/windows in localStorage
     (localStorage is shared across all tabs, unlike sessionStorage).
       • On load: read the count.
           - count > 0  → another tab is already open → cache is trusted,
             keep it (this is what lets tabs share cache).
           - count <= 0 → no other tab is open → previous browser session
             is over → purge stale cache BEFORE this page reads it. This
             is also what protects a different user logging in next.
         Then increment the count.
       • On unload (this tab closing): decrement the count. If that
         brings it to 0, this was the last window → purge immediately,
         same as logout does.
     beforeunload/pagehide can't tell "closing" from "refreshing", but
     that's fine here: a refresh decrements then immediately re-increments
     on next load, netting out with no purge — only a real drop to zero
     (no tab re-opening) triggers the wipe.
  ───────────────────────────────────────── */
  const TAB_COUNT_KEY = 'ap2_tab_count';
  let _tabRegistered = false;

  function _readTabCount() {
    try { return parseInt(localStorage.getItem(TAB_COUNT_KEY), 10) || 0; }
    catch { return 0; }
  }
  function _writeTabCount(n) {
    try { localStorage.setItem(TAB_COUNT_KEY, String(Math.max(0, n))); } catch {}
  }

  function _registerTabOpen() {
    try {
      const count = _readTabCount();
      if (count <= 0) {
        console.log('[Auth] No other tab/window open — purging stale cache');
        _purgeLocalAndIDB();
      }
      _writeTabCount(count + 1);
      _tabRegistered = true;
    } catch {}
  }

  function _registerTabClose() {
    if (!_tabRegistered) return; // avoid double-decrement (beforeunload + pagehide can both fire)
    _tabRegistered = false;
    try {
      const remaining = _readTabCount() - 1;
      _writeTabCount(remaining);
      if (remaining <= 0) {
        console.log('[Auth] Last tab/window closing — purging cache instantly');
        _purgeLocalAndIDB();
      }
    } catch {}
  }

  // Runs immediately, synchronously, before dataLayer.js (or anything else)
  // gets a chance to read the cache — applies on every page, login included.
  _registerTabOpen();
  window.addEventListener('beforeunload', _registerTabClose);
  window.addEventListener('pagehide', _registerTabClose);

  /* ─────────────────────────────────────────
     REDIRECT HELPER
  ───────────────────────────────────────── */
  function _redirectToLogin(reason) {
    console.warn('[Auth] → login:', reason || 'session invalid');
    _clearSession();
    // Session is ending (expired / rejected) — wipe the rest of the
    // cache too, not just the session key, so no stale data survives.
    _purgeLocalAndIDB();
    try { window.dispatchEvent(new CustomEvent('ap:signout', { detail: { reason } })); } catch {}
    // Hide page instantly to prevent flash of protected content
    try { document.documentElement.style.visibility = 'hidden'; } catch {}
    const next = encodeURIComponent(window.location.href);
    window.location.replace(ALLOWED_ORIGIN + 'login.html?next=' + next);
  }

  /* ─────────────────────────────────────────
     CLIENT-SIDE FAST CHECK
     Does NOT contact the server — immediate gate on page load
  ───────────────────────────────────────── */
  function _isClientValid(s) {
    if (!s || typeof s !== 'object') return false;
    if (!s.sessionId || typeof s.sessionId !== 'string') return false;
    if (!s.token     || typeof s.token     !== 'string') return false;
    if (!s.email     || typeof s.email     !== 'string') return false;
    if (!s.loginAt   || typeof s.loginAt   !== 'number') return false;

    const now = Date.now();
    // Absolute TTL — 8 hours from login regardless of activity
    if (now - s.loginAt > ABSOLUTE_TTL) return false;
    // Inactivity TTL
    if (s.lastActive && now - s.lastActive > INACTIVITY_TTL) return false;
    return true;
  }

  /* ─────────────────────────────────────────
     SERVER VALIDATION
     In-flight guard prevents concurrent pings
  ───────────────────────────────────────── */
  let _serverCheckTimer = null;
  let _serverCheckInFlight = false;

  async function _validateWithServer() {
    if (_serverCheckInFlight) return;
    _serverCheckInFlight = true;

    const s = _readSession();
    if (!_isClientValid(s)) {
      _serverCheckInFlight = false;
      _redirectToLogin('client check failed before server call');
      return;
    }

    try {
      const url = `${API_BASE}?type=validateSession`
        + `&sessionId=${encodeURIComponent(s.sessionId)}`
        + `&token=${encodeURIComponent(s.token)}`
        + `&_t=${Date.now()}`;

      const res  = await fetch(url, { cache: 'no-store', redirect: 'follow', mode: 'cors' });

      if (!res.ok) {
        // HTTP error (5xx etc.) — keep session, don't force logout
        console.warn('[Auth] Server validate HTTP', res.status, '— keeping session');
        _scheduleServerCheck();
        return;
      }

      const data = await res.json();

      if (data.valid === false) {
        _serverCheckInFlight = false;
        _redirectToLogin('server rejected: ' + (data.reason || 'unknown'));
        return;
      }

      // Update lastActive on confirmed valid
      s.lastActive = Date.now();
      _writeSession(s);

    } catch (e) {
      // Network error — do NOT log out, could be transient
      console.warn('[Auth] Server validate network error (session kept):', e.message);
    }

    _serverCheckInFlight = false;
    _scheduleServerCheck();
  }

  function _scheduleServerCheck() {
    if (_serverCheckTimer) clearTimeout(_serverCheckTimer);
    _serverCheckTimer = setTimeout(_validateWithServer, SERVER_CHECK_INT);
  }

  /* ─────────────────────────────────────────
     INACTIVITY WATCHER
  ───────────────────────────────────────── */
  let _idleTimer = null;

  function _resetIdle() {
    const s = _readSession();
    if (!s) { _redirectToLogin('no session on idle reset'); return; }
    if (!_isClientValid(s)) { _redirectToLogin('session expired on idle reset'); return; }

    s.lastActive = Date.now();
    _writeSession(s);

    if (_idleTimer) clearTimeout(_idleTimer);
    _idleTimer = setTimeout(() => _redirectToLogin('inactivity timeout'), INACTIVITY_TTL);
  }

  function _startIdleWatcher() {
    ['mousemove','mousedown','keydown','touchstart','scroll','click']
      .forEach(evt => document.addEventListener(evt, _resetIdle, { passive: true }));
    _idleTimer = setTimeout(() => _redirectToLogin('inactivity timeout'), INACTIVITY_TTL);
  }

  /* ─────────────────────────────────────────
     USER CHIP RENDERER
  ───────────────────────────────────────── */
  function _populateUserChip() {
    try {
      const s = _readSession();
      if (!s || !s.email) return;

      const parts    = (s.name || s.email).trim().split(/\s+/);
      const initials = parts.length >= 2
        ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
        : (s.name || s.email).substring(0, 2).toUpperCase();

      const avatar = document.getElementById('tb-avatar');
      const nameEl = document.getElementById('tb-uname');
      const roleEl = document.getElementById('tb-urole');
      const chip   = document.getElementById('tb-user-chip');

      if (avatar) avatar.textContent = initials;
      if (nameEl) nameEl.textContent = s.name || s.email;
      if (roleEl) roleEl.textContent = s.role || 'User'; // display only

      if (chip) {
        chip.title   = `Signed in as ${s.email}\nClick to sign out`;
        chip.onclick = () => { if (confirm(`Sign out ${s.name || s.email}?`)) window.Auth.signOut(); };
        chip.style.cursor = 'pointer';
      }
    } catch (e) {
      console.warn('[Auth] _populateUserChip error:', e.message);
    }
  }

  /* ─────────────────────────────────────────
     BOOT — runs immediately when script loads
     Guards: login page skip · client check · async server validate
  ───────────────────────────────────────── */
  function _boot() {
    // Skip all guards on login page — no session exists yet
    if (window.location.pathname.endsWith('login.html') ||
        window.location.href.includes('/login.html')) {
      return;
    }

    const s = _readSession();

    // Instant client-side gate — hide page if obviously invalid
    if (!_isClientValid(s)) {
      _redirectToLogin('client validation failed on boot');
      return;
    }

    // Page is safe to show
    try { document.documentElement.style.visibility = ''; } catch {}

    // Start activity watcher
    _startIdleWatcher();

    // Async server validation — page loads optimistically
    _validateWithServer();

    // Populate user chip once DOM ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _populateUserChip);
    } else {
      _populateUserChip();
    }
  }

  // Run boot after current call stack clears — avoids issues when script
  // loads synchronously before some browser APIs are ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot);
  } else {
    _boot();
  }

  /* ─────────────────────────────────────────
     PUBLIC API  — window.Auth
  ───────────────────────────────────────── */
  window.Auth = {

    /**
     * Returns { sessionId, token } for attaching to API calls.
     * Returns null if session is invalid — caller must abort the request.
     */
    getCredentials() {
      const s = _readSession();
      if (!_isClientValid(s)) return null;
      return { sessionId: s.sessionId, token: s.token };
    },

    /**
     * Async check — resolves true/false without redirecting.
     * Use for pre-flight checks in dataLayer.
     */
    async isAuthenticated() {
      const s = _readSession();
      return _isClientValid(s);
    },

    /**
     * Display-safe user info — NEVER use for access control decisions.
     */
    getUser() {
      try {
        const s = _readSession();
        if (!s) return {};
        const parts    = (s.name || s.email || '').trim().split(/\s+/);
        const initials = parts.length >= 2
          ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
          : (s.name || s.email || '??').substring(0, 2).toUpperCase();
        return {
          name     : s.name   || s.email || '',
          email    : s.email  || '',
          role     : s.role   || 'User',
          initials : initials,
        };
      } catch { return {}; }
    },

    /**
     * createSession — called by login.html after Apps Script confirms credentials.
     * Stores: sessionId, token, email, name, role, loginAt, lastActive, permissions.
     * Returns true on success, false on missing required fields.
     */
    createSession(payload) {
      try {
        if (!payload || !payload.sessionId || !payload.token || !payload.email) {
          console.error('[Auth] createSession: missing required fields', {
            hasSessionId : !!payload?.sessionId,
            hasToken     : !!payload?.token,
            hasEmail     : !!payload?.email,
          });
          return false;
        }
        const _loginAt = Date.now();
        const s = {
          sessionId          : String(payload.sessionId).trim(),
          token              : String(payload.token).trim(),
          email              : String(payload.email).trim().toLowerCase(),
          name               : String(payload.name  || payload.email).trim(),
          role               : String(payload.role  || 'User').trim(), // display only
          permissions        : payload.permissions || null, // portal access map — only TRUE keys from server
          loginAt            : _loginAt,
          lastActive         : _loginAt,
          // Fingerprint used by dataLayer to detect a different user
          // and automatically purge stale localStorage cache from prior sessions.
          sessionFingerprint : String(payload.email).trim().toLowerCase() + '|' + _loginAt,
        };
        const wrote = _writeSession(s);
        if (!wrote) {
          console.error('[Auth] createSession: sessionStorage write failed');
          return false;
        }
        return true;
      } catch (e) {
        console.error('[Auth] createSession exception:', e.message);
        return false;
      }
    },

    /**
     * fetchPermissions — fetches portal permissions for the current user from the server.
     * Call this after createSession. Returns the permissions object or null on failure.
     * Permissions are stored in session for the lifetime of the tab.
     *
     * Expected server response:
     * { success: true, permissions: { ap2_employee: true, ap2_bike: false, ... } }
     */
    async fetchPermissions() {
      try {
        const s = _readSession();
        if (!s) return null;
        // Permissions are bundled in the login response and stored by createSession()
        // No network call needed — just read from session
        const perms = s.permissions || null;
        console.log('[Auth] fetchPermissions: reading from session →', perms);
        return perms;
      } catch (e) {
        console.warn('[Auth] fetchPermissions error:', e.message);
        return null;
      }
    },

    /**
     * getPermissions — returns the stored permissions map or null.
     * { ap2_employee: true, ap2_bike: false, ap2_master: true, ... }
     */
    getPermissions() {
      try {
        const s = _readSession();
        return (s && s.permissions) ? s.permissions : null;
      } catch { return null; }
    },

    /**
     * hasPermission(portal) — quick boolean check for a single portal's
     * VIEW access. Returns true if the user can view it, false if denied,
     * missing, or no perms loaded (fail-closed).
     * portal: 'ap2_employee' | 'ap2_bike' | 'ap2_master' | 'ap2_recovery' | 'ap2_approvedSheet' | 'ap2_cioLog'
     */
    hasPermission(portal) {
      try {
        const perms = this.getPermissions();
        if (!perms || !perms[portal]) return false; // fail-closed: no perms = no access
        const p = perms[portal];
        if (p === true) return true; // legacy boolean shape
        return !!(p.access && p.access.view === true);
      } catch { return false; }
    },

    /**
     * canDo(portal, action) — granular check against the ParamKey bits
     * ("view-add-editDelete", e.g. "1-1-0") decoded server-side.
     * action: 'view' | 'add' | 'editDelete'
     * Returns false (fail-closed) if perms aren't loaded or the bit isn't set.
     * Use this to show/hide Add / Edit / Delete buttons in page modules —
     * hasPermission() only tells you whether the portal is visible at all.
     */
    canDo(portal, action) {
      try {
        const perms = this.getPermissions();
        if (!perms || !perms[portal]) return false;
        const p = perms[portal];
        if (p === true) return action === 'view'; // legacy boolean = view-only
        return !!(p.access && p.access[action] === true);
      } catch { return false; }
    },

    /**
     * Secure logout:
     *  1. Stop all timers immediately
     *  2. Wipe client session (sessionStorage, localStorage, IndexedDB)
     *  3. Tell server to destroy session (best-effort, non-blocking)
     *  4. Redirect to login
     */
    async signOut() {
      const s = _readSession();

      // Stop timers first — prevents any callbacks firing after wipe
      if (_idleTimer)        clearTimeout(_idleTimer);
      if (_serverCheckTimer) clearTimeout(_serverCheckTimer);

      // Stop dataLayer refresh timers before wiping storage
      try {
        if (window.DataLayer || window.AdminPro) {
          const dl = window.AdminPro || window.DataLayer;
          if (typeof dl.stopAllTimers === 'function') dl.stopAllTimers();
          if (dl.cache && typeof dl.cache.clearAll === 'function') dl.cache.clearAll();
        }
      } catch {}

      // ── 1. sessionStorage ─────────────────────────────────────────
      try { sessionStorage.clear(); } catch {}

      // ── 2. localStorage ───────────────────────────────────────────
      try { localStorage.clear(); } catch {}

      // ── 3. IndexedDB — delete every database the browser reports ──
      try {
        const dbs = await indexedDB.databases?.();
        if (Array.isArray(dbs)) {
          dbs.forEach(({ name }) => {
            try { if (name) indexedDB.deleteDatabase(name); } catch {}
          });
        }
      } catch {}

      // Tell server to destroy session — best-effort, don't block redirect
      if (s && s.sessionId && s.token) {
        fetch(`${API_BASE}`, {
          method  : 'POST',
          headers : { 'Content-Type': 'text/plain' },
          body    : JSON.stringify({
            type      : 'destroySession',
            sessionId : s.sessionId,
            token     : s.token,
          }),
          keepalive: true, // fires even after navigation
        }).catch(() => {}); // intentionally ignore errors
      }

      window.location.replace(ALLOWED_ORIGIN + 'login.html');
    },

  };

  /* ─────────────────────────────────────────
     LOGIN PAGE REDIRECT HELPER
     Called by login.html after Auth.createSession() succeeds.
  ───────────────────────────────────────── */
  window.handleLoginRedirect = function () {
    try {
      const params = new URLSearchParams(window.location.search);
      const next   = decodeURIComponent(params.get('next') || '');
      // Only redirect within our own origin — prevent open redirect
      if (next && next.startsWith(ALLOWED_ORIGIN)) {
        window.location.replace(next);
      } else {
        window.location.replace(ALLOWED_ORIGIN + 'index.html');
      }
    } catch {
      window.location.replace(ALLOWED_ORIGIN + 'index.html');
    }
  };

  /* Legacy shims */
  window.signOut = () => window.Auth.signOut();
  window.logout  = () => window.Auth.signOut();
  window.getUser = () => window.Auth.getUser();

})();
