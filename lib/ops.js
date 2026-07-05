'use strict';

const { GuardError, assertValidClientName, assertManagedZvol, assertValidSnapshotName } = require('./guards');
const { normalizeMac } = require('./mac');

class OpError extends Error {
  constructor(msg) { super(msg); this.name = 'OpError'; }
}

// High-level fleet operations. Every mutating op is audited into events with
// enough before/after detail to reconstruct what happened.
class Ops {
  /**
   * @param {object} deps
   * @param {import('./adapter').Adapter} deps.adapter
   * @param {object} deps.db
   * @param {() => Set<string>} deps.activeTargets  live iSCSI target names (lowercase)
   * @param {object} deps.logger
   */
  constructor({ adapter, db, activeTargets = () => new Set(), logger = console }) {
    this.adapter = adapter;
    this.db = db;
    this.activeTargets = activeTargets;
    this.log = logger;
  }

  settings() { return this.db.allSettings(); }

  // Target "groups" (portal/initiator bindings) are box-specific config. If
  // the operator hasn't pinned them in settings, copy them from an existing
  // target so new targets behave like the ones made in the TrueNAS UI.
  async resolveTargetGroups() {
    const s = this.settings();
    if (s.target_groups) {
      try {
        const g = JSON.parse(s.target_groups);
        if (Array.isArray(g)) return g;
      } catch { /* fall through to auto-detect */ }
      this.log.warn('[ops] target_groups setting is not valid JSON — auto-detecting instead');
    }
    const targets = await this.adapter.listTargets();
    const donor = (targets || []).find((t) => Array.isArray(t.groups) && t.groups.length);
    if (donor) {
      // Strip ids that belong to the donor row; keep portal/initiator/auth refs.
      return donor.groups.map(({ portal, initiator, auth, authmethod }) => {
        const g = { portal };
        if (initiator !== undefined && initiator !== null) g.initiator = initiator;
        if (authmethod) g.authmethod = authmethod;
        if (auth !== undefined && auth !== null) g.auth = auth;
        return g;
      });
    }
    throw new OpError('cannot determine iSCSI target groups: no existing target to copy from and no target_groups setting');
  }

  async latestGoldenSnapshot() {
    const s = this.settings();
    const snaps = await this.adapter.listSnapshots(s.golden_zvol);
    const golds = (snaps || [])
      .map((x) => x.snapshot_name || (x.name ? String(x.name).split('@')[1] : null))
      .filter((n) => n && n.startsWith('gold-'));
    if (!golds.length) throw new OpError(`no gold-* snapshots found on ${s.golden_zvol}`);
    golds.sort(compareGoldVersions);
    return golds[golds.length - 1];
  }

  _assertNoSession(targetName, force, action) {
    if (force) return;
    const live = this.activeTargets();
    if (live.has(String(targetName).toLowerCase())) {
      throw new OpError(`${action} refused: target '${targetName}' has an active iSCSI session (client is booted). Use force to override.`);
    }
  }

