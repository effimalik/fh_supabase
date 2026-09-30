/**
 * cioView.js — Check-In/Out Paired View Builder
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  PURPOSE
 *  -------
 *  Reads the raw ap2_cioLog dataset from IndexedDB, builds a structured
 *  "paired view" (each Check-Out matched with its corresponding Check-In),
 *  then writes the result back to IDB as ap2_cioView.
 *
 *  Call AP2CioView.build() once after login + initial cache fetch.
 *  Call AP2CioView.build() again whenever ap2_cioLog is refreshed.
 *  Consumers (allEmp.html, inOut.html, any future portal) read ap2_cioView
 *  directly — zero parsing, zero pairing logic needed in the consumer.
 *
 *  IDB TOPOLOGY
 *  ------------
 *  Database : ap2_fleet_cache
 *  Store    : datasets
 *  Keys used:
 *    ap2_cioLog   — raw source rows (written by dataLayer / index.html)
 *    ap2_cioView  — built view (written by this script)
 *
 *  RAW ap2_cioLog ROW FORMAT (array, 0-based columns):
 *    [0]  Timestamp           ISO 8601 string
 *    [1]  Ref ID              ignored
 *    [2]  Emp ID
 *    [3]  Action              "Check Out" | "Check In"
 *    [4]  Item Type           "Bike" | "SIM" | "Sim" | "Company" | "Inventory"
 *    [5]  Item value          bike id / SIM number / company name
 *
 *  OUTPUT ap2_cioView RECORD (saved to IDB):
 *  {
 *    ts          : <epoch ms of build time>,
 *    sourcets    : <ts of the ap2_cioLog record it was built from>,
 *    fingerprint : <fingerprint of the ap2_cioLog record>,
 *    data        : [  <-- array of PairedEntry objects (see below) -->  ]
 *  }
 *
 *  PairedEntry shape:
 *  {
 *    empId      : string,        // employee ID
 *    itemType   : 'bike'|'sim'|'company',
 *    item       : string,        // bike plate / SIM number / company name
 *    seq        : number,        // 1-based assignment sequence per (empId, item)
 *    checkOutTs : string|null,   // original DDMMYYYYHHmmss string, or null
 *    checkInTs  : string|null,   // original DDMMYYYYHHmmss string, or null
 *    checkOutDate: string|null,  // ISO 8601 string for easy Date construction
 *    checkInDate : string|null,  // ISO 8601 string for easy Date construction
 *    active     : boolean        // true = checked out, not yet returned
 *  }
 *
 *  CONSUMER USAGE EXAMPLE
 *  ----------------------
 *  // Read the view for one employee, bike type only:
 *  const view = await AP2CioView.read();
 *  const rows = view.filter(r => r.empId === '12345' && r.itemType === 'bike');
 *
 *  // Read everything for a specific bike across all employees:
 *  const bikeRows = view.filter(r => r.item === 'DXB-1234' && r.itemType === 'bike');
 *
 *  PUBLIC API
 *  ----------
 *  AP2CioView.build()          — (async) builds + saves view, returns PairedEntry[]
 *  AP2CioView.read()           — (async) reads saved view from IDB, returns PairedEntry[]
 *  AP2CioView.readRaw()        — (async) reads full IDB record { ts, data, ... }
 *  AP2CioView.isStale()        — (async) true if ap2_cioLog is newer than ap2_cioView
 *  AP2CioView.buildIfStale()   — (async) calls build() only when isStale() === true
 * ═══════════════════════════════════════════════════════════════════════════
 */

