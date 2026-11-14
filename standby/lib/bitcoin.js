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

// Absolute-locktime check (0.7.14). A transaction is timelocked by
// an absolute locktime that has not yet passed when ALL of these
// hold:
//   * locktime != 0, and
//   * at least one input has a sequence below 0xffffffff (if every
//     sequence is maxed, the locktime is ignored and the transaction
//     is final regardless — the nLockTime rule), and
//   * the locktime has not passed: below 500,000,000 it is a block
//     height (timelocked while tipHeight < locktime); at or above it
//     is a Unix timestamp (timelocked while wall-clock time <
//     locktime — the node actually compares against the median time
//     past, not the wall clock, so a timestamp locktime is an
//     approximation, and the broadcast-retry loop covers the gap).
// Returns { timelocked, until } where `until` is a number (block
// height) or a Date (unlock time) when timelocked, else null.
// Scope: absolute locktime ONLY. Relative timelocks (BIP 68, carried
// in the sequences) and script timelocks (CLTV/CSV, in the output
// scripts) are not evaluated here — they are invisible to this
// check, so such a transaction still looks 'ready' and fails at
// broadcast, where the retry fix (0.7.14) retakes it.
function timelockedUntil(tx, tipHeight, now) {
  const locktime = tx.locktime || 0;
  if (!locktime) return { timelocked: false, until: null };
  const anySeq = (tx.inputs || []).some((i) => (i.sequence >>> 0) !== 0xffffffff);
  if (!anySeq) return { timelocked: false, until: null };
  if (locktime < 500000000) {
    if (tipHeight == null) return { timelocked: false, until: null };
    return tipHeight < locktime ? { timelocked: true, until: locktime } : { timelocked: false, until: null };
  }
  const until = new Date(locktime * 1000);
  return now.getTime() < locktime * 1000 ? { timelocked: true, until } : { timelocked: false, until: null };
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
// { txid, version, segwit, inputs, outputs, totalOutSats, locktime, size, vsize }
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
    // vsize: the size the fee rate is computed against. For a
    // non-segwit transaction it is the serialized size; for a
    // segwit one it is ceil((3 * base_size + total_size) / 4),
    // where base_size is the serialization without marker, flag,
    // or witness data (the `stripped` buffer above).
    vsize: segwit ? Math.ceil((3 * stripped.length + buf.length) / 4) : buf.length,
  };
}

// ---------------------------------------------------------------------------
// PSBT (BIP 174) — import a fully-signed transaction from a .psbt file.
// ---------------------------------------------------------------------------
// A PSBT is: magic 'psbt' + 0xff, then a global map, one input map per
// input of the unsigned transaction, and one output map per output.
// Each map is a run of <keylen><key><vallen><value> pairs ending in a
// single 0x00 byte. A key is <keytype 1 byte><keydata>.
// Zero dependencies — the parser and the finalizer below are plain
// Node Buffer work. The app never sees keys: a PSBT carries only
// signatures and scripts, and the extracted raw hex is validated by
// parseTx exactly like a pasted hex before it is stored.
//
// extractTxFromPsbt(data) — data is a Buffer (raw PSBT bytes) or a
// string (a base64 PSBT, or raw PSBT bytes as a latin1 string — the
// JSON API can only carry text, so a raw binary file arrives as
// latin1). Returns { hex, txid } for a FULLY signed PSBT. Throws a
// clear error when the PSBT is malformed, its unsigned transaction
// does not parse, or it is not fully signed (naming which inputs are
// missing signatures and how many each has vs. needs). A partially
// signed PSBT is never added — finish signing it in the wallet first.
//
// Script types finalized from partial signatures (input key 0x02)
// plus the script info (redeem_script 0x04, witness_script 0x05):
// P2PKH, P2WPKH, P2SH-P2WPKH, P2SH multisig, P2WSH single-key and
// P2WSH M-of-N multisig. An input that already carries
// final_script_sig (0x07) and/or final_script_witness (0x08) uses
// those directly, whatever the script type. Anything else (taproot,
// an exotic witness script, a script type with no usable signature)
// is reported as not fully signed, not guessed at.
const PSBT_MAGIC = Buffer.from([0x70, 0x73, 0x62, 0x74, 0xff]); // 'psbt\xff'
const MAX_PSBT_BYTES = 1024 * 1024; // 1 MB — the API body is capped at 1 MB too

function hash160(buf) {
  const sha = crypto.createHash('sha256').update(buf).digest();
  return crypto.createHash('ripemd160').update(sha).digest();
}

function pushData(buf) {
  if (buf.length < 0x4c) return Buffer.concat([Buffer.from([buf.length]), buf]);
  if (buf.length <= 0xff) return Buffer.concat([Buffer.from([0x4c, buf.length]), buf]);
  const len = Buffer.alloc(2); len.writeUInt16LE(buf.length, 0);
  return Buffer.concat([Buffer.from([0x4d]), len, buf]);
}

function u32le(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }
function u64le(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v), 0); return b; }
function serVarint(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b; }
  if (n <= 0xffffffff) { const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b; }
  const b = Buffer.alloc(9); b[0] = 0xff; b.writeBigUInt64LE(BigInt(n), 1); return b;
}

