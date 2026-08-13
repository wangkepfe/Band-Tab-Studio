/* ============================================================================
 * store.js  —  the browser's local durable layer for CLOUD mode (IndexedDB).
 *
 * The cloud build's source of truth for the OPEN DOCUMENT is this database, not
 * the server: anyone (logged out included) may edit any project on screen, and
 * only PERSISTENCE is gated behind GitHub login. That means the in-progress edit
 * has to survive a full-page navigation to github.com and back — so every write
 * here resolves on the transaction's `complete` event, never on a request's
 * `success`. A transaction still open when the document navigates is NOT
 * guaranteed to commit; awaiting `complete` is the entire reason the work lives.
 *
 *   StudioStore.ready()                    -> Promise<void>   (never rejects)
 *   StudioStore.available()                -> bool   false => memory-only, warn
 *   StudioStore.backend()                  -> 'opening'|'indexeddb'|'memory'|'off'
 *   StudioStore.mintDraftId()              -> 'local_' + 24 hex
 *   StudioStore.newId(n)                   -> n hex chars (default 12)
 *   StudioStore.putDoc(rec) / getDoc(key) / getDocByServerId(id)
 *   StudioStore.listDocs() / deleteDoc(key) / pruneDocs(now)
 *   StudioStore.putIntent(i) / getIntent() / clearIntent()
 *   StudioStore.kvGet(k) / kvSet(k, v) / kvDel(k)
 *   StudioStore.outboxAdd(e) / outboxList() / outboxDelete(seq) / outboxClear()
 *   StudioStore.markViewed(projectId, now) -> bool  (send the view, or suppress)
 *   StudioStore.onDocChanged(fn)           -> cross-tab notice
 *
 * Object stores (database 'studio', version 1):
 *   docs    keyPath 'key'  — one record per open document, the thing that must
 *                            survive the OAuth round trip.
 *                            { key, id, serverId, baseVersion, ownerId, name,
 *                              doc, updated, sha, dirty }
 *                            `doc` is EXACTLY serializeMeta()'s output
 *                            (app.js:479-490), stored as a structured clone.
 *                            indexes: updated, serverId
 *   intent  keyPath 'id'   — at most one record, id 'pending': what the user
 *                            asked for right before we sent them to GitHub.
 *   kv      keyPath 'k'    — small flags (last opened draft, schema marker).
 *   outbox  keyPath 'seq', autoIncrement — durable retry queue for writes that
 *                            failed while offline (state S6). indexes: draftKey, at
 *
 * ALL timestamps are UNIX SECONDS (Math.floor(Date.now()/1000)). app.js:710
 * renders them with new Date(t * 1000) — milliseconds would render as year 57000,
 * so every timestamp that enters this module is passed through secs().
 *
 * INERT OUTSIDE CLOUD MODE. The desktop backend serves this same index.html
 * (server/app.py mounts tab-studio/web at /), so this file also executes under
 * mode 'desktop' and mode 'web'. There it returns a no-op stub of the same shape
 * and opens NOTHING — no database, no BroadcastChannel, no localStorage — because
 * a second writer racing the FastAPI PUT (app.js:492 doSave) is exactly the bug
 * that would corrupt the committed projects/ folder.
 * ========================================================================== */
