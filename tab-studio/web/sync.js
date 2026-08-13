/* ============================================================================
 * sync.js — the cloud build's persistence engine: the local-first outbox that
 * sits between the editor and Api.
 *
 * The rules it exists to enforce:
 *   · every edit is safe on THIS DEVICE (IndexedDB) before anything touches the
 *     network — logged in or not;
 *   · login gates KEEPING work, never doing it, and the in-progress edit must
 *     survive the full-page round trip to github.com and back;
 *   · only the author (or admin) may save in place; everyone else forks;
 *   · nothing is ever discarded to resolve a conflict — both sides survive;
 *   · writes are rationed: 10 s after the last edit, 60 s ceiling while typing,
 *     and a sha no-op check so an idle tab writes ZERO rows.
 *
 * INERT unless STUDIO_CONFIG.mode === 'cloud': init() returns immediately, no
 * timers, no listeners, no locks, no network. The 'web' and 'desktop' builds are
 * completely unaffected by this file being present.
 *
 *   Sync.init(hooks)                 wire the editor in (see HOOKS below)
 *   Sync.noteEdit()                  every edit funnels here (scheduleSave)
 *   Sync.requestSave() / requestFork() / requestNew() / requestRename(name)
 *                                    (requestDuplicate is an alias of requestFork)
 *   Sync.openProject(id) / openDraft(key) / listLibrary(opts) / listDrafts()
 *   Sync.resume()                    boot: ?resume=<draft> then ?p=<project>
 *   Sync.resolveConflict('keep-mine'|'copy'|'take-theirs')
 *   Sync.adoptLocalDocs()            claim anonymous work after login
 *   Sync.flush() / retryNow() / state() / signIn() / signOut() / user()
 * ========================================================================== */