// Read one <key,value> map starting at off. Returns { map, next }
// where map is [{ type, keydata, value }] and next is the offset just
// past the 0x00 terminator.
function readPsbtMap(buf, off) {
  const map = [];
  for (;;) {
    if (off >= buf.length) throw new Error('PSBT is truncated (a map has no terminator)');
    const kl = readVarint(buf, off); off += kl.size;
    if (kl.value === 0) break; // map terminator
    if (off + kl.value > buf.length) throw new Error('PSBT is truncated (a key overruns the buffer)');
    const key = buf.subarray(off, off + kl.value); off += kl.value;
    const vl = readVarint(buf, off); off += vl.size;
    if (off + vl.value > buf.length) throw new Error('PSBT is truncated (a value overruns the buffer)');
    const value = buf.subarray(off, off + vl.value); off += vl.value;
    if (key.length === 0) throw new Error('PSBT has a key with no type byte');
    map.push({ type: key[0], keydata: Buffer.from(key.subarray(1)), value: Buffer.from(value) });
  }
  return { map, next: off };
}

// A final_script_witness value is a serialized witness stack:
// <count varint> then per item <len varint><bytes>.
function parseWitnessStack(buf) {
  let off = 0;
  const n = readVarint(buf, off); off += n.size;
  if (n.value > 10000) throw new Error('PSBT witness stack is implausibly large');
  const items = [];
  for (let i = 0; i < n.value; i++) {
    const l = readVarint(buf, off); off += l.size;
    if (off + l.value > buf.length) throw new Error('PSBT witness stack is truncated');
    items.push(Buffer.from(buf.subarray(off, off + l.value))); off += l.value;
  }
  if (off !== buf.length) throw new Error('PSBT witness stack has trailing bytes');
  return items;
}

// { m, pubkeys } for OP_M <pubkey>... OP_N OP_CHECKMULTISIG, or null
// when the script is not a multisig. OP_1..OP_16 are 0x51..0x60,
// OP_CHECKMULTISIG is 0xae.
function parseMultisigScript(script) {
  if (script.length < 3) return null;
  const mOp = script[0];
  if (mOp < 0x51 || mOp > 0x60) return null;
  const m = mOp - 0x50;
  let off = 1;
  const pubkeys = [];
  while (off < script.length) {
    const op = script[off];
    if (op >= 0x51 && op <= 0x60) {
      const n = op - 0x50;
      if (off + 2 !== script.length || script[off + 1] !== 0xae) return null;
      if (n < m || n > 16 || pubkeys.length !== n) return null;
      return { m, pubkeys };
    }
    if (op !== 0x21 && op !== 0x41) return null; // 33- or 65-byte pubkey push
    if (off + 1 + op > script.length) return null;
    pubkeys.push(Buffer.from(script.subarray(off + 1, off + 1 + op)));
    off += 1 + op;
  }
  return null;
}

// The scriptPubKey of the output an input spends, from witness_utxo
// (0x01) when present, else from non_witness_utxo (0x00) by parsing
// the previous transaction. Null when the PSBT carries neither —
// then partial signatures cannot be matched to an address, and the
// input can only be finalized from final scripts.
function inputScriptPubKey(inputMap, prevVout) {
  const wit = inputMap.find((e) => e.type === 0x01);
  if (wit) {
    if (wit.value.length < 8) throw new Error('witness_utxo is truncated');
    let off = 8;
    const sl = readVarint(wit.value, off); off += sl.size;
    if (off + sl.value > wit.value.length) throw new Error('witness_utxo script overruns its value');
    return Buffer.from(wit.value.subarray(off, off + sl.value));
  }
  const nonwit = inputMap.find((e) => e.type === 0x00);
  if (nonwit) {
    let prev;
    try { prev = parseTx(nonwit.value.toString('hex')); }
    catch (e) { throw new Error('non_witness_utxo does not parse: ' + e.message); }
    const out = prev.outputs[prevVout];
    if (!out) throw new Error('non_witness_utxo has no output ' + prevVout);
    return Buffer.from(out.script, 'hex');
  }
  return null;
}

