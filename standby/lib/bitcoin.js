'use strict';
// ============================================================================
// BITCOIN — transaction parsing, REAL broadcast, dry-run validation.
// ============================================================================
// Zero dependencies: Node built-ins only (crypto, http, https).
//
// What this module does:
//   - parseTx(): validate a raw signed transaction (legacy or segwit) and
//     compute its txid. No network, no keys.
//   - dryRun(): check every input of the stored transaction against the
//     chain (via the primary node, falling back to the secondary) and
//     report whether a broadcast would be attempted. NEVER broadcasts.
//   - broadcastTx(): broadcast the stored hex FOR REAL via the primary
//     mempool API endpoint, falling back to the secondary endpoint if
//     the primary does not answer. Every attempt is written to the
//     broadcast log.
//   - testConnection(): verify both endpoints work (fee endpoint)
//     without moving funds. The app is OK if either one answers.
//
// BROADCAST PATH (settings.primaryApiUrl / secondaryApiUrl):
//   Two mempool API endpoints, tried in order. The primary is
//   mempool.space by default; the secondary is blockstream.info/api by
//   default (a different operator, so it is a genuine second path).
//   Either can be any mempool.space-compatible instance — another public
//   one, or the owner's own mempool on the LAN
//   (e.g. http://192.168.1.10:8999). A blank secondary means the
//   primary runs alone. A completed freshness check is definitive
//   (a spent input is a chain fact, not a reason to ask the other
//   endpoint); only a failed check falls through to the next endpoint.
//   "Already in mempool" counts as broadcast.
//
// There is no Bitcoin Core RPC path any more (removed in 0.5.4): the
// mempool API is the only broadcast path, and a self-hosted mempool
// instance is how an own-node user keeps it on their own hardware.
//
// HARD RULES:
//   - Never accept, store, or log private keys, seeds, or passwords.
//   - The raw signed hex IS stored by the server (see PUT /api/bitcoin) —
//     it contains no key material, but it reveals the destination
//     addresses and amounts to anyone who can read the app data.
//   - The full hex is never written to the log — only a short preview.
//   - A broadcast is irrevocable. Callers must gate it behind the
//     release evaluation (server.js) — never broadcast on a hunch.
// ============================================================================

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { appendBroadcastLog } = require('./store');

const MAX_TX_BYTES = 1000000; // 1 MB, same ceiling as the API body limit
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MB — a mempool reply is a 64-char txid or small JSON; anything bigger is a faulty endpoint, not data
const NET_TIMEOUT_MS = 15000;

// Node endpoints — the user chooses them (settings.primaryApiUrl /
// secondaryApiUrl). Each is a mempool API endpoint: any
// mempool.space-compatible instance — another public one, or the owner's
// own mempool on the LAN (e.g. http://192.168.1.10:8999). MEMPOOL_HOST
// / MEMPOOL_PORT / MEMPOOL_PROTOCOL env vars let a self-hoster (or a
// test) point the app at an instance instead; when set they win over
// the configured PRIMARY URL. There is no env override for the
// secondary.
const DEFAULT_PUBLIC_API_URL = 'https://mempool.space';
const DEFAULT_SECONDARY_API_URL = 'https://blockstream.info/api';

