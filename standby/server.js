'use strict';
// Standby — single-container Node app. ZERO runtime dependencies.
// Serves the static UI and a JSON API backed by plain files in DATA_DIR.
// Run:  PORT=3100 DATA_DIR=./data node server.js
//
// What this app is (0.7.19): a dead man's switch that does ONE thing —
// broadcast the owner's pre-signed Bitcoin transactions if they stop
// checking in past the broadcast threshold — or immediately, on the
// owner's say-so (Broadcast Now on a transaction's own card, or
// Broadcast All). There is no message delivery any more: no Part 1 /
// Part 2, no recipient, no channels, no reminders. Each transaction is
// signed in the owner's own wallet and pasted as raw hex; the app never
// sees keys. Each has its own enable toggle and its own release
// record. New transactions are armed by default. The broadcast is REAL,
// via the mempool API — a primary node and a secondary node (both
// user-chosen mempool endpoints, default mempool.space and
// blockstream.info/api), primary first, secondary if the primary does
// not answer. There is no Bitcoin Core RPC path any more (removed in
// 0.5.4). The "test" buttons are dry-runs that check the inputs are
// still unspent and never broadcast. A dry-run that finds spent inputs
// records the transaction stale on the spot: staleness is a durable
// fact about the inputs, not a cycle record and not page memory, so it
// survives refreshes and check-ins — only replacing the hex re-arms
// it. Settings has a data backup card:
// download a JSON backup of the whole setup, or restore one.
// The shared-input warning is derived from the stored transactions
// on every state read, so it persists across refreshes and clears the
// moment a transaction is edited away from the shared input.
// The check-in status turns 'broadcasted' once a release has gone
// out (a manual broadcast does not count) and a check-in resets it
// to 'on-track'. Broadcast All only attempts the transactions that
// are not archived (broadcasted or stale).
// 0.6.6 adds check-in API keys: a key lets a service or app check in
// for the owner, and it can only record a check-in — it cannot read
// transactions or broadcast. Each service gets its own labelled key
// (shown once, stored as a hash, revocable on its own), and the
// check-in log records which key checked in. The key is presented to
// the check-in receiver (a separate service, checkin-receiver/,
// LAN port 3101), which holds no transaction data and writes only a
// timestamp the app merges — so a holder of a key has no route to the
// transactions at all. The receiver reads the key hashes the app
// publishes to the shared CHECKIN_DIR (keys.json); the app merges a
// newer timestamp from CHECKIN_DIR/last.json on every status read and
// on the hourly tick.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const store = require('./lib/store');
const bitcoin = require('./lib/bitcoin');