// Finalize one input. Returns { scriptSig, witness } (a Buffer and an
// array of Buffers). Throws a descriptive error when it cannot be
// finalized — the caller collects these into the not-fully-signed
// report, so the message names the input index and, for missing
// signatures, how many it has vs. needs.
function finalizePsbtInput(inputMap, scriptPubKey, index) {
  const at = 'input ' + index;
  const finalSig = inputMap.find((e) => e.type === 0x07);
  const finalWit = inputMap.find((e) => e.type === 0x08);
  if (finalSig || finalWit) {
    return {
      scriptSig: finalSig ? finalSig.value : Buffer.alloc(0),
      witness: finalWit ? parseWitnessStack(finalWit.value) : [],
    };
  }
  const partials = new Map(); // pubkey hex -> signature Buffer
  for (const e of inputMap) {
    if (e.type === 0x02) partials.set(e.keydata.toString('hex'), e.value);
  }
  if (!scriptPubKey) {
    throw new Error(at + ' cannot be finalized: no final scripts, and no spent-output info (witness_utxo / non_witness_utxo) to match signatures against');
  }
  const sigFor = (pubkey) => partials.get(pubkey.toString('hex')) || null;
  const sigForHash = (hash20) => {
    for (const [pkHex, sig] of partials) {
      const pk = Buffer.from(pkHex, 'hex');
      if (hash160(pk).equals(hash20)) return { sig, pubkey: pk };
    }
    return null;
  };
  // P2PKH: 76 a9 14 <20-byte hash> 88 ac.
  if (scriptPubKey.length === 25 && scriptPubKey[0] === 0x76 && scriptPubKey[1] === 0xa9
      && scriptPubKey[2] === 0x14 && scriptPubKey[23] === 0x88 && scriptPubKey[24] === 0xac) {
    const found = sigForHash(scriptPubKey.subarray(3, 23));
    if (!found) throw new Error(at + ' is missing its signature (has 0 of 1)');
    return { scriptSig: Buffer.concat([pushData(found.sig), pushData(found.pubkey)]), witness: [] };
  }
  // P2WPKH: 00 14 <20-byte hash>.
  if (scriptPubKey.length === 22 && scriptPubKey[0] === 0x00 && scriptPubKey[1] === 0x14) {
    const found = sigForHash(scriptPubKey.subarray(2, 22));
    if (!found) throw new Error(at + ' is missing its signature (has 0 of 1)');
    return { scriptSig: Buffer.alloc(0), witness: [found.sig, found.pubkey] };
  }
  // P2SH: a9 14 <20-byte hash> 87. The redeem script decides the rest.
  if (scriptPubKey.length === 23 && scriptPubKey[0] === 0xa9 && scriptPubKey[1] === 0x14 && scriptPubKey[22] === 0x87) {
    const redeemEntry = inputMap.find((e) => e.type === 0x04);
    if (!redeemEntry) throw new Error(at + ' is a P2SH input with no redeem_script, so it cannot be finalized');
    const redeem = redeemEntry.value;
    if (!hash160(redeem).equals(scriptPubKey.subarray(2, 22))) {
      throw new Error(at + ' has a redeem_script that does not match the spent output');
    }
    // P2SH-P2WPKH: the redeem script is itself a P2WPKH script.
    if (redeem.length === 22 && redeem[0] === 0x00 && redeem[1] === 0x14) {
      const found = sigForHash(redeem.subarray(2, 22));
      if (!found) throw new Error(at + ' is missing its signature (has 0 of 1)');
      return { scriptSig: pushData(redeem), witness: [found.sig, found.pubkey] };
    }
    const ms = parseMultisigScript(redeem);
    if (ms) {
      const sigs = [];
      for (const pk of ms.pubkeys) {
        const sig = sigFor(pk);
        if (sig) sigs.push(sig);
        if (sigs.length === ms.m) break;
      }
      if (sigs.length < ms.m) throw new Error(at + ' is missing ' + (ms.m - sigs.length) + ' of ' + ms.m + ' signatures (has ' + sigs.length + ' of ' + ms.m + ')');
      const parts = [Buffer.from([0x00])];
      for (const s of sigs) parts.push(pushData(s));
      parts.push(pushData(redeem));
      return { scriptSig: Buffer.concat(parts), witness: [] };
    }
    throw new Error(at + ' has an unsupported redeem_script type, so it cannot be finalized');
  }
  // P2WSH: 00 20 <32-byte hash>. The witness script decides the rest.
  if (scriptPubKey.length === 34 && scriptPubKey[0] === 0x00 && scriptPubKey[1] === 0x20) {
    const witEntry = inputMap.find((e) => e.type === 0x05);
    if (!witEntry) throw new Error(at + ' is a P2WSH input with no witness_script, so it cannot be finalized');
    const wscript = witEntry.value;
    const hash = crypto.createHash('sha256').update(wscript).digest();
    if (!hash.equals(scriptPubKey.subarray(2, 34))) {
      throw new Error(at + ' has a witness_script that does not match the spent output');
    }
    const ms = parseMultisigScript(wscript);
    if (ms) {
      const sigs = [];
      for (const pk of ms.pubkeys) {
        const sig = sigFor(pk);
        if (sig) sigs.push(sig);
        if (sigs.length === ms.m) break;
      }
      if (sigs.length < ms.m) throw new Error(at + ' is missing ' + (ms.m - sigs.length) + ' of ' + ms.m + ' signatures (has ' + sigs.length + ' of ' + ms.m + ')');
      return { scriptSig: Buffer.alloc(0), witness: [Buffer.alloc(0), ...sigs] };
    }
    // Single-key P2WSH: <pubkey> OP_CHECKSIG — the witness is just the signature.
    if (wscript.length === 35 && wscript[0] === 0x21 && wscript[34] === 0xac) {
      const pk = wscript.subarray(1, 34);
      const sig = sigFor(pk);
      if (!sig) throw new Error(at + ' is missing its signature (has 0 of 1)');
      return { scriptSig: Buffer.alloc(0), witness: [sig] };
    }
    throw new Error(at + ' has an unsupported witness_script type, so it cannot be finalized');
  }
  throw new Error(at + ' has an unsupported script type, so it cannot be finalized');
}

