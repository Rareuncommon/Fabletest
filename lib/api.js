'use strict';

const express = require('express');
const { normalizeMac } = require('./mac');
const { OpError } = require('./ops');
const { GuardError } = require('./guards');

// Settings the UI may edit. session_secret is deliberately absent.
const EDITABLE_SETTINGS = [
  'iqn_prefix', 'golden_zvol', 'golden_target', 'managed_prefix', 'portal_ip',
  'ipxe_template', 'ipxe_unknown_template', 'nightly_reset_time', 'nightly_force',
  'target_groups', 'tftp_note',
];

function buildApiRouter({ db, ops, poller, adapter, tnClient, auth, config, logger = console }) {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  router.post('/api/login', (req, res) => auth.login(req, res));
  router.post('/api/logout', (req, res) => auth.logout(req, res));

  // Everything below requires the session cookie.
  router.use('/api', (req, res, next) => auth.middleware(req, res, next));

  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      const status = (err instanceof OpError || err instanceof GuardError) ? 400 : 500;
      if (status === 500) logger.error(`[api] ${req.method} ${req.path}: ${err.stack || err.message}`);
      res.status(status).json({ error: err.message });
    }
  };

  // ---- dashboard state (single round trip for the UI) ----
  router.get('/api/state', wrap(async (_req, res) => {
    const cache = poller.cache;
    const settings = { ...db.allSettings() };
    delete settings.session_secret;

    const clients = db.listClients().map((c) => {
      const ds = cache.datasets.get(c.zvol);
      return {
        ...c,
        online: cache.activeTargets.has(c.target_name.toLowerCase()),
        space_used: ds ? ds.used : null,
        volsize: ds ? ds.volsize : null,
        zfs_origin: ds ? ds.origin : null,   // ground truth from ZFS
        zvol_missing: cache.connected && cache.datasets.size > 0 && !ds,
      };
    });

    const byVersion = {};
    for (const c of clients) byVersion[c.golden_snapshot] = (byVersion[c.golden_snapshot] || 0) + 1;

    res.json({
      connected: cache.connected,
      dry_run: config.dryRun,
      truenas_url: tnClient.url || config.truenasUrl,
      protocol: tnClient.protocol,
      resolved_methods: adapter.resolved,
      missing_ops: adapter.missing,
      last_poll: cache.lastPoll,
      last_error: cache.lastError,
      settings,
      clients,
      golden: {
        zvol: settings.golden_zvol,
        snapshots: cache.goldenSnapshots.map((snap) => ({ ...snap, clients: byVersion[snap.name] || 0 })),
      },
      discovered: db.listDiscovered(),
      session_count: cache.activeTargets.size,
    });
  }));

  router.get('/api/events', wrap(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 1000);
    res.json(db.listEvents(limit).map((e) => ({ ...e, detail: safeParse(e.detail) })));
  }));

  // ---- client lifecycle ----
  router.post('/api/clients', wrap(async (req, res) => {
    const { name, mac, golden_snapshot, volsize, notes } = req.body || {};
    const row = await ops.createClient({
      name: String(name || '').trim(),
      mac,
      goldenSnapshot: golden_snapshot || null,
      volsize: volsize ? parseSize(volsize) : null,
      notes: notes || '',
    });
    db.deleteDiscovered(row.mac); // adopting a discovered machine clears it
    res.json(row);
  }));

  router.patch('/api/clients/:id', wrap(async (req, res) => {
    const c = db.getClient(req.params.id);
    if (!c) return res.status(404).json({ error: 'no such client' });
    const fields = {};
    const b = req.body || {};
    if (b.mac !== undefined) {
      const nm = normalizeMac(b.mac);
      if (!nm) throw new OpError(`invalid MAC '${b.mac}'`);
      const clash = db.getClientByMac(nm);
      if (clash && clash.id !== c.id) throw new OpError(`MAC ${nm} already assigned to '${clash.name}'`);
      fields.mac = nm;
    }
    if (b.notes !== undefined) fields.notes = String(b.notes);
    if (b.ipxe_override !== undefined) fields.ipxe_override = b.ipxe_override === '' ? null : String(b.ipxe_override);
    if (b.boot_golden_once !== undefined) fields.boot_golden_once = b.boot_golden_once ? 1 : 0;
    if (b.nightly_reset !== undefined) fields.nightly_reset = b.nightly_reset ? 1 : 0;
    const updated = db.updateClient(c.id, fields);
    db.logEvent('client.update', c.name, { before: pick(c, Object.keys(fields)), after: pick(updated, Object.keys(fields)) });
    res.json(updated);
  }));

  router.post('/api/clients/:id/reset', wrap(async (req, res) => {
    res.json(await ops.resetClient(parseInt(req.params.id, 10), { force: !!req.body?.force }));
  }));

  router.post('/api/clients/:id/rebase', wrap(async (req, res) => {
    const snap = String(req.body?.snapshot || '').trim();
    if (!snap) throw new OpError('rebase needs a snapshot name');
    res.json(await ops.resetClient(parseInt(req.params.id, 10), { force: !!req.body?.force, toSnapshot: snap }));
  }));

  router.post('/api/clients/:id/retire', wrap(async (req, res) => {
    res.json(await ops.retireClient(parseInt(req.params.id, 10), {
      confirmName: req.body?.confirm,
      force: !!req.body?.force,
    }));
  }));

  router.post('/api/bulk/reset', wrap(async (req, res) => {
    const ids = (req.body?.ids || []).map(Number).filter(Number.isInteger);
    if (!ids.length) throw new OpError('no client ids given');
    res.json(await ops.bulkReset(ids, {
      force: !!req.body?.force,
      toSnapshot: req.body?.snapshot ? String(req.body.snapshot) : null,
    }));
  }));

  // ---- golden ----
  router.post('/api/golden/promote', wrap(async (_req, res) => {
    const snapshot = await ops.promoteGolden();
    res.json({ snapshot });
  }));

  // ---- discovered ----
  router.delete('/api/discovered/:mac', wrap(async (req, res) => {
    const mac = normalizeMac(req.params.mac);
    if (mac) db.deleteDiscovered(mac);
    res.json({ ok: true });
  }));

  // ---- settings ----
  router.get('/api/settings', wrap(async (_req, res) => {
    const s = { ...db.allSettings() };
    delete s.session_secret;
    res.json(s);
  }));

  router.put('/api/settings', wrap(async (req, res) => {
    const before = db.allSettings();
    const changed = {};
    for (const key of EDITABLE_SETTINGS) {
      if (req.body?.[key] !== undefined && String(req.body[key]) !== before[key]) {
        db.setSetting(key, String(req.body[key]));
        changed[key] = { before: before[key], after: String(req.body[key]) };
      }
    }
    if (Object.keys(changed).length) db.logEvent('settings.update', null, changed);
    const s = { ...db.allSettings() };
    delete s.session_secret;
    res.json(s);
  }));

  // ---- bring-up helper: prove the box answers ----
  router.get('/api/truenas-info', wrap(async (_req, res) => {
    const info = await adapter.systemInfo();
    res.json({ version: info?.version, hostname: info?.hostname, uptime: info?.uptime });
  }));

  return router;
}

function safeParse(s) { try { return JSON.parse(s); } catch { return s; } }
function pick(obj, keys) { const o = {}; for (const k of keys) o[k] = obj?.[k]; return o; }

// "50G", "1.5T", "500000000" -> bytes
function parseSize(v) {
  if (typeof v === 'number') return Math.round(v);
  const m = /^\s*([\d.]+)\s*([kmgtp]?)i?b?\s*$/i.exec(String(v));
  if (!m) throw new OpError(`cannot parse size '${v}' (try e.g. 256G)`);
  const mult = { '': 1, k: 2 ** 10, m: 2 ** 20, g: 2 ** 30, t: 2 ** 40, p: 2 ** 50 }[m[2].toLowerCase()];
  return Math.round(parseFloat(m[1]) * mult);
}

module.exports = { buildApiRouter, parseSize };