var StudioSync = (function () {
  'use strict';

  var CFG   = window.STUDIO_CONFIG || {};
  var CLOUD = (CFG.mode === 'cloud');

  /* ---- cadence: these four constants ARE the write budget ---------------- */
  var LOCAL_DEBOUNCE_MS = 1200;    // edit -> IndexedDB
  var PUSH_DEBOUNCE_MS  = 10000;   // push 10 s after the LAST edit …
  var PUSH_MAX_WAIT_MS  = 60000;   // … but never wait more than 60 s while editing
  var PUSH_FLOOR_MS     = 10000;   // hard minimum between two PUTs of one project
  var BACKOFF_MS        = [2000, 6000, 20000, 60000];
  var INTENT_TTL_SEC    = 86400;

  var LOCK_NAME    = 'studio-sync-writer';
  var LEADER_KEY   = 'studio.sync.leader';
  var LEADER_TTL   = 15000, LEADER_BEAT = 5000;
  var CHANNEL      = 'studio-sync';

  /* ---- state ------------------------------------------------------------ */
  var inited = false, hk = null, userResolved = false;
  // TWO different questions, deliberately separated:
  //   hasStore — is StudioStore present at all? It always persists SOMETHING (it
  //              falls back to an in-memory map when IndexedDB is off), so every
  //              read/write path uses it unconditionally.
  //   durable  — did IndexedDB actually open? ONLY the login round trip cares:
  //              a memory-backed store does not survive navigating to github.com,
  //              so gate() must refuse rather than walk the user off a cliff.
  //              It is a CACHE of that answer and never the authority: store.js
  //              drops its handle from onversionchange / onclose and from any
  //              store_closed abort, so a database that opened cleanly at boot can
  //              be gone by the time Save is pressed. refreshDurable() re-asks.
  var hasStore = false, durable = false;
  var phase = 'idle';                 // idle|local-dirty|saving|saved|gated|resuming|conflict|error
  var draftKey = null;                // 'local_<24 hex>' — NEVER a project id
  var serverId = null, baseVersion = null, ownerId = null, canEditFlag = false;
  var dirty = false, user = null;
  var lastSyncedSha = '';             // sha of the bytes the server already holds
  // PER PROJECT, not global: the outbox drains every dirty draft in one pass, and a
  // single shared timestamp let a leader holding N drafts write N rows per tick.
  // PUSH_FLOOR_MS is the client half of the write budget, so it is keyed by project.
  var pushAt = {}, maxWaitAt = 0;
  var localTimer = null, pushTimer = null, retryTimer = null, retryN = 0;
  var persistChain = Promise.resolve();
  var warnedLocal = false;            // the "not storing locally" toast fires once
  var memRec = null;                  // mirror of the last snapshot, for pagehide
  var draining = false, blocked = {};  // draft keys parked awaiting a human
  var lastError = null, conflict = null;
  var isLeader = false, leaderId = null, leaderTimer = null, bc = null;

  /* ---- tiny helpers ----------------------------------------------------- */
  function nowSec() { return Math.floor(Date.now() / 1000); }
  function noop() {}
  function lastPushFor(id) { return (id && pushAt[id]) || 0; }
  function notePush(id) { if (id) pushAt[id] = Date.now(); }
  // The LIVE answer to "does IndexedDB still work", not init()'s boot snapshot.
  // store.js drops its handle from onversionchange / onclose and from fail() on any
  // store_closed abort, so a database that opened fine at boot can be gone by the
  // time the user presses Save. Everything that would navigate away asks again.
  function refreshDurable() {
    if (!hasStore) { durable = false; return Promise.resolve(false); }
    var p = (StudioStore.ready ? StudioStore.ready() : Promise.resolve());
    return p.then(function () {
      durable = !!(StudioStore.available && StudioStore.available());
      return durable;
    }, function () { durable = false; return false; });
  }
  function isDraftId(id) { return typeof id === 'string' && id.indexOf('local_') === 0; }
  function log(e) { if (window.console && console.warn) console.warn('[sync]', e && (e.code || e.message) || e); }

  // Every hook is optional: a partially wired integration degrades instead of
  // throwing halfway through a save.
  function bindHooks(h) {
    h = h || {};
    function fn(name, dflt) { return typeof h[name] === 'function' ? h[name] : dflt; }
    return {
      serializeMeta:   fn('serializeMeta', function () { return {}; }),
      serializeActive: fn('serializeActive', noop),
      loadProjectMeta: fn('loadProjectMeta', noop),
      setProjectId:    fn('setProjectId', noop),
      getProjectId:    fn('getProjectId', function () { return serverId; }),
      getName:         fn('getName', function () { return ''; }),
      setName:         fn('setName', noop),
      markSave:        fn('markSave', noop),
      flash:           fn('flash', noop),
      setDirty:        fn('setDirty', noop),
      onState:         fn('onState', noop),
      suppressUnload:  fn('suppressUnload', noop)
    };
  }

  function setPhase(p) { phase = p; emit(); }
  function emit() { try { hk.onState(state()); } catch (e) { log(e); } }
  function state() {
    return {
      phase: phase, dirty: dirty, projectId: serverId, draftKey: draftKey,
      ownerId: ownerId, canEdit: canEditFlag, version: baseVersion,
      lastError: lastError, conflict: conflict, user: user, leader: isLeader
    };
  }
  function canPut() { return !!(user && serverId && canEditFlag); }
  // resume() normally resolves the session at boot. openProject/openDraft can be
  // reached without it (a deep link handled by app.js, a test), and getting
  // `user` wrong there would silently disable every push — so resolve it once,
  // lazily. Zero rows written, and skipped entirely on the normal boot path.
  function ensureUser() {
    if (userResolved) return Promise.resolve(user);
    return StudioApi.me().then(function (m) {
      userResolved = true; user = m.user || null; emit(); return user;
    }, function () { return user; });
  }
  // Layer 1 of the recently-viewed suppression stack: an anonymous reader sends
  // NOTHING — not a request, let alone a row. (Layer 2 is StudioStore.markViewed
  // inside Api.recordView, layer 3 is the server's 10-minute floor.)
  function recordView(id) { if (user && id) StudioApi.recordView(id); }

  /* ====================== identity ====================== */
  // draftKey is minted CLIENT-side and is the IndexedDB key AND the
  // Idempotency-Key. It is NEVER used as a projects.id — the server mints those,
  // which is what stops a client squatting a short memorable global id.
  function mintKey() {
    if (hasStore && StudioStore.mintDraftId) return StudioStore.mintDraftId();
    var s = '', i;
    for (i = 0; i < 24; i++) s += '0123456789abcdef'[(Math.random() * 16) | 0];
    return 'local_' + s;
  }
  function adoptIdentity(o) {
    draftKey    = o.draftKey || draftKey || mintKey();
    serverId    = ('serverId'    in o) ? o.serverId    : serverId;
    baseVersion = ('baseVersion' in o) ? o.baseVersion : baseVersion;
    ownerId     = ('ownerId'     in o) ? o.ownerId     : ownerId;
    canEditFlag = ('canEdit'     in o) ? !!o.canEdit   : canEditFlag;
    if ('sha' in o) lastSyncedSha = o.sha || '';
    // app.js:612 copies meta.id into the live model — the fork-breaker. In cloud
    // mode the server identity belongs to sync.js, so re-assert it every time.
    hk.setProjectId(serverId);
    emit();
  }
  function cardIdentity(card) {
    if (!card) return {};
    return {
      serverId: card.id, baseVersion: card.version || 1, ownerId: card.ownerId || null,
      canEdit: !!card.canEdit || !!(user && user.isAdmin)
    };
  }

  /* ====================== the local document ====================== */
  function snapshot() {
    hk.serializeActive();               // MANDATORY (app.js:496): drum events, note
                                        // edits, fingering overrides and the guitar
                                        // sub-view live in the views until this flush
    var doc = hk.serializeMeta() || {};
    doc.id = serverId || null;          // never the draft key
    var nm = (hk.getName() || doc.name || 'Untitled');
    doc.name = nm;
    return doc;
  }
  function recFrom(doc, sha) {
    return {
      key: draftKey, serverId: serverId, baseVersion: baseVersion, ownerId: ownerId,
      name: doc.name || 'Untitled', doc: doc, updated: nowSec(), sha: sha || '', dirty: dirty
    };
  }
  // Serialize + persist to IndexedDB. The returned promise resolves only once the
  // TRANSACTION has committed (StudioStore.putDoc's contract) — the whole
  // logged-out flow rests on that guarantee.
  //
  // Resolves { rec, persisted, error } and NEVER rejects, because persistChain has
  // to stay green for the next edit. `persisted` is the load-bearing field: false
  // means the record reached MEMORY ONLY — a QuotaExceededError, a store_closed
  // abort, or no StudioStore at all. Reporting that as success is how gate() came
  // to navigate to github.com with the user's edit committed nowhere, so nothing
  // in here may claim a write it did not get.
  function persistLocal() {
    if (!draftKey) draftKey = mintKey();
    var doc = snapshot();
    persistChain = persistChain.then(function () {
      return StudioApi.shaMeta(doc).then(function (sha) {
        var rec = recFrom(doc, sha);
        memRec = rec;                       // the mirror flushUnload/pendingDocs use
        // No store at all: init()'s ready() check has already told the user this
        // browser is not persisting, and gate() refuses on the same fact.
        if (!hasStore) return { rec: rec, persisted: false, error: null };
        return StudioStore.putDoc(rec).then(
          function () {
            post({ type: 'wake' });
            // putDoc RESOLVES against store.js's in-memory shim as readily as against
            // IndexedDB (its `if (!db)` branch), so a resolved promise on its own does
            // not mean the bytes are on disk. available() is the only honest answer,
            // and `persisted` has to mean DURABLE — gate() decides on it.
            durable = !!(StudioStore.available && StudioStore.available());
            return { rec: rec, persisted: durable, error: null };
          },
          function (e) { return localWriteFailed(rec, e); }
        );
      });
    }).catch(function (e) {
      // serializeMeta / shaMeta threw: there is no record to hand back this time.
      return localWriteFailed(memRec, e);
    });
    return persistChain;
  }
  // Warned ONCE per session, not once per keystroke: the local debounce runs every
  // 1.2 s while the user types and a toast storm would bury the message.
  function localWriteFailed(rec, e) {
    lastError = (e && e.message) ? e : new Error('local write did not commit');
    log(lastError);
    durable = false;                        // whatever the boot snapshot said
    if (!warnedLocal) {
      warnedLocal = true;
      hk.flash('This browser stopped storing your work on this device — your edits are only in this tab. Use "Save file" to keep them.');
    }
    emit();
    return { rec: rec || null, persisted: false, error: lastError };
  }
  function scheduleLocal() {
    clearTimeout(localTimer);
    localTimer = setTimeout(function () { localTimer = null; persistLocal(); }, LOCAL_DEBOUNCE_MS);
  }

  /* ====================== edit cadence ====================== */
  function noteEdit() {
    if (!CLOUD || !inited) return;
    dirty = true; hk.setDirty(true);
    if (phase !== 'conflict' && phase !== 'gated' && phase !== 'resuming') setPhase('local-dirty');
    hk.markSave(canPut() ? '•' : (user ? 'on this device' : 'on this device — sign in to keep'));
    scheduleLocal();
    schedulePush();
  }
  // 10 s after the last edit, and never later than 60 s into a continuous edit —
  // so a long uninterrupted session still checkpoints, and a burst of edits still
  // collapses into one write.
  function schedulePush() {
    if (!canPut()) return;                       // logged out / not the author: local only
    var now = Date.now();
    if (!maxWaitAt) maxWaitAt = now + PUSH_MAX_WAIT_MS;
    var due = Math.min(now + PUSH_DEBOUNCE_MS, maxWaitAt);
    due = Math.max(due, lastPushFor(serverId) + PUSH_FLOOR_MS);   // per-project floor
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { pushTimer = null; maxWaitAt = 0; drain(); }, Math.max(0, due - now));
  }
  function cancelPush() { clearTimeout(pushTimer); pushTimer = null; maxWaitAt = 0; }
  // Re-run the outbox once a floor expires. Shares retryTimer with stall(), so a
  // backoff already in flight wins and exactly one timer ever owns the next drain.
  function scheduleDrain(ms) {
    if (retryTimer) return;
    retryTimer = setTimeout(function () { retryTimer = null; drain(); }, Math.max(0, ms || PUSH_FLOOR_MS));
  }

  /* ====================== the outbox ====================== */
  // There is no separate outbox store: the outbox IS the set of dirty docs in
  // IndexedDB. Any tab can fill it; exactly one tab (the leader) drains it, so two
  // windows on the same project never race each other into a conflict.
  function pendingDocs() {
    if (!user) return Promise.resolve([]);
    if (!hasStore) return Promise.resolve(memRec && memRec.dirty && memRec.serverId ? [memRec] : []);
    return StudioStore.listDocs().then(function (recs) {
      return (recs || []).filter(function (r) {
        return r && r.dirty && r.serverId && !blocked[r.key] &&
               (r.ownerId === user.id || user.isAdmin);
      });
    }, function () { return []; });
  }
  function drain() {
    if (!CLOUD || !inited || draining || !user) return Promise.resolve();
    if (!isLeader) { post({ type: 'wake' }); return Promise.resolve(); }
    draining = true;
    var deferred = false;
    return (dirty ? persistLocal() : Promise.resolve())
      .then(pendingDocs)
      .then(function (list) {
        return list.reduce(function (chain, rec) {
          return chain.then(function () {
            // The floor applies to EVERY document this loop touches, not just the
            // one this tab has open. With a single shared timestamp a leader holding
            // 20 dirty drafts wrote 20 PUTs (40 rows) per tick — 5.7x the daily cap
            // in a runaway tab. Skip the ones still inside their floor and come back.
            if (Date.now() - lastPushFor(rec.serverId) < PUSH_FLOOR_MS) { deferred = true; return undefined; }
            return pushDoc(rec);
          });
        }, Promise.resolve());
      })
      .catch(function (e) { lastError = e; log(e); })
      .then(function () {
        draining = false;
        if (deferred) scheduleDrain(PUSH_FLOOR_MS);
      });
  }

  function isCurrent(rec) { return !!rec && rec.key === draftKey; }

  // A record whose baseVersion is unknown — openDraft() restores `rec.baseVersion ||
  // null`, and an older stored draft may never have had one — makes api.js omit
  // If-Match entirely, and saveRoute (routes.js:578) answers 412 precondition_failed.
  // That is PERMANENT, so it must be resolved rather than fed to the backoff ladder.
  // One /head read, zero rows written.
  function ensureBaseVersion(rec) {
    if (!rec || !rec.serverId || rec.baseVersion != null) return Promise.resolve(rec);
    return StudioApi.getHead(rec.serverId).then(function (head) {
      rec.baseVersion = head.version || null;
      if (isCurrent(rec)) { baseVersion = rec.baseVersion; emit(); }
      return rec;
    });
  }

  function pushDoc(rec) {
    // A /head that will not answer is transient like any other network failure —
    // never a reason to reject out of drain()'s loop and strand the drafts behind it.
    return ensureBaseVersion(rec).then(function () { return pushDocNow(rec); },
                                       function (e) { return stall(rec, e); });
  }
  function pushDocNow(rec) {
    return StudioApi.shaMeta(rec.doc).then(function (sha) {
      // THE no-op brake, and the reason an idle tab writes zero rows however long
      // it sits open. It only applies to the document THIS tab holds, because only
      // that one has a known last-synced sha; a foreign draft another tab left dirty
      // is pushed on its owner's word. (rec.sha is the CURRENT bytes' sha, so it
      // cannot stand in for the synced one — and store.js whitelists record fields,
      // so an extra column would not survive a round trip anyway.)
      if (sha && isCurrent(rec) && sha === lastSyncedSha) return markClean(rec, rec.baseVersion, sha);
      if (isCurrent(rec)) { setPhase('saving'); hk.markSave('saving…'); }
      notePush(rec.serverId);
      return StudioApi.saveProject(rec.serverId, { meta: rec.doc, name: rec.name, ifMatch: rec.baseVersion })
        .then(function (res) {
          retryN = 0; lastError = null;
          return markClean(rec, res.version, sha).then(function () {
            post({ type: 'saved', projectId: rec.serverId, version: res.version, draftKey: rec.key });
            if (isCurrent(rec)) { setPhase('saved'); hk.markSave('saved ✓'); }
          });
        })
        .catch(function (e) { return onPushError(rec, sha, e); });
    });
  }

  function markClean(rec, version, sha) {
    rec.dirty = false; rec.baseVersion = version || rec.baseVersion; rec.sha = sha || rec.sha;
    delete rec.revalidated;             // the 412 one-shot guard; see onPushError
    rec.updated = nowSec();
    if (isCurrent(rec)) {
      dirty = false; baseVersion = rec.baseVersion; lastSyncedSha = rec.sha;
      hk.setDirty(false);
    }
    memRec = isCurrent(rec) ? rec : memRec;
    emit();
    return hasStore ? StudioStore.putDoc(rec).catch(function () {}) : Promise.resolve();
  }

  function onPushError(rec, sha, e) {
    lastError = e;
    if (e.code === 'conflict' || e.status === 409) return onConflict(rec, sha, e, false);
    if (e.code === 'precondition_failed' || e.status === 412) {
      // saveRoute demands If-Match, and api.js omits the header when baseVersion is
      // null. Retrying that unchanged just burns 2/6/20/60 s and then reports a
      // transient-looking failure for a permanent one. Resolve the version from
      // /head and push ONCE more; `revalidated` is a plain in-memory marker (store.js
      // whitelists record fields, so it never reaches IndexedDB) that stops this
      // becoming a loop.
      if (rec.revalidated) {
        block(rec, 'precondition_failed');
        if (isCurrent(rec)) { hk.markSave('save failed'); setPhase('error'); }
        hk.flash('Could not work out which version of this project you are editing — use "Duplicate" to keep your changes.');
        return Promise.resolve();
      }
      rec.revalidated = true;
      rec.baseVersion = null;
      return ensureBaseVersion(rec).then(function () { return pushDocNow(rec); },
                                         function (err) { return stall(rec, err); });
    }
    if (e.code === 'not_author' || e.status === 403) {
      // R4 meeting R1: the user never learns mid-flow that they were not allowed
      // to edit; they simply get their own copy, with lineage recorded.
      var who = (e.body && e.body.ownerName) || 'someone else';
      return forkFrom(rec, rec.name + ' (copy)', copyKey(rec)).then(function () {
        hk.flash('Saved as your copy — the original belongs to ' + who + '.');
      }, function (err) { return stall(rec, err); });
    }
    if (e.code === 'unauthenticated' || e.status === 401) {
      user = null; block(rec, 'unauthenticated');
      if (isCurrent(rec)) { hk.markSave('sign in to keep'); setPhase('error'); }
      hk.flash('Your session expired — your edits are safe on this device. Sign in to keep them.');
      return Promise.resolve();
    }
    if (e.code === 'payload_too_large' || e.status === 413) {
      block(rec, 'payload_too_large');
      if (isCurrent(rec)) { hk.markSave('too large'); setPhase('error'); }
      hk.flash('This project is too large to save to the cloud — use "Save file" to keep it.');
      return Promise.resolve();
    }
    // 429 (server save floor), 5xx and network failures are all transient.
    return stall(rec, e);
  }

  // Exponential backoff, then stop and wait for a human / an 'online' event.
  function stall(rec, e) {
    lastError = e;
    if (isCurrent(rec)) { hk.markSave('save failed — retrying'); setPhase('error'); }
    if (retryN >= BACKOFF_MS.length) {
      if (isCurrent(rec)) hk.markSave('save failed');
      return Promise.resolve();
    }
    var wait = BACKOFF_MS[retryN++];
    clearTimeout(retryTimer);
    retryTimer = setTimeout(function () { retryTimer = null; drain(); }, wait);
    return Promise.resolve();
  }
  function block(key, why) { var k = key && key.key ? key.key : key; blocked[k] = why || 1; }
  function unblock(k) { delete blocked[k]; }

  /* ====================== conflicts ====================== */
  // 409 handling, in order of how much it costs the user:
  //   1. the stored sha already equals ours — our own retry landed twice, or
  //      another tab pushed the identical bytes. Adopt the version, done.
  //   2. an EXPLICIT save -> hand the user the three-way choice (S5).
  //   3. anything automatic (the outbox, a background flush) -> conflictCopy():
  //      our bytes become a fork, theirs stay untouched. Nothing is discarded and
  //      nobody is interrupted.
  function onConflict(rec, sha, e, explicit) {
    return StudioApi.getHead(rec.serverId).then(function (head) {
      if (head.payloadSha && sha && head.payloadSha === sha) {
        return markClean(rec, head.version, sha).then(function () {
          if (isCurrent(rec)) { setPhase('saved'); hk.markSave('saved ✓'); }
        });
      }
      if (explicit) {
        conflict = {
          draftKey: rec.key, projectId: rec.serverId,
          serverVersion: head.version, serverUpdated: head.project && head.project.updated,
          serverName: (head.project && head.project.name) || rec.name
        };
        block(rec, 'conflict');
        if (isCurrent(rec)) { setPhase('conflict'); hk.markSave('conflict'); }
        hk.flash('This project changed elsewhere — choose what to keep.');
        return undefined;
      }
      return conflictCopy(rec, sha);
    }, function (err) { return stall(rec, err); });
  }

  // Keep BOTH sides. Theirs stays exactly where it is; ours becomes a new project
  // that records the original as its parent. The LOCAL draft key does not change —
  // the user keeps editing the same document, it just now points somewhere else.
  //
  // The idempotency key is derived from (draft, base version) rather than freshly
  // minted, so retrying a failed conflict copy returns the first fork instead of
  // minting a second one.
  function copyKey(rec, tag) { return (rec.key + '-' + (tag || 'c') + (rec.baseVersion || 0)).slice(0, 64); }
  function conflictCopy(rec, sha) {
    return forkFrom(rec, rec.name + ' (copy)', copyKey(rec), sha).then(function (card) {
      hk.flash('Saved as a copy — "' + rec.name + '" had changed on the server.');
      return card;
    }, function (e) { return stall(rec, e); });
  }

  // Fork rec's LOCAL bytes into a new project owned by the caller, then re-point
  // the draft at it. Used by Duplicate, by the not-author save, and by conflictCopy.
  function forkFrom(rec, name, idemKey, sha) {
    return StudioApi.forkProject(rec.serverId, { meta: rec.doc, name: name, idempotencyKey: idemKey })
      .then(function (res) {
        var card = res.project || {};
        rec.serverId = card.id; rec.baseVersion = res.version || 1;
        rec.ownerId = card.ownerId || (user && user.id) || null;
        rec.name = card.name || name;
        rec.doc.id = card.id;
        unblock(rec.key);
        return markClean(rec, rec.baseVersion, sha || rec.sha).then(function () {
          if (isCurrent(rec)) {
            conflict = null;
            adoptIdentity({ serverId: rec.serverId, baseVersion: rec.baseVersion, ownerId: rec.ownerId, canEdit: true });
            hk.setName(rec.name); setUrlProject(rec.serverId);
            setPhase('saved'); hk.markSave('saved ✓');
            recordView(rec.serverId);
          }
          post({ type: 'saved', projectId: rec.serverId, version: rec.baseVersion, draftKey: rec.key });
          return card;
        });
      });
  }

  // The explicit S5 outcomes. 'take-theirs' is the only one that drops anything,
  // and only the caller's own local copy, only on an explicit choice.
  function resolveConflict(choice) {
    if (!CLOUD || !conflict) return Promise.resolve();
    var key = conflict.draftKey;
    return loadRec(key).then(function (rec) {
      if (!rec) { conflict = null; unblock(key); emit(); return; }
      unblock(key);
      if (choice === 'copy') { conflict = null; return StudioApi.shaMeta(rec.doc).then(function (s) { return conflictCopy(rec, s); }); }
      if (choice === 'keep-mine') {
        return StudioApi.getHead(rec.serverId).then(function (head) {
          rec.baseVersion = head.version;
          conflict = null;
          return StudioApi.shaMeta(rec.doc).then(function (sha) {
            return StudioApi.saveProject(rec.serverId, { meta: rec.doc, name: rec.name, ifMatch: head.version })
              .then(function (res) {
                return markClean(rec, res.version, sha).then(function () {
                  post({ type: 'saved', projectId: rec.serverId, version: res.version, draftKey: rec.key });
                  if (isCurrent(rec)) { setPhase('saved'); hk.markSave('saved ✓'); }
                });
              // ONE retry only — a second 409 means a genuinely busy row, so we
              // stop guessing and copy rather than loop.
              }, function (e) { return (e.code === 'conflict') ? conflictCopy(rec, sha) : stall(rec, e); });
          });
        });
      }
      // take-theirs
      conflict = null;
      return StudioApi.getProject(rec.serverId).then(function (got) {
        applyMeta(got.meta, got.project, rec.key);
        if (hasStore) StudioStore.deleteDoc(rec.key).catch(function () {});
        draftKey = mintKey();
        // Promise<void> per the contract: persistLocal's {rec, persisted} report is
        // for the callers that must act on it, not for the public surface.
        return persistLocal().then(noop);
      });
    });
  }

  function loadRec(key) {
    if (!hasStore) return Promise.resolve(memRec && memRec.key === key ? memRec : null);
    return StudioStore.getDoc(key).catch(function () { return null; });
  }

  /* ====================== opening ====================== */
  // Applies a fetched/loaded document to the editor and re-asserts server identity
  // afterwards (loadProjectMeta ends by clearing dirty and by copying meta.id into
  // the model — both have to be undone here, in that order).
  function applyMeta(meta, card, key) {
    hk.loadProjectMeta(meta, null);           // TWO args: cloud projects carry no local audio
    draftKey = key || mintKey();
    var ident2 = card ? cardIdentity(card) : { serverId: null, baseVersion: null, ownerId: null, canEdit: !!user };
    dirty = false; hk.setDirty(false); conflict = null;
    adoptIdentity(ident2);
    hk.markSave(card ? (ident2.canEdit ? 'saved ✓' : 'read-only — Duplicate to keep changes') : '');
    setPhase('idle');
  }

  function openProject(id) {
    if (!CLOUD || !inited) return Promise.resolve();
    if (isDraftId(id)) return openDraft(id);
    setPhase('resuming');
    return ensureUser().then(function () { return existingDraftFor(id); }).then(function (hit) {
      // Unsaved local edits for this project outrank the stored copy: opening it
      // from the library must never quietly bury work parked on this device.
      if (hit && hit.dirty) {
        return openDraft(hit.key).then(function () { hk.flash('Reopened your unsaved edits for this project.'); });
      }
      return StudioApi.getProject(id).then(function (got) {
        applyMeta(got.meta, got.project, hit ? hit.key : null);   // reuse the draft slot
        return StudioApi.shaMeta(got.meta).then(function (sha) {
          lastSyncedSha = sha;
          return persistCleanRec(got.meta, sha);
        // Exactly once per genuine open, and only AFTER the document rendered.
        }).then(function () { return recordView(serverId); });
      });
    }).catch(function (e) {
      // A fresh database (or an outage) still has the bundled library to fall back
      // on — the seed copy opens read-only and "saves" by creating a new project.
      if (e.status === 404 || e.code === 'offline') {
        return StudioApi.getSeedProject(id).then(function (meta) {
          applyMeta(meta, null, null);
          hk.markSave('bundled copy — Save to keep your own');
          hk.flash('Opened the bundled copy of this project.');
          return persistLocal().then(noop);      // Promise<void> per the contract
        }, function () { throw e; });
      }
      throw e;
    }).catch(function (e) {
      lastError = e; setPhase('error');
      hk.flash('Could not open project: ' + (e.message || 'unknown error'));
    });
  }

  function existingDraftFor(projectId) {
    if (!hasStore) return Promise.resolve(memRec && memRec.serverId === projectId ? memRec : null);
    // getDocByServerId is store.js's own index for exactly this question.
    if (StudioStore.getDocByServerId) return StudioStore.getDocByServerId(projectId).catch(function () { return null; });
    return StudioStore.listDocs().then(function (recs) {
      return (recs || []).filter(function (r) { return r && r.serverId === projectId; })[0] || null;
    }, function () { return null; });
  }
  function persistCleanRec(meta, sha) {
    var rec = {
      key: draftKey, serverId: serverId, baseVersion: baseVersion, ownerId: ownerId,
      name: meta.name || 'Untitled', doc: meta, updated: nowSec(), sha: sha, dirty: false
    };
    memRec = rec;
    return hasStore ? StudioStore.putDoc(rec).catch(function () {}) : Promise.resolve();
  }

  function openDraft(key) {
    if (!CLOUD || !inited) return Promise.resolve();
    return ensureUser().then(function () { return loadRec(key); }).then(function (rec) {
      if (!rec) { hk.flash('That draft is no longer on this device.'); return; }
      hk.loadProjectMeta(rec.doc, null);
      draftKey = rec.key; dirty = !!rec.dirty; hk.setDirty(dirty);
      // A CLEAN record's sha is by definition what the server holds; a dirty one's
      // is our unsent bytes, so we know nothing about the server and must push.
      lastSyncedSha = dirty ? '' : (rec.sha || '');
      adoptIdentity({
        serverId: rec.serverId || null, baseVersion: rec.baseVersion || null, ownerId: rec.ownerId || null,
        canEdit: !!(user && (rec.ownerId === user.id || user.isAdmin || !rec.serverId))
      });
      setPhase(dirty ? 'local-dirty' : 'idle');
      hk.markSave(dirty ? 'on this device' : '');
      if (rec.serverId) recordView(rec.serverId);
      if (dirty) schedulePush();
    });
  }

  /* ====================== the library ====================== */
  // Cloud list, with the bundled projects/ bundle as the offline fallback and the
  // unsaved local drafts pinned on top under "On this device".
  function listLibrary(opts) {
    opts = opts || {};
    if (!CLOUD) return Promise.reject(new Error('not cloud'));
    return StudioApi.listProjects(opts).then(function (page) {
      return withDrafts(page, opts);
    }, function (e) {
      if (e.code !== 'offline' && e.status !== 404) throw e;
      return StudioApi.listSeedProjects().then(function (cards) {
        return withDrafts({ projects: cards, nextCursor: null, order: 'updated', orderDegraded: true, fallback: 'seed' }, opts);
      }, function () { throw e; });
    });
  }
  function withDrafts(page, opts) {
    if (opts.cursor || opts.owner) return Promise.resolve(page);   // only on the first page
    return listDrafts().then(function (drafts) {
      var q = (opts.q || '').toLowerCase().trim();
      var keep = drafts.filter(function (d) { return !q || (d.name || '').toLowerCase().indexOf(q) >= 0; });
      page.drafts = keep;
      page.projects = keep.concat(page.projects || []);
      return page;
    }, function () { return page; });
  }
  // Cards for documents that exist ONLY on this device (never saved to the cloud).
  // Their `id` is the draft key, which openProject() routes back to openDraft().
  function listDrafts() {
    if (!hasStore) return Promise.resolve([]);
    return StudioStore.listDocs().then(function (recs) {
      return (recs || []).filter(function (r) { return r && !r.serverId; }).map(function (r) {
        var f = StudioApi.metaFacts(r.doc || {});
        return {
          id: r.key, name: r.name || 'Untitled', updated: r.updated || 0, created: r.updated || 0,
          youtubeUrl: f.youtubeUrl, hasSong: !!f.hasSong,
          instruments: f.instruments ? f.instruments.split(',') : [], trackCount: f.trackCount,
          version: 0, ownerId: null, ownerName: 'on this device', ownerImage: '',
          isMine: true, canEdit: true, forkOf: null, forkRoot: null, viewedAt: null, draft: true
        };
      });
    }, function () { return []; });
  }
  function discardDraft(key) {
    if (!hasStore) return Promise.resolve();
    return StudioStore.deleteDoc(key).then(function () { if (key === draftKey) { draftKey = mintKey(); emit(); } });
  }

  /* ====================== the gate (S2) ====================== */
  // Persist FIRST, record the intent SECOND, navigate LAST — and await both
  // writes. Navigating after a failed persist is the one way this design can
  // actually lose work, so a failure here stays put and says so.
  function gate(kind) {
    if (!CLOUD || !inited) return Promise.resolve();
    // Ask NOW, not at boot: `durable` is a snapshot and IndexedDB can die
    // mid-session (see refreshDurable).
    return refreshDurable().then(function (durableNow) {
      if (!durableNow) {
        hk.flash('This browser is blocking local storage, so sign-in would lose your edits — use "Save file" instead.');
        return undefined;
      }
      setPhase('gated');
      return persistLocal().then(function (out) {
        // THE check this whole flow exists for. A record that only reached memory
        // does not survive the navigation to github.com, and persistLocal used to
        // resolve with exactly that record as though the write had landed.
        if (!out || !out.rec) throw (out && out.error) || new Error('nothing to stage');
        if (!out.persisted) throw out.error || new Error('local write did not commit');
        return StudioStore.putIntent({
          id: 'pending', kind: kind, draftKey: out.rec.key, projectId: out.rec.serverId || null,
          at: nowSec(), ttl: nowSec() + INTENT_TTL_SEC
        }).then(function () { return out.rec; });
      }).then(function (rec) {
        // putIntent RESOLVES against store.js's in-memory shim the moment its handle
        // is gone (store.js's fail() nulls db on store_closed), so its success alone
        // proves nothing. This is the last instant we can still refuse.
        return refreshDurable().then(function (stillDurable) {
          if (!stillDurable) throw new Error('local storage went away before sign-in');
          hk.suppressUnload(true);        // we are leaving deliberately; no "leave site?"
          return StudioApi.signInGithub(location.pathname + '?resume=' + encodeURIComponent(rec.key));
        });
      }).catch(function (e) {
        // Stay put, stay dirty, say so. Navigating after a failed persist is the one
        // way this design can actually lose work.
        hk.suppressUnload(false);
        lastError = e; setPhase('local-dirty');
        hk.markSave('on this device — sign in to keep');
        hk.flash((e && (e.code === 'offline' || e.code === 'no_redirect'))
          ? 'Could not reach GitHub sign-in — your edits are still here. Try again.'
          : 'Could not stage your edits for sign-in — they are still on screen. Try again, or export with "Save file".');
      });
    });
  }

  /* ====================== explicit user actions ====================== */
  function requestSave() {
    if (!CLOUD || !inited) return Promise.resolve();
    cancelPush();
    // Logged out: gate() owns the whole sequence (persist -> intent -> navigate) and
    // must be the one to persist, so it can refuse on a write that did not commit.
    if (!user) return gate('save');
    return persistLocal().then(function (out) {
      var rec = out && out.rec;
      if (!rec) return noRecord();
      if (!rec.serverId) return createNow(rec);
      if (!canEditFlag) return forkFrom(rec, rec.name + ' (copy)', copyKey(rec)).then(function () {
        hk.flash('Saved as your copy — you are not the author of the original.');
      }, function (e) { return stall(rec, e); });
      return explicitPush(rec);
    });
  }
  // persistLocal could not even build a record (serializeMeta threw). There is
  // nothing to send and nothing to stage; say so rather than acting on `undefined`.
  function noRecord() {
    setPhase('error');
    hk.markSave('save failed');
    hk.flash('Could not read the current project — nothing was saved. Try again, or export with "Save file".');
    return undefined;
  }
  function explicitPush(rec) {
    // Same 412 trap as the background push: no baseVersion means no If-Match means
    // a flat rejection, so resolve it before spending the round trip.
    return ensureBaseVersion(rec).then(function () { return explicitPushNow(rec); },
                                       function (e) { return stall(rec, e); });
  }
  function explicitPushNow(rec) {
    return StudioApi.shaMeta(rec.doc).then(function (sha) {
      if (sha && sha === lastSyncedSha) { hk.markSave('saved ✓'); setPhase('saved'); return markClean(rec, rec.baseVersion, sha); }
      setPhase('saving'); hk.markSave('saving…'); notePush(rec.serverId);
      return StudioApi.saveProject(rec.serverId, { meta: rec.doc, name: rec.name, ifMatch: rec.baseVersion })
        .then(function (res) {
          retryN = 0;
          return markClean(rec, res.version, sha).then(function () {
            post({ type: 'saved', projectId: rec.serverId, version: res.version, draftKey: rec.key });
            setPhase('saved'); hk.markSave('saved ✓');
            if (res.actedAsAdmin) hk.flash('Saved as admin.');
          });
        }, function (e) {
          if (e.code === 'conflict' || e.status === 409) return onConflict(rec, sha, e, true);
          return onPushError(rec, sha, e);
        });
    });
  }
  function createNow(rec) {
    setPhase('saving'); hk.markSave('creating…');
    return StudioApi.createProject({ meta: rec.doc, name: rec.name, idempotencyKey: rec.key })
      .then(function (res) {
        var card = res.project || {};
        rec.serverId = card.id; rec.baseVersion = res.version || 1;
        rec.ownerId = card.ownerId || (user && user.id) || null; rec.doc.id = card.id;
        return markClean(rec, rec.baseVersion, res.sha).then(function () {
          adoptIdentity({ serverId: rec.serverId, baseVersion: rec.baseVersion, ownerId: rec.ownerId, canEdit: true });
          setUrlProject(rec.serverId); setPhase('saved'); hk.markSave('saved ✓');
          hk.flash('Saved: ' + rec.name);
          recordView(rec.serverId);
        });
      }, function (e) { return onPushError(rec, '', e); });
  }
  function requestFork() {
    if (!CLOUD || !inited) return Promise.resolve();
    cancelPush();
    if (!user) return gate('fork');                        // R1: login REQUIRED to duplicate
    return persistLocal().then(function (out) {
      var rec = out && out.rec;
      if (!rec) return noRecord();
      if (!rec.serverId) return createNow(rec);            // nothing upstream to fork from
      // A duplicate is a NEW local document, and its key is DERIVED from
      // (draft + base version) rather than freshly minted. That single choice
      // makes a double-tapped Duplicate collapse into one copy at BOTH ends: the
      // server dedupes on the Idempotency-Key, and the two responses land in one
      // IndexedDB record instead of leaving an orphan behind. A deliberate second
      // duplicate is taken from the new state, so it still gets its own.
      var srcKey = rec.key, idem = copyKey(rec, 'd'), key = idem;
      return StudioApi.forkProject(rec.serverId, { meta: rec.doc, name: rec.name + ' (copy)', idempotencyKey: idem })
        .then(function (res) {
          var card = res.project || {};
          draftKey = key; dirty = false; hk.setDirty(false);
          adoptIdentity({ serverId: card.id, baseVersion: res.version || 1, ownerId: card.ownerId || user.id, canEdit: true });
          hk.setName(card.name || rec.name); setUrlProject(card.id);
          setPhase('saved'); hk.markSave('saved ✓'); hk.flash('Duplicated: ' + (card.name || rec.name));
          // Drop the source draft: its edits now live in the copy, and leaving it
          // dirty would let the outbox push them over the original too.
          if (hasStore) StudioStore.deleteDoc(srcKey).catch(function () {});
          return StudioApi.shaMeta(rec.doc).then(function (sha) { lastSyncedSha = sha; return persistCleanRec(rec.doc, sha); })
            .then(function () { recordView(card.id); });
        }, function (e) { return onPushError(rec, '', e); });
    });
  }
  // A brand-new document is NOT created server-side until the user saves it: a
  // create costs 4 rows written, and most new documents are abandoned.
  function requestNew() {
    if (!CLOUD || !inited) return Promise.resolve();
    cancelPush(); clearTimeout(localTimer); localTimer = null;
    draftKey = mintKey(); serverId = null; baseVersion = null; ownerId = user ? user.id : null;
    canEditFlag = !!user; dirty = false; lastSyncedSha = ''; conflict = null; memRec = null;
    hk.setDirty(false); hk.setProjectId(null); hk.markSave(''); setPhase('idle');
    setUrlProject(null);
    return Promise.resolve();
  }
  // A rename of an otherwise-clean project goes over PATCH, which never re-uploads
  // the payload. If the document is dirty the new name rides along in the payload.
  function requestRename(name) {
    if (!CLOUD || !inited) return Promise.resolve();
    name = StudioApi.clampName(name);
    hk.setName(name);
    if (!user || !serverId || !canEditFlag || dirty) { noteEdit(); return Promise.resolve(); }
    // renameRoute demands If-Match exactly as saveRoute does, and api.js omits the
    // header when we hold no version — a flat 412 that would silently demote the
    // cheap PATCH to a full payload push. Resolve the version first: one read, zero
    // rows written, versus re-uploading up to 80 KB.
    var pid = serverId;
    var pre = (baseVersion == null)
      ? StudioApi.getHead(pid).then(function (h) { if (serverId === pid) baseVersion = h.version || null; })
      : Promise.resolve();
    return pre.then(function () {
      if (serverId !== pid || baseVersion == null) { noteEdit(); return undefined; }
      return renameNow(pid, name);
    }, function () { noteEdit(); });
  }
  function renameNow(pid, name) {
    return StudioApi.renameProject(pid, name, baseVersion).then(function (res) {
      baseVersion = res.version || baseVersion;
      return persistLocal().then(function (out) {
        var rec = out && out.rec;
        // The rename LANDED on the server; a local write that did not commit is not
        // a reason to mark the document dirty again.
        return rec ? markClean(rec, baseVersion, rec.sha) : undefined;
      });
    }, function (e) { lastError = e; noteEdit(); });
  }

  /* ====================== login / adoption ====================== */
  function signIn() {
    if (!CLOUD) return Promise.resolve();
    return dirty ? gate('save') : StudioApi.signInGithub(location.pathname + location.search);
  }
  function signOut() {
    if (!CLOUD) return Promise.resolve();
    return StudioApi.signOut().then(function () { user = null; canEditFlag = false; emit(); location.reload(); });
  }

  // Claim work made while logged out. The DRAFT KEY NEVER CHANGES — the document
  // the user is looking at keeps its identity; only its server binding appears.
  // The draft key doubles as the Idempotency-Key, so re-running adoption (a
  // double-tap, a reload mid-flight) returns the same project instead of a copy.
  function adoptLocalDocs() {
    if (!CLOUD || !user || !hasStore) return Promise.resolve([]);
    return StudioStore.listDocs().then(function (recs) {
      // Only DIRTY ownerless drafts: adoption exists to claim unsaved anonymous
      // work. A clean orphan (a project merely opened while logged out) has
      // nothing to preserve, and creating a row for it would clutter the library
      // and spend 4 rows written for nothing.
      var orphans = (recs || []).filter(function (r) { return r && !r.ownerId && r.dirty; });
      var done = [];
      return orphans.reduce(function (chain, rec) {
        return chain.then(function () { return adoptOne(rec).then(function (o) { if (o) done.push(o); }, log); });
      }, Promise.resolve()).then(function () {
        if (done.length) hk.flash(done.length === 1 ? 'Your edits are now saved to your account.' : done.length + ' local projects saved to your account.');
        return done;
      });
    }, function () { return []; });
  }
  function adoptOne(rec) {
    if (!rec.serverId) {
      return StudioApi.createProject({ meta: rec.doc, name: rec.name, idempotencyKey: rec.key }).then(function (res) {
        return settleAdopted(rec, res.project, res.version, res.sha, 'created');
      });
    }
    return StudioApi.getHead(rec.serverId).then(function (head) {
      var card = head.project || {};
      if (card.canEdit || (user && user.isAdmin)) {
        return StudioApi.saveProject(rec.serverId, { meta: rec.doc, name: rec.name, ifMatch: head.version })
          .then(function (res) { return settleAdopted(rec, res.project || card, res.version, res.sha, 'saved'); },
                function (e) {
                  if (e.code !== 'conflict') throw e;
                  return StudioApi.forkProject(rec.serverId, { meta: rec.doc, name: rec.name + ' (copy)', idempotencyKey: rec.key })
                    .then(function (res) { return settleAdopted(rec, res.project, res.version, res.sha, 'forked'); });
                });
      }
      return StudioApi.forkProject(rec.serverId, { meta: rec.doc, name: rec.name + ' (copy)', idempotencyKey: rec.key })
        .then(function (res) { return settleAdopted(rec, res.project, res.version, res.sha, 'forked'); });
    });
  }
  function settleAdopted(rec, card, version, sha, action) {
    card = card || {};
    rec.serverId = card.id || rec.serverId;
    rec.baseVersion = version || 1;
    rec.ownerId = card.ownerId || user.id;
    rec.doc.id = rec.serverId;
    rec.dirty = false; rec.sha = sha || rec.sha; rec.updated = nowSec();
    return StudioStore.putDoc(rec).then(function () {
      if (isCurrent(rec)) {
        dirty = false; hk.setDirty(false); lastSyncedSha = rec.sha;
        adoptIdentity({ serverId: rec.serverId, baseVersion: rec.baseVersion, ownerId: rec.ownerId, canEdit: true });
        setUrlProject(rec.serverId); setPhase('saved'); hk.markSave('saved ✓');
      }
      post({ type: 'saved', projectId: rec.serverId, version: rec.baseVersion, draftKey: rec.key });
      return { key: rec.key, projectId: rec.serverId, action: action };
    });
  }

  /* ====================== boot / resume (S3, S4) ====================== */
  function resume() {
    if (!CLOUD || !inited) return Promise.resolve();
    setPhase('resuming');
    var params = new URLSearchParams(location.search || '');
    var resumeKey = params.get('resume'), deepLink = params.get('p');
    return StudioApi.me().then(function (m) {
      user = m.user || null; userResolved = true;
      var intentP = hasStore ? StudioStore.getIntent().catch(function () { return null; }) : Promise.resolve(null);
      return intentP.then(function (intent) {
        // A stale or mismatched intent must never silently overwrite a project the
        // user opened days later.
        var live = intent && intent.draftKey && (!intent.ttl || intent.ttl > nowSec());
        if (intent && !live && hasStore) StudioStore.clearIntent().catch(function () {});
        if (!live || (resumeKey && intent.draftKey !== resumeKey)) { if (resumeKey) stripParam('resume'); return bootNormally(deepLink); }
        if (!resumeKey) return bootNormally(deepLink);         // intent kept for the next attempt
        return resumeIntent(intent);
      });
    }).catch(function (e) { lastError = e; log(e); return bootNormally(deepLink); });
  }

  function resumeIntent(intent) {
    return loadRec(intent.draftKey).then(function (rec) {
      if (!rec) { return clearIntent().then(function () { return bootNormally(null); }); }
      // Put the work back on screen FIRST — whether or not the login succeeded.
      hk.loadProjectMeta(rec.doc, null);
      draftKey = rec.key; dirty = true; hk.setDirty(true);
      lastSyncedSha = '';                       // resumed drafts are unsent by definition
      adoptIdentity({
        serverId: rec.serverId || null, baseVersion: rec.baseVersion || null, ownerId: rec.ownerId || null,
        canEdit: !!(user && (rec.ownerId === user.id || user.isAdmin || !rec.serverId))
      });
      stripParam('resume');
      if (!user) {
        // S4: came back without a session. Keep the intent (its 24 h TTL bounds it)
        // so pressing Save again re-runs the gate without re-serializing.
        setPhase('local-dirty');
        hk.markSave('on this device — sign in to keep');
        hk.flash('Your edits are safe on this device. Sign in with GitHub to keep them.');
        return undefined;
      }
      // The user already pressed the button; making them press it again is how a
      // flow feels broken. Execute the intent now.
      return runIntent(intent, rec).then(function () { return clearIntent(); }, function (e) {
        lastError = e; setPhase('error');
        hk.flash('Signed in, but the save did not go through — your edits are still here. Retrying…');
        stall(rec, e);
      });
    });
  }
  function runIntent(intent, rec) {
    if (!rec.serverId) return createNow(rec);
    if (intent.kind === 'fork') {
      return forkFrom(rec, rec.name + ' (copy)', rec.key).then(function () {
        hk.flash('Signed in — duplicated to your library.');
      });
    }
    // kind 'save': mine -> PUT; someone else's -> silently promote to a fork.
    return StudioApi.getHead(rec.serverId).then(function (head) {
      var card = head.project || {};
      if (card.canEdit || (user && user.isAdmin)) {
        rec.baseVersion = head.version;
        return explicitPush(rec).then(function () { hk.flash('Signed in — saved.'); });
      }
      return forkFrom(rec, rec.name + ' (copy)', rec.key).then(function () {
        hk.flash('Signed in. Saved as your copy — the original belongs to ' + (card.ownerName || 'someone else') + '.');
      });
    });
  }
  function clearIntent() { return hasStore ? StudioStore.clearIntent().catch(function () {}) : Promise.resolve(); }

  function bootNormally(deepLink) {
    // Adoption runs on every signed-in boot, not just the resume path: a tab that
    // was signed in elsewhere still has to claim whatever this device made offline.
    var p = user ? adoptLocalDocs().catch(function () { return []; }) : Promise.resolve([]);
    return p.then(function () {
      if (deepLink) return openProject(deepLink);
      setPhase('idle');
      return undefined;
    });
  }

  function setUrlProject(id) {
    try {
      var url = location.pathname + (id ? '?p=' + encodeURIComponent(id) : '');
      history.replaceState(null, '', url);
    } catch (e) {}
  }
  function stripParam(name) {
    try {
      var u = new URL(location.href);
      u.searchParams.delete(name);
      history.replaceState(null, '', u.pathname + (u.search || '') + (u.hash || ''));
    } catch (e) {}
  }

  /* ====================== single-writer election ====================== */
  // Web Locks gives a real election with automatic hand-off when the holder's tab
  // dies. Where it is missing (older Safari) a localStorage heartbeat approximates
  // it: claim the key when it is empty, ours, or stale, and refresh it every 5 s.
  function electLeader() {
    if (navigator.locks && navigator.locks.request) {
      navigator.locks.request(LOCK_NAME, { mode: 'exclusive' }, function () {
        isLeader = true; emit(); drain();
        return new Promise(function () {});     // held for the life of the tab
      }).catch(function () { heartbeat(); });
      return;
    }
    heartbeat();
  }
  function heartbeat() {
    leaderId = leaderId || ('t' + Math.random().toString(36).slice(2, 10));
    function beat() {
      var now = Date.now(), cur = null, was = isLeader;
      try { cur = JSON.parse(localStorage.getItem(LEADER_KEY) || 'null'); } catch (e) { cur = null; }
      if (!cur || !cur.id || cur.id === leaderId || (now - (cur.at || 0)) > LEADER_TTL) {
        try { localStorage.setItem(LEADER_KEY, JSON.stringify({ id: leaderId, at: now })); } catch (e) {}
        isLeader = true;
      } else isLeader = false;
      if (isLeader && !was) { emit(); drain(); }
    }
    beat();
    leaderTimer = setInterval(beat, LEADER_BEAT);
  }

  /* ====================== cross-tab messaging ====================== */
  function post(msg) { if (bc) { try { bc.postMessage(msg); } catch (e) {} } }
  function onMessage(e) {
    var m = (e && e.data) || {};
    if (m.type === 'wake') { if (isLeader) drain(); return; }
    if (m.type !== 'saved') return;
    if (m.draftKey === draftKey) {
      // Our own document, pushed by another tab (or by the leader on our behalf):
      // adopt the new version so our next PUT does not 409 against ourselves.
      baseVersion = m.version; if (serverId == null) serverId = m.projectId;
      emit();
      return;
    }
    if (m.projectId && m.projectId === serverId) {
      // Same project, different document. Do NOT adopt the version — let the CAS
      // decide, so a genuine divergence becomes a copy instead of an overwrite.
      hk.flash('This project was edited in another tab.');
    }
  }

  /* ====================== lifecycle ====================== */
  function flush() {
    if (!CLOUD || !inited) return Promise.resolve();
    clearTimeout(localTimer); localTimer = null;
    return (dirty ? persistLocal() : Promise.resolve()).then(function () {
      if (!dirty || !canPut()) { cancelPush(); return; }
      // The per-project floor applies HERE too: someone alt-tabbing while they
      // work must not turn into one PUT per tab switch. Under the floor we leave
      // the pending timer in place instead of firing early.
      if (Date.now() - lastPushFor(serverId) < PUSH_FLOOR_MS) { schedulePush(); return; }
      cancelPush();
      return drain();
    });
  }
  // pagehide / hidden on mobile: beforeunload (app.js:1220) frequently never fires
  // on iOS Safari, so this is the flush that actually runs. keepalive lets the PUT
  // outlive the document — within the spec's 64 KB body budget, which Api checks.
  function flushUnload() {
    if (!CLOUD || !inited || !dirty) return;
    persistLocal();
    post({ type: 'wake' });
    if (!canPut()) return;
    // Take a FRESH snapshot rather than reusing memRec: persistLocal's write is
    // async and this is the last chance the document gets.
    var rec = recFrom(snapshot(), '');
    // No baseVersion means no If-Match means a guaranteed 412 (routes.js:578). There
    // is no time left to resolve it from /head, and firing the request anyway would
    // spend a Worker invocation to be told no. The draft is on disk; the next boot
    // drains it with a version in hand.
    if (rec.baseVersion == null) return;
    notePush(rec.serverId);
    StudioApi.saveProject(rec.serverId, { meta: rec.doc, name: rec.name, ifMatch: rec.baseVersion, keepalive: true })
      .then(function (res) { post({ type: 'saved', projectId: rec.serverId, version: res.version, draftKey: rec.key }); })
      .catch(function () {});   // the draft is already on disk; the next boot drains it
  }
  // The manual "Retry save" control. Conflict blocks survive it — those wait on a
  // human choice, not on a network retry.
  function retryNow() {
    retryN = 0; clearTimeout(retryTimer); retryTimer = null;
    Object.keys(blocked).forEach(function (k) { if (blocked[k] !== 'conflict') delete blocked[k]; });
    return drain();
  }

  function init(hooks) {
    if (inited) return;
    hk = bindHooks(hooks);
    if (!CLOUD) return;                       // INERT: no timers, no listeners, no net
    inited = true;
    hasStore = !!window.StudioStore;
    durable = !!(hasStore && StudioStore.available && StudioStore.available());
    draftKey = mintKey();
    // available() only tells the truth once the database has finished opening, and
    // init() runs synchronously — so re-ask after ready() settles and warn only
    // then. Warning eagerly would fire on every normal boot. Every later caller
    // that is about to leave the page re-asks again through refreshDurable().
    refreshDurable().then(function (ok) {
      if (!ok) {
        warnedLocal = true;      // one message, not two, if a write then fails
        hk.flash('This browser is not storing data locally — use "Save file" to keep your work.');
      }
      emit();
    });

    try { bc = new BroadcastChannel(CHANNEL); bc.onmessage = onMessage; } catch (e) { bc = null; }
    if (hasStore && StudioStore.onDocChanged) {
      StudioStore.onDocChanged(function (m) {
        if (m && m.key && m.key === draftKey && !dirty) hk.flash('This project was edited in another tab.');
      });
    }

    window.addEventListener('online', function () { retryN = 0; drain(); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush();
      else { retryN = 0; drain(); }
    });
    window.addEventListener('pagehide', flushUnload);

    electLeader();
    emit();
  }

  return {
    init: init, enabled: function () { return CLOUD; },
    noteEdit: noteEdit,
    requestSave: requestSave, requestFork: requestFork, requestNew: requestNew, requestRename: requestRename,
    // The Duplicate button has been called both things during the build. One
    // implementation, two names, so neither wiring can miss.
    requestDuplicate: requestFork,
    openProject: openProject, openDraft: openDraft,
    listLibrary: listLibrary, listDrafts: listDrafts, discardDraft: discardDraft,
    resume: resume, resolveConflict: resolveConflict, conflictCopy: function () { return resolveConflict('copy'); },
    adoptLocalDocs: adoptLocalDocs,
    flush: flush, retryNow: retryNow,
    signIn: signIn, signOut: signOut,
    user: function () { return user; },
    isLeader: function () { return isLeader; },
    state: state
  };
})();
// House idiom is a bare global; the contract names it StudioSync. Both, one object.
var Sync = StudioSync;
