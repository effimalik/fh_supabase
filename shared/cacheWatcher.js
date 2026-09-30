/* ═══════════════════════════════════════════════════════════════════════
   cacheWatcher.js  —  FINAL, SELF-CONTAINED VERSION
   ───────────────────────────────────────────────────────────────────────
   Every page (shell or leaf) reads its OWN data directly from
   IndexedDB — no waiting on another page to answer a request. This
   removes the multi-second delay entirely, and doesn't require
   index.html or any other file to be updated for this to work.

   The iPad freeze (several frames opening the same database at the
   exact same instant) is avoided differently now: each frame waits a
   small RANDOM stagger (0-250ms) before its first open attempt, so
   frames don't collide. Combined with a timeout + one retry, opening
   the database can no longer hang forever, on any OS.

   Public API (unchanged from before, no page needs to change):
     AP2CacheWatcher.init()              start watching
     AP2CacheWatcher.readKey(key)        → Promise<array|null>, reads NOW
     AP2CacheWatcher.subscribe(fn)       fn(key) fires on change/deletion
     AP2CacheWatcher.notifyNow(key)      instant "this key changed" ping
     AP2CacheWatcher.getStatus()         → { healthy, mode, lastError }

   If this page happens to be inside an iframe AND its parent shell
   also broadcasts 'ap-cache-updated' messages, this still listens for
   those as a BONUS instant signal — but never waits on them. Reading
   works the same with or without a parent doing anything.
   ═══════════════════════════════════════════════════════════════════════ */