  // ---- create --------------------------------------------------------------
  // clone golden snapshot -> extent -> target -> targetextent -> DB row.
  // All-or-nothing: on any failure, roll back created TrueNAS objects in
  // reverse order.
  async createClient({ name, mac, goldenSnapshot = null, volsize = null, notes = '' }) {
    const s = this.settings();
    assertValidClientName(name);
    const nmac = normalizeMac(mac);
    if (!nmac) throw new OpError(`invalid MAC address '${mac}'`);
    if (this.db.getClientByName(name)) throw new OpError(`client name '${name}' already exists`);
    if (this.db.getClientByMac(nmac)) throw new OpError(`MAC ${nmac} already assigned`);

    const zvol = `${s.managed_prefix}${name}`;
    assertManagedZvol(zvol, s);

    const snap = goldenSnapshot || await this.latestGoldenSnapshot();
    assertValidSnapshotName(snap);
    const fullSnapshot = `${s.golden_zvol}@${snap}`;
    const groups = await this.resolveTargetGroups();

    // LIFO rollback stack — undo steps are pushed as their create steps
    // succeed and run in reverse on failure.
    const rollback = [];
    const created = { zvol: null, extent: null, target: null, targetextent: null };
    try {
      await this.adapter.cloneSnapshot(fullSnapshot, zvol);
      created.zvol = zvol;
      rollback.push(['dataset.delete', () => this.adapter.deleteDataset(zvol, { recursive: false, force: true })]);

      if (volsize) {
        await this.adapter.updateDataset(zvol, { volsize });
      }

      const extent = await this.adapter.createExtent(name, zvol);
      created.extent = extent?.id;
      rollback.push(['extent.delete', () => this.adapter.deleteExtent(extent.id)]);

      const target = await this.adapter.createTarget(name, groups);
      created.target = target?.id;
      rollback.push(['target.delete', () => this.adapter.deleteTarget(target.id)]);

      const te = await this.adapter.createTargetExtent(target.id, extent.id, 0);
      created.targetextent = te?.id;
      rollback.push(['targetextent.delete', () => this.adapter.deleteTargetExtent(te.id)]);

      const row = this.db.insertClient({
        name, mac: nmac, zvol, target_name: name, golden_snapshot: snap, notes,
      });
      this.db.logEvent('client.create', name, { mac: nmac, zvol, snapshot: fullSnapshot, volsize, created });
      return row;
    } catch (err) {
      const undone = await this._runRollback(rollback);
      this.db.logEvent('client.create.failed', name, {
        mac: nmac, zvol, snapshot: fullSnapshot, error: err.message, rolled_back: undone,
      });
      throw new OpError(`create failed (${err.message}); rolled back: ${undone.join(', ') || 'nothing to undo'}`);
    }
  }

  async _runRollback(stack) {
    const undone = [];
    for (const [label, fn] of stack.reverse()) {
      try {
        await fn();
        undone.push(label);
      } catch (err) {
        undone.push(`${label} FAILED (${err.message})`);
        this.log.error(`[ops] rollback step ${label} failed: ${err.message}`);
      }
    }
    return undone;
  }

  // ---- reset / rebase --------------------------------------------------------
  // destroy clone, re-clone from a golden snapshot. Extent/target untouched
  // (zvol path is unchanged). Rebase = reset against a different snapshot.
  async resetClient(id, { force = false, toSnapshot = null } = {}) {
    const c = this.db.getClient(id);
    if (!c) throw new OpError(`no client with id ${id}`);
    const s = this.settings();
    assertManagedZvol(c.zvol, s);
    this._assertNoSession(c.target_name, force, 'reset');

    const snap = toSnapshot || c.golden_snapshot;
    assertValidSnapshotName(snap);
    const fullSnapshot = `${s.golden_zvol}@${snap}`;
    const before = { zvol: c.zvol, golden_snapshot: c.golden_snapshot };

    await this.adapter.deleteDataset(c.zvol, { recursive: true, force: true });
    try {
      await this.adapter.cloneSnapshot(fullSnapshot, c.zvol);
    } catch (err) {
      // The dangerous state: old clone destroyed, new clone failed.
      this.db.logEvent('client.reset.failed', c.name, { before, snapshot: fullSnapshot, error: err.message });
      throw new OpError(`reset of '${c.name}' destroyed the old clone but re-clone from ${fullSnapshot} failed: ${err.message}. Fix and reset again.`);
    }

    if (toSnapshot && toSnapshot !== c.golden_snapshot) {
      this.db.updateClient(id, { golden_snapshot: toSnapshot });
    }
    const action = toSnapshot && toSnapshot !== before.golden_snapshot ? 'client.rebase' : 'client.reset';
    this.db.logEvent(action, c.name, { before, after: { snapshot: fullSnapshot }, force });
    return this.db.getClient(id);
  }