var StudioStore = (function () {
  'use strict';

  // ---- mode gate: FIRST statement, before anything can arm itself ----------
  var MODE = (window.STUDIO_CONFIG && window.STUDIO_CONFIG.mode) || 'desktop';
  if (MODE !== 'cloud') return inert();

  var DB_NAME = 'studio', DB_VERSION = 1;
  var DOCS = 'docs', INTENT = 'intent', KV = 'kv', OUTBOX = 'outbox';
  var INTENT_ID = 'pending';                 // there is only ever one intent
  var INTENT_TTL_SEC = 86400;                // 24 h — a stale intent must never
                                             // replay onto a project opened days later
  var DRAFT_TTL_SEC = 7 * 86400;             // saved+clean drafts expire after 7 days;
                                             // NEVER-SAVED drafts are kept forever
  var VIEW_FLOOR_SEC = 600;                  // client mirror of the server's 10-min
                                             // recent_views floor (0 rows written)
  var VIEW_KEY = 'studio.viewed.';
  var VIEW_SWEEP_SEC = 90 * 86400;           // drop view stamps older than the
                                             // server's 90-day history window
  var OPEN_TIMEOUT_MS = 4000;                // Safari private mode can hang open()

  var db = null;                             // live IDBDatabase, or null
  var openPromise = null;                    // ready()'s single promise
  var opening = true;                        // true until open() settles
  var lastErr = null;
  var chan = null, docListeners = [];
  var TAB_ID = hex(8);                       // so a tab can ignore its own echo
  // In-memory shim: the whole database, used when IndexedDB is unavailable
  // (private-mode Safari, blocked storage). The editor stays fully usable and
  // available() reports false so the UI can warn instead of losing edits quietly.
  var mem = { docs: {}, intent: null, kv: {}, outbox: [], seq: 1 };
  var viewMem = {};                          // localStorage fallback for view stamps

  // ===========================================================================
  // ids + time
  // ===========================================================================
  // crypto.randomUUID is UNDEFINED outside a secure context — file:// and plain
  // http:// both lack it, and release-web.bat documents dropping dist/ on any
  // static host — so feature-detect all the way down to Math.random rather than
  // assuming HTTPS. Output is hex, which satisfies [A-Za-z0-9_-]{1,64}.
  function hex(n) {
    var H = '0123456789abcdef', out = '', i, C = null;
    n = Math.max(1, Math.min(64, n | 0)) || 12;
    try { C = (typeof crypto !== 'undefined' && crypto) || window.msCrypto || null; } catch (e) { C = null; }
    if (C && typeof C.randomUUID === 'function' && n <= 32) {
      try { out = C.randomUUID().replace(/-/g, ''); } catch (e1) { out = ''; }
    }
    if (out.length < n && C && typeof C.getRandomValues === 'function') {
      try {
        var buf = new Uint8Array(Math.ceil(n / 2));
        C.getRandomValues(buf);
        out = '';
        for (i = 0; i < buf.length; i++) out += H.charAt(buf[i] >> 4) + H.charAt(buf[i] & 15);
      } catch (e2) { out = ''; }
    }
    while (out.length < n) out += H.charAt((Math.random() * 16) | 0);
    return out.slice(0, n);
  }
  function newId(n) { return hex(n == null ? 12 : n); }
  // The draft key is the IndexedDB key AND the Idempotency-Key on create/fork.
  // It is NEVER used as a projects.id — the server mints those (see the contract's
  // id-minting section: a client-chosen global id is a namespace grab).
  function mintDraftId() { return 'local_' + hex(24); }
  function nowSec() { return Math.floor(Date.now() / 1000); }
  // Accepts seconds, tolerates a caller who handed us milliseconds, rejects junk.
  function secs(t) {
    var n = Number(t);
    if (!isFinite(n) || n <= 0) return 0;
    if (n > 1e11) n = n / 1000;               // 1e11 s is year 5138 — that was ms
    return Math.floor(n);
  }

  // ===========================================================================
  // open / degrade
  // ===========================================================================
  function ready() {
    if (!openPromise) openPromise = open();
    return openPromise;
  }

  function open() {
    return new Promise(function (resolve) {
      var idb = null;
      try { idb = window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || null; } catch (e) { idb = null; }
      if (!idb) { degrade(new Error('IndexedDB unavailable'), resolve); return; }

      var req;
      // Firefox private browsing throws here rather than firing onerror.
      try { req = idb.open(DB_NAME, DB_VERSION); } catch (e2) { degrade(e2, resolve); return; }

      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        // Safari in private mode (and an old version pinned open by another tab)
        // can leave open() hanging forever with neither success nor error. Degrade
        // now so the editor is usable; adopt() folds our memory writes back in if
        // the request does eventually land.
        degrade(new Error('IndexedDB open timed out'), resolve);
      }, OPEN_TIMEOUT_MS);

      req.onupgradeneeded = function () { upgrade(req.result); };
      req.onblocked = function () { lastErr = new Error('IndexedDB upgrade blocked by another tab'); };
      req.onsuccess = function () {
        var d = req.result;
        d.onversionchange = function () {
          // Another tab is upgrading. Let go of the handle rather than blocking it,
          // and fall back to memory so in-flight edits still have somewhere to go.
          try { d.close(); } catch (e3) {}
          if (db === d) { db = null; lastErr = new Error('database closed by another tab'); }
        };
        d.onclose = function () { if (db === d) { db = null; lastErr = new Error('database connection closed'); } };
        if (settled) { adopt(d); return; }     // late success after the timeout
        settled = true; clearTimeout(timer);
        db = d; opening = false;
        resolve();
      };
      req.onerror = function () {
        if (settled) return;
        settled = true; clearTimeout(timer);
        degrade(req.error || new Error('IndexedDB open failed'), resolve);
      };
    });
  }

  function upgrade(d) {
    if (!d.objectStoreNames.contains(DOCS)) {
      var docs = d.createObjectStore(DOCS, { keyPath: 'key' });
      docs.createIndex('updated', 'updated', { unique: false });   // listDocs order
      docs.createIndex('serverId', 'serverId', { unique: false });  // draft <-> project
    }
    if (!d.objectStoreNames.contains(INTENT)) d.createObjectStore(INTENT, { keyPath: 'id' });
    if (!d.objectStoreNames.contains(KV)) d.createObjectStore(KV, { keyPath: 'k' });
    if (!d.objectStoreNames.contains(OUTBOX)) {
      var ob = d.createObjectStore(OUTBOX, { keyPath: 'seq', autoIncrement: true });
      ob.createIndex('draftKey', 'draftKey', { unique: false });
      ob.createIndex('at', 'at', { unique: false });
    }
  }

  function degrade(err, resolve) {
    db = null; opening = false; lastErr = err || null;
    try { console.warn('[store] IndexedDB unavailable — edits are memory-only this session:', err && err.message); } catch (e) {}
    if (resolve) resolve();
  }

  // The database showed up after we had already fallen back. Push whatever the
  // memory shim collected in the meantime into it, then switch over.
  function adopt(d) {
    try {
      var t = d.transaction([DOCS, INTENT, KV], 'readwrite');
      var ds = t.objectStore(DOCS), k;
      for (k in mem.docs) { if (Object.prototype.hasOwnProperty.call(mem.docs, k)) ds.put(mem.docs[k]); }
      if (mem.intent) t.objectStore(INTENT).put(mem.intent);
      var ks = t.objectStore(KV);
      for (k in mem.kv) { if (Object.prototype.hasOwnProperty.call(mem.kv, k)) ks.put({ k: k, v: mem.kv[k] }); }
      t.oncomplete = function () { db = d; lastErr = null; };
    } catch (e) { try { d.close(); } catch (e2) {} }
  }

  function available() { return !!db; }
  function backend() { return opening ? 'opening' : (db ? 'indexeddb' : 'memory'); }
  function lastError() { return lastErr; }

  // ===========================================================================
  // transaction helper
  // ===========================================================================
  // Runs fn(transaction, box) and resolves with box.value ON THE TRANSACTION'S
  // `complete` EVENT — never on a request's `success`. Callers that await this
  // before navigating (the login gate, state S2) are therefore guaranteed the
  // write actually committed.
  function txn(names, mode, fn) {
    return new Promise(function (resolve, reject) {
      var t, box = { value: undefined };
      try { t = db.transaction(names, mode); }
      catch (e) { reject(fail(e)); return; }
      t.oncomplete = function () { resolve(box.value); };
      t.onabort = t.onerror = function () { reject(fail(t.error || new Error('transaction aborted'))); };
      try { fn(t, box); }
      catch (e2) { try { t.abort(); } catch (e3) {} reject(fail(e2)); }
    });
  }

  function fail(e) {
    var err = (e instanceof Error) ? e : new Error(String((e && e.message) || e || 'store error'));
    err.code = (e && e.name === 'QuotaExceededError') ? 'quota'
      : (e && (e.name === 'InvalidStateError' || e.name === 'NotFoundError')) ? 'store_closed' : 'store_error';
    lastErr = err;
    // A closed / missing database can never recover inside this page; drop to the
    // memory shim so the NEXT write lands somewhere instead of failing forever.
    if (err.code === 'store_closed') db = null;
    return err;
  }

  function get1(store, key, box) { var r = store.get(key); r.onsuccess = function () { box.value = r.result || null; }; }
  function clone(o) {
    if (o == null) return o;
    try { if (typeof structuredClone === 'function') return structuredClone(o); } catch (e) {}
    try { return JSON.parse(JSON.stringify(o)); } catch (e2) { return o; }
  }

  // ===========================================================================
  // docs — the open document, and every parked draft
  // ===========================================================================
  // Accepts either `key` or `id` as the draft key (the stored record carries both,
  // so a reader written against either name works) and normalises every field so a
  // half-built record from a caller can never poison the store.
  function normDoc(rec) {
    rec = rec || {};
    var key = String(rec.key || rec.id || mintDraftId());
    return {
      key: key,
      id: key,
      serverId: rec.serverId || null,
      baseVersion: (typeof rec.baseVersion === 'number' && isFinite(rec.baseVersion)) ? rec.baseVersion : null,
      ownerId: rec.ownerId || null,
      name: (rec.name == null ? '' : String(rec.name)) || 'Untitled',
      doc: rec.doc || null,
      updated: secs(rec.updated) || nowSec(),
      sha: rec.sha ? String(rec.sha) : '',
      dirty: !!rec.dirty
    };
  }

  function putDoc(rec) {
    var r = normDoc(rec);
    return ready().then(function () {
      if (!db) { mem.docs[r.key] = clone(r); announce(r.key, r.updated); return; }
      return txn([DOCS], 'readwrite', function (t) { t.objectStore(DOCS).put(r); })
        .then(function () { announce(r.key, r.updated); });
    });
  }

  function getDoc(key) {
    if (!key) return Promise.resolve(null);
    key = String(key);
    return ready().then(function () {
      if (!db) return clone(mem.docs[key] || null);
      return txn([DOCS], 'readonly', function (t, box) { get1(t.objectStore(DOCS), key, box); });
    });
  }

  // Which local draft (if any) belongs to a server project — used when reopening a
  // project the user has unsent edits for. Newest wins if there are several.
  function getDocByServerId(serverId) {
    if (!serverId) return Promise.resolve(null);
    serverId = String(serverId);
    return listDocs().then(function (rows) {
      for (var i = 0; i < rows.length; i++) if (rows[i].serverId === serverId) return rows[i];
      return null;
    });
  }

  function listDocs() {
    return ready().then(function () {
      var out = [], k;
      if (!db) {
        for (k in mem.docs) { if (Object.prototype.hasOwnProperty.call(mem.docs, k)) out.push(clone(mem.docs[k])); }
        return sortDocs(out);
      }
      return txn([DOCS], 'readonly', function (t, box) {
        var r = t.objectStore(DOCS).getAll ? t.objectStore(DOCS).getAll() : null;
        if (r) { r.onsuccess = function () { box.value = sortDocs(r.result || []); }; return; }
        // getAll is missing on old Safari/IE — walk a cursor instead.
        var rows = [];
        t.objectStore(DOCS).openCursor().onsuccess = function (e) {
          var c = e.target.result;
          if (!c) { box.value = sortDocs(rows); return; }
          rows.push(c.value); c.continue();
        };
      });
    });
  }
  function sortDocs(rows) { return rows.sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); }); }

  function deleteDoc(key) {
    if (!key) return Promise.resolve();
    key = String(key);
    return ready().then(function () {
      if (!db) { delete mem.docs[key]; announce(key, nowSec()); return; }
      return txn([DOCS], 'readwrite', function (t) { t.objectStore(DOCS).delete(key); })
        .then(function () { announce(key, nowSec()); });
    });
  }

  // Retention: a draft that is SAVED (serverId set) and CLEAN is redundant with the
  // server after 7 days, so it goes. A draft that was never saved is the user's only
  // copy — it is kept indefinitely and surfaced under "On this device". Deleting
  // someone's only copy of unsaved work on a timer is not acceptable.
  function pruneDocs(at) {
    var cutoff = (secs(at) || nowSec()) - DRAFT_TTL_SEC;
    return ready().then(function () {
      var removed = 0, k, r;
      if (!db) {
        for (k in mem.docs) {
          if (!Object.prototype.hasOwnProperty.call(mem.docs, k)) continue;
          r = mem.docs[k];
          if (r && r.serverId && !r.dirty && (r.updated || 0) < cutoff) { delete mem.docs[k]; removed++; }
        }
        return removed;
      }
      return txn([DOCS], 'readwrite', function (t, box) {
        t.objectStore(DOCS).openCursor().onsuccess = function (e) {
          var c = e.target.result;
          if (!c) { box.value = removed; return; }
          var v = c.value;
          if (v && v.serverId && !v.dirty && (v.updated || 0) < cutoff) { c.delete(); removed++; }
          c.continue();
        };
      });
    });
  }

  // ===========================================================================
  // intent — "what the user pressed right before we sent them to GitHub"
  // ===========================================================================
  function normIntent(i) {
    i = i || {};
    var at = secs(i.at) || nowSec();
    return {
      id: INTENT_ID,
      kind: (i.kind === 'fork' || i.kind === 'create') ? i.kind : 'save',
      draftKey: i.draftKey ? String(i.draftKey) : null,
      projectId: i.projectId ? String(i.projectId) : null,
      at: at,
      ttl: secs(i.ttl) || (at + INTENT_TTL_SEC)
    };
  }

  function putIntent(i) {
    var rec = normIntent(i);
    return ready().then(function () {
      if (!db) { mem.intent = clone(rec); return; }
      return txn([INTENT], 'readwrite', function (t) { t.objectStore(INTENT).put(rec); });
    });
  }

  // Returns null once the TTL has passed, and clears the expired record on the way
  // out — resume() must never replay a day-old intent onto whatever is open now.
  function getIntent() {
    return ready().then(function () {
      if (!db) return clone(mem.intent || null);
      return txn([INTENT], 'readonly', function (t, box) { get1(t.objectStore(INTENT), INTENT_ID, box); });
    }).then(function (rec) {
      if (!rec) return null;
      if ((rec.ttl || 0) < nowSec()) { clearIntent(); return null; }
      return rec;
    });
  }

  function clearIntent() {
    return ready().then(function () {
      if (!db) { mem.intent = null; return; }
      return txn([INTENT], 'readwrite', function (t) { t.objectStore(INTENT).delete(INTENT_ID); });
    });
  }

  // ===========================================================================
  // kv — small flags
  // ===========================================================================
  function kvGet(k) {
    if (!k) return Promise.resolve(null);
    k = String(k);
    return ready().then(function () {
      // Both branches yield the STORED RECORD ({k, v}); the unwrap below is the one
      // place the value comes back out, so a falsy value (0, '', false) survives.
      if (!db) return (k in mem.kv) ? { k: k, v: clone(mem.kv[k]) } : null;
      return txn([KV], 'readonly', function (t, box) { get1(t.objectStore(KV), k, box); });
    }).then(function (rec) { return rec ? (rec.v === undefined ? null : rec.v) : null; });
  }

  function kvSet(k, v) {
    if (!k) return Promise.resolve();
    k = String(k);
    return ready().then(function () {
      if (!db) { mem.kv[k] = clone(v); return; }
      return txn([KV], 'readwrite', function (t) { t.objectStore(KV).put({ k: k, v: v }); });
    });
  }

  function kvDel(k) {
    if (!k) return Promise.resolve();
    k = String(k);
    return ready().then(function () {
      if (!db) { delete mem.kv[k]; return; }
      return txn([KV], 'readwrite', function (t) { t.objectStore(KV).delete(k); });
    });
  }

  // ===========================================================================
  // outbox — durable retry queue for writes that failed (state S6)
  // ===========================================================================
  // Not on the happy path: sync.js retries in memory first. This exists so a save
  // that failed while offline is still queued after a reload, instead of the user
  // discovering at close time that nothing ever reached the server.
  function normOut(e) {
    e = e || {};
    return {
      kind: e.kind ? String(e.kind) : 'save',
      draftKey: e.draftKey ? String(e.draftKey) : null,
      projectId: e.projectId ? String(e.projectId) : null,
      baseVersion: (typeof e.baseVersion === 'number' && isFinite(e.baseVersion)) ? e.baseVersion : null,
      name: e.name ? String(e.name) : '',
      at: secs(e.at) || nowSec(),
      tries: (e.tries | 0) || 0,
      lastError: e.lastError ? String(e.lastError) : ''
    };
  }

  function outboxAdd(entry) {
    var rec = normOut(entry);
    return ready().then(function () {
      if (!db) { rec.seq = mem.seq++; mem.outbox.push(clone(rec)); return rec.seq; }
      return txn([OUTBOX], 'readwrite', function (t, box) {
        var r = t.objectStore(OUTBOX).add(rec);
        r.onsuccess = function () { box.value = r.result; };
      });
    });
  }

  function outboxList() {
    return ready().then(function () {
      if (!db) return mem.outbox.map(clone);
      return txn([OUTBOX], 'readonly', function (t, box) {
        var st = t.objectStore(OUTBOX), rows = [];
        if (st.getAll) { var r = st.getAll(); r.onsuccess = function () { box.value = r.result || []; }; return; }
        st.openCursor().onsuccess = function (e) {
          var c = e.target.result;
          if (!c) { box.value = rows; return; }
          rows.push(c.value); c.continue();
        };
      });
    });
  }

  function outboxDelete(seq) {
    if (seq == null) return Promise.resolve();
    return ready().then(function () {
      if (!db) {
        mem.outbox = mem.outbox.filter(function (e) { return e.seq !== seq; });
        return;
      }
      return txn([OUTBOX], 'readwrite', function (t) { t.objectStore(OUTBOX).delete(seq); });
    });
  }

  function outboxClear() {
    return ready().then(function () {
      if (!db) { mem.outbox = []; return; }
      return txn([OUTBOX], 'readwrite', function (t) { t.objectStore(OUTBOX).clear(); });
    });
  }

  // ===========================================================================
  // recently-viewed dedupe (localStorage, layer 2 of 3)
  // ===========================================================================
  // Layer 1 is "anonymous users send nothing"; layer 3 is the server's ON CONFLICT
  // floor. This layer suppresses the REQUEST as well as the row, so a user who
  // reloads a tab twenty times costs zero Worker invocations. Returns true when the
  // caller should POST /api/projects/:id/view, false to suppress.
  function markViewed(projectId, at) {
    if (!projectId) return false;
    at = secs(at) || nowSec();
    var k = VIEW_KEY + projectId;
    var prev = secs(lsGet(k));
    if (prev && (at - prev) < VIEW_FLOOR_SEC) return false;
    lsSet(k, String(at));
    return true;
  }

  function lsGet(k) {
    try { var v = window.localStorage.getItem(k); return v == null ? viewMem[k] : v; } catch (e) { return viewMem[k]; }
  }
  function lsSet(k, v) {
    viewMem[k] = v;                            // survives a throwing localStorage
    try { window.localStorage.setItem(k, v); } catch (e) {}
  }
  // View stamps are tiny but unbounded — a browser that opens hundreds of projects
  // would accumulate them forever. Swept once per session against the same 90-day
  // window the server's recent_views read query uses.
  function sweepViewStamps() {
    var cutoff = nowSec() - VIEW_SWEEP_SEC, kill = [], i, k;
    try {
      for (i = 0; i < window.localStorage.length; i++) {
        k = window.localStorage.key(i);
        if (k && k.indexOf(VIEW_KEY) === 0 && secs(window.localStorage.getItem(k)) < cutoff) kill.push(k);
      }
      for (i = 0; i < kill.length; i++) { window.localStorage.removeItem(kill[i]); delete viewMem[kill[i]]; }
    } catch (e) {}
  }

  // ===========================================================================
  // cross-tab notice
  // ===========================================================================
  // Two tabs editing the same draft is LAST-WRITE-WINS by design; this only lets
  // the other tab say so. Full reconciliation is explicitly out of scope.
  function openChannel() {
    if (typeof BroadcastChannel !== 'function') return;
    try { chan = new BroadcastChannel('studio-docs'); } catch (e) { chan = null; return; }
    chan.onmessage = function (e) {
      var m = e && e.data;
      if (!m || m.type !== 'doc-changed' || m.origin === TAB_ID) return;
      for (var i = 0; i < docListeners.length; i++) {
        try { docListeners[i](m); } catch (e2) {}
      }
    };
  }
  function announce(key, updated) {
    if (!chan) return;
    // BroadcastChannel does not echo to the posting context, so this reaches other
    // tabs only — which is exactly who needs to know.
    try { chan.postMessage({ type: 'doc-changed', key: key, id: key, updated: updated, origin: TAB_ID }); } catch (e) {}
  }
  function onDocChanged(fn) { if (typeof fn === 'function') docListeners.push(fn); }

  // ===========================================================================
  // boot
  // ===========================================================================
  openChannel();
  openPromise = open();
  openPromise.then(function () {
    sweepViewStamps();
    // Retention is a best-effort background chore; a failure here must never
    // surface to the user or block ready().
    return pruneDocs(nowSec()).catch(function () { return 0; });
  });

  return {
    ready: ready,
    available: available,
    backend: backend,
    lastError: lastError,
    newId: newId,
    mintDraftId: mintDraftId,
    nowSec: nowSec,
    putDoc: putDoc,
    getDoc: getDoc,
    getDocByServerId: getDocByServerId,
    listDocs: listDocs,
    deleteDoc: deleteDoc,
    pruneDocs: pruneDocs,
    putIntent: putIntent,
    getIntent: getIntent,
    clearIntent: clearIntent,
    kvGet: kvGet,
    kvSet: kvSet,
    kvDel: kvDel,
    outboxAdd: outboxAdd,
    outboxList: outboxList,
    outboxDelete: outboxDelete,
    outboxClear: outboxClear,
    markViewed: markViewed,
    onDocChanged: onDocChanged
  };

  // ===========================================================================
  // the inert stub (mode 'desktop' / 'web')
  // ===========================================================================
  // Same shape, same return types, zero side effects. markViewed() answers false so
  // no caller ever fires a view; available() answers false so the UI treats this as
  // "no local persistence" rather than believing a write landed.
  function inert() {
    function no() { return Promise.resolve(); }
    function nul() { return Promise.resolve(null); }
    return {
      ready: no,
      available: function () { return false; },
      backend: function () { return 'off'; },
      lastError: function () { return null; },
      newId: newId,
      mintDraftId: mintDraftId,
      nowSec: nowSec,
      putDoc: no,
      getDoc: nul,
      getDocByServerId: nul,
      listDocs: function () { return Promise.resolve([]); },
      deleteDoc: no,
      pruneDocs: function () { return Promise.resolve(0); },
      putIntent: no,
      getIntent: nul,
      clearIntent: no,
      kvGet: nul,
      kvSet: no,
      kvDel: no,
      outboxAdd: nul,
      outboxList: function () { return Promise.resolve([]); },
      outboxDelete: no,
      outboxClear: no,
      markViewed: function () { return false; },
      onDocChanged: function () {}
    };
  }
})();

// The contract names this module StudioStore; `Store` is the short alias the rest
// of the cloud UI can use. Both point at the same object in every mode.
var Store = StudioStore;
if (typeof window !== 'undefined') { window.StudioStore = StudioStore; window.Store = StudioStore; }