const PORT = parseInt(process.env.PORT || '3100', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
// The directory shared with the check-in receiver (mounted as a
// volume in docker-compose.yml). The app publishes the key hashes
// there (keys.json) and reads the receiver's check-in timestamps
// (last.json). Absent on a plain `node server.js` run — the key
// feature is dormant then; every file access is guarded.
const CHECKIN_DIR = process.env.CHECKIN_DIR || '/checkin';
const VERSION = '0.7.19';
const MAX_BODY = 1024 * 1024; // 1 MB

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function asStr(v, maxLen) {
  if (typeof v !== 'string') return '';
  return v.slice(0, maxLen);
}

// Broadcast route (0.7.16): which network a transaction goes out
// on. 'public' is the mempool nodes (primary, then secondary);
// 'slipstream' is MARA Slipstream (direct to MARA Pool's private
// mempool). Per transaction, chosen when it is added and changeable
// on its card — the two routes are never a fallback chain: only the
// selected route is attempted, and the hourly retry re-attempts that
// same route. Anything else (including a missing value on an older
// record or backup) is 'public'.
function validBroadcastVia(v) {
  return v === 'slipstream' ? 'slipstream' : 'public';
}

// Public fallback (0.7.17): a per-transaction OPT-IN timer on a
// Slipstream-route transaction. If the transaction is not publicly
// visible within the chosen number of days, Standby broadcasts it
// publicly instead — the automatic version of the manual "Broadcast
// publicly" escape hatch, for when nobody is watching. The allowed
// durations are the seven the UI offers; anything else (including a
// missing value on an older record or backup) is null — Never, no
// automatic fallback. The fallback only applies while the route is
// 'slipstream'; the value is stored (and kept) when the route is
// 'public', but ignored. It is deliberately lenient, like
// validBroadcastVia above: an invalid value becomes Never, never a
// 400.
const PUBLIC_FALLBACK_DAYS = [1, 3, 7, 14, 30, 60, 90];
function validPublicFallbackDays(v) {
  return (typeof v === 'number' && PUBLIC_FALLBACK_DAYS.includes(v)) ? v : null;
}

// The deadline a Slipstream transaction's public fallback fires at —
// or null when there is none. Two anchors, by the transaction's
// state (the owner's rule):
//   (a) 'submitted-slipstream' (MARA accepted it): the deadline runs
//       from when MARA first accepted it — release.submittedAt. A
//       change of duration while pending re-times the deadline from
//       that same submittedAt; it does NOT restart the clock.
//   (b) still 'release-due' because the submit keeps failing (never
//       got the 200+success): the deadline runs from the FIRST
//       Slipstream broadcast attempt — slipstreamFirstAttemptAt,
//       set on the first attempt whether it succeeds or fails, never
//       overwritten after. If no attempt has been made yet, there is
//       no deadline (nothing to fall back from).
// A tx that succeeded on the first try has firstAttemptAt ==
// submittedAt, so the two anchors agree there; a tx that failed
// first and succeeded later anchors on (a), the acceptance — the
// fallback is about MARA holding it, not about our first try.
function fallbackDeadline(tx) {
  if (!tx || tx.broadcastVia !== 'slipstream') return null;
  const days = validPublicFallbackDays(tx.publicFallbackDays);
  if (days === null) return null;
  let anchor = null;
  if (tx.release && tx.release.status === 'submitted-slipstream' && tx.release.submittedAt) {
    anchor = tx.release.submittedAt;
  } else if (tx.slipstreamFirstAttemptAt) {
    anchor = tx.slipstreamFirstAttemptAt;
  } else {
    return null;
  }
  const at = new Date(anchor).getTime();
  if (Number.isNaN(at)) return null;
  return new Date(at + days * 86400000);
}

// State as served to the UI: a plain deep copy, except the check-in key
// hashes are stripped — the UI never needs them (the /api/checkin-keys
// list omits them too). The hashes are SHA-256 of the keys, which cannot
// be turned back into a key, but there is no reason to send them to the
// browser on every state read. The BACKUP is the only document that
// carries the hashes (a restore needs them so the keys keep working) —
// it takes its own full copy below, not sanitizeState.
function sanitizeState(state) {
  const copy = JSON.parse(JSON.stringify(state));
  if (Array.isArray(copy.checkinKeys)) copy.checkinKeys = copy.checkinKeys.map(publicCheckinKey);
  return copy;
}

// ---------------------------------------------------------------------------
// Check-in API keys (0.6.6). A key is a bearer token that authorizes
// exactly one thing: recording a check-in, via the check-in receiver.
// It cannot read state, list transactions, broadcast, or change
// settings — and the receiver has no route to the transactions at
// all, so a key holder has no path to them either.
//   - The plaintext key is generated here, returned ONCE (at creation),
//     and never stored. Only its SHA-256 hash is kept.
//   - The hashes are published to the receiver through the shared
//     CHECKIN_DIR (keys.json, rewritten whenever keys change). The
//     receiver reads that file fresh on every request, so a revocation
//     takes effect immediately.
//   - The receiver writes a check-in as CHECKIN_DIR/last.json
//     ({ lastCheckinAt, keyId, label, sourceIp }); mergeExternalCheckin()
//     below folds a newer timestamp into the check-in clock, the same
//     way POST /api/checkin does (clears the cycle-scoped release
//     records, never a stale one; auto-resumes a pause; logs which key
//     checked in). Idempotent: the same file merged twice changes
//     nothing the second time, because its timestamp is no longer
//     newer than the clock.
// ---------------------------------------------------------------------------
function hashCheckinKey(plain) {
  return crypto.createHash('sha256').update(plain, 'utf8').digest('hex');
}

function newCheckinKeyId() {
  return 'key_' + crypto.randomBytes(4).toString('hex');
}

// The key as listed to the UI: everything except the hash.
function publicCheckinKey(k) {
  return { id: k.id, label: k.label, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt || null };
}

function writeReceiverKeys(state) {
  try {
    fs.mkdirSync(CHECKIN_DIR, { recursive: true });
    const doc = {
      keys: (state.checkinKeys || []).map((k) => ({ id: k.id, label: k.label, hash: k.hash })),
    };
    const file = path.join(CHECKIN_DIR, 'keys.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(doc, null, 2) + '\n', 'utf8');
    fs.renameSync(file + '.tmp', file);
  } catch (e) {
    // No shared directory (a plain `node server.js` run, or the
    // receiver is not installed) — the keys are inert until it is.
  }
}

// Read the receiver's last check-in (CHECKIN_DIR/last.json) —
// tri-state (0.7.13, fourth-audit finding 7). Returns { status }:
//   'missing' — no file. There is no receiver, or it has never
//     recorded a check-in. Nothing to merge; this is NOT an error.
//   'ok' — a valid check-in record (plus the record's fields).
//   'error' — the file exists but cannot be read or parsed. A
//     check-in may be sitting there that we cannot see, so a
//     release must NOT go out while this stands (see
//     evaluateRelease). "Missing" is decided from the read error's
//     code (ENOENT), never from fs.existsSync — existsSync returns
//     false on EACCES too, so an unreadable file would otherwise
//     be mistaken for a missing one.
function readExternalCheckin() {
  const file = path.join(CHECKIN_DIR, 'last.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { status: 'missing' };
    return { status: 'error', error: e.message };
  }
  try {
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== 'object' || typeof doc.lastCheckinAt !== 'string') {
      return { status: 'error', error: 'last.json is not a check-in record' };
    }
    const at = new Date(doc.lastCheckinAt);
    if (Number.isNaN(at.getTime())) return { status: 'error', error: 'last.json check-in time is not a valid date' };
    return {
      status: 'ok',
      at,
      raw: doc.lastCheckinAt,
      keyId: typeof doc.keyId === 'string' ? doc.keyId : null,
      keyLabel: typeof doc.label === 'string' ? doc.label : null,
      sourceIp: typeof doc.sourceIp === 'string' ? doc.sourceIp : null,
    };
  } catch (e) {
    return { status: 'error', error: e.message };
  }
}

// Fold a newer receiver check-in into the clock. Returns true when a
// check-in was applied (and saved + logged), false when there was
// nothing to apply — a missing file, a timestamp in the future (the
// receiver writes "now"; anything more than 5 minutes ahead is a
// skewed clock, not a check-in), or one no newer than the clock —
// and the string 'error' when the receiver state could not be read
// (see readExternalCheckin). Callers that decide a release MUST treat
// 'error' as "do not proceed": an unreadable check-in file is not the
// same as no check-in (0.7.13, fourth-audit finding 7). Callers that
// only display state treat it as "nothing applied".
function mergeExternalCheckin(state, now) {
  const ext = readExternalCheckin();
  if (ext.status === 'error') return 'error';
  if (ext.status === 'missing') return false;
  if (ext.at.getTime() > now.getTime() + 5 * 60 * 1000) return false;
  const last = state.checkin.lastCheckinAt ? new Date(state.checkin.lastCheckinAt) : null;
  if (last && ext.at.getTime() <= last.getTime()) return false;
  const wasPaused = state.settings.paused;
  state.checkin.lastCheckinAt = ext.raw;
  state.checkin.totalCheckins += 1;
  for (const t of (state.bitcoin.txs || [])) {
    if (t.release && t.release.status === 'stale') continue;
    t.release = null;
  }
  if (wasPaused) state.settings.paused = false;
  if (ext.keyId) {
    const k = (state.checkinKeys || []).find((x) => x.id === ext.keyId);
    if (k) k.lastUsedAt = ext.raw;
  }
  store.saveState(DATA_DIR, state);
  store.appendCheckin(DATA_DIR, { ts: ext.raw, method: 'api-key', keyId: ext.keyId, keyLabel: ext.keyLabel, sourceIp: ext.sourceIp || null, autoResumed: wasPaused });
  return true;
}

// Derived check-in status from state + now. One number: the broadcast
// threshold. Check in before it runs out and the clock resets; past it,
// the release is due. There are no warning levels and no grace period.
// Once a release has actually broadcast (the threshold was exceeded
// and a release went out), the status is 'broadcasted' — a manual
// broadcast does not count, only a release does (the release record
// carries kind 'release'). But 'broadcasted' means the release is
// DONE: every armed transaction has reached a terminal state
// (broadcasted or stale). A failed attempt is not terminal — an
// unknown-reason failure (a node rejection, a network error, a
// not-yet-final timelocked transaction) is retried on the next
// hourly tick (0.7.14) — so while any ARMED transaction still
// carries a 'failed' release record, the status stays 'release-due'
// and the release keeps running. A stale transaction does not keep
// it due (stale is terminal: skip it), and a transaction that has
// never been attempted does not either — one added after a release
// still waits for the next cycle. A check-in clears the
// cycle-scoped release records — a stale record survives, it is a
// fact about the inputs — so checking in after a broadcast resets
// the status to 'on-track'.
function checkinStatus(state, now) {
  const s = state.settings;
  const last = state.checkin.lastCheckinAt ? new Date(state.checkin.lastCheckinAt) : null;
  if (s.vacationMode) {
    return { state: 'vacation', label: 'Vacation mode', daysSince: last ? days(last, now) : null, vacationUntil: s.vacationUntil || null };
  }
  if (s.paused) {
    return { state: 'paused', label: 'Paused', daysSince: last ? days(last, now) : null };
  }
  if (!last) {
    return { state: 'not-started', label: 'Not started', daysSince: null, nextDue: null };
  }
  const d = days(last, now); // display only — the release decision below is exact
  // Exact due instant. The release decision compares real timestamps
  // (now vs. the due instant), not the floored day count — otherwise
  // the release lands up to a whole day after the displayed next-due
  // time (0.7.5 and earlier only released once the floored day count
  // passed the threshold).
  const dueMs = last.getTime() + s.thresholdDays * 86400000;
  const nextDue = new Date(dueMs).toISOString();
  // A 'failed' record on an ARMED transaction means the release is
  // not done: that transaction is still owed a broadcast, and the
  // next hourly tick retries it (0.7.14). Only armed transactions
  // count — a disabled transaction's 'failed' record is inert (the
  // release never attempts a disabled transaction), and a stale one
  // is terminal, so neither keeps the status 'release-due'. A
  // transaction that has never been attempted does not keep it due
  // either — one added after a release still waits for the next cycle.
  const txs = state.bitcoin.txs || [];
  const anyFailed = txs.some((t) => t.enabled && t.release && t.release.status === 'failed');
  // A transaction waiting on MARA (0.7.16) means the release is not
  // done: it still needs to become visible publicly or be declared
  // failed, so the status is not 'broadcasted' while one is waiting
  // — even if another transaction already broadcast. Only armed
  // transactions count (a disabled one's record is inert, like its
  // 'failed' record).
  const anyWaitingMara = txs.some((t) => t.enabled && t.release && t.release.status === 'submitted-slipstream');
  if (!anyFailed && !anyWaitingMara && txs.some((t) => t.release && t.release.status === 'broadcast' && t.release.kind === 'release')) {
    return { state: 'broadcasted', label: 'Broadcasted', daysSince: d, nextDue };
  }
  if (now.getTime() < dueMs) return { state: 'on-track', label: 'On track', daysSince: d, nextDue };
  return { state: 'release-due', label: 'Release due', daysSince: d, nextDue };
}

function days(from, to) {
  return Math.floor((to - from) / 86400000);
}

// Re-verify, against freshly loaded state, that a broadcast is still
// wanted — right before the real broadcast. This closes the race where
// a check-in, a pause, a disable, or a replacement lands while the
// input check is waiting on the network, and the original evaluation
// would otherwise broadcast anyway using its stale state. For the
// automatic release it re-checks the armed toggle, pause / vacation,
// and that the clock is still release-due; a manual broadcast (the
// owner's explicit say-so) ignores the clock, the armed toggle, and
// pause / vacation, exactly as the endpoints do. Both kinds re-check
// that the transaction still exists, is still the same hex, and is
// neither broadcast nor stale. Returns { ok, reason, state, tx } —
// the fresh state and tx to broadcast from. The broadcast record
// itself is NOT written to this snapshot: broadcastOne reloads fresh
// state again after the network call and merges only the record in
// (see below), so a check-in that lands mid-broadcast survives.
// `opts.releaseRun` (set by the release evaluation) skips the clock
// re-check inside an already-decided release run — all-or-none,
// 0.7.10 — while the other guards above still apply.
function preBroadcastCheck(tx, logKind, now, opts) {
  const fresh = store.loadState(DATA_DIR);
  const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
  if (!ftx) return { ok: false, reason: 'transaction was deleted' };
  if (ftx.hex !== tx.hex) return { ok: false, reason: 'transaction was replaced' };
  if (ftx.broadcasted || (ftx.release && ftx.release.status === 'broadcast')) return { ok: false, reason: 'already broadcast' };
  if (ftx.release && ftx.release.status === 'stale') return { ok: false, reason: 'transaction is stale — replace it to re-arm' };
  // A transaction already submitted to Slipstream is waiting on
  // MARA — it is not re-submitted (0.7.16). The hourly MARA-waiting
  // refresh (refreshMaraWaiting) is what moves it on: to 'broadcast'
  // once the public nodes see it, or back to 'failed' if MARA drops
  // it, and only then is it attempted again. The ONE exception is
  // the manual "Broadcast publicly" escape hatch (opts.forcePublic):
  // the owner explicitly chose to give up the Slipstream privacy
  // and put this tx in the public mempool, so the wait is over.
  if (ftx.release && ftx.release.status === 'submitted-slipstream' && !(opts && opts.forcePublic)) return { ok: false, reason: 'already submitted to Slipstream — waiting on MARA' };
  if (logKind === 'release') {
    if (!ftx.enabled) return { ok: false, reason: 'transaction was disabled' };
    if (fresh.settings.paused || fresh.settings.vacationMode) return { ok: false, reason: 'paused or vacation mode' };
    // All-or-none release (0.7.10): once a release evaluation has
    // decided the clock is due, the whole armed set broadcasts even
    // if a check-in lands mid-run. A check-in is still recorded —
    // the merge-only broadcast write preserves it — and resets the
    // clock for the next cycle; it just does not stop a release that
    // already started. So inside a decided release run the clock is
    // NOT re-checked here; the guards above (disabled, paused) still
    // apply, because those are explicit owner actions on the
    // transaction or the switch, not the clock.
    // Outside a decided run, the clock must still be due, and
    // 'broadcasted' counts as still due: it only means a release
    // already went out in this cycle, and the remaining armed txs
    // must still broadcast.
    if (!opts || !opts.releaseRun) {
      const st = checkinStatus(fresh, now).state;
      if (st !== 'release-due' && st !== 'broadcasted') return { ok: false, reason: 'no longer release-due' };
    }
  }
  return { ok: true, state: fresh, tx: ftx };
}

// ---------------------------------------------------------------------------
// Broadcast ONE transaction for real — the shared path the release and
// the manual buttons (Broadcast Now, Broadcast All) both use.
//   1. Freshness gate: re-check every input right before broadcasting.
//      A spent input is three things (0.7.12, third-audit finding 1):
//      our OWN txid as the spender means the transaction is already
//      out there — record 'broadcast' and do NOT re-broadcast it
//      (recognition, not a re-send — the same as a node answering
//      'already in mempool'); a confirmed spend by another tx means
//      the tx is stale — record 'stale' and do NOT broadcast (a stale
//      tx can never broadcast); an unconfirmed spend by another tx is
//      a warning only — it does NOT block the broadcast below, the
//      node is the arbiter.
//   2. Broadcast via the transaction's selected route (0.7.16):
//      'public' broadcasts via the primary node, falling back to
//      the secondary if the primary does not answer; 'slipstream'
//      submits to MARA Slipstream ONLY — no fallback to the public
//      nodes. A successful Slipstream submission records status
//      'submitted-slipstream' (not 'broadcast') and no broadcasted
//      fact: the transaction is in MARA's private mempool, invisible
//      to the public nodes, until refreshMaraWaiting sees it publicly
//      (then 'broadcast') or MARA drops it (then 'failed', retried
//      next tick via Slipstream). Success is recorded once per tx
//      and never repeated, with the endpoint that actually broadcast;
//      failure is recorded as 'failed' and retried on the next tick
//      (a transient network failure must not lose the moment).
// A broadcast records BOTH the cycle release record (tx.release) and
// the permanent broadcasted fact (tx.broadcasted). A check-in clears
// the cycle record and starts a new cycle — but the broadcasted fact
// stays: a broadcast is an on-chain fact, and the card keeps showing
// it (with its confirmation count) until the transaction is replaced.
// `logKind` is 'release' for the automatic release and 'broadcast' for
// a manual broadcast, so the broadcast log distinguishes them.
// Returns the per-tx result { id, txid, label, action, method?, error? }.
// Callers skip already-broadcast and stale txs themselves.
// ---------------------------------------------------------------------------
// Broadcasts in flight, by transaction id — a manual Broadcast Now /
// Broadcast All and the automatic release must never broadcast the
// same transaction twice at once (audit finding 6). Only the release
// evaluation has a single-flight lock (0.7.6); the manual endpoints
// call broadcastOne directly, so a double-click or a manual call
// landing during a release could overlap it. broadcastOne claims the
// id for its whole run (freshness gate + network + write); a second
// attempt for the same id is skipped, not queued. The claim is a
// check-and-set with no await in between, so it is atomic on Node's
// single thread, and the finally releases it even if the inner run
// throws.
const broadcastingTxIds = new Set();
async function broadcastOne(state, tx, endpoints, now, logKind, opts) {
  if (broadcastingTxIds.has(tx.id)) {
    return { id: tx.id, txid: tx.txid, label: tx.label || '', action: 'skipped', reason: 'broadcast already in progress' };
  }
  broadcastingTxIds.add(tx.id);
  try {
    return await broadcastOneInner(state, tx, endpoints, now, logKind, opts);
  } finally {
    broadcastingTxIds.delete(tx.id);
  }
}

async function broadcastOneInner(state, tx, endpoints, now, logKind, opts) {
  const failNote = logKind === 'release'
    ? 'Release check failed before broadcast: '
    : 'Broadcast check failed before broadcast: ';
  let check;
  try {
    check = await bitcoin.checkInputsUnspent(bitcoin.parseTx(tx.hex), endpoints);
  } catch (e) {
    // The manual "Broadcast publicly" escape hatch (forcePublic)
    // does NOT write a 'failed' record: the tx stays
    // Slipstream-pending if the public attempt cannot even check
    // its inputs — the failure is surfaced to the owner, and MARA
    // is still holding the tx.
    if (!(opts && opts.forcePublic)) {
      const record = { status: 'failed', kind: logKind, txid: tx.txid, method: 'primary', lastAttemptAt: now.toISOString(), error: 'input check failed: ' + e.message };
      const fresh = store.loadState(DATA_DIR);
      const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
      if (ftx && ftx.hex === tx.hex) {
        recordRelease(fresh, ftx, record, {
          ts: now.toISOString(), kind: logKind, status: 'failed', method: 'primary', txid: tx.txid,
          hexPreview: tx.hex.slice(0, 64), note: failNote + e.message,
        });
      }
    }
    return { id: tx.id, txid: tx.txid, label: tx.label || '', action: 'failed', error: 'input check failed: ' + e.message };
  }
  // Our own txid is the spender (0.7.12, third-audit finding 1):
  // this transaction is already out there — in the mempool or a
  // block — so there is nothing to send. Record it broadcast and
  // report broadcast, never stale, never a warning, regardless of
  // confirmations. The write is merge-only, like the success path
  // below: the broadcasted fact takes precedence over any cycle
  // record, and the hourly confirmation refresh fills in the
  // confirmation count from the block height the outspend reported.
  if (check.own && check.own.length) {
    const own = check.own[0];
    const record = { status: 'broadcast', kind: logKind, txid: tx.txid, method: check.checkedVia, broadcastedAt: now.toISOString() };
    const fresh = store.loadState(DATA_DIR);
    const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
    if (ftx && ftx.hex === tx.hex && !ftx.broadcasted) {
      ftx.broadcasted = {
        txid: tx.txid, broadcastedAt: now.toISOString(), method: check.checkedVia,
        confirmations: null, blockHeight: own.blockHeight != null ? own.blockHeight : null, found: true, checkedAt: now.toISOString(),
      };
      recordRelease(fresh, ftx, record, {
        ts: now.toISOString(), kind: logKind, status: 'broadcast', method: check.checkedVia, txid: tx.txid,
        hexPreview: tx.hex.slice(0, 64), note: 'Transaction is already out there — the node reports its own txid as the spending transaction. Recorded as broadcast; nothing was sent.',
      });
    }
    return { id: tx.id, txid: tx.txid, label: tx.label || '', action: 'broadcast', method: check.checkedVia, alreadyOut: true };
  }
  if (check.spent.length) {
    const spentDesc = check.spent.map((i) => i.prevTxid.slice(0, 12) + ':' + i.prevVout).join(', ');
    // The record survives check-ins: spent inputs are a fact about
    // the transaction, not the cycle (only replacing the hex clears
    // it — a stale transaction can never broadcast).
    const record = { status: 'stale', kind: logKind, txid: tx.txid, method: check.checkedVia, lastAttemptAt: now.toISOString(), error: 'inputs spent: ' + spentDesc };
    // Record the stale verdict on the CURRENT transaction only if it
    // is still the same hex; a replacement in the meantime means the
    // old tx is gone and there is nothing to mark stale.
    const fresh = store.loadState(DATA_DIR);
    const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
    if (ftx && ftx.hex === tx.hex) {
      recordRelease(fresh, ftx, record, {
        ts: now.toISOString(), kind: logKind, status: 'stale', method: check.checkedVia, txid: tx.txid,
        hexPreview: tx.hex.slice(0, 64), note: 'Transaction is stale (inputs spent: ' + spentDesc + ') — broadcast not attempted.',
      });
    }
    return { id: tx.id, txid: tx.txid, label: tx.label || '', action: 'stale', error: record.error };
  }

  // Broadcast for real — but only after re-verifying against fresh
  // state (see preBroadcastCheck above): a check-in, pause, disable,
  // or replacement that landed while the input check was on the
  // network must stop the broadcast. The route is the transaction's
  // own broadcastVia (0.7.16): 'public' broadcasts via the mempool
  // nodes (primary, then secondary); 'slipstream' submits to MARA
  // Slipstream ONLY. There is no cross-route fallback — if the
  // selected route fails, the transaction is 'failed' and the next
  // evaluation retries that same route. The manual "Broadcast
  // publicly" escape hatch (opts.forcePublic) overrides the route:
  // it always goes public, whatever the stored route says.
  const pre = preBroadcastCheck(tx, logKind, now, opts);
  if (!pre.ok) {
    return { id: tx.id, txid: tx.txid, label: tx.label || '', action: 'skipped', reason: pre.reason };
  }
  const via = (opts && opts.forcePublic) ? 'public' : (pre.tx.broadcastVia === 'slipstream' ? 'slipstream' : 'public');
  // (0.7.17) The first Slipstream attempt — success or fail — is the
  // deadline anchor for a transaction whose submit keeps failing
  // (case (b) of fallbackDeadline). Record it once, before the
  // network call, so it is set even if the attempt itself throws;
  // never overwrite it after. The success and failure branches below
  // reload fresh state, so this write survives them.
  if (via === 'slipstream') {
    const fresh0 = store.loadState(DATA_DIR);
    const ftx0 = (fresh0.bitcoin.txs || []).find((t) => t.id === tx.id);
    if (ftx0 && ftx0.hex === tx.hex && !ftx0.slipstreamFirstAttemptAt) {
      ftx0.slipstreamFirstAttemptAt = now.toISOString();
      store.saveState(DATA_DIR, fresh0);
    }
  }
  // (0.7.17) The public fallback (refreshPublicFallbacks) passes
  // fallbackDays: its presence means this public broadcast is the
  // automatic fallback for a Slipstream transaction that ran out its
  // timer — the broadcast log must say why it went public, so the
  // note is prefixed onto the broadcast entry broadcastTx writes.
  const fallbackNote = (opts && typeof opts.fallbackDays === 'number')
    ? 'Public fallback: this Slipstream transaction was not publicly visible within ' + opts.fallbackDays + (opts.fallbackDays === 1 ? ' day' : ' days') + ', so Standby broadcast it publicly instead.'
    : null;
  try {
    if (via === 'slipstream') {
      // A successful Slipstream submission is NOT a broadcast yet:
      // the transaction is in MARA's private mempool, invisible to
      // the public nodes. It gets its own release status,
      // 'submitted-slipstream' — a pseudo-pending-but-success state
      // — and NO broadcasted fact (that fact is written only once
      // the public nodes see it, by refreshMaraWaiting). The release
      // is not complete while any transaction is in this state.
      const out = await bitcoin.broadcastViaSlipstream(pre.tx.hex, pre.tx.txid);
      const record = { status: 'submitted-slipstream', kind: logKind, txid: out.txid, method: 'slipstream', submittedAt: now.toISOString() };
      const fresh = store.loadState(DATA_DIR);
      const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
      if (ftx && ftx.hex === tx.hex) {
        ftx.release = record;
        store.saveState(DATA_DIR, fresh);
      }
      store.appendBroadcastLog(DATA_DIR, {
        ts: now.toISOString(), kind: logKind, status: 'submitted-slipstream', method: 'slipstream', txid: out.txid,
        hexPreview: pre.tx.hex.slice(0, 64),
        note: 'Submitted to MARA Slipstream — waiting for MARA to mine it. Not visible in the public mempool yet.',
      });
      return { id: tx.id, txid: out.txid, label: tx.label || '', action: 'submitted-slipstream', method: 'slipstream' };
    }
    const out = await bitcoin.broadcastTx(DATA_DIR, { hex: pre.tx.hex, txid: pre.tx.txid, endpoints, notePrefix: fallbackNote });
    // Merge-only write (audit finding 1): the broadcast itself was
    // just on the network, and anything may have landed while it was
    // out there — a check-in, a settings change, a disable. Saving
    // pre.state here would overwrite those newer changes (and a lost
    // check-in is exactly how a release could outlive the owner
    // checking in). So reload FRESH state and write only the
    // broadcast record onto the matching transaction. If the tx was
    // deleted or replaced mid-broadcast, there is no record left to
    // mark — the broadcast already went out on-chain and is in the
    // broadcast log — and the deleted/replaced record must NOT be
    // resurrected by saving the old snapshot.
    const record = { status: 'broadcast', kind: logKind, txid: out.txid, method: out.method, broadcastedAt: now.toISOString() };
    const fresh = store.loadState(DATA_DIR);
    const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
    if (ftx && ftx.hex === tx.hex) {
      // The escape hatch went public: the stored route follows the
      // tx — it is a public tx now, and if it ever drops back to
      // 'release-due' it retries via the public route.
      if (opts && opts.forcePublic) ftx.broadcastVia = 'public';
      ftx.release = record;
      ftx.broadcasted = {
        txid: out.txid, broadcastedAt: now.toISOString(), method: out.method,
        confirmations: null, blockHeight: null, found: true, checkedAt: null,
      };
      store.saveState(DATA_DIR, fresh);
    }
    return { id: tx.id, txid: out.txid, label: tx.label || '', action: 'broadcast', method: out.method };
  } catch (e) {
    // A failed attempt (either route) is 'failed' and retried on
    // the next evaluation via the SAME selected route (0.7.14 retry
    // rule). For Slipstream the error carries Slipstream's own
    // rejection reason (a fee below the floor, a sanctions
    // rejection, an invalid tx). The method names the route that
    // failed: 'slipstream' for Slipstream, 'primary' for the public
    // route (the first endpoint tried — the pre-0.7.16 convention).
    // EXCEPT the manual "Broadcast publicly" escape hatch
    // (forcePublic): a failed public attempt does NOT write a
    // 'failed' record — the tx stays Slipstream-pending, still in
    // MARA's queue, and the error is surfaced to the owner instead.
    const record = { status: 'failed', kind: logKind, txid: tx.txid, method: via === 'slipstream' ? 'slipstream' : 'primary', lastAttemptAt: now.toISOString(), error: e.message };
    if (!(opts && opts.forcePublic)) {
      const fresh = store.loadState(DATA_DIR);
      const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
      if (ftx && ftx.hex === tx.hex) recordRelease(fresh, ftx, record, null); // broadcastTx already logged the failure
    }
    return { id: tx.id, txid: tx.txid, label: tx.label || '', action: 'failed', error: e.message };
  }
}

function recordRelease(state, tx, record, logEntry) {
  tx.release = record;
  store.saveState(DATA_DIR, state);
  if (logEntry) store.appendBroadcastLog(DATA_DIR, logEntry);
}

// Release evaluation — the heart of the app. When the check-in clock has
// run past the broadcast threshold ("release-due"), every ARMED transaction is
// evaluated in list order, each on its own, via broadcastOne() above.
//   1. Skip if paused / vacation / nothing armed.
//   2. Skip a tx already broadcast (this cycle, or any cycle — the
//      broadcasted fact survives check-ins) or stale (a stale verdict
//      survives check-ins too — it is a fact about the inputs, not
//      the cycle).
//   3. Freshness gate + broadcast per tx (see broadcastOne).
//      One tx failing does not stop the others.
// All-or-none (0.7.10): the release decision is made once, when the
// clock is found due above. A check-in that lands while the release
// is running is still recorded and resets the clock for the NEXT
// cycle, but it does not stop the txs still to broadcast — a release
// that started finishes. (The audit's finding 1 recommended
// re-evaluating the clock before each tx; the owner chose all-or-none
// instead.) What still stops a tx mid-run: it was deleted, replaced,
// disabled, or the switch was paused — explicit owner actions.
// A check-in clears every tx's cycle-scoped release record and starts
// a new cycle — a stale record is not cycle-scoped and survives; but
// if a broadcast already went out, the funds have already moved; the
// broadcast log keeps the record, and the broadcasted fact keeps the
// card showing it.
// ---------------------------------------------------------------------------
// Single-flight: only one release evaluation runs at a time. The
// hourly tick and the manual release-check API both call
// evaluateRelease(); without this they can overlap, and two
// evaluations can broadcast the same transaction. A second caller gets
// a plain 'already in progress' skip. The flag is set and cleared
// synchronously around the awaited work, in a finally, so it can never
// stick — and Node's single thread makes the check-and-set atomic.
let releaseEvaluationInFlight = false;
async function evaluateRelease() {
  if (releaseEvaluationInFlight) {
    return { action: 'skipped', reason: 'release evaluation already in progress', results: [] };
  }
  releaseEvaluationInFlight = true;
  try {
    // A receiver check-in that landed since the last read is merged
    // before the clock is judged — the manual release check (POST
    // /api/release/check) is otherwise the only evaluation path that
    // skips it (the hourly tick merges first, and the status/key
    // endpoints merge on read). Merging twice is harmless:
    // mergeExternalCheckin only applies a timestamp newer than the
    // clock, so a second merge is a no-op (0.7.12, third-audit
    // finding 3).
    // (0.7.13, fourth-audit finding 7) An unreadable receiver state
    // withholds the whole evaluation: the file may hold a check-in
    // that would clear the due state, and broadcasting on a clock
    // that may be wrong is the worst failure this app has. Skip this
    // evaluation — mark nothing, retry next tick — and say so loudly
    // (the owner sees it in GET /api/status as checkinReadError).
    // A missing file is not an error: it just means no receiver is
    // installed, and releases proceed as before. A merge that throws
    // is treated the same way: if the merged check-in cannot be
    // applied reliably, do not broadcast on the unmerged clock.
    let merged;
    try { merged = mergeExternalCheckin(store.loadState(DATA_DIR), new Date()); }
    catch (e) { console.error('external check-in merge failed:', e); merged = 'error'; }
    if (merged === 'error') {
      console.error('release withheld: external check-in state is unreadable — not broadcasting until it can be read (see GET /api/status checkinReadError)');
      return { action: 'skipped', reason: 'check-in state unreadable', results: [] };
    }
    return await evaluateReleaseInner();
  } finally {
    releaseEvaluationInFlight = false;
  }
}

async function evaluateReleaseInner() {
  const state = store.loadState(DATA_DIR);
  const now = new Date();
  const s = state.settings;
  if (s.paused || s.vacationMode) return { action: 'skipped', reason: 'paused or vacation mode', results: [] };
  const armed = (state.bitcoin.txs || []).filter((t) => t.enabled);
  if (!armed.length) return { action: 'skipped', reason: 'no armed transactions', results: [] };
  const st = checkinStatus(state, now);
  if (st.state !== 'release-due') return { action: 'skipped', reason: 'not release-due (' + st.state + ')', results: [] };

  // Endpoints: the primary node first, the secondary if the primary
  // does not answer. (The MEMPOOL_* env vars can override the primary
  // — see lib/bitcoin.js.)
  const endpoints = bitcoin.endpointsFor(s);
  const results = [];

  for (const tx of armed) {
    if (tx.broadcasted) {
      results.push({ id: tx.id, txid: tx.txid, label: tx.label || '', action: 'skipped', reason: 'already broadcast' });
      continue;
    }
    if (tx.release && tx.release.status === 'broadcast') {
      results.push({ id: tx.id, txid: tx.txid, label: tx.label || '', action: 'skipped', reason: 'already broadcast' });
      continue;
    }
    if (tx.release && tx.release.status === 'stale') {
      results.push({ id: tx.id, txid: tx.txid, label: tx.label || '', action: 'skipped', reason: 'transaction is stale — replace it to re-arm' });
      continue;
    }
    // Already submitted to Slipstream and waiting on MARA (0.7.16):
    // it is not re-submitted. refreshMaraWaiting (run after this
    // evaluation, on the tick and on the manual release check) is
    // what moves it on — to 'broadcast' once the public nodes see
    // it, or back to 'failed' if MARA drops it.
    if (tx.release && tx.release.status === 'submitted-slipstream') {
      results.push({ id: tx.id, txid: tx.txid, label: tx.label || '', action: 'skipped', reason: 'submitted to Slipstream — waiting on MARA' });
      continue;
    }
    // releaseRun: the release decision was made once, above — a
    // check-in landing mid-run is recorded but does not stop the
    // remaining transactions (all-or-none, 0.7.10).
    results.push(await broadcastOne(state, tx, endpoints, now, 'release', { releaseRun: true }));
  }

  const action = results.some((r) => r.action === 'broadcast') ? 'broadcast'
    : results.some((r) => r.action === 'failed') ? 'failed'
    : results.some((r) => r.action === 'stale') ? 'stale' : 'skipped';
  return { action, results };
}

// Refresh the confirmation count for every broadcast transaction.
// `maxAgeSec`: only re-query a tx whose last check is older than this
// (0 = always re-query). Returns [{ id, txid, confirmations,
// blockHeight, found, checkedAt }]. Best-effort per tx: a failed
// lookup keeps the last known value, and the checkedAt stays old so the
// UI can tell the number is stale.
async function refreshConfirmations(state, maxAgeSec) {
  // Collect the network results first, then merge ONLY the
  // confirmation fields into FRESH state before saving. The old code
  // mutated this (stale) state object while the lookups were on the
  // network and saved it, so a user edit landing during the hourly
  // tick — disable, delete, or change a transaction — was clobbered
  // by the save. (Same class of bug as the 0.7.6 broadcast race;
  // the synchronous handlers were already atomic.)
  const endpoints = bitcoin.endpointsFor(state.settings);
  const nowMs = Date.now();
  const out = [];
  const updates = [];
  for (const tx of (state.bitcoin.txs || []).filter((t) => t.broadcasted)) {
    const b = tx.broadcasted;
    const ageSec = b.checkedAt ? (nowMs - new Date(b.checkedAt).getTime()) / 1000 : Infinity;
    if (ageSec < maxAgeSec && b.confirmations !== null) {
      out.push({ id: tx.id, txid: tx.txid, confirmations: b.confirmations, blockHeight: b.blockHeight ?? null, found: b.found !== false, checkedAt: b.checkedAt });
      continue;
    }
    try {
      const c = await bitcoin.getConfirmations(tx.txid, endpoints);
      const checkedAt = new Date().toISOString();
      updates.push({ id: tx.id, txid: tx.txid, confirmations: c.confirmations, blockHeight: c.blockHeight, found: c.found, checkedAt });
      out.push({ id: tx.id, txid: tx.txid, confirmations: c.confirmations, blockHeight: c.blockHeight ?? null, found: c.found !== false, checkedAt });
    } catch (e) {
      console.error('confirmations check failed for', tx.txid.slice(0, 12), e.message);
      out.push({ id: tx.id, txid: tx.txid, confirmations: b.confirmations, blockHeight: b.blockHeight ?? null, found: b.found !== false, checkedAt: b.checkedAt });
    }
  }
  if (updates.length) {
    const fresh = store.loadState(DATA_DIR);
    let changed = false;
    for (const u of updates) {
      // Only apply to the same transaction, still broadcasted — a
      // tx deleted or replaced in the meantime gets no update.
      const tx = (fresh.bitcoin.txs || []).find((t) => t.id === u.id && t.broadcasted && t.broadcasted.txid === u.txid);
      if (tx) {
        tx.broadcasted.confirmations = u.confirmations;
        tx.broadcasted.blockHeight = u.blockHeight;
        tx.broadcasted.found = u.found;
        tx.broadcasted.checkedAt = u.checkedAt;
        changed = true;
      }
    }
    if (changed) store.saveState(DATA_DIR, fresh);
  }
  return out;
}

// Refresh the MARA-waiting transactions (0.7.16). For every tx
// whose release status is 'submitted-slipstream' — submitted to MARA
// Slipstream, not yet visible in the public mempool — check BOTH:
//   (a) the public node lookup: if the tx is now visible (in the
//       public mempool, unconfirmed, or confirmed) it is out there —
//       mined or relayed — so it becomes 'broadcast', with the
//       permanent broadcasted fact (method 'slipstream', since that
//       is how it went out). The release is then complete for it.
//   (b) Slipstream's own status endpoint: if it reports the tx as
//       failed/dropped (MARA no longer lists it), the tx is 'failed'
//       — the standard failure path — and the next evaluation retries
//       it via Slipstream (the 0.7.14 retry rule). If Slipstream
//       still shows it queued, the queue info (position, next-block
//       likelihood) is refreshed on the record and the tx stays
//       'submitted-slipstream'.
// A status check that itself fails (endpoint down, unparseable)
// changes nothing — the tx stays waiting and is checked again next
// tick. This is a status refresh, not a broadcast: it runs on the
// hourly tick and on the manual release check regardless of the
// check-in clock (a MARA-waiting tx needs its status kept current
// even while the clock is on-track), and it is NOT withheld by an
// unreadable receiver check-in state (it writes no broadcast, only
// status). Returns [{ id, txid, action }] — 'broadcast', 'failed',
// 'still-waiting', or 'unchanged' (the status check failed).
async function refreshMaraWaiting(state) {
  const endpoints = bitcoin.endpointsFor(state.settings);
  const now = new Date();
  const out = [];
  const updates = [];
  for (const tx of (state.bitcoin.txs || []).filter((t) => t.release && t.release.status === 'submitted-slipstream')) {
    // (a) Public visibility first: if the public nodes see it, it
    // is out there and the release is done for this tx.
    let conf = null;
    try { conf = await bitcoin.getConfirmations(tx.txid, endpoints); } catch (e) { conf = null; }
    if (conf && conf.found) {
      updates.push({ id: tx.id, txid: tx.txid, kind: 'broadcast', confirmations: conf.confirmations, blockHeight: conf.blockHeight, checkedAt: new Date().toISOString() });
      out.push({ id: tx.id, txid: tx.txid, action: 'broadcast' });
      continue;
    }
    // (b) Not visible publicly — ask Slipstream whether it still
    // has it.
    const ms = await bitcoin.getSlipstreamTxStatus(tx.txid);
    if (ms.state === 'confirmed') {
      // MARA mined it (the public nodes have not caught up yet).
      updates.push({ id: tx.id, txid: tx.txid, kind: 'broadcast', confirmations: null, blockHeight: ms.blockHeight, checkedAt: new Date().toISOString() });
      out.push({ id: tx.id, txid: tx.txid, action: 'broadcast' });
      continue;
    }
    if (ms.state === 'failed') {
      updates.push({ id: tx.id, txid: tx.txid, kind: 'failed', error: 'Slipstream no longer lists this transaction — dropped from MARA\u2019s queue' });
      out.push({ id: tx.id, txid: tx.txid, action: 'failed' });
      continue;
    }
    if (ms.state === 'queued') {
      updates.push({
        id: tx.id, txid: tx.txid, kind: 'queue',
        mara: { position: ms.position, isNextBlock: ms.isNextBlock, last24hOdds: ms.last24hOdds, last7dOdds: ms.last7dOdds, checkedAt: new Date().toISOString() },
      });
      out.push({ id: tx.id, txid: tx.txid, action: 'still-waiting' });
      continue;
    }
    // 'unknown': the status check itself failed — leave the tx
    // waiting, check again next tick.
    out.push({ id: tx.id, txid: tx.txid, action: 'unchanged' });
  }
  if (updates.length) {
    // Merge into FRESH state (see refreshConfirmations): an edit
    // landing while the lookups were on the network would otherwise
    // be clobbered by the save of this stale copy.
    const fresh = store.loadState(DATA_DIR);
    let changed = false;
    for (const u of updates) {
      const tx = (fresh.bitcoin.txs || []).find((t) => t.id === u.id && t.release && t.release.status === 'submitted-slipstream');
      if (!tx) continue;
      if (u.kind === 'broadcast') {
        // Keep the record's kind ('release' vs 'broadcast'): the
        // check-in status turns 'broadcasted' only for a release
        // kind, exactly as for a public broadcast.
        const kind = tx.release.kind || 'release';
        tx.release = { status: 'broadcast', kind, txid: u.txid, method: 'slipstream', broadcastedAt: now.toISOString() };
        tx.broadcasted = {
          txid: u.txid, broadcastedAt: now.toISOString(), method: 'slipstream',
          confirmations: u.confirmations, blockHeight: u.blockHeight, found: true, checkedAt: u.checkedAt,
        };
        store.appendBroadcastLog(DATA_DIR, {
          ts: now.toISOString(), kind: 'release', status: 'broadcast', method: 'slipstream', txid: u.txid,
          hexPreview: tx.hex.slice(0, 64),
          note: 'A Slipstream-submitted transaction is now visible via the public nodes — recorded as broadcast.',
        });
        changed = true;
      } else if (u.kind === 'failed') {
        tx.release = { status: 'failed', kind: tx.release.kind || 'release', txid: u.txid, method: 'slipstream', lastAttemptAt: now.toISOString(), error: u.error };
        store.appendBroadcastLog(DATA_DIR, {
          ts: now.toISOString(), kind: 'release', status: 'failed', method: 'slipstream', txid: u.txid,
          hexPreview: tx.hex.slice(0, 64),
          note: u.error + '. It will be retried via Slipstream on the next hourly check.',
        });
        changed = true;
      } else if (u.kind === 'queue') {
        tx.release.mara = u.mara;
        changed = true;
      }
    }
    if (changed) store.saveState(DATA_DIR, fresh);
  }
  return out;
}

// Public fallback (0.7.17): the automatic version of the manual
// "Broadcast publicly" escape hatch. For each Slipstream-route tx
// whose fallback deadline (fallbackDeadline) has passed, that is not
// publicly visible and not stale: broadcast it publicly via the
// existing broadcastTx (primary, then secondary). On success the
// stored route becomes 'public' (broadcastOne with forcePublic does
// that), the broadcasted fact is set, and the broadcast-log entry
// names the fallback (notePrefix via opts.fallbackDays). On failure
// the tx is left as-is — still Slipstream-pending or release-due —
// and the next tick re-attempts it (the deadline has passed, so every
// tick re-attempts until it succeeds or the tx resolves). NO 'failed'
// release record is written for a fallback failure (forcePublic
// skips it): the fallback re-attempt is its own cadence, and a
// 'failed' record would confuse the retry rule — exactly the manual
// escape hatch's reasoning.
// Guards — the fallback does NOT fire when: the duration is Never
// (null); the route is not slipstream; the tx is disarmed (the owner
// said don't broadcast it); the switch is paused or in vacation mode
// (pause means don't broadcast anything); the tx is already
// broadcasted or carries a 'broadcast' release record (settled — a
// restore can carry the record without the fact); the tx is stale
// (the freshness gate inside broadcastOne marks it stale and never
// broadcasts it). Public visibility is checked FIRST: if the public
// nodes already see the tx, it is marked broadcast (the normal
// recognition path — method is the node that reported it) and no
// fallback broadcast happens.
// A check-in does NOT cancel a due fallback: the fallback is not
// part of the release evaluation's clock gate (it runs alongside
// refreshMaraWaiting, regardless of the clock), and its deadline is
// anchored on submittedAt / firstAttemptAt, not on the cycle — a
// check-in clears the cycle record, but the next tick re-evaluates
// the same past deadline and fires. This is the point of the timer:
// the tx goes public even when nobody is watching.
// Runs on the hourly tick and on the manual release check, AFTER
// refreshMaraWaiting, so a tx MARA just confirmed as visible is not
// also fallback-broadcast. It is NOT reachable from Broadcast All
// (that path never calls it) and NOT triggered by the manual escape
// hatch (a separate, immediate path). Returns [{ id, txid, action,
// ... }] — 'broadcast', 'failed', or 'stale' per tx.
async function refreshPublicFallbacks(state) {
  const out = [];
  if (state.settings.paused || state.settings.vacationMode) return out;
  const endpoints = bitcoin.endpointsFor(state.settings);
  const now = new Date();
  for (const tx of (state.bitcoin.txs || [])) {
    if (tx.broadcastVia !== 'slipstream') continue;
    if (!tx.enabled) continue;
    if (validPublicFallbackDays(tx.publicFallbackDays) === null) continue;
    if (tx.broadcasted) continue;
    if (tx.release && (tx.release.status === 'stale' || tx.release.status === 'broadcast')) continue;
    const deadline = fallbackDeadline(tx);
    if (!deadline || now.getTime() < deadline.getTime()) continue;
    // Public visibility first: if the nodes already see it, it is
    // out there — mark it broadcast, do not send it again. (For a
    // submitted-slipstream tx refreshMaraWaiting normally gets here
    // first; this branch is mostly for a release-due tx whose submit
    // kept failing but which is visible anyway — someone else sent
    // it, or MARA mined it without the status endpoint knowing.)
    let conf = null;
    try { conf = await bitcoin.getConfirmations(tx.txid, endpoints); } catch (e) { conf = null; }
    if (conf && conf.found) {
      const fresh = store.loadState(DATA_DIR);
      const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id && t.hex === tx.hex && !t.broadcasted);
      if (ftx) {
        const kind = (ftx.release && ftx.release.kind) || 'release';
        ftx.release = { status: 'broadcast', kind, txid: tx.txid, method: conf.checkedVia || 'slipstream', broadcastedAt: now.toISOString() };
        ftx.broadcasted = {
          txid: tx.txid, broadcastedAt: now.toISOString(), method: conf.checkedVia || 'slipstream',
          confirmations: conf.confirmations, blockHeight: conf.blockHeight, found: true, checkedAt: new Date().toISOString(),
        };
        store.appendBroadcastLog(DATA_DIR, {
          ts: now.toISOString(), kind: 'release', status: 'broadcast', method: conf.checkedVia || 'slipstream', txid: tx.txid,
          hexPreview: tx.hex.slice(0, 64),
          note: 'A Slipstream transaction whose public-fallback deadline had passed is already visible via the public nodes — recorded as broadcast; nothing was sent.',
        });
        store.saveState(DATA_DIR, fresh);
      }
      out.push({ id: tx.id, txid: tx.txid, action: 'broadcast', alreadyVisible: true });
      continue;
    }
    // Not visible: broadcast it publicly. releaseRun skips the clock
    // re-check in preBroadcastCheck (the fallback's own deadline is
    // the trigger, not the check-in clock); forcePublic forces the
    // public route past the 'submitted-slipstream' block, sets the
    // stored route to 'public' on success, and skips the 'failed'
    // record on failure. fallbackDays marks the log entry.
    const r = await broadcastOne(state, tx, endpoints, now, 'release', { releaseRun: true, forcePublic: true, fallbackDays: tx.publicFallbackDays });
    out.push({ id: tx.id, txid: tx.txid, action: r.action, method: r.method, error: r.error, reason: r.reason });
  }
  return out;
}