  async bulkReset(ids, { force = false, toSnapshot = null } = {}) {
    const results = [];
    for (const id of ids) {
      try {
        await this.resetClient(id, { force, toSnapshot });
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false, error: err.message });
      }
    }
    return results;
  }

  // ---- retire ----------------------------------------------------------------
  // delete targetextent -> target -> extent -> zvol -> DB row, in that order.
  // Missing TrueNAS objects are tolerated (logged, skipped) so a half-retired
  // client can be retired again.
  async retireClient(id, { confirmName, force = false } = {}) {
    const c = this.db.getClient(id);
    if (!c) throw new OpError(`no client with id ${id}`);
    if (confirmName !== c.name) throw new OpError(`confirmation name mismatch: type the client name '${c.name}' exactly`);
    const s = this.settings();
    assertManagedZvol(c.zvol, s);
    this._assertNoSession(c.target_name, force, 'retire');

    const steps = [];
    const skip = (label, err) => steps.push(`${label}: skipped (${err.message})`);

    // targetextent
    let targetId = null;
    try {
      const targets = await this.adapter.listTargets([['name', '=', c.target_name]]);
      targetId = targets?.[0]?.id ?? null;
      if (targetId !== null) {
        const tes = await this.adapter.listTargetExtents([['target', '=', targetId]]);
        for (const te of tes || []) {
          await this.adapter.deleteTargetExtent(te.id);
          steps.push(`targetextent ${te.id} deleted`);
        }
      }
    } catch (err) { skip('targetextent', err); }

    // target
    try {
      if (targetId !== null) {
        await this.adapter.deleteTarget(targetId);
        steps.push(`target ${targetId} (${c.target_name}) deleted`);
      } else steps.push('target: not found');
    } catch (err) { skip('target', err); }

    // extent
    try {
      const extents = await this.adapter.listExtents([['name', '=', c.name]]);
      if (extents?.length) {
        await this.adapter.deleteExtent(extents[0].id);
        steps.push(`extent ${extents[0].id} deleted`);
      } else steps.push('extent: not found');
    } catch (err) { skip('extent', err); }

    // zvol
    try {
      await this.adapter.deleteDataset(c.zvol, { recursive: true, force: true });
      steps.push(`zvol ${c.zvol} destroyed`);
    } catch (err) { skip('zvol', err); }

    this.db.deleteClient(id);
    this.db.logEvent('client.retire', c.name, { before: c, steps });
    return { name: c.name, steps };
  }

  // ---- golden ---------------------------------------------------------------
  // Snapshot the golden zvol as the next @gold-vN. Never deletes anything.
  async promoteGolden() {
    const s = this.settings();
    const snaps = await this.adapter.listSnapshots(s.golden_zvol);
    const versions = (snaps || [])
      .map((x) => x.snapshot_name || (x.name ? String(x.name).split('@')[1] : ''))
      .map((n) => /^gold-v(\d+)$/.exec(n || ''))
      .filter(Boolean)
      .map((m) => parseInt(m[1], 10));
    const next = `gold-v${versions.length ? Math.max(...versions) + 1 : 1}`;
    await this.adapter.createSnapshot(s.golden_zvol, next);
    this.db.logEvent('golden.promote', null, { zvol: s.golden_zvol, snapshot: next, previous: versions.length ? `gold-v${Math.max(...versions)}` : null });
    return next;
  }
}

// gold-v10 must sort after gold-v9; non-numeric golds sort lexically first.
function compareGoldVersions(a, b) {
  const ma = /^gold-v(\d+)$/.exec(a);
  const mb = /^gold-v(\d+)$/.exec(b);
  if (ma && mb) return parseInt(ma[1], 10) - parseInt(mb[1], 10);
  if (ma) return 1;
  if (mb) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

module.exports = { Ops, OpError, compareGoldVersions };