(function (global) {
  'use strict';

  /* ── IDB config (must match the rest of the app) ── */
  const IDB_NAME    = 'ap2_fleet_cache';
  const IDB_STORE   = 'datasets';
  const SRC_KEY     = 'ap2_cioLog';
  const VIEW_KEY    = 'ap2_cioView';

  /* ── Singleton IDB connection ── */
  let _db = null;
  function _getDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((res, rej) => {
      const req = indexedDB.open(IDB_NAME);
      req.onsuccess = e => { _db = e.target.result; res(_db); };
      req.onerror   = e => rej(e.target.error);
    });
  }

  /* ── Generic IDB get ── */
  async function _idbGet(key) {
    const db = await _getDB();
    return new Promise((res, rej) => {
      const req = db.transaction(IDB_STORE, 'readonly')
                    .objectStore(IDB_STORE).get(key);
      req.onsuccess = () => res(req.result || null);
      req.onerror   = () => rej(req.error);
    });
  }

  /* ── Generic IDB put ── */
  async function _idbPut(key, value) {
    const db = await _getDB();
    return new Promise((res, rej) => {
      const store = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE);
      const req   = store.put(value, key);
      req.onsuccess = () => res(true);
      req.onerror   = () => rej(req.error);
    });
  }

  /* ── Validate/normalise an ISO timestamp string → canonical ISO (null on failure) ── */
  function _tsToISO(raw) {
    if (!raw) return null;
    const d = new Date(String(raw).trim());
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  /* ── Normalise one raw cioLog row ──
   *  Column format:
   *    [0] Timestamp  — ISO string
   *    [1] Ref ID     — ignored
   *    [2] Emp ID
   *    [3] Action     — "Check Out" | "Check In"
   *    [4] Item Type  — "Bike" | "SIM" | "Sim" | "Company" | "Inventory"
   *    [5] Item value — bike id / sim number / company name
   *
   *  Returns null for rows missing required fields.
   *  Accepts both array rows and object rows.
   */
  function _normaliseRow(r) {
    const _s = v => (v !== null && v !== undefined) ? String(v).trim() : '';

    let tsRaw, empId, action, rawItemType, item;

    if (Array.isArray(r)) {
      tsRaw       = _s(r[0]);
      // r[1] = Ref ID — ignored
      empId       = _s(r[2]);
      action      = _s(r[3]);
      rawItemType = _s(r[4]);
      item        = _s(r[5]);
    } else {
      tsRaw       = _s(r['Timestamp']  || r['timestamp'] || '');
      empId       = _s(r['Emp ID']     || r['EmpID']     || r['empId'] || '');
      action      = _s(r['Action']     || r['action']    || '');
      rawItemType = _s(r['Item Type']  || r['itemType']  || '');
      item        = _s(r['Item']       || r['item']      || '');
    }

    if (!empId || !tsRaw) return null;

    const isoTs = _tsToISO(tsRaw);
    if (!isoTs) return null;

    const actLower = action.toLowerCase();
    const isOut    = actLower.includes('out');
    const isIn     = actLower.includes('in') && !actLower.includes('out');
    if (!isOut && !isIn) return null;

    if (!item) return null;

    // Normalise itemType to lowercase canonical form
    const itLower = rawItemType.toLowerCase();
    let itemType;
    if      (itLower === 'bike')      itemType = 'bike';
    else if (itLower === 'sim')       itemType = 'sim';
    else if (itLower === 'company')   itemType = 'company';
    else if (itLower === 'inventory') itemType = 'inventory';
    else return null; // unknown type — skip

    return { tsRaw, isoTs, empId, itemType, item, isOut };
  }

  /* ══ CORE BUILD FUNCTION ════════════════════════════════════════════════
   *
   *  Algorithm per (empId, itemType, item) group:
   *
   *    Sort events ascending by isoTs.
   *    Walk event list:
   *      - "Check Out": if an open pair exists, close it as active=true first,
   *                     then open a new pair with this timestamp.
   *      - "Check In":  close the open pair; if no open pair exists, record
   *                     an orphan check-in (checkOutTs = null).
   *    At end of group: any still-open pair → active = true.
   *
   * ════════════════════════════════════════════════════════════════════════ */
  function _buildPairs(normRows) {
    /* Group by empId + itemType + item */
    const groups = {};
    normRows.forEach(ev => {
      const key = `${ev.empId}|||${ev.itemType}|||${ev.item}`;
      if (!groups[key]) groups[key] = { empId: ev.empId, itemType: ev.itemType, item: ev.item, events: [] };
      groups[key].events.push(ev);
    });

    const pairs = [];

    Object.values(groups).forEach(g => {
      /* Sort ascending */
      g.events.sort((a, b) => a.isoTs < b.isoTs ? -1 : a.isoTs > b.isoTs ? 1 : 0);

      let openOut = null; // isoTs of current unclosed check-out
      let openRaw = null; // tsRaw of current unclosed check-out
      let seq     = 0;

      g.events.forEach(ev => {
        if (ev.isOut) {
          /* Close any hanging open pair without a check-in */
          if (openOut !== null) {
            seq++;
            pairs.push({
              empId:       g.empId,
              itemType:    g.itemType,
              item:        g.item,
              seq,
              checkOutTs:  openRaw,
              checkInTs:   null,
              checkOutDate: openOut,
              checkInDate:  null,
              active:      true
            });
          }
          openOut = ev.isoTs;
          openRaw = ev.tsRaw;
        } else {
          /* Check-In — close current pair (or create orphan) */
          seq++;
          pairs.push({
            empId:       g.empId,
            itemType:    g.itemType,
            item:        g.item,
            seq,
            checkOutTs:  openRaw,
            checkInTs:   ev.tsRaw,
            checkOutDate: openOut,
            checkInDate:  ev.isoTs,
            active:      false
          });
          openOut = null;
          openRaw = null;
        }
      });

      /* Remaining open check-out → still active */
      if (openOut !== null) {
        seq++;
        pairs.push({
          empId:       g.empId,
          itemType:    g.itemType,
          item:        g.item,
          seq,
          checkOutTs:  openRaw,
          checkInTs:   null,
          checkOutDate: openOut,
          checkInDate:  null,
          active:      true
        });
      }
    });

    /* Final sort: empId → itemType → item → seq */
    pairs.sort((a, b) => {
      if (a.empId    !== b.empId)    return String(a.empId).localeCompare(String(b.empId), undefined, { numeric: true });
      if (a.itemType !== b.itemType) return a.itemType.localeCompare(b.itemType);
      const ic = a.item.localeCompare(b.item, undefined, { numeric: true });
      if (ic !== 0) return ic;
      return a.seq - b.seq;
    });

    return pairs;
  }

  /* ══ PUBLIC API ══════════════════════════════════════════════════════════ */

  const AP2CioView = {

    /**
     * build()
     * Reads ap2_cioLog from IDB, builds paired view, saves as ap2_cioView.
     * Returns the PairedEntry array.
     */
    async build() {
      const srcRec = await _idbGet(SRC_KEY);
      if (!srcRec || !Array.isArray(srcRec.data) || !srcRec.data.length) {
        console.warn('[cioView] ap2_cioLog is empty — nothing to build.');
        return [];
      }

      const normRows = srcRec.data.map(_normaliseRow).filter(Boolean);
      const pairs    = _buildPairs(normRows);

      const viewRec = {
        ts:          Date.now(),
        sourcets:    srcRec.ts        || null,
        fingerprint: srcRec.fingerprint || null,
        data:        pairs
      };

      await _idbPut(VIEW_KEY, viewRec);
      console.info(`[cioView] Built ${pairs.length} paired entries from ${normRows.length} raw events → saved as ${VIEW_KEY}`);
      return pairs;
    },

    /**
     * read()
     * Returns the PairedEntry array from ap2_cioView, or [] if not built yet.
     */
    async read() {
      const rec = await _idbGet(VIEW_KEY);
      return (rec && Array.isArray(rec.data)) ? rec.data : [];
    },

    /**
     * readRaw()
     * Returns the full ap2_cioView IDB record { ts, sourcets, fingerprint, data }.
     */
    async readRaw() {
      return _idbGet(VIEW_KEY);
    },

    /**
     * isStale()
     * Returns true if ap2_cioLog has been updated after the last build,
     * or if ap2_cioView does not exist yet.
     */
    async isStale() {
      const [src, view] = await Promise.all([_idbGet(SRC_KEY), _idbGet(VIEW_KEY)]);
      if (!view) return true;
      if (!src)  return false;
      /* Stale if source timestamp is newer than the view's recorded sourcets */
      return (src.ts || 0) > (view.sourcets || 0);
    },

    /**
     * buildIfStale()
     * Builds only when the source has changed since the last build.
     * Returns the PairedEntry array (from cache if fresh, rebuilt if stale).
     */
    async buildIfStale() {
      if (await this.isStale()) {
        return this.build();
      }
      return this.read();
    }
  };

  /* Expose globally */
  global.AP2CioView = AP2CioView;

})(typeof window !== 'undefined' ? window : this);