// Normalise a user-supplied endpoint to "protocol://host[:port]" (no
// path — the app appends /api/... itself). A bare host gets https://.
// Throws on anything that is not a usable http(s) URL.
function normalizePublicApiUrl(raw) {
  let s = (raw || '').trim();
  if (!s) return DEFAULT_PUBLIC_API_URL;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { throw new Error('invalid node URL: ' + raw); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('node URL must be http(s): ' + raw);
  if (!u.hostname) throw new Error('node URL needs a host: ' + raw);
  return u.protocol + '//' + u.host;
}

function mempoolBase(settings) {
  if (process.env.MEMPOOL_HOST) {
    const proto = process.env.MEMPOOL_PROTOCOL || 'https:';
    const port = parseInt(process.env.MEMPOOL_PORT || (proto === 'https:' ? '443' : '80'), 10);
    return proto + '//' + process.env.MEMPOOL_HOST + ':' + port;
  }
  return normalizePublicApiUrl(settings && settings.primaryApiUrl);
}

// The secondary endpoint, or null when the setting is blank (primary
// runs alone). A blank setting is "no secondary", not the default.
function mempoolSecondaryBase(settings) {
  const v = settings && typeof settings.secondaryApiUrl === 'string' ? settings.secondaryApiUrl.trim() : '';
  if (!v) return null;
  return normalizePublicApiUrl(v);
}

// The endpoints in the order they are tried. A secondary identical to
// the primary is dropped — trying the same server twice buys nothing.
function endpointsFor(settings) {
  const eps = [{ label: 'primary', base: mempoolBase(settings) }];
  const sec = mempoolSecondaryBase(settings);
  if (sec && sec !== eps[0].base) eps.push({ label: 'secondary', base: sec });
  return eps;
}

// "host[:port]" for messages and log notes (never the full URL twice).
function mempoolHostLabel(base) {
  try { return new URL(base).host; } catch { return base; }
}

function readVarint(buf, off) {
  if (off >= buf.length) throw new Error('truncated varint');
  const first = buf[off];
  if (first < 0xfd) return { value: first, size: 1 };
  if (first === 0xfd) {
    if (off + 3 > buf.length) throw new Error('truncated varint');
    return { value: buf.readUInt16LE(off + 1), size: 3 };
  }
  if (first === 0xfe) {
    if (off + 5 > buf.length) throw new Error('truncated varint');
    return { value: buf.readUInt32LE(off + 1), size: 5 };
  }
  if (off + 9 > buf.length) throw new Error('truncated varint');
  const lo = buf.readUInt32LE(off + 1);
  const hi = buf.readUInt32LE(off + 5);
  const value = hi * 0x100000000 + lo;
  if (!Number.isSafeInteger(value) || value > 1e9) throw new Error('varint too large');
  return { value, size: 9 };
}

// Parse a raw signed transaction (legacy or segwit) and compute its txid.
// Throws on anything that is not a well-formed transaction. Returns:
// { txid, version, segwit, inputs, outputs, totalOutSats, locktime, size }
function parseTx(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('transaction must be a hex string');
  }
  if (hex.length % 2 !== 0) throw new Error('transaction hex must have an even length');
  const buf = Buffer.from(hex, 'hex');
  if (buf.length < 10) throw new Error('transaction too short');
  if (buf.length > MAX_TX_BYTES) throw new Error('transaction too large');

  let off = 0;
  const version = buf.readUInt32LE(off); off += 4;

  // Segwit marker (0x00) + flag (0x01) sit between version and inputs.
  let segwit = false;
  let inputsStart = off;
  if (buf[off] === 0x00 && buf[off + 1] === 0x01) {
    segwit = true;
    off += 2;
    inputsStart = off;
  }

  const vin = readVarint(buf, off); off += vin.size;
  if (vin.value === 0 || vin.value > 10000) throw new Error('implausible input count');
  const inputs = [];
  for (let i = 0; i < vin.value; i++) {
    if (off + 36 > buf.length) throw new Error('truncated input');
    const prevTxid = Buffer.from(buf.subarray(off, off + 32)).reverse().toString('hex');
    off += 32;
    const prevVout = buf.readUInt32LE(off); off += 4;
    const sl = readVarint(buf, off); off += sl.size;
    if (off + sl.value + 4 > buf.length) throw new Error('truncated input script');
    off += sl.value;
    const sequence = buf.readUInt32LE(off); off += 4;
    inputs.push({ prevTxid, prevVout, sequence });
  }

  const vout = readVarint(buf, off); off += vout.size;
  if (vout.value === 0 || vout.value > 10000) throw new Error('implausible output count');
  const outputs = [];
  let totalOut = 0n;
  for (let i = 0; i < vout.value; i++) {
    if (off + 8 > buf.length) throw new Error('truncated output');
    const value = buf.readBigUInt64LE(off); off += 8;
    const sl = readVarint(buf, off); off += sl.size;
    if (off + sl.value > buf.length) throw new Error('truncated output script');
    const script = buf.subarray(off, off + sl.value).toString('hex');
    off += sl.value;
    totalOut += value;
    outputs.push({ value: value.toString(), script });
  }
  const outputsEnd = off;

  if (segwit) {
    // Witness data: one stack per input. Skipped for the txid, which
    // commits to the non-witness serialization only.
    for (let i = 0; i < vin.value; i++) {
      const n = readVarint(buf, off); off += n.size;
      if (n.value > 10000) throw new Error('implausible witness stack size');
      for (let j = 0; j < n.value; j++) {
        const l = readVarint(buf, off); off += l.size;
        if (off + l.value > buf.length) throw new Error('truncated witness data');
        off += l.value;
      }
    }
  }

  if (off + 4 !== buf.length) throw new Error('trailing bytes after locktime');
  const locktime = buf.readUInt32LE(off);

  // txid = double-SHA256 of the serialization WITHOUT marker/flag/witness,
  // byte-reversed for display.
  const stripped = Buffer.concat([
    buf.subarray(0, 4),
    buf.subarray(inputsStart, outputsEnd),
    buf.subarray(off, off + 4),
  ]);
  const hash = crypto.createHash('sha256').update(stripped).digest();
  const txid = crypto.createHash('sha256').update(hash).digest().reverse().toString('hex');

  return {
    txid,
    version,
    segwit,
    inputs,
    outputs,
    totalOutSats: totalOut.toString(),
    locktime,
    size: buf.length,
  };
}

