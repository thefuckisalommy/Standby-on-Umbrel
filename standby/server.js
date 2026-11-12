'use strict';
// Standby — single-container Node app. ZERO runtime dependencies.
// Serves the static UI and a JSON API backed by plain files in DATA_DIR.
// Run:  PORT=3100 DATA_DIR=./data node server.js
//
// What this app is (0.7.13): a dead man's switch that does ONE thing —
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
const VERSION = '0.7.13';
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
// carries kind 'release'). A check-in clears the cycle-scoped release
// records — a stale record survives, it is a fact about the inputs —
// so checking in after a broadcast resets the status to 'on-track'.
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
  if ((state.bitcoin.txs || []).some((t) => t.release && t.release.status === 'broadcast' && t.release.kind === 'release')) {
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
//   2. Broadcast via the primary node, falling back to the secondary
//      if the primary does not answer. Success is recorded once per tx
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
    const record = { status: 'failed', kind: logKind, txid: tx.txid, method: 'primary', lastAttemptAt: now.toISOString(), error: 'input check failed: ' + e.message };
    const fresh = store.loadState(DATA_DIR);
    const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
    if (ftx && ftx.hex === tx.hex) {
      recordRelease(fresh, ftx, record, {
        ts: now.toISOString(), kind: logKind, status: 'failed', method: 'primary', txid: tx.txid,
        hexPreview: tx.hex.slice(0, 64), note: failNote + e.message,
      });
    }
    return { id: tx.id, txid: tx.txid, label: tx.label || '', action: 'failed', error: record.error };
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
  // network must stop the broadcast.
  const pre = preBroadcastCheck(tx, logKind, now, opts);
  if (!pre.ok) {
    return { id: tx.id, txid: tx.txid, label: tx.label || '', action: 'skipped', reason: pre.reason };
  }
  try {
    const out = await bitcoin.broadcastTx(DATA_DIR, { hex: pre.tx.hex, txid: pre.tx.txid, endpoints });
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
      ftx.release = record;
      ftx.broadcasted = {
        txid: out.txid, broadcastedAt: now.toISOString(), method: out.method,
        confirmations: null, blockHeight: null, found: true, checkedAt: null,
      };
      store.saveState(DATA_DIR, fresh);
    }
    return { id: tx.id, txid: out.txid, label: tx.label || '', action: 'broadcast', method: out.method };
  } catch (e) {
    const record = { status: 'failed', kind: logKind, txid: tx.txid, method: 'primary', lastAttemptAt: now.toISOString(), error: e.message };
    const fresh = store.loadState(DATA_DIR);
    const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
    if (ftx && ftx.hex === tx.hex) recordRelease(fresh, ftx, record, null); // broadcastTx already logged the failure
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
const RELEASE_STATUSES = new Set(['stale', 'failed', 'broadcast', 'conflict']);
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
    state = store.loadState(DATA_DIR);
    const txs = state.bitcoin.txs || [];
    return sendJson(res, 200, {
      ...r,
      status: checkinStatus(state, now),
      releases: txs.filter((t) => t.release).map((t) => ({ id: t.id, txid: t.txid, label: t.label || '', ...t.release })),
    });
  }

  // POST /api/checkin — clears every tx's cycle-scoped release record:
  // a new cycle starts. A stale record is NOT cleared: spent inputs are
  // a fact about the transaction, not the cycle, so a stale transaction
  // stays stale (and archived) across check-ins — only replacing the
  // hex re-arms it. (If a broadcast already went out, the funds have
  // already moved.)
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
  // POST   /api/bitcoin/txs      — add { txHex, label, notes }
  // PUT    /api/bitcoin/txs/:id  — update { txHex?, label?, notes?, enabled? }
  // DELETE /api/bitcoin/txs/:id  — remove
  const txsMatch = pathname.match(/^\/api\/bitcoin\/txs\/([^/]+)$/);
  if (req.method === 'POST' && pathname === '/api/bitcoin/txs') {
    const body = await readBody(req);
    if (typeof body.txHex !== 'string' || !body.txHex.trim()) return sendError(res, 400, 'empty transaction hex');
    let parsed;
    try { parsed = bitcoin.parseTx(body.txHex.trim()); }
    catch (e) { return sendError(res, 400, 'invalid transaction: ' + e.message); }
    const tx = {
      id: store.newTxId(),
      txid: parsed.txid,
      hex: body.txHex.trim(),
      label: typeof body.label === 'string' ? asStr(body.label, 80) : '',
      notes: typeof body.notes === 'string' ? asStr(body.notes, 500) : '',
      createdAt: now.toISOString(),
      inputs: parsed.inputs.length,
      outputs: parsed.outputs.length,
      totalOutSats: parsed.totalOutSats,
      locktime: parsed.locktime,
      segwit: parsed.segwit,
      enabled: true, // new transactions are armed by default
      release: null,
      // broadcasted is set by broadcastOne() (release or manual) and
      // survives check-ins: { txid, broadcastedAt, method,
      // confirmations, blockHeight, found, checkedAt }.
      broadcasted: null,
    };
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
      tx.hex = hex;
      tx.txid = parsed.txid;
      tx.inputs = parsed.inputs.length;
      tx.outputs = parsed.outputs.length;
      tx.totalOutSats = parsed.totalOutSats;
      tx.locktime = parsed.locktime;
      tx.segwit = parsed.segwit;
      // A replaced hex is a different transaction: the broadcasted fact
      // and any release record belong to the old hex, so both are
      // cleared. The broadcast log keeps the history.
      tx.release = null;
      tx.broadcasted = null;
    }
    if (typeof body.label === 'string') tx.label = asStr(body.label, 80);
    if (typeof body.notes === 'string') tx.notes = asStr(body.notes, 500);
    if (typeof body.enabled === 'boolean') tx.enabled = body.enabled;
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
  if (req.method === 'POST' && pathname === '/api/broadcast/all') {
    const body = await readBody(req).catch(() => ({}));
    const txs = state.bitcoin.txs || [];
    if (!txs.length) return sendError(res, 400, 'no transactions stored — paste a signed transaction hex first');
    let targets;
    if (Array.isArray(body.ids)) {
      targets = [];
      for (const id of body.ids) {
        const tx = txs.find((t) => t.id === id);
        if (!tx) return sendError(res, 400, 'unknown transaction id: ' + id);
        if (!tx.broadcasted) targets.push(tx);
      }
    } else {
      targets = txs.filter((t) => !t.broadcasted && !(t.release && t.release.status === 'stale'));
    }
    if (!targets.length) return sendError(res, 400, 'nothing to broadcast — every transaction is already archived');
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
        locktime: parsed.locktime,
        segwit: parsed.segwit,
        enabled: typeof t.enabled === 'boolean' ? t.enabled : true,
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
        results.push({ id: tx.id, txid: tx.txid, label: tx.label || '', enabled: !!tx.enabled, wouldBroadcast: false, error: e.message });
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
    for (const r of results) {
      const tx = txs.find((t) => t.id === r.id);
      if (!tx || tx.broadcasted) continue;
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
    if (verdictRecorded) store.saveState(DATA_DIR, state);
    const armed = results.filter((r) => r.enabled);
    const would = armed.filter((r) => r.wouldBroadcast).length;
    const stale = armed.filter((r) => r.spent && r.spent.length).length;
    // Dry-run all also checks that no input is spent by two stored
    // transactions: only one of them can ever broadcast, so the shared
    // input is flagged on both cards. A single dry-run does not run
    // this check — it is a property of the whole list. The check still
    // looks at every stored transaction (a broadcasted one is exactly
    // why another one can never broadcast); the client only warns the
    // cards that are not already settled.
    const overlaps = body && body.id ? [] : bitcoin.findSharedInputs(state.bitcoin.txs || []);
    const overlapNote = overlaps.length
      ? ' Warning: ' + overlaps.length + ' input(s) are shared across transactions — only one transaction per shared input can ever broadcast: '
        + overlaps.map((o) => o.input.slice(0, 12) + ':' + o.input.split(':')[1] + ' in ' + o.txIds.length + ' transactions').join('; ') + '.'
      : '';
    const note = results.length === 1
      ? (results[0].note || results[0].error || '')
      : results.length === 0
        ? 'No transactions to check — every stored transaction has already been broadcast or is stale.'
        : would + ' of ' + armed.length + ' armed transaction(s) would broadcast' + (stale ? ', ' + stale + ' stale' : '') + '.';
    return sendJson(res, 200, { ok: true, dryRun: true, results, wouldBroadcast: would > 0, overlaps, note: note + overlapNote });
  }

  return sendError(res, 404, 'unknown API route');
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
setTimeout(runReleaseTick, 5000);
setInterval(runReleaseTick, 60 * 60 * 1000);
