'use strict';

function bool(v, dflt) {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const config = {
  // TrueNAS connection. TRUENAS_URL may be a ws(s):// URL (used as-is, with
  // fallbacks appended) or a bare host/IP (candidate URLs are derived).
  truenasUrl: process.env.TRUENAS_URL || 'wss://192.168.1.36:8444/websocket',
  // Placeholder until the real key is supplied via env. Never log this.
  apiKey: process.env.TRUENAS_API_KEY || '',
  // TrueNAS boxes almost always run self-signed certs on the LAN.
  verifyTls: bool(process.env.TRUENAS_VERIFY_TLS, false),

  adminPassword: process.env.ADMIN_PASSWORD || '',
  httpPort: parseInt(process.env.HTTP_PORT || '8080', 10),
  bindAddress: process.env.BIND_ADDRESS || '0.0.0.0',

  // Read-only bring-up mode: every TrueNAS mutation is logged, not executed.
  dryRun: bool(process.env.DRY_RUN, false),

  dbPath: process.env.DB_PATH || './data/fleetdeck.sqlite',

  // Session poll cadence (ms)
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '10000', 10),
};

module.exports = config;