// One release tick: load fresh state, evaluate. Runs hourly and once
// shortly after startup (see the bottom of this file). The tick also
// re-tests the nodes, so the Dashboard status is fresh even when the
// owner has not opened the app — they can see it when they go to check
// in — and refreshes the confirmation count for any broadcast
// transaction, so the stored number stays accurate even when the UI is
// closed. Best-effort: a node test or a confirmations refresh never
// breaks the tick.
async function runReleaseTick() {
  // A receiver check-in lands in the clock before the release is
  // evaluated, so a check-in that arrived between ticks is honoured
  // even if nobody opened the app.
  try {
    const st0 = store.loadState(DATA_DIR);
    mergeExternalCheckin(st0, new Date());
  } catch (e) { console.error('external check-in merge failed:', e); }
  try {
    const r = await evaluateRelease();
    if (r.action !== 'skipped') {
      const sum = (r.results || []).map((x) => x.action + ':' + (x.txid || '').slice(0, 8)).join(', ');
      console.log('release tick:', r.action, sum || r.reason || '');
    }
  } catch (e) { console.error('release tick failed:', e); }
  try {
    await testNodes();
  } catch (e) { console.error('node check failed:', e); }
  try {
    const st = store.loadState(DATA_DIR);
    await refreshConfirmations(st, 0);
  } catch (e) { console.error('confirmations refresh failed:', e); }
  // MARA-waiting transactions (0.7.16): a Slipstream submission
  // that is not yet visible publicly needs its status kept current
  // even while the clock is on-track — the refresh runs after the
  // evaluation (so a tx MARA just dropped is retried on the NEXT
  // tick, not in this one) and regardless of the clock.
  try {
    const st = store.loadState(DATA_DIR);
    await refreshMaraWaiting(st);
  } catch (e) { console.error('MARA-waiting refresh failed:', e); }
  // Public fallback (0.7.17): a Slipstream transaction whose
  // fallback deadline has passed goes public — after the MARA
  // refresh above, so a tx MARA just confirmed as visible is not
  // also fallback-broadcast. Runs regardless of the clock, like the
  // MARA refresh.
  try {
    const st = store.loadState(DATA_DIR);
    await refreshPublicFallbacks(st);
  } catch (e) { console.error('public-fallback refresh failed:', e); }
}