(function (global) {
  const _IDB_NAME    = 'ap2_fleet_cache';
  const _IDB_STORE   = 'datasets';
  const POLL_MS      = 2000;    // local fallback poll — catches un-notified writes
  const OPEN_TIMEOUT = 2000;    // ms before we treat indexedDB.open() as hung
  const MAX_STAGGER  = 250;     // ms — random delay before first open, desyncs frames

  let _idbConn      = null;
  let _fingerprints = {};
  let _versions     = {};
  let _knownKeys    = new Set();
  let _pollTimer    = null;
  let _started      = false;
  let _subscribers  = [];
  let _dbQueue      = Promise.resolve();
  let _status       = { healthy: null, mode: 'idb', lastError: null };
  let _memoryFallback = {};
  let _staggerDone  = false;

  function _setStatus(patch) {
    _status = Object.assign({}, _status, patch);
    window.dispatchEvent(new CustomEvent('ap-cache-status', { detail: _status }));
  }
  function getStatus() { return _status; }

  function _stagger() {
    if (_staggerDone) return Promise.resolve();
    _staggerDone = true;
    const ms = Math.floor(Math.random() * MAX_STAGGER);
    return new Promise(res => setTimeout(res, ms));
  }

  function _openOnce(attempt) {
    return new Promise((res, rej) => {
      let settled = false;
      const req = indexedDB.open(_IDB_NAME);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        rej(new Error('idb-open-timeout (attempt ' + attempt + ')'));
      }, OPEN_TIMEOUT);
      req.onsuccess = e => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        res(e.target.result);
      };
      req.onerror = e => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        rej(e.target.error || new Error('idb-open-error'));
      };
      req.onblocked = () => console.warn('[cacheWatcher] IDB open blocked (attempt ' + attempt + ')');
    });
  }

  async function _getDB() {
    if (_idbConn) return _idbConn;
    await _stagger(); // desync simultaneous opens across frames — the real iPad fix
    try {
      _idbConn = await _openOnce(1);
    } catch (e1) {
      try {
        _idbConn = await _openOnce(2);
      } catch (e2) {
        _setStatus({ healthy: false, mode: 'fallback', lastError: e2.message });
        throw e2;
      }
    }
    _setStatus({ healthy: true, mode: 'idb', lastError: null });
    return _idbConn;
  }

  // All real reads funnel through one queue — avoids overlapping
  // transactions within THIS frame (a secondary, smaller iOS quirk).
  function _queuedRead(key) {
    const job = _dbQueue.then(async () => {
      try {
        const db = await _getDB();
        if (!db.objectStoreNames.contains(_IDB_STORE)) {
          return null; // cache not warmed yet in this session — normal, not an error
        }
        const rec = await new Promise((res, rej) => {
          const req = db.transaction(_IDB_STORE, 'readonly').objectStore(_IDB_STORE).get(key);
          req.onsuccess = () => res(req.result || null);
          req.onerror   = () => rej(req.error);
        });
        const data = (rec && _isValidData(rec.data)) ? rec.data : null;
        if (data) _memoryFallback[key] = data;
        return data;
      } catch (e) {
        if (e && e.name === 'NotFoundError') return null;
        console.warn('[cacheWatcher] read failed for "' + key + '", using memory fallback:', e.message);
        return _memoryFallback[key] || null;
      }
    });
    _dbQueue = job.catch(() => {});
    return job;
  }

  function _allKeys(db) {
    return new Promise((res, rej) => {
      const req = db.transaction(_IDB_STORE, 'readonly').objectStore(_IDB_STORE).getAllKeys();
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => rej(req.error);
    });
  }

  // Accepts BOTH shapes of cached value:
  //   - a non-empty array              (e.g. ap2_employee — flat row list)
  //   - a non-empty plain object       (e.g. ap2_loginData — bundle of
  //                                      several named sub-datasets)
  // Previously this only recognised arrays, so any object-shaped cache
  // value (like ap2_loginData) silently read back as "no data" on every
  // poll/notifyNow-triggered read, even though it was populated — this
  // is what caused good data to blink away a few seconds after paint.
  function _isValidData(data) {
    if (Array.isArray(data)) return data.length > 0;
    if (data && typeof data === 'object') return Object.keys(data).length > 0;
    return false;
  }

  function _fingerprint(rec) {
    if (!rec || !_isValidData(rec.data)) return '';
    if (Array.isArray(rec.data)) {
      const len = rec.data.length;
      return 'arr|' + len + '|' + JSON.stringify(rec.data[0] || '') + '|' + JSON.stringify(rec.data[len - 1] || '');
    }
    // Object shape: cheap structural fingerprint — key count + per-key
    // array lengths (or JSON length for non-array values) — enough to
    // detect additions/removals/edits without hashing the whole payload.
    const keys = Object.keys(rec.data).sort();
    const shape = keys.map(k => {
      const v = rec.data[k];
      return k + ':' + (Array.isArray(v) ? v.length : JSON.stringify(v || '').length);
    }).join(',');
    return 'obj|' + keys.length + '|' + shape;
  }

  // Each page watches for changes to ITS OWN data on its own short poll —
  // simple, self-contained, works whether or not a parent shell exists.
  async function _checkAll() {
    try {
      const db = await _getDB();
      if (!db.objectStoreNames.contains(_IDB_STORE)) return;
      const currentKeys = await _allKeys(db);
      const currentSet  = new Set(currentKeys);

      for (const key of currentKeys) {
        const rec = await new Promise((res, rej) => {
          const req = db.transaction(_IDB_STORE, 'readonly').objectStore(_IDB_STORE).get(key);
          req.onsuccess = () => res(req.result || null);
          req.onerror   = () => rej(req.error);
        });
        const fp = _fingerprint(rec);
        if (_fingerprints[key] !== undefined && _fingerprints[key] !== fp) {
          _versions[key] = (_versions[key] || 0) + 1;
          _broadcast(key);
        }
        _fingerprints[key] = fp;
        _knownKeys.add(key);
      }

      for (const key of _knownKeys) {
        if (!currentSet.has(key) && _fingerprints[key] !== undefined) {
          delete _fingerprints[key];
          delete _memoryFallback[key];
          _versions[key] = (_versions[key] || 0) + 1;
          _broadcast(key); // deleted — tell subscribers immediately
        }
      }
    } catch (e) {
      console.warn('[cacheWatcher] poll failed:', e.message);
    }
  }

  function _broadcast(key) {
    _subscribers.forEach(fn => { try { fn(key); } catch (e) {} });
  }

  async function readKey(key) {
    return _queuedRead(key);
  }

  function _wireMessages() {
    // Bonus: if a parent shell broadcasts a change, react instantly
    // instead of waiting for the next local poll tick. Purely optional —
    // reading and the local poll both work with no parent at all.
    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'ap-cache-updated') {
        _subscribers.forEach(fn => { try { fn(e.data.key); } catch (err) {} });
      }
    });
  }

  function init() {
    if (_started) return;
    _started = true;
    _wireMessages();
    _checkAll().then(() => {
      _pollTimer = setInterval(_checkAll, POLL_MS);
    });
  }

  function subscribe(fn) {
    _subscribers.push(fn);
    return () => { _subscribers = _subscribers.filter(f => f !== fn); };
  }

  function notifyNow(key) {
    _versions[key] = (_versions[key] || 0) + 1;
    _queuedRead(key).then(() => _broadcast(key));
  }

  global.AP2CacheWatcher = { init, notifyNow, subscribe, readKey, getStatus };
})(window);
