'use strict';

const crypto = require('crypto');

// Single admin password (env) -> signed session cookie. The signing secret is
// generated once and persisted in settings so sessions survive restarts.

const COOKIE = 'fd_session';
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

function getSecret(db) {
  let secret = db.getSetting('session_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    db.setSetting('session_secret', secret);
  }
  return secret;
}

function sign(secret, ts) {
  return crypto.createHmac('sha256', secret).update(String(ts)).digest('hex');
}

function makeToken(db) {
  const ts = Date.now();
  return `${ts}.${sign(getSecret(db), ts)}`;
}

function verifyToken(db, token) {
  if (typeof token !== 'string') return false;
  const [tsStr, mac] = token.split('.');
  const ts = Number(tsStr);
  if (!Number.isFinite(ts) || !mac) return false;
  if (Date.now() - ts > MAX_AGE_MS) return false;
  const expect = sign(getSecret(db), ts);
  return mac.length === expect.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect));
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // still burn comparable time
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

// Dumb-but-effective brute force damper: 5 failures per IP per minute.
const attempts = new Map();
function throttled(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) || { count: 0, since: now };
  if (now - rec.since > 60000) { rec.count = 0; rec.since = now; }
  return rec.count >= 5;
}
function recordFailure(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) || { count: 0, since: now };
  if (now - rec.since > 60000) { rec.count = 0; rec.since = now; }
  rec.count += 1;
  attempts.set(ip, rec);
}

function buildAuth({ db, adminPassword, logger = console }) {
  if (!adminPassword) {
    logger.warn('[auth] ADMIN_PASSWORD is not set — UI/API login is disabled until it is');
  }

  return {
    COOKIE,
    login(req, res) {
      const ip = req.socket.remoteAddress || 'unknown';
      if (throttled(ip)) return res.status(429).json({ error: 'too many attempts, wait a minute' });
      const { password } = req.body || {};
      if (!adminPassword || !password || !constantTimeEqual(password, adminPassword)) {
        recordFailure(ip);
        return res.status(401).json({ error: 'wrong password' });
      }
      const token = makeToken(db);
      res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_MS / 1000}`);
      return res.json({ ok: true });
    },
    logout(_req, res) {
      res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      res.json({ ok: true });
    },
    middleware(req, res, next) {
      const token = parseCookies(req)[COOKIE];
      if (verifyToken(db, token)) return next();
      return res.status(401).json({ error: 'unauthenticated' });
    },
    isAuthed(req) {
      return verifyToken(db, parseCookies(req)[COOKIE]);
    },
  };
}

module.exports = { buildAuth, parseCookies, makeToken, verifyToken };