// Test both nodes and save the per-endpoint results, so the Dashboard
// can show each node's own status. The full result (endpoint, base,
// ok, detail) is stored — the Dashboard only trusts a result measured
// against the endpoint as currently configured.
async function testNodes() {
  const state = store.loadState(DATA_DIR);
  const r = await bitcoin.testConnection(bitcoin.endpointsFor(state.settings));
  // Merge into FRESH state (see refreshConfirmations): an edit landing
  // while the node test was on the network would otherwise be
  // clobbered by the save of this stale copy. The Dashboard only
  // trusts a result measured against the endpoints as currently
  // configured, so a result measured against just-replaced endpoints
  // is ignored, not misattributed.
  const fresh = store.loadState(DATA_DIR);
  fresh.bitcoin.connection = { ok: r.ok, checkedAt: new Date().toISOString(), detail: r.detail, results: r.results };
  store.saveState(DATA_DIR, fresh);
}

function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? 'index.html' : pathname.slice(1);
  // Prevent path traversal.
  const resolved = path.resolve(PUBLIC_DIR, file);
  if (!resolved.startsWith(PUBLIC_DIR)) { sendError(res, 403, 'forbidden'); return; }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) { sendError(res, 404, 'not found'); return; }
  const ext = path.extname(resolved);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(resolved).pipe(res);
}