// Extract the raw transaction hex from a PSBT that is fully signed.
// Throws a clear error for a malformed PSBT, an unparsable unsigned
// transaction, or a PSBT that is not fully signed.
function extractTxFromPsbt(data) {
  let buf;
  if (Buffer.isBuffer(data)) {
    buf = data;
  } else if (typeof data === 'string') {
    const s = data.trim();
    if (!s) throw new Error('empty PSBT');
    const b64 = s.replace(/\s+/g, '');
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(b64) && b64.length % 4 === 0) {
      const dec = Buffer.from(b64, 'base64');
      if (dec.length >= 5 && dec.subarray(0, 5).equals(PSBT_MAGIC)) buf = dec;
    }
    if (!buf) buf = Buffer.from(s, 'latin1'); // raw binary PSBT sent as text
  } else {
    throw new Error('PSBT must be a Buffer or a string');
  }
  if (buf.length > MAX_PSBT_BYTES) throw new Error('PSBT too large');
  if (buf.length < 5 || !buf.subarray(0, 5).equals(PSBT_MAGIC)) {
    throw new Error('not a PSBT file — import a fully-signed PSBT (.psbt) or a plain hex file');
  }
  let off = 5;
  const g = readPsbtMap(buf, off); off = g.next;
  const unsignedEntry = g.map.find((e) => e.type === 0x00);
  if (!unsignedEntry) throw new Error('PSBT has no unsigned transaction');
  let unsigned;
  try { unsigned = parseTx(unsignedEntry.value.toString('hex')); }
  catch (e) { throw new Error('PSBT unsigned transaction does not parse: ' + e.message); }
  const inputMaps = [];
  for (let i = 0; i < unsigned.inputs.length; i++) {
    const m = readPsbtMap(buf, off); off = m.next;
    inputMaps.push(m.map);
  }
  for (let i = 0; i < unsigned.outputs.length; i++) {
    const m = readPsbtMap(buf, off); off = m.next;
  }
  if (off !== buf.length) throw new Error('PSBT has trailing bytes after the output maps');
  const missing = [];
  const finals = [];
  for (let i = 0; i < unsigned.inputs.length; i++) {
    let spk = null;
    try { spk = inputScriptPubKey(inputMaps[i], unsigned.inputs[i].prevVout); }
    catch (e) { missing.push('input ' + i + ' has an unreadable spent output (' + e.message + ')'); finals.push(null); continue; }
    try { finals.push(finalizePsbtInput(inputMaps[i], spk, i)); }
    catch (e) { missing.push(e.message); finals.push(null); }
  }
  if (missing.length) {
    throw new Error('PSBT is not fully signed: ' + missing.join('; '));
  }
  // Serialize the final transaction (segwit when any input carries a
  // witness) and validate it exactly like a pasted hex.
  const segwit = finals.some((f) => f.witness.length > 0);
  const parts = [u32le(unsigned.version)];
  if (segwit) parts.push(Buffer.from([0x00, 0x01]));
  parts.push(serVarint(unsigned.inputs.length));
  for (let i = 0; i < unsigned.inputs.length; i++) {
    const inp = unsigned.inputs[i];
    parts.push(Buffer.from(inp.prevTxid, 'hex').reverse());
    parts.push(u32le(inp.prevVout));
    const sig = finals[i].scriptSig;
    parts.push(serVarint(sig.length), sig);
    parts.push(u32le(inp.sequence));
  }
  parts.push(serVarint(unsigned.outputs.length));
  for (const out of unsigned.outputs) {
    parts.push(u64le(out.value));
    const script = Buffer.from(out.script, 'hex');
    parts.push(serVarint(script.length), script);
  }
  if (segwit) {
    for (let i = 0; i < unsigned.inputs.length; i++) {
      const wit = finals[i].witness;
      parts.push(serVarint(wit.length));
      for (const item of wit) parts.push(serVarint(item.length), item);
    }
  }
  parts.push(u32le(unsigned.locktime));
  const hex = Buffer.concat(parts).toString('hex');
  const parsed = parseTx(hex);
  return { hex, txid: parsed.txid };
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

