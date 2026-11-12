'use strict';
// Standby — plain-file JSON storage. No database server.
// All state lives in DATA_DIR/state.json; check-ins and broadcast attempts
// are append-only JSONL audit logs in the same directory.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const STATE_FILE = 'state.json';
const CHECKIN_LOG = 'checkins.jsonl';
const BROADCAST_LOG = 'broadcast.jsonl';

function defaultState() {
  const now = new Date().toISOString();
  return {
    version: 5,
    createdAt: now,
    updatedAt: now,
    settings: {
      thresholdDays: 35, // the one number: check in before it runs out or the armed transactions broadcast
      primaryApiUrl: 'https://mempool.space', // the primary node: a mempool API endpoint (any mempool.space-compatible instance — another public one, or your own mempool on the LAN)
      secondaryApiUrl: 'https://blockstream.info/api', // the secondary node, tried only if the primary does not answer; blank = primary runs alone
      paused: false,
      vacationMode: false,
      vacationUntil: '',
    },
    // Pre-signed Bitcoin transactions: a LIST, each with its own enable
    // and its own release record. The stored tx is raw signed hex ONLY —
    // the server never sees keys.
    // tx = { id, txid, hex, label, notes, createdAt, inputs, outputs,
    //   totalOutSats, locktime, segwit, enabled,
    //   release: null | { status: 'broadcast'|'failed'|'stale', txid,
    //     method, broadcastedAt | lastAttemptAt, error? },
    //   broadcasted: null | { txid, broadcastedAt, method,
    //     confirmations, blockHeight, found, checkedAt } }
    // release is the current cycle's record (a check-in clears it);
    // broadcasted is the permanent fact that the tx went out (a
    // check-in never clears it; replacing the hex does).
    // Connection is the last Test-connection result { ok, checkedAt,
    // detail } or { ok: null, ... } if untested.
    bitcoin: { txs: [], connection: { ok: null, checkedAt: null, detail: '' } },
    checkin: { lastCheckinAt: null, totalCheckins: 0 },
    // Check-in API keys: one per service that may check in for the
    // owner (a bot, a shortcut, an AI assistant). A key is a bearer
    // token that authorizes exactly one thing — recording a check-in,
    // via the check-in receiver. Only the SHA-256 hash is stored; the
    // plaintext key is shown once, at creation, and never again.
    // key = { id, label, hash, createdAt, lastUsedAt }
    checkinKeys: [],
  };
}

function newTxId() {
  return 'tx_' + crypto.randomBytes(4).toString('hex');
}

// Deep-merge saved state over defaults so older state files keep working
// when new fields are added.
function mergeDefaults(def, saved) {
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) return saved === undefined ? def : saved;
  if (def === null || typeof def !== 'object' || Array.isArray(def)) return saved;
  const out = {};
  for (const k of Object.keys(def)) out[k] = mergeDefaults(def[k], saved[k]);
  for (const k of Object.keys(saved)) if (!(k in out)) out[k] = saved[k];
  return out;
}

function ensureDir(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
}