// ---------------------------------------------------------------------------
// CSRF protection (0.7.12, third-audit finding 2). The UI is the only
// browser client: it fetches this API from the same origin, and api()
// in public/app.js sends Content-Type: application/json on every call
// (verified — the file has a single fetch, with that header always
// set). A cross-origin page cannot read the responses (no CORS headers
// are ever sent), but a plain form POST, or a no-cors fetch, could
// still reach a state-changing endpoint with the owner's Umbrel
// app-auth cookie attached. So a state-changing /api request must
// pass both checks:
//   (a) a present Origin must match the host the request reached (the
//       Host header), or the X-Forwarded-Host the proxy sets — or both
//       sides must be loopback. A missing Origin (curl, a script, the
//       DOM test shim — Node's fetch sends none) is still allowed.
//       This is the same rule Umbrel's own Murmur app uses behind the
//       app proxy, which preserves Host.
//   (b) the Content-Type must be application/json — a cross-origin
//       HTML form can only send urlencoded / multipart / text, and a
//       no-cors fetch cannot set a JSON content type without a CORS
//       preflight this server never answers.
// GETs are reads and are not gated.
function hostOf(h) {
  h = (h || '').trim();
  if (h.startsWith('[')) {
    const close = h.indexOf(']');
    return (close === -1 ? h.slice(1) : h.slice(1, close)).toLowerCase();
  }
  return h.split(':')[0].toLowerCase();
}