function mempoolReq(path, method, body, base, timeoutMs) {
  const u = new URL(base || DEFAULT_PUBLIC_API_URL);
  return requestText({
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80),
    path,
    method: method || 'GET',
    headers: body !== undefined ? { 'Content-Type': 'text/plain' } : {},
    body,
    timeoutMs,
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
// MARA Slipstream — a direct-to-miner broadcast route (0.7.16). A
// transaction submitted here goes straight to MARA Pool's private
// mempool, bypassing the public mempool entirely: it stays private
// until MARA mines it into a block. That is the point (a sensitive
// move nobody else can see before it confirms) and the limit (MARA
// is ~5% of hashrate, so a Slipstream-only transaction can wait, and
// admission is best-effort — it does not guarantee a block). The
// public nodes stay for every read/verify job (input freshness,
// confirmations, tip height): Slipstream has no outspend lookup and
// no general tx search, so it cannot replace them.
//   Submit: POST /api/transactions, JSON {"tx_hex": "<hex>"}.
//     Success = HTTP 200 AND a parsed body with status === "success".
//     Failure = HTTP 400 with {"status": "error", "message": reason}
//     — the reason is surfaced. Anything else (a non-JSON body, a
//     403, a Cloudflare challenge, an unexpected shape) fails closed:
//     it is a failed submission, never a success. No auth, no API key.
//     The API is beta (0.1.0-beta) — unexpected shapes fail closed.
//   Status: GET /api/transactions/status?tx_id=<txid> returns a
//     TransactionInfo (message, market_rate, functional_rate,
//     last_24h_odds, last_7d_odds, is_next_block, and a transaction
//     object with status {confirmed, block_height, block_time},
//     firstSeen, position, plus submission_type and package_txids).
//     The base URL is SLIPSTREAM_API_URL when set (tests point it at
//     the stub so they never touch the real slipstream.mara.com).
//   Fee floor: the minimum submission rate is the higher of 2x the
//     current mempool priority fee rate or 2 sat/vB (GET
//     /api/block-info returns submit_fee_rate). There is deliberately
//     NO local fee-rate pre-check here — the fee is computed for
//     display (0.7.18), not as a gate; the submission is attempted
//     and Slipstream's rejection reason is surfaced if the fee is
//     too low.
// ---------------------------------------------------------------------------
const DEFAULT_SLIPSTREAM_API_URL = 'https://slipstream.mara.com';

function slipstreamBase() {
  const v = (process.env.SLIPSTREAM_API_URL || '').trim();
  if (!v) return DEFAULT_SLIPSTREAM_API_URL;
  let u;
  try { u = new URL(v); } catch { throw new Error('invalid Slipstream URL: ' + v); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Slipstream URL must be http(s): ' + v);
  return u.protocol + '//' + u.host;
}

function slipstreamReq(path, method, body) {
  const base = slipstreamBase();
  const u = new URL(base);
  return requestText({
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80),
    path,
    method: method || 'GET',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body,
  });
}

// Submit one signed transaction to MARA Slipstream. Returns
// { txid, method: 'slipstream' } on success. Throws on any failure —
// the caller records it as a failed broadcast and retries (the
// selected route, Slipstream, is retried; there is no fallback to
// the public nodes). A transaction Slipstream already knows (a
// re-submit after a lost reply) answers success again, so a
// duplicate submit is harmless.
async function broadcastViaSlipstream(hex, txid) {
  let res;
  try {
    res = await slipstreamReq('/api/transactions', 'POST', JSON.stringify({ tx_hex: hex }));
  } catch (e) {
    throw new Error('could not reach Slipstream: ' + e.message);
  }
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { parsed = null; }
  if (res.status === 200 && parsed && parsed.status === 'success') {
    return { txid, method: 'slipstream' };
  }
  // A 400 carries the reason in body.message — surface it (a fee
  // below the floor, a sanctions rejection, an invalid tx). Anything
  // else — a non-JSON body, a 403, a Cloudflare challenge, a 200
  // with an unexpected shape — is a failed submission, never a
  // success: fail closed.
  if (parsed && typeof parsed.message === 'string' && parsed.message) {
    throw new Error('Slipstream rejected the transaction (HTTP ' + res.status + '): ' + parsed.message.slice(0, 200));
  }
  throw new Error('Slipstream rejected the transaction (HTTP ' + res.status + '): ' + res.body.slice(0, 200));
}

// Where is a Slipstream-submitted transaction? Returns a normalized
// { state, position, isNextBlock, last24hOdds, last7dOdds, confirmed,
// blockHeight, message } where state is:
//   'queued'    — Slipstream knows it and it is waiting (not confirmed).
//   'confirmed' — Slipstream reports it confirmed (mined into a block).
//   'failed'    — Slipstream does not know it any more (404, or a
//                 200 with no transaction object): it was dropped
//                 from MARA's queue. The caller treats this as a
//                 failed broadcast and retries via Slipstream.
//   'unknown'   — the status check itself failed (endpoint down,
//                 non-JSON, unexpected shape): do NOT assume the
//                 transaction is gone — leave it waiting and check
//                 again next tick.
async function getSlipstreamTxStatus(txid) {
  let res;
  try {
    res = await slipstreamReq('/api/transactions/status?tx_id=' + encodeURIComponent(txid), 'GET');
  } catch (e) {
    return { state: 'unknown', message: 'could not reach Slipstream: ' + e.message };
  }
  if (res.status === 404) {
    return { state: 'failed', message: 'Slipstream does not list this transaction' };
  }
  if (res.status !== 200) {
    return { state: 'unknown', message: 'Slipstream status check failed (HTTP ' + res.status + ')' };
  }
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object') {
    return { state: 'unknown', message: 'Slipstream status reply was not JSON' };
  }
  // A 200 carrying status 'error' is Slipstream saying it does not
  // know the transaction (the same as a 404).
  if (parsed.status === 'error') {
    return { state: 'failed', message: (typeof parsed.message === 'string' && parsed.message) || 'Slipstream does not list this transaction' };
  }
  const info = parsed.transaction;
  if (!info || typeof info !== 'object') {
    return { state: 'failed', message: (typeof parsed.message === 'string' && parsed.message) || 'Slipstream does not list this transaction' };
  }
  const st = info.status || {};
  if (st.confirmed === true) {
    return {
      state: 'confirmed',
      position: typeof info.position === 'number' ? info.position : null,
      isNextBlock: parsed.is_next_block === true,
      last24hOdds: typeof parsed.last_24h_odds === 'number' ? parsed.last_24h_odds : null,
      last7dOdds: typeof parsed.last_7d_odds === 'number' ? parsed.last_7d_odds : null,
      confirmed: true,
      blockHeight: Number.isFinite(st.block_height) ? st.block_height : null,
      message: (typeof parsed.message === 'string' && parsed.message) || '',
    };
  }
  return {
    state: 'queued',
    position: typeof info.position === 'number' ? info.position : null,
    isNextBlock: parsed.is_next_block === true,
    last24hOdds: typeof parsed.last_24h_odds === 'number' ? parsed.last_24h_odds : null,
    last7dOdds: typeof parsed.last_7d_odds === 'number' ? parsed.last_7d_odds : null,
    confirmed: false,
    blockHeight: null,
    message: (typeof parsed.message === 'string' && parsed.message) || '',
  };
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
  // Six states (audit finding 2, extended by finding 1 in 0.7.12
  // and the timelock warning in 0.7.14), and the release stays
  // fail-open:
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
  //   timelocked — the transaction carries an absolute locktime that
  //               has not passed yet, so the node would reject it as
  //               non-final. The transaction stays active with a
  //               warning; wouldBroadcast is true — the release WILL
  //               attempt the broadcast (and the node will reject
  //               it), so it is retried on the next hourly check
  //               like any other unknown-reason failure. The dry-run
  //               counts it as attempted, not as ready: it will not
  //               land until the locktime passes.
  //   broadcast — the node reports this transaction's OWN txid as the
  //               spending transaction: it is already out there. Nothing
  //               to send, so wouldBroadcast is false.
  //   blocked   — at least one input proven spent by another, confirmed
  //               transaction; stale, never broadcast.
  // wouldBroadcast now means what it says: what the release would do.
  // Precedence: a confirmed competing spend beats everything (our
  // transaction can never land); our own txid out there beats a mere
  // conflict (the transaction already exists — the other inputs are
  // moot); a timelock beats a conflict (the transaction cannot land
  // yet, whatever the inputs say); a conflict beats unknown.
  // The tip height is fetched only when the transaction actually
  // carries a height locktime with a live sequence — a timestamp
  // locktime needs only the wall clock, and a locktime of 0 (or one
  // with every sequence maxed) needs no network at all. If the tip
  // fetch fails, the dry-run fails open: the transaction is reported
  // as it would be without the timelock check, and the broadcast
  // (with its retry) is the arbiter.
  let timelock = { timelocked: false, until: null };
  if (parsed.locktime && parsed.locktime < 500000000
    && (parsed.inputs || []).some((i) => (i.sequence >>> 0) !== 0xffffffff)) {
    let tipHeight = null;
    try { tipHeight = await mempoolTipHeight(check.checkedBase); } catch { tipHeight = null; }
    timelock = timelockedUntil(parsed, tipHeight, new Date());
  } else if (parsed.locktime && parsed.locktime >= 500000000
    && (parsed.inputs || []).some((i) => (i.sequence >>> 0) !== 0xffffffff)) {
    timelock = timelockedUntil(parsed, null, new Date());
  }
  const verdict = check.spent.length ? 'blocked'
    : check.own.length ? 'broadcast'
    : timelock.timelocked ? 'timelocked'
    : check.conflict.length ? 'conflict'
    : check.unknown.length ? 'unknown' : 'ready';
  const wouldBroadcast = check.spent.length === 0 && check.own.length === 0;
  // The route this transaction would take (0.7.16): the dry-run note
  // names it, so a Slipstream transaction says "would submit to
  // Slipstream" instead of "would broadcast". The freshness gate is
  // the same for both routes — a spent input still means stale, never
  // submitted — only the wording changes.
  const viaSlipstream = tx.broadcastVia === 'slipstream';
  const attempt = viaSlipstream ? 'a submission to Slipstream (MARA)' : 'a broadcast';
  const rejecter = viaSlipstream ? 'Slipstream' : 'the node';
  const note = verdict === 'ready'
    ? 'All ' + check.checked + ' input(s) unspent — ' + attempt + ' would be attempted. ' + viaNote
    : verdict === 'blocked'
      ? check.spent.length + ' input(s) no longer unspent — this transaction is stale and will not be ' + (viaSlipstream ? 'submitted to Slipstream' : 'broadcast') + '. ' + viaNote
      : verdict === 'broadcast'
        ? 'This transaction is already out there — the node reports its own txid as the spending transaction — so it is recorded as broadcast. Nothing was sent. ' + viaNote
        : verdict === 'timelocked'
          ? 'This transaction is timelocked until ' + (typeof timelock.until === 'number' ? 'block ' + timelock.until : timelock.until.toISOString()) + ' — ' + rejecter + ' would reject it as non-final until then, so ' + attempt + ' would be attempted and rejected; it will be retried on the next hourly check. ' + viaNote
          : verdict === 'conflict'
          ? check.conflict.length + ' input(s) are spent by another transaction that is not confirmed yet — the spend may still be evicted, so this transaction stays active with a warning and ' + attempt + ' will still be attempted. ' + viaNote
          : check.unknown.length + ' input(s) could not be verified — ' + attempt + ' would be attempted, but the network is the arbiter. ' + viaNote;
  // The fee (0.7.18): the input values come from the parent txs,
  // fetched best-effort from the node. Always computed fresh — the
  // caller (the dry-run endpoint) overwrites the stored fee with
  // it, so a fee stored wrong (e.g. by the units bug, which read
  // the parent value as BTC) self-corrects on the next dry-run
  // instead of lingering. dryRun itself only returns it.
  const fee = await computeFee(parsed, endpoints);
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
    broadcastVia: tx.broadcastVia === 'slipstream' ? 'slipstream' : 'public',
    timelockedUntil: timelock.timelocked ? (timelock.until instanceof Date ? timelock.until.toISOString() : timelock.until) : null,
    txid: tx.txid,
    fee,
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
async function broadcastTx(dataDir, { hex, txid, endpoints, notePrefix }) {
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
        note: (notePrefix ? notePrefix + ' ' : '') + 'Broadcast accepted by the ' + ep.label + ' node (' + mempoolHostLabel(ep.base) + ')'
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
async function mempoolTxStatus(txid, apiBase, timeoutMs) {
  const res = await mempoolReq('/api/tx/' + txid, 'GET', undefined, apiBase, timeoutMs);
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error('mempool tx lookup failed (HTTP ' + res.status + ')');
  return JSON.parse(res.body);
}

// ---------------------------------------------------------------------------
// Transaction fee — sum(input prevout values) − total outputs (0.7.18).
// The input values are NOT in the transaction hex: they live in the
// parent transactions, fetched from the node (GET /api/tx/:txid).
// Best-effort only: any lookup failure, unknown parent, or
// inconsistent value returns null — the caller stores null and the
// add / dry-run still succeeds. The fee is stored on the record at
// add time (and refreshed by a dry-run, and recomputed at startup)
// so the card can show it.
// ---------------------------------------------------------------------------

// A mempool /api/tx vout value, as exact satoshis. The API returns
// the value in SATOSHIS (an integer — the genesis coinbase pays
// 5000000000, i.e. 50 BTC), NOT in BTC: treating it as BTC and
// multiplying by 1e8 inflated every parent value a hundred-million
// fold (a 14,913-sat parent read as 1,491,300,000,000 sats, so a
// ~224-sat fee displayed as ~1.49 trillion). Returns a BigInt, or
// null when the value is not a finite non-negative integer.
function satsValue(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) return null;
  return BigInt(value);
}

// One input's prevout value, in satoshis, from the node that knows
// its parent transaction. The endpoints are tried in order; an
// endpoint that does not know the parent (404) falls through to
// the next, and an endpoint that is down does too. A parent the
// node knows but whose vout is missing (or unparseable) is a real
// answer, not a reason to retry — it returns null.
async function parentOutputValue(prevTxid, prevVout, endpoints, timeoutMs) {
  for (const ep of endpoints) {
    let st;
    try {
      st = await mempoolTxStatus(prevTxid, ep.base, timeoutMs);
    } catch {
      continue; // endpoint down — try the next
    }
    if (st === null) continue; // unknown here — maybe the other endpoint knows it
    const vouts = st.vout || [];
    const out = vouts[prevVout];
    if (!out) return null;
    return satsValue(out.value);
  }
  return null;
}

// The fee of a parsed transaction: sum(input prevout values) −
// total outputs, and the fee rate (fee / vsize). Returns
// { feeSats, feeRateSatVb } or null when any input value cannot be
// fetched (unknown parent, unreachable node, inconsistent value).
// The parents are fetched in parallel; each lookup is capped at
// FEE_LOOKUP_TIMEOUT_MS so a hung node cannot stall an add — the
// add still succeeds, with no fee stored. Never throws.
const FEE_LOOKUP_TIMEOUT_MS = 5000;
async function computeFee(parsed, endpoints) {
  try {
    if (!parsed || !Array.isArray(parsed.inputs) || !parsed.inputs.length) return null;
    const values = await Promise.all(
      parsed.inputs.map((inp) => parentOutputValue(inp.prevTxid, inp.prevVout, endpoints, FEE_LOOKUP_TIMEOUT_MS))
    );
    if (values.some((v) => v === null)) return null;
    let inSats = 0n;
    for (const v of values) inSats += v;
    const fee = inSats - BigInt(parsed.totalOutSats);
    if (fee < 0n) return null;
    const vsize = parsed.vsize;
    if (!vsize || vsize <= 0) return null;
    return { feeSats: Number(fee), feeRateSatVb: Number(fee) / vsize };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Transaction detail — the inputs and outputs of a parsed transaction,
// for the card's nested Inputs/Outputs drop-down (0.7.18 refinement):
// every output with its value and its destination address (or its
// script type when no address can be derived), every input with its
// outpoint. Derived at read time in GET /api/state from the stored
// hex — never stored, so no migration and no restore change (the
// same pattern as findSharedInputs). An input's value is null here:
// it needs a parent lookup, and a state read must not touch the
// network — the UI shows the outpoint alone then. The shape carries
// the slot (valueSats) for a later stored value.
// ---------------------------------------------------------------------------

// Base58 (Bitcoin alphabet) and Base58Check: the legacy address
// encoding. A leading zero byte in the payload is a leading '1'.
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(buf) {
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    const r = n % 58n;
    n = n / 58n;
    s = BASE58_ALPHABET[Number(r)] + s;
  }
  return '1'.repeat(zeros) + s;
}
function base58checkEncode(version, payload) {
  const body = Buffer.concat([Buffer.from([version]), payload]);
  const chk = crypto.createHash('sha256').update(crypto.createHash('sha256').update(body).digest()).digest().subarray(0, 4);
  return base58Encode(Buffer.concat([body, chk]));
}

// Bech32 (BIP 173) and Bech32m (BIP 350): the segwit address
// encoding. Witness version 0 uses bech32 (constant 1); version 1
// (taproot) uses bech32m (constant 0x2bc830a3). Mainnet only — the
// app talks to mainnet mempool endpoints.
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GEN[i];
    }
  }
  return chk;
}
function bech32HrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}
function bech32ConvertBits(data, from, to, pad) {
  let acc = 0, bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const b of data) {
    acc = (acc << from) | b;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    return null;
  }
  return out;
}
function bech32Encode(hrp, witver, program) {
  const spec = witver === 0 ? 1 : 0x2bc830a3;
  const data = bech32ConvertBits(program, 8, 5, true);
  if (data === null) return null;
  const values = bech32HrpExpand(hrp).concat([witver]).concat(data);
  const polymod = bech32Polymod(values.concat([0, 0, 0, 0, 0, 0])) ^ spec;
  const checksum = [];
  for (let i = 0; i < 6; i++) checksum.push((polymod >> (5 * (5 - i))) & 31);
  return hrp + '1' + [witver].concat(data).concat(checksum).map((v) => BECH32_CHARSET[v]).join('');
}

