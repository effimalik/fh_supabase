/* ═══════════════════════════════════════════════════════════════════════
   dataLayer.js — FleetFlow Pro  v2.2
   Cache-first data layer · IndexedDB persistence · session-auth
   Permission-driven: only permitted datasets are fetched or cached.

   ARCHITECTURE:
   ─ window.AdminPro  → public API (warmIfEmpty, get*, forceRefresh, etc.)
   ─ window.DataLayer → alias for window.AdminPro (backwards compat)
   ─ Cache layer      → IndexedDB with prefix 'ap2_' + datasetKey
   ─ Auth gate        → every fetch checks window.Auth.getCredentials()
   ─ Permission gate  → DATASETS built entirely from Auth.getPermissions()
                        at runtime — NO hardcoded metadata in this file.

   PERMISSION SHAPE (from server login response):
   {
     "ap2_employee": { label:"Employees", apiKey:"employee", paramKey:"type", ttlMs:60000  },
     "ap2_bike":     { label:"Bikes",     apiKey:"bike",     paramKey:"type", ttlMs:900000 }
   }
   Each key becomes a dataset key. All config (label, API param, TTL) comes
   from the server — change them in the Permissions sheet, not in this file.

   FLOW:
     login.html → Auth.createSession({ permissions }) ✓
               → AdminPro.init()       ← builds DATASETS from permissions
               → AdminPro.warmIfEmpty() ← parallel fetch permitted datasets only
               → redirect to index

     anyPage.js → AdminPro.get('ap2_employee') / AdminPro.get('ap2_bike') / …
               → cache HIT  → returns instantly, zero network
               → cache MISS → fetch → store → return

   LOAD ORDER:
     1. auth.js      (session guard + permissions)
     2. dataLayer.js (this file)
     3. page JS
═══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {

  /* ─────────────────────────────────────────
     CONFIG — must match auth.js API_BASE
  ───────────────────────────────────────── */
  const API_BASE = 'https://script.google.com/macros/s/AKfycbwHZnQa4elV-ChUslHoci1UhWZnTuBPhLIlrI_-TsOX6ysamVvUDrpkpS3pRVMEoWeP/exec';
   // const API_BASE = 'https://script.google.com/macros/s/AKfycbwjG9K0SJSv5kcUmbQBNnejmyqSg4zdVhX7VudnCyrL2Xa69yhrpjkcNaRY63xe7FZN/exec';

  const CACHE_PREFIX = 'ap2_';

  // Dataset keys that intentionally return a multi-sheet object
  // instead of a flat array. Add to this only when a backend handler
  // genuinely needs to bundle multiple sheets in one response.
  const OBJECT_SHAPE_DATASETS = new Set(['ap2_loginData', 'ap2_ticLog']);

  /* ─────────────────────────────────────────
     LOGOUT CLEANUP
     Wipes every trace of user data on sign-out:
       • IndexedDB store (all ap2_ entries)
       • sessionStorage (entire namespace)
       • localStorage   (ap2_ prefixed keys only — leave 3rd-party keys intact)
     Called automatically when Auth fires a 'ap:signout' event — auth.js
     (v3.1+) fires this both on explicit signOut() and on session-end
     redirects (inactivity / absolute TTL / server rejection) — and
     exposed as AdminPro.clearAllStorage() for manual call from logout
     buttons.
  ───────────────────────────────────────── */
  async function _clearAllStorageOnLogout() {
    // 1. Clear entire IDB store
    try {
      const db = await _openDB();
      await new Promise((res, rej) => {
        const req = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).clear();
        req.onsuccess = () => res();
        req.onerror   = () => rej(req.error);
      });
      _shadow.clear();
      console.log('[DataLayer] logout: IndexedDB store cleared');
    } catch (e) {
      console.warn('[DataLayer] logout: IDB clear failed —', e.message);
    }

    // 2. Clear sessionStorage entirely (it's scoped to this origin/tab)
    try {
      sessionStorage.clear();
      console.log('[DataLayer] logout: sessionStorage cleared');
    } catch (e) {
      console.warn('[DataLayer] logout: sessionStorage clear failed —', e.message);
    }

    // 3. Clear only ap2_ keys from localStorage (leave unrelated keys intact)
    try {
      const lsKeys = Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX) || k.startsWith('ap_') || k.startsWith('ap2_'));
      lsKeys.forEach(k => localStorage.removeItem(k));
      if (lsKeys.length) console.log('[DataLayer] logout: localStorage keys removed:', lsKeys);
    } catch (e) {
      console.warn('[DataLayer] logout: localStorage clear failed —', e.message);
    }
  }

  // Listen for Auth sign-out event — triggered by auth.js
  window.addEventListener('ap:signout', () => {
    DATASETS = {};
    Object.keys(_timers).forEach(k => { clearTimeout(_timers[k]); delete _timers[k]; });
    _clearAllStorageOnLogout();
  });

  /* ─────────────────────────────────────────
     PERMISSION NOTIFICATION HELPER
     Shows a toast/alert when a dataset access is denied.
  ───────────────────────────────────────── */
  function _notifyNotAuthorized(dsKey) {
    const label = (DATASETS[dsKey] && DATASETS[dsKey].label) || dsKey;
    const msg   = `⛔ Not authorized to access: ${label}`;
    console.warn('[DataLayer]', msg);

    if (window.AdminPro && typeof window.AdminPro.showToast === 'function') {
      window.AdminPro.showToast(msg, 'error');
    } else if (typeof window.showNotification === 'function') {
      window.showNotification(msg, 'error');
    } else {
      const existing = document.getElementById('_ap2_auth_banner');
      if (existing) existing.remove();
      const banner = document.createElement('div');
      banner.id = '_ap2_auth_banner';
      Object.assign(banner.style, {
        position:'fixed', top:'16px', left:'50%', transform:'translateX(-50%)',
        background:'#c0392b', color:'#fff', padding:'10px 22px', borderRadius:'6px',
        fontFamily:'sans-serif', fontSize:'14px', zIndex:'99999',
        boxShadow:'0 3px 10px rgba(0,0,0,.35)', whiteSpace:'nowrap'
      });
      banner.textContent = msg;
      document.body.appendChild(banner);
      setTimeout(() => banner.remove(), 4000);
    }
  }

  /* ─────────────────────────────────────────
     DATA NORMALISER
     Converts any server response into Array<Array>
     (all cell values kept as-is for speed & consistency).
     • Bare Array<Array>  → returned as-is
     • { data: [...] }   → unwrap then return
     • Bare Array<Object>→ values() of each object row
  ───────────────────────────────────────── */
  function _normaliseRows(raw) {
    const arr = Array.isArray(raw) ? raw
      : (raw && Array.isArray(raw.data)) ? raw.data
      : raw;

    if (!Array.isArray(arr)) return arr;

    return arr.map(row => {
      if (Array.isArray(row))                    return row;
      if (row && typeof row === 'object') return Object.values(row);
      return [row];
    });
  }

  /* ─────────────────────────────────────────
     DATASETS  — built entirely from server permissions at runtime.

     Shape of each entry (mirrors server Permissions sheet columns):
       label    — human-readable name for UI / cache panel
       apiKey   — value sent as the API type/action parameter
       paramKey — query-string key ('type' or 'action')
       ttlMs    — cache TTL in milliseconds

     DATASETS_ALL is gone. Nothing is hardcoded here.
     Change labels/TTLs in the Google Sheet — no redeploy needed.
  ───────────────────────────────────────── */

  /** Active datasets — permission-filtered at runtime. */
  let DATASETS = {};

  /**
   * Reads Auth.getPermissions() and maps each entry to a normalised
   * dataset config. Only datasets with the VIEW bit granted are included
   * — add/editDelete bits don't unlock caching/fetching on their own,
   * they're read separately (see Auth.canDo) to gate write UI/actions.
   *
   * Auth.getPermissions() must return the rich server shape:
   *   { "ap2_employee": { label, apiKey, paramKey:'type', ttlMs,
   *                        access:{ view, add, editDelete } }, … }
   *
   * Backwards-compat: if a value is `true` (old boolean shape) the
   * dataset key is included with minimal defaults (view-only) so the
   * system degrades gracefully rather than breaking entirely.
   */
  function _buildDatasets() {
    const perms = window.Auth && window.Auth.getPermissions
      ? window.Auth.getPermissions()
      : null;

    if (!perms || typeof perms !== 'object') {
      DATASETS = {};
      console.log('[DataLayer] no permissions available — DATASETS empty');
      return DATASETS;
    }

    const result = {};
    for (const [key, val] of Object.entries(perms)) {
      if (!val) continue; // skip explicit false / null

      let entry;

      if (val === true) {
        // Legacy boolean-only permission — treat as view-only, log a warning.
        console.warn(`[DataLayer] "${key}" has boolean permission — update Permissions sheet to include Label/ApiKey/ParamKey/TTL(ms)`);
        entry = {
          label    : key,
          apiKey   : key.replace(/^ap2_/, ''),  // best-effort fallback
          paramKey : 'type',
          ttlMs    : 5 * 60 * 1000,             // 5-minute default
          access   : { view: true, add: false, editDelete: false },
        };
      } else if (typeof val === 'object' && val.apiKey) {
        // Rich shape from server — use as-is with safe defaults for any missing fields.
        // Fail closed: a missing/malformed `access` block grants nothing.
        const a = (val.access && typeof val.access === 'object') ? val.access : {};
        entry = {
          label    : String(val.label    || key),
          apiKey   : String(val.apiKey),
          paramKey : String(val.paramKey || 'type'),
          ttlMs    : Number(val.ttlMs)   || 5 * 60 * 1000,
          access   : {
            view       : a.view       === true,
            add        : a.add        === true,
            editDelete : a.editDelete === true,
          },
        };
      } else {
        console.warn(`[DataLayer] "${key}" has unrecognised permission shape — skipping`, val);
        continue;
      }

      // View is what unlocks fetching/caching this dataset at all.
      if (!entry.access.view) {
        console.log(`[DataLayer] "${key}" has no view access — excluded from DATASETS`);
        continue;
      }

      result[key] = entry;
    }

    DATASETS = result;
    console.log('[DataLayer] permitted datasets:', Object.keys(DATASETS));
    return DATASETS;
  }

  /* ─────────────────────────────────────────
     INDEXEDDB ENGINE
     Key names: 'ap2_' + datasetKey
     Entry shape: { ts, data, fingerprint }
     DB: 'ap2_fleet_cache'  Store: 'datasets'  keyPath: none (out-of-line)
  ───────────────────────────────────────── */
  const IDB_NAME  = 'ap2_fleet_cache';
  const IDB_VER   = 2;
  const IDB_STORE = 'datasets';

  let _dbPromise = null;
  function _openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VER);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (db.objectStoreNames.contains(IDB_STORE)) {
          db.deleteObjectStore(IDB_STORE);
        }
        db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
    return _dbPromise;
  }

  async function _idbGet(fullKey) {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(fullKey);
      req.onsuccess = () => res(req.result || null);
      req.onerror   = () => rej(req.error);
    });
  }

  async function _idbSet(fullKey, value) {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const record = { ts: value.ts, data: value.data, fingerprint: value.fingerprint || null };
      const tx  = db.transaction(IDB_STORE, 'readwrite');
      const req = tx.objectStore(IDB_STORE).put(record, fullKey);
      req.onsuccess = () => res(true);
      req.onerror   = () => { console.error('[DataLayer] IDB put error for', fullKey, req.error); rej(req.error); };
      tx.onerror    = () => { console.error('[DataLayer] IDB tx error for',  fullKey, tx.error);  rej(tx.error);  };
    });
  }

  async function _idbDelete(fullKey) {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const req = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).delete(fullKey);
      req.onsuccess = () => res(true);
      req.onerror   = () => rej(req.error);
    });
  }

  async function _idbAllKeys() {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAllKeys();
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => rej(req.error);
    });
  }

  async function _idbGetAll() {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => rej(req.error);
    });
  }

  /* ─────────────────────────────────────────
     IN-MEMORY SHADOW  (sync reads for timers / status checks)
     Mirrors IDB so _cache.get() / .status() / .age() stay synchronous.
  ───────────────────────────────────────── */
  const _shadow = new Map();

  _openDB().then(async db => {
    const [keys, records] = await Promise.all([
      new Promise((res, rej) => {
        const r = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAllKeys();
        r.onsuccess = () => res(r.result || []);
        r.onerror   = () => rej(r.error);
      }),
      new Promise((res, rej) => {
        const r = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAll();
        r.onsuccess = () => res(r.result || []);
        r.onerror   = () => rej(r.error);
      }),
    ]);
    for (let i = 0; i < keys.length; i++) {
      const k   = keys[i];
      const rec = records[i];
      if (typeof k === 'string' && k.startsWith(CACHE_PREFIX) && rec) {
        _shadow.set(k, { ts: rec.ts, data: rec.data, fingerprint: rec.fingerprint || null });
      }
    }
    console.log('[DataLayer] IDB shadow loaded —', _shadow.size, 'entries');
  }).catch(e => console.warn('[DataLayer] IDB shadow load failed:', e.message));

  /* ─────────────────────────────────────────
     CACHE PURGE ON LOGIN
  ───────────────────────────────────────── */
  function _purgeUnauthorisedCache() {
    try {
      let currentFingerprint = null;
      try {
        const raw = sessionStorage.getItem('ap_session');
        if (raw) currentFingerprint = JSON.parse(raw).sessionFingerprint || null;
      } catch {}

      const permittedFullKeys = new Set(
        Object.keys(DATASETS).map(k => CACHE_PREFIX + k)
      );

      const keysToDelete = [];

      for (const [fullKey, entry] of _shadow.entries()) {
        if (!fullKey.startsWith(CACHE_PREFIX)) continue;
        if (!permittedFullKeys.has(fullKey)) {
          keysToDelete.push(fullKey);
          continue;
        }
        if (currentFingerprint && entry.fingerprint && entry.fingerprint !== currentFingerprint) {
          keysToDelete.push(fullKey);
        }
      }

      if (keysToDelete.length) {
        keysToDelete.forEach(k => {
          _shadow.delete(k);
          _idbDelete(k).catch(() => {});
        });
        console.log('[DataLayer] purged', keysToDelete.length, 'unauthorised/stale cache entries:', keysToDelete);
      } else {
        console.log('[DataLayer] cache purge: nothing to remove — all entries authorised');
      }

    } catch (e) {
      console.warn('[DataLayer] _purgeUnauthorisedCache error:', e.message);
    }
  }

  /* Build immediately — permissions may already be in session (post-login). */
  _buildDatasets();

  /* ─────────────────────────────────────────
     CACHE  — IndexedDB wrappers
     Entry shape: { ts, data, fingerprint }
     Keys: 'ap2_' + datasetKey
  ───────────────────────────────────────── */
  const _cache = {
    // Dataset keys from the server already include the 'ap2_' prefix (e.g. 'ap2_bike').
    // Do NOT prepend CACHE_PREFIX again — just use the key as-is.
    _key(name) { return name.startsWith(CACHE_PREFIX) ? name : CACHE_PREFIX + name; },

    get(name) {
      return _shadow.get(this._key(name)) || null;
    },

    set(name, data) {
      let fingerprint = null;
      try {
        const raw = sessionStorage.getItem('ap_session');
        if (raw) fingerprint = JSON.parse(raw).sessionFingerprint || null;
      } catch {}

      const entry   = { ts: Date.now(), data, fingerprint };
      const fullKey = this._key(name);

      _shadow.set(fullKey, entry);

      _idbSet(fullKey, entry).then(() => {
        console.log('[DataLayer] IDB write OK:', fullKey, '| rows:', Array.isArray(entry.data) ? entry.data.length : typeof entry.data);
      }).catch(e => {
        console.error('[DataLayer] IDB write FAILED for', fullKey, e);
      });
      return true;
    },

    clear(name) {
      const fullKey = this._key(name);
      _shadow.delete(fullKey);
      _idbDelete(fullKey).catch(() => {});
    },

    clearAll() {
      const keys = Array.from(_shadow.keys()).filter(k => k.startsWith(CACHE_PREFIX));
      keys.forEach(k => {
        _shadow.delete(k);
        _idbDelete(k).catch(() => {});
      });
    },

    /** Returns null (no cache), 'fresh', or 'stale' */
    status(name) {
      const entry = this.get(name);
      if (!entry || entry.data == null) return null;
      const ds = DATASETS[name];
      if (!ds) return null;
      return (Date.now() - entry.ts) < ds.ttlMs ? 'fresh' : 'stale';
    },

    age(name) {
      const entry = this.get(name);
      if (!entry) return Infinity;
      return Date.now() - entry.ts;
    },
  };

  function _evictOldest() {
    let oldest = null, oldestKey = null;
    for (const [k, entry] of _shadow.entries()) {
      if (!k.startsWith(CACHE_PREFIX)) continue;
      if (!oldest || entry.ts < oldest) { oldest = entry.ts; oldestKey = k; }
    }
    if (oldestKey) {
      _shadow.delete(oldestKey);
      _idbDelete(oldestKey).catch(() => {});
    }
  }

  /* ─────────────────────────────────────────
     IN-FLIGHT DEDUP
  ───────────────────────────────────────── */
  const _inflight = {};

  /* ─────────────────────────────────────────
     CORE FETCH
     Attaches session credentials to every request.
     Reads apiKey and paramKey from DATASETS (server-supplied) — no hardcoding.
  ───────────────────────────────────────── */
  async function _fetchFromServer(dsKey) {
    if (_inflight[dsKey]) {
      console.log(`[DataLayer] ${dsKey}: piggyback on in-flight fetch`);
      return _inflight[dsKey];
    }

    const promise = (async () => {
      _buildDatasets();

      const ds = DATASETS[dsKey];
      if (!ds) {
        _notifyNotAuthorized(dsKey);
        throw new Error(`[DataLayer] "${dsKey}" not permitted — access denied`);
      }

      const creds = window.Auth && window.Auth.getCredentials
        ? window.Auth.getCredentials()
        : null;

      if (!creds || !creds.sessionId || !creds.token) {
        throw new Error(`[DataLayer] ${dsKey}: no valid session — aborting fetch`);
      }

      // paramKey and apiKey come from the server-supplied permissions, not hardcode
      const paramKey = ds.paramKey || 'type';
      const url = `${API_BASE}?${paramKey}=${encodeURIComponent(ds.apiKey)}`
        + `&sessionId=${encodeURIComponent(creds.sessionId)}`
        + `&token=${encodeURIComponent(creds.token)}`
        + `&_t=${Date.now()}`;

      console.log(`[DataLayer] ${dsKey}: fetching → ${paramKey}=${ds.apiKey}`);
      const t0 = performance.now();

      const controller = new AbortController();
      const timeoutId  = setTimeout(() => controller.abort(), 30000);

      let res;
      try {
        res = await fetch(url, { cache: 'no-store', redirect: 'follow', mode: 'cors', signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${dsKey}`);

      const json = await res.json();

      if (json && typeof json === 'object' && !Array.isArray(json) && json.success === false) {
        const msg = json.error || json.message || 'Unknown server error';
        console.error(`[DataLayer] ${dsKey}: API rejected — "${msg}" | ${url}`);
        throw new Error(`[DataLayer] ${dsKey} API error: ${msg}`);
      }

      let data;

      if (OBJECT_SHAPE_DATASETS.has(dsKey)) {
        // Special case: combo payload, not a flat row array.
        // Validate it has the expected sub-keys with array values.
        if (!json || typeof json !== 'object' || Array.isArray(json)) {
          throw new Error(`[DataLayer] ${dsKey}: expected object payload, got ${Array.isArray(json) ? 'array' : typeof json}`);
        }
        const hasAnyData = Object.values(json).some(v => Array.isArray(v) && v.length > 0);
        if (!hasAnyData) {
          console.warn(`[DataLayer] ${dsKey}: empty response — not caching`);
          throw new Error(`[DataLayer] ${dsKey}: empty or invalid data received`);
        }
        data = json; // store as-is, no row normalisation
      } else {
        // Standard contract: flat array of rows.
        data = _normaliseRows(json);
        if (!Array.isArray(data) || data.length === 0) {
          console.warn(`[DataLayer] ${dsKey}: empty response — not caching`);
          throw new Error(`[DataLayer] ${dsKey}: empty or invalid data received`);
        }
      }

      _cache.set(dsKey, data);
      const elapsed = Math.round(performance.now() - t0);
      console.log(`[DataLayer] ${dsKey}: cached`,
        Array.isArray(data) ? `${data.length} rows` : Object.keys(data).map(k => `${k}:${data[k].length}`).join(', '),
        `(${elapsed} ms)`);
      return data;
    })();

    _inflight[dsKey] = promise;
    try {
      const result = await promise;
      return result;
    } finally {
      delete _inflight[dsKey];
    }
  }

  /* ─────────────────────────────────────────
     GET — cache-first, fetch-on-miss/stale
  ───────────────────────────────────────── */
  async function _get(dsKey, force) {
    _buildDatasets();
    const ds = DATASETS[dsKey];
    if (!ds) {
      _notifyNotAuthorized(dsKey);
      throw new Error(`[DataLayer] "${dsKey}" not permitted or unknown`);
    }

    if (!force) {
      const entry = _cache.get(dsKey);
      if (entry && entry.data != null) {
        const age = Date.now() - entry.ts;
        if (age < ds.ttlMs) {
          console.log(`[DataLayer] ${dsKey}: cache HIT (age ${Math.round(age/1000)}s)`);
          return entry.data;
        }
        console.log(`[DataLayer] ${dsKey}: cache STALE (age ${Math.round(age/1000)}s) — refreshing`);
      } else {
        console.log(`[DataLayer] ${dsKey}: cache MISS — fetching`);
      }
    } else {
      console.log(`[DataLayer] ${dsKey}: force refresh — skipping cache`);
      _cache.clear(dsKey);
    }

    return _fetchFromServer(dsKey);
  }

  /* ─────────────────────────────────────────
     WARM-IF-EMPTY
  ───────────────────────────────────────── */
  async function warmIfEmpty() {
    _buildDatasets();
    _purgeUnauthorisedCache();

    const allowedKeys = Object.keys(DATASETS);
    if (!allowedKeys.length) {
      console.warn('[DataLayer] warmIfEmpty: no permitted datasets — nothing to fetch');
      return;
    }

    const toFetch = allowedKeys.filter(key => {
      const status = _cache.status(key);
      return status !== 'fresh';
    });

    if (!toFetch.length) {
      console.log('[DataLayer] warmIfEmpty: all datasets are fresh — skipping fetch');
      _startAllTimers();
      return;
    }

    console.log('[DataLayer] warmIfEmpty: fetching', toFetch.length, 'missing/stale datasets:', toFetch);

    await Promise.allSettled(
      toFetch.map(key => _fetchFromServer(key))
    );

    _startAllTimers();
    console.log('[DataLayer] warmIfEmpty: all done');
  }

  /* ─────────────────────────────────────────
     BACKGROUND REFRESH TIMERS
     Each permitted dataset auto-refreshes 30s before its TTL expires.
     TTL is read from ds.ttlMs which comes from the server — no hardcoding.
  ───────────────────────────────────────── */
  const _timers = {};

  function _scheduleRefresh(dsKey) {
    const ds = DATASETS[dsKey];
    if (!ds) return;

    if (_timers[dsKey]) { clearTimeout(_timers[dsKey]); delete _timers[dsKey]; }

    const entry = _cache.get(dsKey);
    if (!entry) return;

    const age       = Date.now() - entry.ts;
    const remaining = ds.ttlMs - age;
    const delay     = Math.max(0, remaining - 30000);

    _timers[dsKey] = setTimeout(async () => {
      if (document.visibilityState === 'hidden') {
        _scheduleRefresh(dsKey);
        return;
      }
      console.log(`[DataLayer] background refresh: ${dsKey}`);
      try {
        await _fetchFromServer(dsKey);
        _scheduleRefresh(dsKey);
      } catch (e) {
        console.warn(`[DataLayer] background refresh failed: ${dsKey}`, e.message);
        _timers[dsKey] = setTimeout(() => _scheduleRefresh(dsKey), 2 * 60 * 1000);
      }
    }, delay);

    console.log(`[DataLayer] ${dsKey}: next refresh in ${Math.round(delay/1000)}s`);
  }

  function _startAllTimers() {
    Object.keys(DATASETS).forEach(_scheduleRefresh);
  }

  /* ─────────────────────────────────────────
     PUBLIC API  — window.AdminPro
  ───────────────────────────────────────── */
  window.AdminPro = {

    VERSION: '2.2',

    /* ── INIT — rebuild permitted DATASETS + purge stale cache + start timers. ── */
    init() {
      _buildDatasets();
      _purgeUnauthorisedCache();
      _startAllTimers();
      console.log('[DataLayer] init: ready with', Object.keys(DATASETS).length, 'permitted datasets');
    },

    /* ── WARMUP ── */
    warmIfEmpty,

    /* ── STREAM-QUERY ── */
    async streamQuery(dsKey, predicateFn) {
      _buildDatasets();
      const ds = DATASETS[dsKey];
      if (!ds) { _notifyNotAuthorized(dsKey); throw new Error(`[DataLayer] "${dsKey}" not permitted`); }

      const fullKey = dsKey.startsWith(CACHE_PREFIX) ? dsKey : CACHE_PREFIX + dsKey;

      try {
        const db = await _openDB();
        return await new Promise((resolve, reject) => {
          const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(fullKey);
          req.onsuccess = () => {
            const rec = req.result;
            if (!rec || !Array.isArray(rec.data)) { resolve([]); return; }
            const results = [];
            for (let i = 0, len = rec.data.length; i < len; i++) {
              try { if (predicateFn(rec.data[i])) results.push(rec.data[i]); } catch (_) {}
            }
            resolve(results);
          };
          req.onerror = () => reject(req.error);
        });
      } catch (e) {
        console.warn('[DataLayer] streamQuery IDB fallback:', e.message);
        const entry = _cache.get(dsKey);
        if (!entry || !Array.isArray(entry.data)) return [];
        return entry.data.filter(row => { try { return predicateFn(row); } catch (_) { return false; } });
      }
    },

    /* ── GENERIC GETTER — preferred interface; dsKey = permission key e.g. 'ap2_employee' ── */
    get(dsKey, force) { return _get(dsKey, force); },

    /* ── NAMED GETTERS (backwards compat) — resolve through permission keys ──────────────
       These call _get() with the canonical permission key. If the user doesn't have
       permission for that dataset, the permission gate inside _get() will reject it.
       Pages that switched to AdminPro.get('ap2_employee') don't need these at all.
    ── */
    getEmployees  (force) { return _get('ap2_employee', force); },
    getBikes      (force) { return _get('ap2_bike',     force); },
    getMasterSheet(force) { return _get('ap2_master',   force); },
    getCioLog     (force) { return _get('ap2_cioLog',   force); },
    getRecovery   (force) { return _get('ap2_recovery', force); },
    // Returns { ticLog: [...], Ticket: [...] } — object-shape dataset, not a flat array
    getTicLog     (force) { return _get('ap2_ticLog',   force); },

    /* ── FORCE REFRESH ── */
    async forceRefresh(dsKey) {
      if (dsKey) {
        if (!DATASETS[dsKey]) {
          console.warn(`[DataLayer] forceRefresh: "${dsKey}" not permitted — skipping`);
          return;
        }
        const data = await _get(dsKey, true);
        _scheduleRefresh(dsKey);
        return data;
      }
      await Promise.allSettled(Object.keys(DATASETS).map(k => _get(k, true)));
      _startAllTimers();
    },

    /* ── WARM CACHE ── */
    async warmCache() {
      await this.forceRefresh();
    },

    /* ── CACHE UTILITIES ── */
    cache: {
      get      : (name)        => _cache.get(name),
      set      : (name, data)  => _cache.set(name, data),
      clear    : (name)        => _cache.clear(name),
      clearAll : ()            => _cache.clearAll(),
      status   : (name)        => _cache.status(name),
      age      : (name)        => _cache.age(name),
    },

    /* ── getCacheStatus — returns only permitted datasets for cache panel ── */
    getCacheStatus() {
      return Object.entries(DATASETS).map(([key, ds]) => {
        const entry   = _cache.get(key);
        const ageMs   = entry ? Date.now() - entry.ts : Infinity;
        const hasData = entry && entry.data != null
          ? (Array.isArray(entry.data) ? entry.data.length > 0 : true)
          : false;
        const fresh   = hasData && ageMs < ds.ttlMs;

        const ageLabel = ageMs === Infinity ? 'Not loaded'
          : ageMs < 60000      ? Math.floor(ageMs / 1000)    + 's ago'
          : ageMs < 3600000    ? Math.floor(ageMs / 60000)   + 'm ago'
          :                      Math.floor(ageMs / 3600000) + 'h ago';

        let lastSync = null;
        if (ageMs !== Infinity) {
          const d = new Date(Date.now() - ageMs);
          lastSync = d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })
            + ', ' + d.toLocaleDateString([], { day:'2-digit', month:'short' });
        }

        const rowCount  = (entry && Array.isArray(entry.data)) ? entry.data.length : null;
        const remaining = ageMs === Infinity ? 0 : Math.max(0, ds.ttlMs - ageMs);
        const inFlight  = !!_inflight[key];

        return { key, label: ds.label, ageMs, ageLabel, fresh, hasData, lastSync,
                 ttl: ds.ttlMs, rowCount, remaining, inFlight };
      });
    },

    /* ── getActiveDatasets — exposes permitted dataset configs ── */
    getActiveDatasets() {
      return { ...DATASETS };
    },

    /* ── stopAllTimers ── */
    stopAllTimers() {
      Object.keys(_timers).forEach(k => { clearTimeout(_timers[k]); delete _timers[k]; });
    },

    /* ── signOut ── */
    async signOut() {
      this.stopAllTimers();
      DATASETS = {};
      await _clearAllStorageOnLogout();
      console.log('[DataLayer] signOut: all storage cleared, DATASETS reset');
    },

    /* ── clearAllStorage ── */
    clearAllStorage: _clearAllStorageOnLogout,

    /* ── getDatasetNames — keys of all permitted datasets ── */
    getDatasetNames() {
      return Object.keys(DATASETS);
    },

    /* ── getDatasetMeta — full permitted dataset config ── */
    getDatasetMeta() {
      return Object.entries(DATASETS).map(([key, ds]) => ({
        key,
        label    : ds.label,
        apiKey   : ds.apiKey,
        paramKey : ds.paramKey,
        ttlMs    : ds.ttlMs,
        access   : ds.access,
      }));
    },

  };

  /* Backwards-compat alias */
  window.DataLayer = window.AdminPro;

  /* ─────────────────────────────────────────
     AUTO-INIT
  ───────────────────────────────────────── */
  (function _autoInit() {
    const isLoginPage = window.location.pathname.endsWith('login.html')
      || window.location.href.includes('/login.html');

    if (isLoginPage) return;

    function _initAndWarm() {
      _buildDatasets();
      _purgeUnauthorisedCache();
      _startAllTimers();
      warmIfEmpty().catch(e => console.warn('[DataLayer] autoInit warmIfEmpty error:', e.message));
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _initAndWarm);
    } else {
      _initAndWarm();
    }
  })();

  /* ─────────────────────────────────────────
     VISIBILITY CHANGE WATCHER
  ───────────────────────────────────────── */
  (function _visibilityWatcher() {
    const isLoginPage = window.location.pathname.endsWith('login.html')
      || window.location.href.includes('/login.html');
    if (isLoginPage) return;

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;

      try {
        _buildDatasets();
      } catch (e) {
        console.warn('[DataLayer] visibilityWatcher: _buildDatasets unavailable —', e.message);
        return;
      }

      try {
        const staleKeys = Object.keys(DATASETS).filter(key => {
          const status = _cache.status(key);
          return status !== 'fresh';
        });
        if (staleKeys.length) {
          console.log('[DataLayer] Tab visible — refreshing stale datasets:', staleKeys);
          Promise.allSettled(staleKeys.map(key => _fetchFromServer(key))).then(() => {
            _startAllTimers();
          });
        }
      } catch (e) {
        console.warn('[DataLayer] visibilityWatcher error:', e.message);
      }
    });
  })();

  console.log('[DataLayer] v2.2 loaded — IndexedDB cache — window.AdminPro ready');

})();