function isLoopback(h) {
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

function csrfAllowed(req) {
  const origin = req.headers.origin;
  if (origin) {
    let oh;
    try { oh = hostOf(new URL(origin).hostname); } catch { return false; }
    const host = hostOf(req.headers.host);
    const fwd = hostOf((req.headers['x-forwarded-host'] || '').split(',')[0]);
    if (oh !== host && oh !== fwd && !(isLoopback(oh) && isLoopback(host))) return false;
  }
  const ct = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') return false;
  return true;
}

// The release-record statuses the app itself writes (see recordRelease
// / broadcastOne): 'stale', 'failed', 'broadcast', 'conflict' — the
// last is an input spent by another transaction that is NOT confirmed
// yet (0.7.12, third-audit finding 1): a warning, not a verdict —
// the transaction stays active and a broadcast is still attempted.
// A backup carrying any other status is not a real record (0.7.12,
// third-audit finding 4).
const RELEASE_STATUSES = new Set(['stale', 'failed', 'broadcast', 'conflict', 'submitted-slipstream']);
// The kinds a release record may carry — 'release' for the automatic
// release, 'broadcast' for a manual broadcast, 'dryrun' for a
// dry-run verdict. Used by the restore validation (0.7.13).
const RELEASE_KINDS = new Set(['release', 'broadcast', 'dryrun']);

async function handleApi(req, res, pathname) {
  const now = new Date();
  // CSRF gate (0.7.12): state-changing requests must come from the
  // app's own page — see csrfAllowed above. Checked before any state
  // is loaded, so a rejected request cannot touch anything.
  if (req.method !== 'GET' && !csrfAllowed(req)) {
    return sendError(res, 403, 'cross-origin or non-JSON request rejected');
  }
  let state = store.loadState(DATA_DIR);

  // GET /api/health
  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, version: VERSION });
  }

  // GET /api/state — full state (no secrets live in state any more).
  // Also carries the shared inputs, derived from the stored
  // transactions on every read (findSharedInputs parses the hexes,
  // no network): the UI renders the shared-input warning from this,
  // so the warning persists across refreshes and clears the moment a
  // transaction is edited away from the shared input. It is derived,
  // not stored — the state file holds only the transactions.
  if (req.method === 'GET' && pathname === '/api/state') {
    // A receiver check-in that landed since the last read is merged
    // first, so the state served is current.
    mergeExternalCheckin(state, now);
    const served = sanitizeState(state);
    served.bitcoin.overlaps = bitcoin.findSharedInputs(state.bitcoin.txs || []);
    // The inputs/outputs detail (0.7.18 refinement): derived from
    // the stored hexes on every read, like the overlaps — never
    // stored, so no migration and no restore change. An unparseable
    // hex (defensive only — adds and restores validate) gets no
    // detail, and the card falls back to the plain counts.
    for (const t of served.bitcoin.txs || []) {
      try { t.detail = bitcoin.txIoDetail(bitcoin.parseTx(t.hex)); }
      catch { t.detail = null; }
    }
    return sendJson(res, 200, served);
  }

  // GET /api/status
  if (req.method === 'GET' && pathname === '/api/status') {
    const merged = mergeExternalCheckin(state, now);
    const txs = state.bitcoin.txs || [];
    return sendJson(res, 200, {
      ...checkinStatus(state, now),
      lastCheckinAt: state.checkin.lastCheckinAt,
      totalCheckins: state.checkin.totalCheckins,
      // (0.7.13, fourth-audit finding 7) Whether the receiver's
      // check-in file could not be read. A missing file is NOT an
      // error (no receiver installed); an unreadable one means the
      // release evaluation is withheld until it can be read again.
      checkinReadError: merged === 'error',
      bitcoinEnabled: txs.some((t) => t.enabled),
      bitcoinTxStored: txs.length > 0,
      primaryApiUrl: state.settings.primaryApiUrl,
      secondaryApiUrl: state.settings.secondaryApiUrl,
      // Per-tx release records (only txs with one) — the cycle-scoped
      // ones are cleared by a check-in, but a stale record survives
      // (it is a fact about the inputs, not the cycle).
      releases: txs.filter((t) => t.release).map((t) => ({
        id: t.id, txid: t.txid, label: t.label || '', ...t.release,
      })),
    });
  }

  // GET /api/checkins
  if (req.method === 'GET' && pathname === '/api/checkins') {
    mergeExternalCheckin(state, now);
    return sendJson(res, 200, store.readCheckins(DATA_DIR, 50).reverse());
  }

  // GET /api/broadcast/log — dry-runs, broadcasts, release attempts.
  if (req.method === 'GET' && pathname === '/api/broadcast/log') {
    return sendJson(res, 200, store.readBroadcastLog(DATA_DIR, 50).reverse());
  }

  // POST /api/release/check — run the release evaluation now (also runs hourly).
  // A receiver check-in is merged inside evaluateRelease first (0.7.12),
  // so a check-in that arrived since the last read is honoured here too.
  if (req.method === 'POST' && pathname === '/api/release/check') {
    const r = await evaluateRelease();
    // MARA-waiting transactions (0.7.16): refresh after the
    // evaluation, so a tx MARA just dropped is retried on the next
    // evaluation, not in this one. The response below is read from
    // fresh state, so it already reflects the refresh.
    try { await refreshMaraWaiting(store.loadState(DATA_DIR)); } catch (e) { console.error('MARA-waiting refresh failed:', e); }
    // Public fallback (0.7.17): after the MARA refresh, so a tx
    // MARA just confirmed as visible is not also fallback-broadcast.
    // Runs regardless of the check-in clock — a due fallback fires
    // even while the clock is on-track.
    let fallbacks = [];
    try { fallbacks = await refreshPublicFallbacks(store.loadState(DATA_DIR)); } catch (e) { console.error('public-fallback refresh failed:', e); }
    state = store.loadState(DATA_DIR);
    const txs = state.bitcoin.txs || [];
    return sendJson(res, 200, {
      ...r,
      fallbacks,
      status: checkinStatus(state, now),
      releases: txs.filter((t) => t.release).map((t) => ({ id: t.id, txid: t.txid, label: t.label || '', ...t.release })),
    });
  }

  // POST /api/checkin — clears every tx's cycle-scoped release record:
  // a new cycle starts. A stale record is NOT cleared: spent inputs are
  // a fact about the transaction, not the cycle, so a stale transaction
  // stays stale (and archived) across check-ins — only replacing the
  // hex re-arms it. (If a broadcast already went out, the funds have
  // already moved.) A 'submitted-slipstream' record (0.7.16) IS
  // cleared, like any other non-stale cycle record: the check-in ends
  // the cycle, and the card goes back to Ready — but the transaction
  // is still sitting in MARA's private mempool, and a check-in cannot
  // recall it. If MARA mines it, the public-node lookup (or a fresh
  // dry-run) recognises the tx's own txid out there and records it
  // broadcast; if MARA drops it, the next release re-submits it.
  if (req.method === 'POST' && pathname === '/api/checkin') {
    const body = await readBody(req).catch(() => ({}));
    const method = body.method === 'telegram' ? 'telegram' : 'app';
    const wasPaused = state.settings.paused;
    state.checkin.lastCheckinAt = now.toISOString();
    state.checkin.totalCheckins += 1;
    for (const t of (state.bitcoin.txs || [])) {
      if (t.release && t.release.status === 'stale') continue;
      t.release = null;
    }
    if (wasPaused) state.settings.paused = false; // owner is alive — auto-resume
    store.saveState(DATA_DIR, state);
    store.appendCheckin(DATA_DIR, { ts: now.toISOString(), method, autoResumed: wasPaused });
    return sendJson(res, 200, { ok: true, status: checkinStatus(state, now), autoResumed: wasPaused });
  }

  // Check-in API keys (0.6.6) — managed here, used by the check-in
  // receiver. A key is created with a label; the plaintext is returned
  // ONCE in the response and never stored — only its hash is kept, and
  // the hashes are published to the receiver (keys.json) on every
  // change. The list never carries the hash (the UI has no use for
  // it). Revoking a key removes it from state and from the receiver's
  // list, so the next check-in with it is refused.
  //
  // GET    /api/checkin-keys     — list { id, label, createdAt, lastUsedAt }
  // POST   /api/checkin-keys     — create { label } -> 201 { key, plain }
  // DELETE /api/checkin-keys/:id — revoke
  if (req.method === 'GET' && pathname === '/api/checkin-keys') {
    mergeExternalCheckin(state, now);
    return sendJson(res, 200, (state.checkinKeys || []).map(publicCheckinKey));
  }
  if (req.method === 'POST' && pathname === '/api/checkin-keys') {
    const body = await readBody(req).catch(() => ({}));
    const label = asStr(typeof body.label === 'string' ? body.label.trim() : '', 80) || 'Untitled key';
    const plain = crypto.randomBytes(32).toString('base64url');
    const key = {
      id: newCheckinKeyId(), label, hash: hashCheckinKey(plain),
      createdAt: now.toISOString(), lastUsedAt: null,
    };
    state.checkinKeys = state.checkinKeys || [];
    state.checkinKeys.push(key);
    store.saveState(DATA_DIR, state);
    writeReceiverKeys(state);
    return sendJson(res, 201, { key: publicCheckinKey(key), plain });
  }
  const keyMatch = pathname.match(/^\/api\/checkin-keys\/([^/]+)$/);
  if (req.method === 'DELETE' && keyMatch) {
    const keys = state.checkinKeys || [];
    const idx = keys.findIndex((k) => k.id === keyMatch[1]);
    if (idx === -1) return sendError(res, 404, 'no such key');
    keys.splice(idx, 1);
    store.saveState(DATA_DIR, state);
    writeReceiverKeys(state);
    return sendJson(res, 200, { ok: true, removed: keyMatch[1] });
  }

  // PUT /api/settings
  if (req.method === 'PUT' && pathname === '/api/settings') {
    const body = await readBody(req);
    const s = state.settings;
    if (body.thresholdDays !== undefined) s.thresholdDays = clampInt(body.thresholdDays, s.thresholdDays, 1, 3650);
    if (body.primaryApiUrl !== undefined) {
      const v = typeof body.primaryApiUrl === 'string' ? body.primaryApiUrl.trim() : '';
      try { s.primaryApiUrl = v ? bitcoin.normalizePublicApiUrl(v) : bitcoin.DEFAULT_PUBLIC_API_URL; }
      catch (e) { return sendError(res, 400, e.message); }
    }
    if (body.secondaryApiUrl !== undefined) {
      const v = typeof body.secondaryApiUrl === 'string' ? body.secondaryApiUrl.trim() : '';
      try { s.secondaryApiUrl = v ? bitcoin.normalizePublicApiUrl(v) : ''; }
      catch (e) { return sendError(res, 400, e.message); }
    }
    if (body.vacationMode !== undefined) s.vacationMode = !!body.vacationMode;
    if (body.vacationUntil !== undefined) s.vacationUntil = asStr(body.vacationUntil, 10);
    store.saveState(DATA_DIR, state);
    return sendJson(res, 200, sanitizeState(state).settings);
  }

  // POST /api/pause — no code required; anyone who can open the app can hold a release.
  if (req.method === 'POST' && pathname === '/api/pause') {
    state.settings.paused = true;
    store.saveState(DATA_DIR, state);
    return sendJson(res, 200, { ok: true, paused: true });
  }

  // POST /api/resume
  if (req.method === 'POST' && pathname === '/api/resume') {
    state.settings.paused = false;
    store.saveState(DATA_DIR, state);
    return sendJson(res, 200, { ok: true, paused: false });
  }

  // Transactions — the pre-signed list. Adding one arms it (the toggle
  // disarms it). The hex is validated (structure + txid) before
  // storing. The server never sees keys — only the signed hex. Replacing
  // a tx's hex clears its release record and its broadcasted fact (both
  // belong to the old hex — the new one has never been broadcast); the
  // broadcast log keeps the history. Deleting a tx drops its release
  // record with it.
  //
  // POST   /api/bitcoin/txs      — add { txHex, label, notes, broadcastVia? }
  // PUT    /api/bitcoin/txs/:id  — update { txHex?, label?, notes?, enabled?, broadcastVia? }
  // DELETE /api/bitcoin/txs/:id  — remove
  const txsMatch = pathname.match(/^\/api\/bitcoin\/txs\/([^/]+)$/);
  // One stored-transaction record, from a parsed tx and its hex —
  // shared by the paste path (POST /api/bitcoin/txs) and the file
  // import path (POST /api/bitcoin/txs/import), so the two cannot
  // drift apart. broadcastVia is the route the transaction goes out
  // on ('public' or 'slipstream', 0.7.16) — default 'public'.
  // publicFallbackDays (0.7.17) is the opt-in public-fallback
  // duration in days, or null for Never (the default).
  // slipstreamFirstAttemptAt (0.7.17) is the ISO timestamp of the
  // first Slipstream broadcast attempt, success or fail — the
  // deadline anchor for a tx whose submit keeps failing. It is set
  // by broadcastOneInner, never by the client, and never overwritten
  // once set.
  // feeSats / feeRateSatVb (0.7.18) are the transaction fee in
  // satoshis and the fee rate in sat/vB, computed from the parent
  // txs on the node at add time (and refreshed by a dry-run, and
  // recomputed at startup — see recomputeStoredFees).
  // null when the parents could not be fetched — the fee is
  // display-only, never a gate, so an unknown fee never blocks an
  // add.
  function newTxRecord(parsed, hex, label, notes, broadcastVia, publicFallbackDays) {
    return {
      id: store.newTxId(),
      txid: parsed.txid,
      hex,
      label: typeof label === 'string' ? asStr(label, 80) : '',
      notes: typeof notes === 'string' ? asStr(notes, 500) : '',
      createdAt: now.toISOString(),
      inputs: parsed.inputs.length,
      outputs: parsed.outputs.length,
      totalOutSats: parsed.totalOutSats,
      feeSats: null,
      feeRateSatVb: null,
      locktime: parsed.locktime,
      segwit: parsed.segwit,
      enabled: true, // new transactions are armed by default
      broadcastVia: validBroadcastVia(broadcastVia),
      publicFallbackDays: validPublicFallbackDays(publicFallbackDays),
      slipstreamFirstAttemptAt: null,
      release: null,
      // broadcasted is set by broadcastOne() (release or manual) and
      // survives check-ins: { txid, broadcastedAt, method,
      // confirmations, blockHeight, found, checkedAt }.
      broadcasted: null,
    };
  }
  // The fee for a parsed tx, best-effort (0.7.18): null when the
  // node cannot answer (unknown parent, unreachable node). Never
  // throws — an add must never fail because the fee could not be
  // computed.
  async function feeFor(parsed) {
    try { return await bitcoin.computeFee(parsed, bitcoin.endpointsFor(state.settings)); }
    catch { return null; }
  }
  // A transaction is identified by its txid: the same on-chain
  // transaction stored twice is two cards, both armed, for one
  // Bitcoin tx (the second broadcast is a no-op). Reject a txid
  // that is already stored, naming the existing card by its label
  // (or its id when it has no label). `exceptId` is the tx being
  // edited — its own txid is not a duplicate.
  function duplicateTx(txid, exceptId) {
    const dup = (state.bitcoin.txs || []).find((t) => t.txid === txid && t.id !== exceptId);
    return dup ? "This transaction is already stored as '" + (dup.label || dup.id) + "'" : null;
  }
  if (req.method === 'POST' && pathname === '/api/bitcoin/txs') {
    const body = await readBody(req);
    if (typeof body.txHex !== 'string' || !body.txHex.trim()) return sendError(res, 400, 'empty transaction hex');
    const input = body.txHex.trim();
    let hex;
    if (/^[0-9a-fA-F]+$/.test(input) && input.length % 2 === 0) {
      // Clean hex — the original paste path.
      hex = input;
    } else {
      // Maybe a pasted PSBT (base64). extractTxFromPsbt detects the
      // format by content. A PSBT that parses but is not fully
      // signed reports its own error (naming the inputs); anything
      // that is not a PSBT at all is an invalid paste, like a
      // corrupt hex.
      try { hex = bitcoin.extractTxFromPsbt(input).hex; }
      catch (e) {
        if (e.message.indexOf('not fully signed') !== -1) return sendError(res, 400, e.message);
        return sendError(res, 400, 'invalid transaction: ' + e.message);
      }
    }
    let parsed;
    try { parsed = bitcoin.parseTx(hex); }
    catch (e) { return sendError(res, 400, 'invalid transaction: ' + e.message); }
    const dupErr = duplicateTx(parsed.txid);
    if (dupErr) return sendError(res, 400, dupErr);
    const tx = newTxRecord(parsed, hex, body.label, body.notes, body.broadcastVia, body.publicFallbackDays);
    const fee = await feeFor(parsed);
    if (fee) { tx.feeSats = fee.feeSats; tx.feeRateSatVb = fee.feeRateSatVb; }
    state.bitcoin.txs.push(tx);
    store.saveState(DATA_DIR, state);
    return sendJson(res, 201, { tx });
  }

  // POST /api/bitcoin/txs/preview — finalize a file's contents and
  // return the raw hex WITHOUT storing anything. The UI calls this
  // when a PSBT file is imported, so the extracted hex can be put
  // in the textarea for the user to label and add via the normal
  // paste path. Body { format: 'hex'|'psbt', data }. Hex is
  // validated exactly like the paste path; a PSBT is finalized
  // exactly like the import path (same errors, including the
  // clearer "not a PSBT file" one). No state change.
  if (req.method === 'POST' && pathname === '/api/bitcoin/txs/preview') {
    const body = await readBody(req);
    if (body.format !== 'hex' && body.format !== 'psbt') return sendError(res, 400, 'import format must be hex or psbt');
    if (typeof body.data !== 'string' || !body.data.trim()) return sendError(res, 400, 'empty import data');
    let hex;
    if (body.format === 'hex') {
      try { bitcoin.parseTx(body.data.trim()); }
      catch (e) { return sendError(res, 400, 'invalid transaction: ' + e.message); }
      hex = body.data.trim();
    } else {
      try { hex = bitcoin.extractTxFromPsbt(body.data).hex; }
      catch (e) { return sendError(res, 400, e.message); }
    }
    let parsed;
    try { parsed = bitcoin.parseTx(hex); }
    catch (e) { return sendError(res, 400, 'invalid transaction: ' + e.message); }
    return sendJson(res, 200, { hex, txid: parsed.txid });
  }

  // POST /api/bitcoin/txs/import — add a signed transaction from a
  // FILE instead of a paste. Body { format: 'hex'|'psbt', data,
  // label?, notes? }. A hex file is a text file holding the raw
  // transaction hex; it is validated exactly like the paste path
  // (same errors). A PSBT file (.psbt, base64 or raw binary) is
  // finalized server-side — the PSBT must be fully signed, or it is
  // rejected with a clear error naming the inputs that are missing
  // signatures; a partially signed PSBT is never stored. The
  // extracted raw hex is validated by parseTx exactly like a paste
  // before it is stored. The body is capped at 1 MB (MAX_BODY), and
  // the PSBT parser caps the decoded PSBT at 1 MB too.
  if (req.method === 'POST' && pathname === '/api/bitcoin/txs/import') {
    const body = await readBody(req);
    if (body.format !== 'hex' && body.format !== 'psbt') return sendError(res, 400, 'import format must be hex or psbt');
    if (typeof body.data !== 'string' || !body.data.trim()) return sendError(res, 400, 'empty import data');
    let hex;
    if (body.format === 'hex') {
      try { bitcoin.parseTx(body.data.trim()); }
      catch (e) { return sendError(res, 400, 'invalid transaction: ' + e.message); }
      hex = body.data.trim();
    } else {
      try { hex = bitcoin.extractTxFromPsbt(body.data).hex; }
      catch (e) { return sendError(res, 400, e.message); }
    }
    let parsed;
    try { parsed = bitcoin.parseTx(hex); }
    catch (e) { return sendError(res, 400, 'invalid transaction: ' + e.message); }
    const dupErr = duplicateTx(parsed.txid);
    if (dupErr) return sendError(res, 400, dupErr);
    const tx = newTxRecord(parsed, hex, body.label, body.notes, body.broadcastVia, body.publicFallbackDays);
    const fee = await feeFor(parsed);
    if (fee) { tx.feeSats = fee.feeSats; tx.feeRateSatVb = fee.feeRateSatVb; }
    state.bitcoin.txs.push(tx);
    store.saveState(DATA_DIR, state);
    return sendJson(res, 201, { tx });
  }
  if (txsMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
    const tx = (state.bitcoin.txs || []).find((t) => t.id === txsMatch[1]);
    if (!tx) return sendError(res, 404, 'no such transaction');
    if (req.method === 'DELETE') {
      state.bitcoin.txs = state.bitcoin.txs.filter((t) => t.id !== tx.id);
      store.saveState(DATA_DIR, state);
      return sendJson(res, 200, { ok: true, removed: tx.id });
    }
    const body = await readBody(req);
    if (typeof body.txHex === 'string') {
      const hex = body.txHex.trim();
      if (!hex) return sendError(res, 400, 'empty transaction hex');
      let parsed;
      try { parsed = bitcoin.parseTx(hex); }
      catch (e) { return sendError(res, 400, 'invalid transaction: ' + e.message); }
      // The hex is immutable once the transaction is out the door
      // (0.7.16, Pending card): a broadcasted tx, one submitted to
      // Slipstream and waiting on MARA, a stale tx, or a
      // restore-carried 'broadcast' record — all Pending or Archived
      // — cannot be replaced with a DIFFERENT transaction, because
      // that would be a different on-chain tx. Sending the same hex
      // back (unchanged, same txid) is a no-op, not a change, so it
      // is allowed and changes nothing. A 'failed' or 'conflict'
      // record is Active, not locked: its hex can still change.
      const locked = !!(tx.broadcasted || (tx.release
        && (tx.release.status === 'submitted-slipstream' || tx.release.status === 'stale' || tx.release.status === 'broadcast')));
      if (locked && parsed.txid !== tx.txid) {
        return sendError(res, 400, 'the transaction hex cannot be changed once it has been broadcast');
      }
      if (parsed.txid !== tx.txid) {
        // A replacement hex that is another stored transaction's txid
        // is a duplicate; the tx's own hex (unchanged) is fine.
        const dupErr = duplicateTx(parsed.txid, tx.id);
        if (dupErr) return sendError(res, 400, dupErr);
        tx.hex = hex;
        tx.txid = parsed.txid;
        tx.inputs = parsed.inputs.length;
        tx.outputs = parsed.outputs.length;
        tx.totalOutSats = parsed.totalOutSats;
        // A replaced hex is a different transaction: its fee is
        // recomputed from the new inputs (best-effort, null when
        // the parents cannot be fetched).
        const fee = await feeFor(parsed);
        tx.feeSats = fee ? fee.feeSats : null;
        tx.feeRateSatVb = fee ? fee.feeRateSatVb : null;
        tx.locktime = parsed.locktime;
        tx.segwit = parsed.segwit;
        // A replaced hex is a different transaction: the broadcasted fact
        // and any release record belong to the old hex, so both are
        // cleared. The broadcast log keeps the history. (Only reachable
        // for an unlocked tx — a locked tx with a different txid is
        // rejected above, and a locked tx with the same txid takes the
        // no-op path, so its broadcasted fact is never cleared here.)
        tx.release = null;
        tx.broadcasted = null;
      }
    }
    if (typeof body.label === 'string') tx.label = asStr(body.label, 80);
    if (typeof body.notes === 'string') tx.notes = asStr(body.notes, 500);
    if (typeof body.enabled === 'boolean') tx.enabled = body.enabled;
    // The route toggle on the card (0.7.16): switching the route
    // applies to the NEXT broadcast attempt — a transaction already
    // submitted to Slipstream is not re-submitted by toggling it
    // (preBroadcastCheck blocks a re-submit while it waits on MARA).
    if (typeof body.broadcastVia === 'string') tx.broadcastVia = validBroadcastVia(body.broadcastVia);
    // The public-fallback duration (0.7.17): changeable on the card
    // and in the edit popup, for Active and Pending txs. It is
    // validated leniently (invalid → Never, never a 400), like the
    // route above. A change while the tx waits on MARA re-times the
    // deadline from the original submittedAt — the deadline is
    // computed from submittedAt at evaluation time (see
    // fallbackDeadline), so no clock is restarted here.
    if (body.publicFallbackDays !== undefined) tx.publicFallbackDays = validPublicFallbackDays(body.publicFallbackDays);
    store.saveState(DATA_DIR, state);
    return sendJson(res, 200, { tx });
  }

  // POST /api/bitcoin/txs/:id/broadcast — MANUAL broadcast, now. Same
  // path as the release (freshness gate, then primary with secondary
  // fallback) but on the owner's explicit say-so: it ignores the
  // check-in clock, the armed toggle, pause, and vacation mode. The UI
  // asks first (a confirmation dialog). A tx already broadcast is
  // skipped, never re-sent.
  const txBroadcastMatch = pathname.match(/^\/api\/bitcoin\/txs\/([^/]+)\/broadcast$/);
  if (req.method === 'POST' && txBroadcastMatch) {
    const tx = (state.bitcoin.txs || []).find((t) => t.id === txBroadcastMatch[1]);
    if (!tx) return sendError(res, 404, 'no such transaction');
    if (tx.broadcasted) {
      return sendJson(res, 200, { ok: true, id: tx.id, txid: tx.txid, label: tx.label || '', action: 'skipped', reason: 'already broadcast', tx });
    }
    const r = await broadcastOne(state, tx, bitcoin.endpointsFor(state.settings), now, 'broadcast');
    state = store.loadState(DATA_DIR);
    const fresh = (state.bitcoin.txs || []).find((t) => t.id === tx.id);
    return sendJson(res, 200, { ok: true, ...r, tx: fresh });
  }

  // POST /api/bitcoin/txs/:id/broadcast-public — the MANUAL escape
  // hatch for a slow MARA tx (0.7.16, Pending card). A transaction
  // submitted to Slipstream and waiting on MARA is private until
  // MARA mines it; if the owner does not want to wait, this
  // broadcasts it via the PUBLIC route instead (mempool.space, then
  // blockstream.info), right now, on the owner's explicit say-so.
  // It applies ONLY to a Slipstream-pending tx (release status
  // 'submitted-slipstream') — a public-pending tx is already public,
  // and an active tx uses the route toggle. On success the
  // broadcasted fact is set, the stored route becomes 'public', and
  // the tx is public-pending (confirmed -> Archived, as usual). On
  // failure the error is surfaced and the tx STAYS Slipstream-pending
  // (no 'failed' record is written — MARA is still holding it).
  // MANUAL ONLY: it is not reachable from the release evaluation or
  // Broadcast All — only this endpoint calls broadcastOne with
  // forcePublic, and only for the one tx named here.
  const txBroadcastPublicMatch = pathname.match(/^\/api\/bitcoin\/txs\/([^/]+)\/broadcast-public$/);
  if (req.method === 'POST' && txBroadcastPublicMatch) {
    const tx = (state.bitcoin.txs || []).find((t) => t.id === txBroadcastPublicMatch[1]);
    if (!tx) return sendError(res, 404, 'no such transaction');
    if (!(tx.release && tx.release.status === 'submitted-slipstream')) {
      return sendError(res, 400, 'only a transaction waiting on MARA (Slipstream-pending) can be broadcast publicly');
    }
    const r = await broadcastOne(state, tx, bitcoin.endpointsFor(state.settings), now, 'broadcast', { forcePublic: true });
    state = store.loadState(DATA_DIR);
    const fresh = (state.bitcoin.txs || []).find((t) => t.id === tx.id);
    return sendJson(res, 200, { ok: true, ...r, tx: fresh });
  }

  // POST /api/broadcast/all — MANUAL broadcast of the transactions
  // that are NOT in the Archived Transactions card (broadcasted, or
  // already declared stale) — those are never attempted or counted.
  // The UI sends their ids (it knows the archived set). Without ids
  // (an older client or a direct API call) the same rule applies from
  // what the server can see: the broadcasted ones, and the ones
  // already declared stale — by a release, a manual broadcast, or a
  // dry-run, whose stale verdict is now recorded on the transaction.
  // Each is broadcast through the same path (freshness gate, then primary
  // with secondary fallback); a stale or failed tx does not stop the
  // others. The UI asks first (a confirmation dialog).
  // Body { armedOnly: true } (round 12) sends only the armed
  // (enabled) transactions — a disarmed id in the list is skipped,
  // not sent. The broadcast guards are the same either way.
  if (req.method === 'POST' && pathname === '/api/broadcast/all') {
    const body = await readBody(req).catch(() => ({}));
    const armedOnly = !!(body && body.armedOnly);
    const txs = state.bitcoin.txs || [];
    if (!txs.length) return sendError(res, 400, 'no transactions stored — paste a signed transaction hex first');
    let targets;
    if (Array.isArray(body.ids)) {
      targets = [];
      for (const id of body.ids) {
        const tx = txs.find((t) => t.id === id);
        if (!tx) return sendError(res, 400, 'unknown transaction id: ' + id);
        // A transaction already submitted to Slipstream is not
        // re-submitted (0.7.16) — it is waiting on MARA, and the
        // MARA-waiting refresh is what moves it on.
        if (!tx.broadcasted && !(tx.release && tx.release.status === 'submitted-slipstream')) targets.push(tx);
      }
    } else {
      targets = txs.filter((t) => !t.broadcasted && !(t.release && t.release.status === 'stale')
        && !(t.release && t.release.status === 'submitted-slipstream'));
    }
    if (armedOnly) targets = targets.filter((t) => t.enabled);
    if (!targets.length) return sendError(res, 400, armedOnly ? 'nothing to broadcast — no armed transactions to broadcast' : 'nothing to broadcast — every transaction is already archived or pending');
    const endpoints = bitcoin.endpointsFor(state.settings);
    const results = [];
    for (const tx of targets) {
      results.push(await broadcastOne(state, tx, endpoints, now, 'broadcast'));
    }
    const action = results.some((r) => r.action === 'broadcast') ? 'broadcast'
      : results.some((r) => r.action === 'failed') ? 'failed'
      : results.some((r) => r.action === 'stale') ? 'stale' : 'skipped';
    return sendJson(res, 200, { ok: true, action, results });
  }

  // GET /api/bitcoin/confirmations — the confirmation count for every
  // broadcast transaction, refreshed from the network unless checked
  // less than a minute ago (the UI polls this; the hourly tick
  // refreshes it too). A failed lookup keeps the last known value.
  if (req.method === 'GET' && pathname === '/api/bitcoin/confirmations') {
    const refreshed = await refreshConfirmations(state, 60);
    return sendJson(res, 200, { confirmations: refreshed });
  }

  // GET /api/backup — the whole setup as one JSON document: settings,
  // every signed transaction (hex included), the check-in clock, and
  // the recent check-in + broadcast history. Restoring it (POST
  // /api/restore) puts the app back exactly where the backup was taken.
  // The file contains the signed hexes, which reveal the destination
  // addresses and amounts — treat it like the transactions themselves.
  // It also carries the check-in key hashes (not the keys — those were
  // never stored), so a restored setup keeps its keys working.
  if (req.method === 'GET' && pathname === '/api/backup') {
    return sendJson(res, 200, {
      format: 'standby-backup',
      version: 1,
      app: 'standby',
      exportedAt: now.toISOString(),
      state: JSON.parse(JSON.stringify(state)),
      checkins: store.readCheckins(DATA_DIR, 200),
      broadcastLog: store.readBroadcastLog(DATA_DIR, 200),
    });
  }

  // POST /api/restore — restore a backup document (the parsed JSON from
  // a downloaded backup). Validates before touching anything: the
  // format and version, the settings, and every transaction's hex
  // (each hex is re-parsed and all derived fields are recomputed from
  // it, so a corrupt or hand-edited backup cannot store a bad tx).
  // Replaces the state wholesale; the logs are replaced too when the
  // backup carries them. Returns the restored transaction count.
  if (req.method === 'POST' && pathname === '/api/restore') {
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || body.format !== 'standby-backup') {
      return sendError(res, 400, 'not a Standby backup file (format must be standby-backup)');
    }
    if (body.version !== 1) return sendError(res, 400, 'unsupported backup version: ' + body.version);
    const bs = body.state;
    if (!bs || typeof bs !== 'object' || !bs.settings || typeof bs.settings !== 'object'
        || !bs.bitcoin || typeof bs.bitcoin !== 'object' || !Array.isArray(bs.bitcoin.txs)) {
      return sendError(res, 400, 'backup is missing the state (settings + transactions)');
    }
    const bsSettings = bs.settings;
    const settings = {
      thresholdDays: clampInt(bsSettings.thresholdDays, 35, 1, 3650),
      primaryApiUrl: bitcoin.DEFAULT_PUBLIC_API_URL,
      secondaryApiUrl: '',
      paused: !!bsSettings.paused,
      vacationMode: !!bsSettings.vacationMode,
      vacationUntil: asStr(bsSettings.vacationUntil || '', 10),
    };
    if (typeof bsSettings.primaryApiUrl === 'string' && bsSettings.primaryApiUrl.trim()) {
      try { settings.primaryApiUrl = bitcoin.normalizePublicApiUrl(bsSettings.primaryApiUrl); }
      catch (e) { return sendError(res, 400, 'backup primary node URL: ' + e.message); }
    }
    if (typeof bsSettings.secondaryApiUrl === 'string' && bsSettings.secondaryApiUrl.trim()) {
      try { settings.secondaryApiUrl = bitcoin.normalizePublicApiUrl(bsSettings.secondaryApiUrl); }
      catch (e) { return sendError(res, 400, 'backup secondary node URL: ' + e.message); }
    }
    const txs = [];
    const seenIds = new Set();
    for (const t of bs.bitcoin.txs) {
      if (!t || typeof t.hex !== 'string' || !t.hex.trim()) {
        return sendError(res, 400, 'backup transaction is missing its hex');
      }
      let parsed;
      try { parsed = bitcoin.parseTx(t.hex.trim()); }
      catch (e) { return sendError(res, 400, 'backup transaction hex is invalid: ' + e.message); }
      // (0.7.12, third-audit finding 4; tightened in 0.7.13,
      // fourth-audit finding 1) A release record is only believed
      // when its status is one the app itself writes, its txid is a
      // string equal to the txid of the hex in this same backup
      // entry, and its kind (when present) is one the app writes.
      // The txid is REQUIRED: the 0.7.12 check only rejected a txid
      // when one was present and wrong, so {"release":{"status":
      // "stale"}} passed and permanently disabled a transaction
      // that was never broadcast. A broadcasted record is only
      // believed when its txid is that txid. Anything else rejects
      // the WHOLE restore — a corrupt or hand-edited backup must not
      // silently mark a transaction stale, or resurrect a broadcast
      // that never happened. A record the app wrote always passes:
      // every writer carries txid = the tx's txid (broadcastOneInner
      // paths, dry-run verdict writes) and kind in RELEASE_KINDS,
      // and the 0.4.0 migration guarantees txid on older records.
      if (t.release !== undefined && t.release !== null) {
        if (typeof t.release !== 'object' || !RELEASE_STATUSES.has(t.release.status)
            || typeof t.release.txid !== 'string' || t.release.txid !== parsed.txid
            || (t.release.kind !== undefined && !RELEASE_KINDS.has(t.release.kind))) {
          return sendError(res, 400, 'backup transaction release record is invalid');
        }
      }
      if (t.broadcasted !== undefined && t.broadcasted !== null) {
        if (typeof t.broadcasted !== 'object' || t.broadcasted.txid !== parsed.txid) {
          return sendError(res, 400, 'backup transaction broadcast record does not match its hex');
        }
      }
      let id = (typeof t.id === 'string' && t.id) ? asStr(t.id, 40) : '';
      if (!id || seenIds.has(id)) id = store.newTxId();
      seenIds.add(id);
      txs.push({
        id,
        txid: parsed.txid,
        hex: t.hex.trim(),
        label: asStr(t.label || '', 80),
        notes: asStr(t.notes || '', 500),
        createdAt: (typeof t.createdAt === 'string' && t.createdAt) ? t.createdAt : now.toISOString(),
        inputs: parsed.inputs.length,
        outputs: parsed.outputs.length,
        totalOutSats: parsed.totalOutSats,
        // The fee (0.7.18): carried through when present (a number
        // or null); a backup from before 0.7.18 carries no fee,
        // which restores as null — the same as an older record
        // loaded from disk. A negative or non-finite value is not
        // believed either.
        feeSats: (typeof t.feeSats === 'number' && Number.isFinite(t.feeSats) && t.feeSats >= 0) ? t.feeSats : null,
        feeRateSatVb: (typeof t.feeRateSatVb === 'number' && Number.isFinite(t.feeRateSatVb) && t.feeRateSatVb >= 0) ? t.feeRateSatVb : null,
        locktime: parsed.locktime,
        segwit: parsed.segwit,
        enabled: typeof t.enabled === 'boolean' ? t.enabled : true,
        // The broadcast route (0.7.16): a backup from before 0.7.16
        // carries no route, which restores as 'public' — the same
        // as an older record loaded from disk.
        broadcastVia: validBroadcastVia(t.broadcastVia),
        // The public fallback (0.7.17): a backup from before 0.7.17
        // carries no duration, which restores as Never (null) — the
        // same as an older record loaded from disk. The first-attempt
        // timestamp rides along too (an unparseable one is dropped);
        // without it a restored failing-submit tx would have no
        // fallback deadline until its next attempt.
        publicFallbackDays: validPublicFallbackDays(t.publicFallbackDays),
        slipstreamFirstAttemptAt: (typeof t.slipstreamFirstAttemptAt === 'string'
          && !Number.isNaN(new Date(t.slipstreamFirstAttemptAt).getTime())) ? t.slipstreamFirstAttemptAt : null,
        release: t.release ? t.release : null,
        broadcasted: t.broadcasted ? t.broadcasted : null,
      });
    }
    const bsCheckin = (bs.checkin && typeof bs.checkin === 'object') ? bs.checkin : {};
    // (0.7.12, third-audit finding 4) The check-in time must be a
    // real date and not in the future (beyond the same 5-minute skew
    // the receiver merge allows). An invalid date makes checkinStatus
    // throw on every status read (new Date(NaN).toISOString()), and a
    // far-future date would silently postpone the release forever.
    // Anything else rejects the WHOLE restore before anything is
    // applied. A real backup always carries a valid ISO timestamp
    // (or null, for a setup that has never checked in), so this
    // cannot reject a backup the app itself wrote.
    let lastCheckinAt = null;
    if (bsCheckin.lastCheckinAt !== undefined && bsCheckin.lastCheckinAt !== null) {
      if (typeof bsCheckin.lastCheckinAt !== 'string') {
        return sendError(res, 400, 'backup check-in time is invalid');
      }
      const at = new Date(bsCheckin.lastCheckinAt);
      if (Number.isNaN(at.getTime())) {
        return sendError(res, 400, 'backup check-in time is not a valid date');
      }
      if (at.getTime() > now.getTime() + 5 * 60 * 1000) {
        return sendError(res, 400, 'backup check-in time is in the future');
      }
      lastCheckinAt = bsCheckin.lastCheckinAt;
    }
    // Check-in API keys ride along in the backup (hashes only — the
    // plaintext keys were never stored, so a backup cannot leak them).
    // A malformed key entry rejects the restore, like a bad tx hex. A
    // backup from before 0.6.6 carries no keys at all, which restores
    // as an empty list.
    const restoredKeys = [];
    if (Array.isArray(bs.checkinKeys)) {
      for (const k of bs.checkinKeys) {
        if (!k || typeof k !== 'object' || typeof k.id !== 'string' || !k.id
            || typeof k.label !== 'string' || typeof k.hash !== 'string'
            || !/^[0-9a-f]{64}$/.test(k.hash)) {
          return sendError(res, 400, 'backup check-in key entry is invalid');
        }
        restoredKeys.push({
          id: asStr(k.id, 40), label: asStr(k.label, 80), hash: k.hash,
          createdAt: (typeof k.createdAt === 'string' && k.createdAt) ? k.createdAt : now.toISOString(),
          lastUsedAt: (typeof k.lastUsedAt === 'string' || k.lastUsedAt === null) ? (k.lastUsedAt || null) : null,
        });
      }
    }
    const restored = {
      version: 5,
      createdAt: (typeof bs.createdAt === 'string' && bs.createdAt) ? bs.createdAt : now.toISOString(),
      updatedAt: now.toISOString(),
      settings,
      bitcoin: {
        txs,
        connection: (bs.bitcoin.connection && typeof bs.bitcoin.connection === 'object')
          ? bs.bitcoin.connection : { ok: null, checkedAt: null, detail: '' },
      },
      checkin: {
        lastCheckinAt,
        totalCheckins: clampInt(bsCheckin.totalCheckins, 0, 0, 1000000),
      },
      checkinKeys: restoredKeys,
    };
    store.saveState(DATA_DIR, restored);
    // The receiver's key list matches the restored state from now on.
    writeReceiverKeys(restored);
    if (Array.isArray(body.checkins)) store.writeCheckins(DATA_DIR, body.checkins.slice(-200));
    if (Array.isArray(body.broadcastLog)) store.writeBroadcastLog(DATA_DIR, body.broadcastLog.slice(-200));
    return sendJson(res, 200, { ok: true, restoredTxs: txs.length, state: sanitizeState(restored) });
  }

  // POST /api/bitcoin/connection/test — verifies both nodes without
  // moving funds. Saves the result (including the per-endpoint results)
  // so the Dashboard can show each node's own status. The app is OK if
  // either one answers (the other is the backup).
  if (req.method === 'POST' && pathname === '/api/bitcoin/connection/test') {
    const r = await bitcoin.testConnection(bitcoin.endpointsFor(state.settings));
    state.bitcoin.connection = { ok: r.ok, checkedAt: now.toISOString(), detail: r.detail, results: r.results };
    store.saveState(DATA_DIR, state);
    return sendJson(res, 200, { ok: r.ok, detail: r.detail, results: r.results });
  }

  // POST /api/broadcast/test — DRY-RUN validation. Checks the stored
  // txs' inputs are still unspent via the primary node (falling back to
  // the secondary) and reports whether a broadcast would be attempted.
  // Never broadcasts anything.
  // Body { id } dry-runs one transaction; no id dry-runs all stored
  // ones. Every transaction is checked, armed or not — a dry-run is a
  // read-only test, and a signed transaction should be testable the
  // moment it is stored. The aggregate "would broadcast" count stays
  // armed-only (that is the release-relevant number). A failed check on
  // one tx does not stop the others.
  // A dry-run all only tests the transactions that could still
  // broadcast. One that has already been broadcast, or whose inputs
  // were already declared spent, is left out of the results and the
  // aggregate — the run gives it no new status. (A single dry-run of
  // one transaction still tests it: the owner asked for that one.)
  // A spent verdict is recorded on the transaction (a stale release
  // record, kind 'dryrun'): staleness is a fact about the inputs, so
  // the card stays Stale — and stays in the Archived Transactions
  // card — across refreshes and check-ins. Before 0.6.5 the verdict
  // lived only in the page's memory, so a dry-run-declared stale
  // transaction popped back to Ready on every refresh.
  if (req.method === 'POST' && pathname === '/api/broadcast/test') {
    const body = await readBody(req).catch(() => ({}));
    let txs = state.bitcoin.txs || [];
    if (body && body.id) {
      const one = txs.find((t) => t.id === body.id);
      if (!one) return sendError(res, 404, 'no such transaction');
      txs = [one];
    }
    if (!txs.length) return sendError(res, 400, 'no transactions stored — paste a signed transaction hex first');
    const results = [];
    for (const tx of txs) {
      if (!body.id && (tx.broadcasted || (tx.release && tx.release.status === 'stale'))) {
        continue;
      }
      try {
        const r = await bitcoin.dryRun(DATA_DIR, { tx, endpoints: bitcoin.endpointsFor(state.settings) });
        results.push({ id: tx.id, label: tx.label || '', enabled: !!tx.enabled, ...r });
      } catch (e) {
        results.push({ id: tx.id, txid: tx.txid, label: tx.label || '', enabled: !!tx.enabled, broadcastVia: validBroadcastVia(tx.broadcastVia), wouldBroadcast: false, error: e.message });
      }
    }
    // Persist what the run found (0.7.12, third-audit finding 1 —
    // three cases, not just stale): a broadcasted transaction is never
    // re-marked (its broadcast record takes precedence), and a stale
    // verdict is a fact and is left alone once recorded. An own-txid
    // spend is recorded as broadcast — recognition, not a re-send;
    // the dry-run never broadcasts, and neither does the record. A
    // conflict warning is re-derived on every fresh check: a clean
    // verdict clears it (the unconfirmed spend was evicted), a
    // confirmed spend turns it stale. The dry-run log entry (written
    // by bitcoin.dryRun) already records the run itself, so no second
    // log entry is written here.
    let verdictRecorded = false;
    let feeBackfilled = false;
    for (const r of results) {
      const tx = txs.find((t) => t.id === r.id);
      if (!tx || tx.broadcasted) continue;
      // The fee (0.7.18): a dry-run OVERWRITES the stored fee with
      // the freshly computed one — the input values were fetched
      // from the node for the freshness check anyway. A fee stored
      // wrong (e.g. by the units bug, which read the parent value
      // as BTC) self-corrects on the next dry-run instead of
      // lingering; a null result (the node could not answer) leaves
      // the stored fee alone.
      if (r.fee && typeof r.fee.feeSats === 'number') {
        if (tx.feeSats !== r.fee.feeSats || tx.feeRateSatVb !== r.fee.feeRateSatVb) feeBackfilled = true;
        tx.feeSats = r.fee.feeSats;
        tx.feeRateSatVb = (typeof r.fee.feeRateSatVb === 'number') ? r.fee.feeRateSatVb : null;
      }
      if (r.spent && r.spent.length) {
        if (tx.release && tx.release.status === 'stale') continue;
        const spentDesc = r.spent.map((i) => String(i.prevTxid || '').slice(0, 12) + ':' + i.prevVout).join(', ');
        tx.release = { status: 'stale', kind: 'dryrun', txid: tx.txid, method: r.checkedVia, lastAttemptAt: now.toISOString(), error: 'inputs spent: ' + spentDesc };
        verdictRecorded = true;
        continue;
      }
      if (r.own && r.own.length) {
        // Repair, don't overwrite: a release that already went out
        // keeps its kind ('release'); a broadcasted fact keeps the
        // confirmations it already has. A restore could have left
        // one half of the pair behind — the check that just proved
        // the tx is out there fills in the missing half.
        const own = r.own[0];
        if (!tx.broadcasted) {
          tx.broadcasted = {
            txid: tx.txid, broadcastedAt: now.toISOString(), method: r.checkedVia,
            confirmations: null, blockHeight: own.blockHeight != null ? own.blockHeight : null, found: true, checkedAt: now.toISOString(),
          };
          verdictRecorded = true;
        }
        if (!tx.release || tx.release.status !== 'broadcast') {
          tx.release = { status: 'broadcast', kind: 'dryrun', txid: tx.txid, method: r.checkedVia, broadcastedAt: now.toISOString() };
          verdictRecorded = true;
        }
        continue;
      }
      if (r.conflict && r.conflict.length) {
        if (tx.release && tx.release.status === 'stale') continue;
        const conflictDesc = r.conflict.map((i) => String(i.prevTxid || '').slice(0, 12) + ':' + i.prevVout).join(', ');
        tx.release = { status: 'conflict', kind: 'dryrun', txid: tx.txid, method: r.checkedVia, lastAttemptAt: now.toISOString(), error: 'inputs spent by an unconfirmed transaction: ' + conflictDesc };
        verdictRecorded = true;
        continue;
      }
      // A clean verdict re-derives the warning away: the unconfirmed
      // spend was evicted, so the transaction is ready again. Only a
      // 'ready' verdict clears — an 'unknown' verdict cannot prove
      // the input unspent, so the warning stands on ambiguous data.
      if (r.verdict === 'ready' && tx.release && tx.release.status === 'conflict') {
        tx.release = null;
        verdictRecorded = true;
      }
    }
    if (verdictRecorded || feeBackfilled) store.saveState(DATA_DIR, state);
    const armed = results.filter((r) => r.enabled);
    // 'would broadcast' counts the transactions that would actually
    // land: a timelocked transaction is attempted (its per-result
    // wouldBroadcast is true — the release will try it) but the node
    // will reject it as non-final until the locktime passes, so it is
    // not counted here. It is named separately, so the summary never
    // implies it will successfully broadcast right now. A
    // Slipstream-route transaction is named separately too (0.7.16):
    // it would be submitted to MARA, not broadcast to the public
    // mempool — so if every would-be transaction is Slipstream, the
    // summary says "would submit to Slipstream"; if only some are,
    // it says how many are via Slipstream.
    const would = armed.filter((r) => r.wouldBroadcast && r.verdict !== 'timelocked').length;
    const slipstream = armed.filter((r) => r.wouldBroadcast && r.verdict !== 'timelocked' && r.broadcastVia === 'slipstream').length;
    const stale = armed.filter((r) => r.spent && r.spent.length).length;
    const timelocked = armed.filter((r) => r.verdict === 'timelocked').length;
    // Dry-run all also checks that no input is spent by two stored
    // transactions: only one of them can ever be confirmed, so the shared
    // input is flagged on both cards. A single dry-run does not run
    // this check — it is a property of the whole list. Archived
    // transactions are excluded from the check (round 12): their fate
    // is decided, so a live transaction sharing an input with an
    // archived one is not warned about it.
    const overlaps = body && body.id ? [] : bitcoin.findSharedInputs(state.bitcoin.txs || []);
    const overlapNote = overlaps.length
      ? ' Warning: ' + overlaps.length + ' input(s) are shared across transactions — only one transaction per shared input can ever be confirmed: '
        + overlaps.map((o) => o.input.slice(0, 12) + ':' + o.input.split(':')[1] + ' in ' + o.txIds.length + ' transactions').join('; ') + '.'
      : '';
    const note = results.length === 1
      ? (results[0].note || results[0].error || '')
      : results.length === 0
        ? 'No transactions to check — every stored transaction has already been broadcast or is stale.'
        : would + ' of ' + armed.length + ' armed transaction(s) would '
          + (slipstream > 0 && slipstream === would ? 'submit to Slipstream' : 'broadcast')
          + (slipstream > 0 && slipstream < would ? ' (' + slipstream + ' via Slipstream)' : '')
          + (stale ? ', ' + stale + ' stale' : '') + (timelocked ? ', ' + timelocked + ' timelocked' : '') + '.';
    return sendJson(res, 200, { ok: true, dryRun: true, results, wouldBroadcast: would > 0, overlaps, note: note + overlapNote });
  }

  return sendError(res, 404, 'unknown API route');
}

