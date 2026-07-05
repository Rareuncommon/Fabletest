'use strict';

// Background cache of TrueNAS state used by the dashboard:
//  - live iSCSI sessions (every tick, ~10s) -> booted/offline per target
//  - zvol space/origin + golden snapshots (every 3rd tick) -> cheap reads
// The dashboard reads this cache; it never blocks on the box.

class Poller {
  constructor({ adapter, db, intervalMs = 10000, isConnected = () => true, logger = console }) {
    this.adapter = adapter;
    this.db = db;
    this.isConnected = isConnected;
    this.intervalMs = intervalMs;
    this.log = logger;
    this.timer = null;
    this.tick = 0;
    this.cache = {
      connected: false,
      sessions: [],            // raw session objects
      activeTargets: new Set(),// lowercase target short-names with a session
      datasets: new Map(),     // zvol id -> {used, volsize, origin}
      goldenSnapshots: [],     // [{name, used, created}]
      lastPoll: null,
      lastError: null,
    };
  }

  activeTargets() { return this.cache.activeTargets; }

  start() {
    const loop = async () => {
      try {
        await this.poll();
      } catch (err) {
        this.cache.connected = false;
        this.cache.lastError = err.message;
      }
      this.timer = setTimeout(loop, this.intervalMs);
      this.timer.unref?.();
    };
    loop();
  }

  stop() { clearTimeout(this.timer); }

  async poll() {
    if (!this.isConnected()) {
      this.cache.connected = false;
      this.cache.lastError = 'TrueNAS not connected';
      return;
    }
    await this.pollSessions();
    if (this.tick % 3 === 0) await this.pollStorage();
    this.tick += 1;
    this.cache.lastPoll = new Date().toISOString();
    this.cache.lastError = null;
    this.cache.connected = true;
  }

  async pollSessions() {
    const sessions = await this.adapter.sessions();
    const active = new Set();
    for (const sess of sessions || []) {
      const name = extractTargetName(sess);
      if (name) active.add(name.toLowerCase());
    }
    this.cache.sessions = sessions || [];
    this.cache.activeTargets = active;
  }

  async pollStorage() {
    const s = this.db.allSettings();
    const prefix = s.managed_prefix.replace(/\/$/, '');

    // All zvols under the managed prefix in one query ("^" = startswith).
    const datasets = await this.adapter.queryDatasets([['id', '^', `${prefix}/`]]);
    const map = new Map();
    for (const ds of datasets || []) {
      map.set(ds.id || ds.name, {
        used: prop(ds, 'used'),
        volsize: prop(ds, 'volsize'),
        origin: propRaw(ds, 'origin') || null,
      });
    }
    this.cache.datasets = map;

    const snaps = await this.adapter.listSnapshots(s.golden_zvol);
    this.cache.goldenSnapshots = (snaps || [])
      .map((x) => ({
        name: x.snapshot_name || (x.name ? String(x.name).split('@')[1] : null),
        used: prop(x, 'used'),
        referenced: prop(x, 'referenced'),
        created: propRaw(x, 'creation') || null,
      }))
      .filter((x) => x.name);
  }
}

// Session objects vary across versions; the target is either a short name or
// a full IQN ("iqn.2005-10.org.freenas.ctl:client01") under one of several
// keys. Take the last colon-separated segment.
function extractTargetName(sess) {
  const t = sess?.target ?? sess?.target_name ?? sess?.target_alias;
  if (typeof t !== 'string' || !t) return null;
  const parts = t.split(':');
  return parts[parts.length - 1] || null;
}

// ZFS properties arrive as {used: {parsed: 123, rawvalue: "123", value: "1.2M"}}
// on some versions and as plain values on others. Return bytes (number) or null.
function prop(obj, key) {
  const p = obj?.properties?.[key] ?? obj?.[key];
  if (p === undefined || p === null) return null;
  if (typeof p === 'number') return p;
  if (typeof p === 'string') { const n = Number(p); return Number.isFinite(n) ? n : null; }
  if (typeof p === 'object') {
    for (const k of ['parsed', 'rawvalue', 'value']) {
      const v = p[k];
      if (typeof v === 'number') return v;
      if (typeof v === 'string') { const n = Number(v); if (Number.isFinite(n)) return n; }
    }
  }
  return null;
}

// Same but returns the string form (for `origin`, `creation`).
function propRaw(obj, key) {
  const p = obj?.properties?.[key] ?? obj?.[key];
  if (p === undefined || p === null) return null;
  if (typeof p === 'object') return p.value ?? p.rawvalue ?? (p.parsed != null ? String(p.parsed) : null);
  return String(p);
}

module.exports = { Poller, extractTargetName, prop, propRaw };