// The destination of one output script, as a human address when the
// script type has one, else its type. No hashing is needed: the
// hash / witness program is already in the script. Returns
// { type, address } — address is null for OP_RETURN and for scripts
// no known type covers.
function scriptPubKeyInfo(scriptHex) {
  let script;
  try { script = Buffer.from(scriptHex || '', 'hex'); } catch { return { type: 'nonstandard', address: null }; }
  // P2PKH: OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG
  if (script.length === 25 && script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14 && script[23] === 0x88 && script[24] === 0xac) {
    return { type: 'P2PKH', address: base58checkEncode(0x00, script.subarray(3, 23)) };
  }
  // P2SH: OP_HASH160 <20> OP_EQUAL
  if (script.length === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87) {
    return { type: 'P2SH', address: base58checkEncode(0x05, script.subarray(2, 22)) };
  }
  // P2WPKH: OP_0 <20>
  if (script.length === 22 && script[0] === 0x00 && script[1] === 0x14) {
    return { type: 'P2WPKH', address: bech32Encode('bc', 0, script.subarray(2, 22)) };
  }
  // P2WSH: OP_0 <32>
  if (script.length === 34 && script[0] === 0x00 && script[1] === 0x20) {
    return { type: 'P2WSH', address: bech32Encode('bc', 0, script.subarray(2, 34)) };
  }
  // P2TR: OP_1 <32>
  if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) {
    return { type: 'P2TR', address: bech32Encode('bc', 1, script.subarray(2, 34)) };
  }
  // OP_RETURN: a data carrier, no destination.
  if (script.length >= 1 && script[0] === 0x6a) {
    return { type: 'OP_RETURN', address: null };
  }
  return { type: 'nonstandard', address: null };
}