function loadState(dataDir) {
  ensureDir(dataDir);
  const file = path.join(dataDir, STATE_FILE);
  if (!fs.existsSync(file)) {
    const state = defaultState();
    saveState(dataDir, state);
    return state;
  }
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const state = mergeDefaults(defaultState(), saved);
  // 0.3.0 migration: the message release is gone. Prune everything it
  // left behind — including any stored Part 2 ciphertext — so no message
  // data lingers unread in state.json. Old delivery.jsonl stays on disk
  // (audit history) but is no longer read.
  let pruned = false;
  for (const k of ['recipient', 'channels', 'reminders']) {
    if (k in state) { delete state[k]; pruned = true; }
  }
  if (state.release && typeof state.release === 'object' && !('status' in state.release)) {
    state.release = null;
    pruned = true;
  }
  // 0.4.0 migration: one transaction became a list. A stored single tx
  // (0.3.x shape: bitcoin.tx + bitcoin.enabled + top-level release)
  // becomes txs[0] with its own enable and its own release record.
  let migrated = false;
  if (state.bitcoin && state.bitcoin.tx && typeof state.bitcoin.tx === 'object') {
    const old = state.bitcoin.tx;
    const oldRelease = (state.release && typeof state.release === 'object' && state.release.txid === old.txid) ? state.release : null;
    state.bitcoin.txs = [{
      id: newTxId(),
      txid: old.txid,
      hex: old.hex,
      label: old.label || '',
      notes: '',
      createdAt: old.createdAt || state.updatedAt,
      inputs: old.inputs || 0,
      outputs: old.outputs || 0,
      totalOutSats: old.totalOutSats || '0',
      locktime: old.locktime || 0,
      segwit: !!old.segwit,
      enabled: !!state.bitcoin.enabled,
      release: oldRelease,
    }];
    delete state.bitcoin.tx;
    delete state.bitcoin.enabled;
    migrated = true;
  }
  if ('release' in state) { delete state.release; pruned = true; }
  // 0.5.2 migration: the ladder is one number now. Prune the check-in
  // interval, both warning levels, and the grace period from settings —
  // the status is on-track until the broadcast threshold, then
  // release-due. Dropping the grace period moves the release 5 days
  // earlier for a cycle already in progress.
  for (const k of ['checkinIntervalDays', 'warn1Days', 'warn2Days', 'graceDays']) {
    if (state.settings && k in state.settings) { delete state.settings[k]; pruned = true; }
  }
  // 0.5.4 migration: the RPC path is gone — no broadcast method, no RPC
  // config, and the stored RPC password along with it. The two mempool
  // endpoints replace them. A custom public endpoint from 0.5.3 carries
  // over as the primary (an own-mempool-on-the-LAN install keeps it);
  // the default mempool.space just becomes the new default.
  if (state.settings && typeof state.settings.publicApiUrl === 'string'
      && state.settings.publicApiUrl && state.settings.publicApiUrl !== 'https://mempool.space') {
    state.settings.primaryApiUrl = state.settings.publicApiUrl;
  }
  for (const k of ['broadcastMethod', 'publicApiUrl', 'rpcHost', 'rpcPort', 'rpcUser', 'rpcPassword']) {
    if (state.settings && k in state.settings) { delete state.settings[k]; pruned = true; }
  }
  if (state.version !== 5) state.version = 5;
  if (pruned || migrated) {
    if (migrated) console.log('Standby 0.4.0: migrated single transaction to the transactions list');
    if (pruned) console.log('Standby: pruned legacy state (recipient/channels/reminders/release)');
    saveState(dataDir, state);
  }
  return state;
}

function saveState(dataDir, state) {
  ensureDir(dataDir);
  state.updatedAt = new Date().toISOString();
  const file = path.join(dataDir, STATE_FILE);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return state;
}

function appendJsonl(dataDir, file, entry) {
  ensureDir(dataDir);
  fs.appendFileSync(path.join(dataDir, file), JSON.stringify(entry) + '\n', 'utf8');
}

function readJsonl(dataDir, file, limit) {
  const p = path.join(dataDir, file);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  const entries = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return limit ? entries.slice(-limit) : entries;
}

function appendCheckin(dataDir, entry) { appendJsonl(dataDir, CHECKIN_LOG, entry); }
function readCheckins(dataDir, limit) { return readJsonl(dataDir, CHECKIN_LOG, limit); }
function writeCheckins(dataDir, entries) { writeJsonl(dataDir, CHECKIN_LOG, entries); }
function appendBroadcastLog(dataDir, entry) { appendJsonl(dataDir, BROADCAST_LOG, entry); }
function readBroadcastLog(dataDir, limit) { return readJsonl(dataDir, BROADCAST_LOG, limit); }
function writeBroadcastLog(dataDir, entries) { writeJsonl(dataDir, BROADCAST_LOG, entries); }

// Overwrite a JSONL audit log with an array of entries (used by
// restore, which replaces the logs with the backup's copies). An empty
// array clears the file.
function writeJsonl(dataDir, file, entries) {
  ensureDir(dataDir);
  const lines = (entries || []).map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(path.join(dataDir, file), lines ? lines + '\n' : '', 'utf8');
}

module.exports = {
  loadState, saveState, defaultState, newTxId,
  appendCheckin, readCheckins, writeCheckins,
  appendBroadcastLog, readBroadcastLog, writeBroadcastLog,
};