// Stored fees self-correct at startup (0.7.18, fee units fix): a
// fee stored wrong — e.g. by the pre-fix code, which read the
// parent vout value as BTC and multiplied by 1e8 — is recomputed
// from the node and overwritten, so a wrong fee displays correct
// after the next restart with nobody re-adding the tx. A fee the
// node cannot recompute (unknown parent, unreachable node) is left
// alone: null means "unknown", never "zero", so a failed lookup
// must not wipe a stored fee — and a stored fee is only overwritten
// when the recompute returns a value. Runs in the background
// shortly after startup; never throws; saves only when something
// changed. The fresh state is reloaded just before saving, so a
// release tick that saved in the meantime is not clobbered.
async function recomputeStoredFees() {
  try {
    const st = store.loadState(DATA_DIR);
    const txs = st.bitcoin.txs || [];
    if (!txs.length) return;
    const endpoints = bitcoin.endpointsFor(st.settings);
    const fresh = await Promise.all(txs.map(async (tx) => {
      try {
        const fee = await bitcoin.computeFee(bitcoin.parseTx(tx.hex), endpoints);
        return { id: tx.id, fee };
      } catch { return { id: tx.id, fee: null }; }
    }));
    const computed = fresh.filter((f) => f.fee && typeof f.fee.feeSats === 'number');
    if (!computed.length) return;
    const st2 = store.loadState(DATA_DIR);
    let any = false;
    for (const f of computed) {
      const tx = (st2.bitcoin.txs || []).find((t) => t.id === f.id);
      if (!tx) continue;
      if (tx.feeSats !== f.fee.feeSats || tx.feeRateSatVb !== f.fee.feeRateSatVb) {
        tx.feeSats = f.fee.feeSats;
        tx.feeRateSatVb = (typeof f.fee.feeRateSatVb === 'number') ? f.fee.feeRateSatVb : null;
        any = true;
      }
    }
    if (any) {
      store.saveState(DATA_DIR, st2);
      console.log('startup fee recompute: corrected stored fee(s)');
    }
  } catch (e) { console.error('startup fee recompute failed:', e); }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch((e) => {
      console.error(e);
      if (!res.headersSent) sendError(res, 500, e.message || 'internal error');
    });
    return;
  }
  try { serveStatic(req, res, pathname); }
  catch (e) { console.error(e); if (!res.headersSent) sendError(res, 500, 'static file error'); }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Standby ${VERSION} listening on :${PORT} (data: ${DATA_DIR})`);
});

// Release-evaluation timer: hourly, plus once shortly after startup.
// The startup fee recompute runs on the same schedule (once, shortly
// after startup) — see recomputeStoredFees.
setTimeout(runReleaseTick, 5000);
setTimeout(recomputeStoredFees, 5000);
setInterval(runReleaseTick, 60 * 60 * 1000);
