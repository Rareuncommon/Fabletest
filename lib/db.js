'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL UNIQUE,
  mac              TEXT NOT NULL UNIQUE,          -- normalized aa:bb:cc:dd:ee:ff
  zvol             TEXT NOT NULL UNIQUE,          -- Main_pool/iscsi/client01
  target_name      TEXT NOT NULL,
  golden_snapshot  TEXT NOT NULL,                 -- e.g. gold-v2 (name only, no @)
  notes            TEXT NOT NULL DEFAULT '',
  ipxe_override    TEXT,                          -- raw per-client script override
  boot_golden_once INTEGER NOT NULL DEFAULT 0,    -- serve golden target on next boot, auto-revert
  nightly_reset    INTEGER NOT NULL DEFAULT 0,    -- opt-in to the nightly wipe
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  last_boot_at     TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     TEXT NOT NULL DEFAULT (datetime('now')),
  action TEXT NOT NULL,
  client TEXT,             -- client name if applicable
  detail TEXT NOT NULL DEFAULT '{}'   -- JSON: before/after, params, errors
);

CREATE TABLE IF NOT EXISTS discovered (
  mac        TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  hits       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
`;

const DEFAULT_TEMPLATE = `#!ipxe
echo FleetDeck: booting {{name}} ({{mac}})
sanboot iscsi:{{portal_ip}}::::{{iqn_prefix}}:{{target_name}}
`;

const DEFAULT_UNKNOWN_TEMPLATE = `#!ipxe
echo
echo FleetDeck: unknown client MAC {{mac}}
echo This machine is not registered with the fleet.
echo Open the FleetDeck dashboard, adopt it from the
echo "Discovered clients" panel, then reboot this machine.
echo Dropping to iPXE shell.
shell
`;

function defaultSettings(truenasUrl) {
  let portalIp = '192.168.1.36';
  try { portalIp = new URL(truenasUrl).hostname; } catch { /* keep default */ }
  return {
    iqn_prefix: 'iqn.2005-10.org.freenas.ctl',
    golden_zvol: 'Main_pool/iscsi/win-golden',
    golden_target: 'win-golden',
    managed_prefix: 'Main_pool/iscsi/',
    portal_ip: portalIp,
    ipxe_template: DEFAULT_TEMPLATE,
    ipxe_unknown_template: DEFAULT_UNKNOWN_TEMPLATE,
    nightly_reset_time: '04:00',
    nightly_force: '0',
    target_groups: '',   // JSON array override; empty = copy from an existing target
    tftp_note: 'TFTP/snponly.efi is served elsewhere; FleetDeck only serves /boot/*.ipxe',
  };
}

function openDb(dbPath, truenasUrl) {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(defaultSettings(truenasUrl))) insertSetting.run(k, v);

  return wrap(db);
}

function wrap(db) {
  const api = {
    raw: db,

    // ---- settings ----
    getSetting(key) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return row ? row.value : null;
    },
    setSetting(key, value) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, String(value));
    },
    allSettings() {
      const out = {};
      for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
      return out;
    },

    // ---- clients ----
    listClients() {
      return db.prepare('SELECT * FROM clients ORDER BY name').all();
    },
    getClient(id) {
      return db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
    },
    getClientByMac(mac) {
      return db.prepare('SELECT * FROM clients WHERE mac = ?').get(mac);
    },
    getClientByName(name) {
      return db.prepare('SELECT * FROM clients WHERE name = ?').get(name);
    },
    insertClient(c) {
      const r = db.prepare(`INSERT INTO clients (name, mac, zvol, target_name, golden_snapshot, notes)
                            VALUES (@name, @mac, @zvol, @target_name, @golden_snapshot, @notes)`).run(c);
      return api.getClient(r.lastInsertRowid);
    },
    updateClient(id, fields) {
      const allowed = ['name', 'mac', 'notes', 'ipxe_override', 'boot_golden_once', 'nightly_reset', 'golden_snapshot', 'last_boot_at'];
      const keys = Object.keys(fields).filter((k) => allowed.includes(k));
      if (!keys.length) return api.getClient(id);
      const sets = keys.map((k) => `${k} = @${k}`).join(', ');
      db.prepare(`UPDATE clients SET ${sets} WHERE id = @__id`).run({ ...fields, __id: id });
      return api.getClient(id);
    },
    deleteClient(id) {
      db.prepare('DELETE FROM clients WHERE id = ?').run(id);
    },

    // ---- events ----
    logEvent(action, client, detail) {
      db.prepare('INSERT INTO events (action, client, detail) VALUES (?, ?, ?)')
        .run(action, client || null, JSON.stringify(detail || {}));
    },
    listEvents(limit = 200) {
      return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
    },

    // ---- discovered clients ----
    recordDiscovered(mac) {
      db.prepare(`INSERT INTO discovered (mac) VALUES (?)
                  ON CONFLICT(mac) DO UPDATE SET last_seen = datetime('now'), hits = hits + 1`).run(mac);
    },
    listDiscovered() {
      return db.prepare('SELECT * FROM discovered ORDER BY last_seen DESC').all();
    },
    deleteDiscovered(mac) {
      db.prepare('DELETE FROM discovered WHERE mac = ?').run(mac);
    },
  };
  return api;
}

module.exports = { openDb, DEFAULT_TEMPLATE, DEFAULT_UNKNOWN_TEMPLATE };