// The inputs/outputs detail of a parsed transaction. Outputs carry
// their value (satoshis, as a string — BigInt-safe, like
// totalOutSats) plus the destination address and script type;
// inputs carry their outpoint, with valueSats null (no parent
// lookup at read time — see above). Returns null when the parsed
// transaction is not usable (defensive only).
function txIoDetail(parsed) {
  if (!parsed || !Array.isArray(parsed.inputs) || !Array.isArray(parsed.outputs)) return null;
  return {
    inputs: parsed.inputs.map((inp) => ({ prevTxid: inp.prevTxid, prevVout: inp.prevVout, valueSats: null })),
    outputs: parsed.outputs.map((out) => {
      const info = scriptPubKeyInfo(out.script);
      return { valueSats: out.value, address: info.address, type: info.type };
    }),
  };
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
// Archived (settled) transactions — broadcasted, or carrying a release
// record (broadcast, stale, failed, conflict, submitted-slipstream).
// Their fate is decided. (The server's RELEASE_STATUSES is the same
// set; keep the two in sync.)
// ---------------------------------------------------------------------------
const ARCHIVED_RELEASE_STATUSES = new Set(['stale', 'failed', 'broadcast', 'conflict', 'submitted-slipstream']);
function isArchivedTx(tx) {
  return !!(tx && (tx.broadcasted || (tx.release && ARCHIVED_RELEASE_STATUSES.has(tx.release.status))));
}

// ---------------------------------------------------------------------------
// Shared inputs — the same outpoint spent by two stored transactions.
// Only one of them can ever confirm; the other goes stale the moment the
// first lands. Parses each stored hex (no network) and groups inputs by
// prevTxid:prevVout. Returns [{ input, txIds }] for inputs used by 2+
// transactions. Unparseable hex is skipped (a stored tx is always
// well-formed, so this is defensive only). Archived transactions are
// excluded: their fate is decided, so a live transaction sharing an
// input with an archived one is not warned about it (round 12).
// ---------------------------------------------------------------------------
function findSharedInputs(txs) {
  const byInput = new Map();
  for (const tx of txs || []) {
    if (isArchivedTx(tx)) continue;
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
  parseTx, extractTxFromPsbt, checkInputsUnspent, dryRun, broadcastTx, testConnection,
  getConfirmations, findSharedInputs, isArchivedTx, timelockedUntil, computeFee, txIoDetail, scriptPubKeyInfo,
  broadcastViaSlipstream, getSlipstreamTxStatus,
  normalizePublicApiUrl, mempoolBase, endpointsFor,
  DEFAULT_PUBLIC_API_URL, DEFAULT_SECONDARY_API_URL,
  DEFAULT_SLIPSTREAM_API_URL,
};
