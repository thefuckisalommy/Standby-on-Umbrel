'use strict';
// Standby check-in receiver — the check-in-only front door (0.6.6).
// A separate, minimal service: it holds NO transaction data (it mounts
// only the shared CHECKIN_DIR, never the app's /data) and it exposes
// exactly two routes:
//   GET  /health  — liveness, no data.
//   POST /checkin — with a check-in API key (Authorization: Bearer <key>
//   or X-Api-Key) — records "checked in at this time" by writing
//   last.json into the shared directory, which the main app merges
//   into its check-in clock on its next status read or hourly tick.
//   Each check-in also records the caller’s address, so a check-in
//   from an unexpected address is visible in the check-in log.
// The key is a bearer token: whoever holds it can check in — and only
// check in. The receiver validates the presented key against the
// SHA-256 hashes in keys.json (written by the main app whenever keys
// change, read fresh on every request, so a revocation takes effect
// immediately). The key itself is never logged. Plain HTTP on the LAN:
// the key is the only authentication, so treat it like a password and
// rotate it if it ever leaks. The main app's Settings tab is where keys
// are created and revoked.
// Run:  PORT=3101 CHECKIN_DIR=/checkin node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3101', 10);
const CHECKIN_DIR = process.env.CHECKIN_DIR || '/checkin';
const MAX_KEY_LEN = 256;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// The key list, read fresh on every request: a revocation lands the
// moment the main app rewrites keys.json. A missing or unreadable
// file means no keys are configured — nothing can check in.
function readKeys() {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(CHECKIN_DIR, 'keys.json'), 'utf8'));
    if (!doc || !Array.isArray(doc.keys)) return [];
    return doc.keys.filter((k) => k && typeof k.id === 'string' && typeof k.hash === 'string'
      && /^[0-9a-f]{64}$/.test(k.hash));
  } catch (e) { return []; }
}

function hashKey(plain) {
  return crypto.createHash('sha256').update(plain, 'utf8').digest('hex');
}

// The presented key: a Bearer token, or the X-Api-Key header for
// clients that cannot set Authorization (a phone shortcut, a simple
// webhook). Nothing else is accepted.
function presentedKey(req) {
  const auth = req.headers.authorization || '';
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const alt = req.headers['x-api-key'];
  return typeof alt === 'string' ? alt.trim() : '';
}

function cleanIp(ip) {
  if (typeof ip !== 'string' || !ip) return null;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function writeLastCheckin(keyId, label, sourceIp) {
  const now = new Date().toISOString();
  const doc = { lastCheckinAt: now, keyId, label, receivedAt: now };
  if (sourceIp) doc.sourceIp = sourceIp;
  fs.mkdirSync(CHECKIN_DIR, { recursive: true });
  const file = path.join(CHECKIN_DIR, 'last.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(doc, null, 2) + '\n', 'utf8');
  fs.renameSync(file + '.tmp', file);
  return now;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/checkin') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    const sourceIp = cleanIp(req.socket && req.socket.remoteAddress);
    const plain = presentedKey(req);
    if (!plain || plain.length > MAX_KEY_LEN) {
      console.log('check-in rejected: no key' + (sourceIp ? ' from ' + sourceIp : ''));
      return sendJson(res, 401, { error: 'invalid check-in key' });
    }
    const keys = readKeys();
    if (!keys.length) {
      console.log('check-in rejected: no keys configured' + (sourceIp ? ' from ' + sourceIp : ''));
      return sendJson(res, 401, { error: 'invalid check-in key' });
    }
    const digest = hashKey(plain);
    const match = keys.find((k) => {
      try {
        return crypto.timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(k.hash, 'hex'));
      } catch (e) { return false; }
    });
    if (!match) {
      console.log('check-in rejected: unknown key' + (sourceIp ? ' from ' + sourceIp : ''));
      return sendJson(res, 401, { error: 'invalid check-in key' });
    }
    try {
      writeLastCheckin(match.id, match.label, sourceIp);
    } catch (e) {
      console.error('check-in failed writing last.json:', e);
      return sendJson(res, 500, { error: 'could not record the check-in' });
    }
    console.log('check-in via key "' + match.label + '"' + (sourceIp ? ' from ' + sourceIp : ''));
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Standby check-in receiver listening on :${PORT} (checkin dir: ${CHECKIN_DIR})`);
});