// ---------------------------------------------------------------------------
// Minimal HTTP(S) client (zero deps). Resolves { status, body } as text.
// ---------------------------------------------------------------------------
// A hard wall-clock deadline guards every call: the socket `timeout`
// option does NOT fire during a stalled TLS handshake (verified live — a
// mempool.space request hung for 600s without it), so a setTimeout that
// destroys the request and rejects is the real guard. Without it a
// stalled broadcast path would hang the release evaluation, the hourly
// tick, and any dry-run/test request indefinitely.
function requestText({ protocol, hostname, port, path: p, method, headers, body, timeoutMs }) {
  const timeout = timeoutMs || NET_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { req.destroy(err); } catch { /* already gone */ }
      reject(err);
    };
    const timer = setTimeout(
      () => fail(new Error('request timed out after ' + timeout + 'ms')),
      timeout,
    );
    if (timer.unref) timer.unref(); // don't keep the process alive for this alone
    const lib = protocol === 'https:' ? https : http;
    const req = lib.request(
      { hostname, port, path: p, method, headers },
      (res) => {
        const chunks = [];
        let received = 0;
        res.on('data', (c) => {
          received += c.length;
          // Audit finding 4: without a cap a faulty (or hostile) custom
          // endpoint could answer with an unbounded body and grow the
          // process until Umbrel restarts it. The 15 s timeout bounds
          // time, not size — this bounds size.
          if (received > MAX_RESPONSE_BYTES) {
            return fail(new Error('response exceeded ' + MAX_RESPONSE_BYTES + ' bytes'));
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('timeout', () => fail(new Error('request timed out after ' + timeout + 'ms')));
    req.on('error', fail);
    req.setTimeout(timeout); // secondary signal; the wall-clock timer is the real guard
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function mempoolReq(path, method, body, base) {
  const u = new URL(base || DEFAULT_PUBLIC_API_URL);
  return requestText({
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80),
    path,
    method: method || 'GET',
    headers: body !== undefined ? { 'Content-Type': 'text/plain' } : {},
    body,
  });
}

// ---------------------------------------------------------------------------
// Broadcast paths — primary node first, secondary on failure.
// ---------------------------------------------------------------------------

// Already-on-the-network counts as broadcast: if the endpoint accepted
// the transaction but the reply was lost (timeout, dropped connection),
// the fallback endpoint — or the next hourly retry — will see "already
// in mempool" and must not report it as a failure. The funds already moved.
function isAlreadyOut(err) {
  return /already in mempool/i.test(err && err.message ? err.message : String(err || ''));
}

// Mempool API: POST /api/tx with the raw hex. Returns the txid as
// plain text on success. Throws on rejection — the tx stays off-chain.
async function broadcastViaApi(hex, txid, apiBase) {
  let res;
  try {
    res = await mempoolReq('/api/tx', 'POST', hex, apiBase);
  } catch (e) {
    throw new Error('could not reach ' + mempoolHostLabel(apiBase) + ': ' + e.message);
  }
  if (res.status === 200) {
    const returned = res.body.trim();
    // Audit finding 5: the mempool API answers a broadcast with the
    // txid as plain text. A 200 carrying anything else — an error
    // page, a proxy body, garbage from a faulty custom endpoint —
    // must NOT be recorded as a broadcast. Require exactly the 64-hex
    // txid we sent; anything else is a failed attempt and the caller
    // retries (or falls back to the secondary). The local txid is
    // returned: it is the value we computed and verified.
    if (!/^[0-9a-f]{64}$/i.test(returned) || returned.toLowerCase() !== txid.toLowerCase()) {
      throw new Error('mempool answered 200 but returned an unexpected txid: ' + returned.slice(0, 200));
    }
    return txid;
  }
  if (isAlreadyOut(new Error(res.body))) return txid;
  throw new Error('mempool rejected the transaction (HTTP ' + res.status + '): ' + res.body.slice(0, 200));
}

// ---------------------------------------------------------------------------
// Input freshness — is each input still unspent?
// ---------------------------------------------------------------------------

// mempool API: GET /api/tx/:txid/outspend/:vout
//   200 {spent} / {spent, txid, vin, status}  |  404 = tx unknown to mempool
async function mempoolOutspend(prevTxid, prevVout, apiBase) {
  const res = await mempoolReq('/api/tx/' + prevTxid + '/outspend/' + prevVout, 'GET', undefined, apiBase);
  if (res.status === 404) return null; // unknown — cannot prove spent or unspent
  if (res.status !== 200) throw new Error('mempool outspend check failed (HTTP ' + res.status + ')');
  return JSON.parse(res.body);
}

// One input-freshness check against a single endpoint. A spent input
// is THREE different things (0.7.12, third-audit finding 1) — the
// outspend answer carries the spending txid AND whether that spend is
// confirmed, and the two must be read together:
//   own      — the spending txid is this transaction's OWN txid: our
//              exact transaction is already out there (mempool or a
//              block). Never stale, never a warning — it is broadcast.
//   spent    — some OTHER tx spends the input AND that spend is
//              confirmed: the input is gone for good; stale.
//   conflict — some OTHER tx spends the input but the spend is NOT
//              confirmed yet (status.confirmed === false, or no status
//              at all — ambiguous data is never permanent): the spend
//              may still be evicted or replaced, so the transaction
//              stays active with a warning, and a broadcast is still
//              attempted — the network is the arbiter.
async function checkInputsUnspentVia(parsed, apiBase) {
  const unspent = [];
  const spent = [];
  const conflict = [];
  const own = [];
  const unknown = [];
  for (const inp of parsed.inputs) {
    const out = await mempoolOutspend(inp.prevTxid, inp.prevVout, apiBase);
    if (out === null) unknown.push(inp);
    else if (!out.spent) unspent.push(inp);
    else if (out.txid && out.txid.toLowerCase() === parsed.txid.toLowerCase()) {
      own.push({ ...inp, spentBy: out.txid, confirmed: !!(out.status && out.status.confirmed),
        blockHeight: (out.status && Number.isFinite(out.status.block_height)) ? out.status.block_height : null });
    } else if (out.status && out.status.confirmed === true) spent.push({ ...inp, spentBy: out.txid || null });
    else conflict.push({ ...inp, spentBy: out.txid || null });
  }
  return { checked: parsed.inputs.length, unspent, spent, conflict, own, unknown };
}

// Returns { checked, unspent: [input], spent: [input], conflict:
// [input], own: [input], unknown: [input], checkedVia:
// 'primary'|'secondary', checkedBase }. `spent` is only the
// confirmed spends by another transaction; `conflict` the unconfirmed
// ones; `own` the spends by this transaction's own txid. The
// endpoints are tried in order; the first one that completes a check
// wins. A completed check is definitive — an endpoint that says an input
// is spent is a chain fact, not a reason to ask the other endpoint as
// well. Only a failed check (endpoint down) falls through to the next one.
async function checkInputsUnspent(parsed, endpoints) {
  const errors = [];
  for (const ep of endpoints) {
    try {
      const result = await checkInputsUnspentVia(parsed, ep.base);
      return { ...result, checkedVia: ep.label, checkedBase: ep.base };
    } catch (e) {
      errors.push(ep.label + ' (' + mempoolHostLabel(ep.base) + '): ' + e.message);
    }
  }
  throw new Error('could not verify inputs (' + errors.join('; ') + ')');
}

// ---------------------------------------------------------------------------
// Dry-run validation — answers "would a broadcast be attempted?" and
// records the answer. NEVER broadcasts. The full hex never reaches the log.
// ---------------------------------------------------------------------------
async function dryRun(dataDir, { tx, endpoints }) {
  const parsed = parseTx(tx.hex);
  const check = await checkInputsUnspent(parsed, endpoints);
  const fellBack = check.checkedVia !== 'primary';
  const viaNote = 'Checked via the ' + check.checkedVia + ' node (' + mempoolHostLabel(check.checkedBase) + ')'
    + (fellBack ? ' — the primary node could not be reached.' : '.');
  // Five states (audit finding 2, extended by finding 1 in 0.7.12),
  // and the release stays fail-open:
  //   ready     — every input proven unspent; a broadcast would be attempted.
  //   unknown   — no input proven spent, but some could not be verified
  //               (the parent is unknown to the node: very recent, or a
  //               lagging custom node). The release WOULD still attempt the
  //               broadcast — the network is the arbiter — so wouldBroadcast
  //               is true here too. The old code said false while its own
  //               note said the broadcast would be attempted, and logged
  //               the run as 'blocked': all three disagreed.
  //   conflict  — at least one input is spent by another transaction
  //               that is NOT confirmed yet. The spend may still be
  //               evicted, so the transaction stays active with a
  //               warning — and the release WOULD still attempt the
  //               broadcast, so wouldBroadcast is true here too.
  //   broadcast — the node reports this transaction's OWN txid as the
  //               spending transaction: it is already out there. Nothing
  //               to send, so wouldBroadcast is false.
  //   blocked   — at least one input proven spent by another, confirmed
  //               transaction; stale, never broadcast.
  // wouldBroadcast now means what it says: what the release would do.
  // Precedence: a confirmed competing spend beats everything (our
  // transaction can never land); our own txid out there beats a mere
  // conflict (the transaction already exists — the other inputs are
  // moot); a conflict beats unknown.
  const verdict = check.spent.length ? 'blocked'
    : check.own.length ? 'broadcast'
    : check.conflict.length ? 'conflict'
    : check.unknown.length ? 'unknown' : 'ready';
  const wouldBroadcast = check.spent.length === 0 && check.own.length === 0;
  const note = verdict === 'ready'
    ? 'All ' + check.checked + ' input(s) unspent — a broadcast would be attempted. ' + viaNote
    : verdict === 'blocked'
      ? check.spent.length + ' input(s) no longer unspent — this transaction is stale and will not be broadcast. ' + viaNote
      : verdict === 'broadcast'
        ? 'This transaction is already out there — the node reports its own txid as the spending transaction — so it is recorded as broadcast. Nothing was sent. ' + viaNote
        : verdict === 'conflict'
          ? check.conflict.length + ' input(s) are spent by another transaction that is not confirmed yet — the spend may still be evicted, so this transaction stays active with a warning and a broadcast will still be attempted. ' + viaNote
          : check.unknown.length + ' input(s) could not be verified — broadcast would be attempted, but the network is the arbiter. ' + viaNote;
  appendBroadcastLog(dataDir, {
    ts: new Date().toISOString(),
    kind: 'dry-run',
    status: verdict === 'ready' ? 'would-broadcast' : verdict,
    method: check.checkedVia,
    txid: tx.txid,
    hexPreview: tx.hex.slice(0, 64),
    inputsChecked: check.checked,
    unspent: check.unspent.length,
    spent: check.spent.length,
    conflict: check.conflict.length,
    own: check.own.length,
    unknown: check.unknown.length,
    note,
  });
  return {
    ok: true,
    wouldBroadcast,
    verdict,
    txid: tx.txid,
    checked: check.checked,
    checkedVia: check.checkedVia,
    checkedBase: check.checkedBase,
    unspent: check.unspent,
    spent: check.spent,
    conflict: check.conflict,
    own: check.own,
    unknown: check.unknown,
    note,
  };
}

// ---------------------------------------------------------------------------
// Real broadcast. Tries the endpoints in order — primary first, the
// secondary on failure. Returns { txid, method, fallback } where method
// is the endpoint that actually broadcast ('primary'|'secondary').
// Throws on total failure (and logs it). A broadcast that lands is
// irrevocable; a failed attempt is retried by the caller.
async function broadcastTx(dataDir, { hex, txid, endpoints }) {
  const errors = [];
  for (const ep of endpoints) {
    try {
      const outTxid = await broadcastViaApi(hex, txid, ep.base);
      const fellBack = ep !== endpoints[0];
      appendBroadcastLog(dataDir, {
        ts: new Date().toISOString(),
        kind: 'broadcast',
        status: 'broadcast',
        method: ep.label,
        txid: outTxid,
        hexPreview: hex.slice(0, 64),
        note: 'Broadcast accepted by the ' + ep.label + ' node (' + mempoolHostLabel(ep.base) + ')'
          + (fellBack ? ' — the primary node failed (' + (errors[0] || '') + '), fell back to the secondary.' : '.'),
      });
      return { txid: outTxid, method: ep.label, fallback: fellBack };
    } catch (e) {
      errors.push(ep.label + ' (' + mempoolHostLabel(ep.base) + '): ' + e.message);
    }
  }
  const errText = 'Broadcast failed: ' + errors.join('; ');
  appendBroadcastLog(dataDir, {
    ts: new Date().toISOString(),
    kind: 'broadcast',
    status: 'failed',
    method: 'primary',
    txid: txid || '',
    hexPreview: hex.slice(0, 64),
    note: errText,
  });
  throw new Error(errText);
}

// ---------------------------------------------------------------------------
// Confirmation lookup — how many blocks deep is a broadcast transaction?
// ---------------------------------------------------------------------------

// mempool API: GET /api/tx/:txid
//   200 { status: { confirmed, block_height, block_time, ... } }
//   404 = the network does not know this transaction (never seen, or
//     dropped from the mempool).
async function mempoolTxStatus(txid, apiBase) {
  const res = await mempoolReq('/api/tx/' + txid, 'GET', undefined, apiBase);
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error('mempool tx lookup failed (HTTP ' + res.status + ')');
  return JSON.parse(res.body);
}

// Tip height from one endpoint (the same probe the connection test uses).
async function mempoolTipHeight(apiBase) {
  const res = await mempoolReq('/api/blocks/tip/height', 'GET', undefined, apiBase);
  if (res.status !== 200) throw new Error('mempool tip height failed (HTTP ' + res.status + ')');
  const h = parseInt(res.body.trim(), 10);
  if (!Number.isFinite(h)) throw new Error('mempool tip height unparseable');
  return h;
}

// Confirmations for a broadcast transaction, via the endpoints in order.
// Returns { found, confirmed, blockHeight, confirmations, checkedVia,
// checkedBase }. A transaction the network has never seen (or that
// dropped out of the mempool) reports found: false — the caller keeps
// the last known value and says so. A lookup that fails outright
// (endpoint down) falls through to the next endpoint; if none answers,
// the call throws and the caller keeps the last known value.
async function getConfirmations(txid, endpoints) {
  const errors = [];
  for (const ep of endpoints) {
    try {
      const st = await mempoolTxStatus(txid, ep.base);
      if (st === null) continue; // unknown here — maybe the other endpoint knows it
      const tip = await mempoolTipHeight(ep.base);
      const status = st.status || {};
      if (!status.confirmed) {
        return { found: true, confirmed: false, blockHeight: null, confirmations: 0, checkedVia: ep.label, checkedBase: ep.base };
      }
      const height = status.block_height;
      if (!Number.isFinite(height)) {
        return { found: true, confirmed: true, blockHeight: null, confirmations: null, checkedVia: ep.label, checkedBase: ep.base };
      }
      return { found: true, confirmed: true, blockHeight: height, confirmations: Math.max(0, tip - height + 1), checkedVia: ep.label, checkedBase: ep.base };
    } catch (e) {
      errors.push(ep.label + ' (' + mempoolHostLabel(ep.base) + '): ' + e.message);
    }
  }
  // Every endpoint either 404'd the tx or failed to answer. Distinguish
  // "answered and does not know it" from "could not reach it": a 404 on
  // every endpoint that DID answer means not found; anything else is a
  // lookup failure and the caller keeps the last known value.
  if (errors.length === 0) {
    return { found: false, confirmed: false, blockHeight: null, confirmations: null, checkedVia: null, checkedBase: null };
  }
  throw new Error('could not check confirmations (' + errors.join('; ') + ')');
}

// ---------------------------------------------------------------------------
// Shared inputs — the same outpoint spent by two stored transactions.
// Only one of them can ever confirm; the other goes stale the moment the
// first lands. Parses each stored hex (no network) and groups inputs by
// prevTxid:prevVout. Returns [{ input, txIds }] for inputs used by 2+
// transactions. Unparseable hex is skipped (a stored tx is always
// well-formed, so this is defensive only).
// ---------------------------------------------------------------------------
function findSharedInputs(txs) {
  const byInput = new Map();
  for (const tx of txs || []) {
    let parsed;
    try { parsed = parseTx(tx.hex); } catch { continue; }
    for (const inp of parsed.inputs) {
      const key = inp.prevTxid + ':' + inp.prevVout;
      if (!byInput.has(key)) byInput.set(key, []);
      if (!byInput.get(key).includes(tx.id)) byInput.get(key).push(tx.id);
    }
  }
  const out = [];
  for (const [input, txIds] of byInput) {
    if (txIds.length > 1) out.push({ input, txIds });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Connection test — verifies both endpoints without moving funds.
// The app is OK if either one answers (the other is the backup). Returns
// { ok, detail, results: [{ endpoint, base, ok, detail }] }. The probe
// is the tip height, which both mempool.space and Esplora answer.
// ---------------------------------------------------------------------------
async function testConnection(endpoints) {
  const results = [];
  for (const ep of endpoints) results.push({ endpoint: ep.label, base: ep.base, ...(await testOnePath(ep.base)) });
  const ok = results.some((r) => r.ok);
  const detail = results
    .map((r) => (r.endpoint === 'primary' ? 'Primary' : 'Secondary') + ' (' + mempoolHostLabel(r.base) + '): ' + (r.ok ? 'OK — ' + r.detail : 'FAILED — ' + r.detail))
    .join('; ');
  return { ok, detail, results };
}

async function testOnePath(apiBase) {
  try {
    // The probe is the tip height, not the fee endpoint:
    // /v1/fees/recommended is mempool.space-specific, and Esplora
    // backends (blockstream.info) answer it with 404 — so the test
    // failed even when the node was fine. /api/blocks/tip/height is
    // answered by both mempool.space and Esplora, so it is the probe
    // that works for any endpoint.
    const res = await mempoolReq('/api/blocks/tip/height', 'GET', undefined, apiBase);
    if (res.status !== 200) return { ok: false, detail: 'answered HTTP ' + res.status };
    const height = parseInt(res.body.trim(), 10);
    return { ok: true, detail: Number.isFinite(height) ? 'reachable, tip height ' + height : 'reachable' };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

module.exports = {
  parseTx, checkInputsUnspent, dryRun, broadcastTx, testConnection,
  getConfirmations, findSharedInputs,
  normalizePublicApiUrl, mempoolBase, endpointsFor,
  DEFAULT_PUBLIC_API_URL, DEFAULT_SECONDARY_API_URL,
};
