'use strict';

// ============================================================================
// TrueNAS API adapter — THE one-file fix for version drift.
//
// TrueNAS has renamed dataset/snapshot/iSCSI methods across releases
// (zfs.snapshot.* -> pool.snapshot.* in 25.04, etc). We never trust memorized
// names: on connect we call core.get_methods and resolve each logical
// operation against the CANDIDATES lists below, preferring the first
// candidate that actually exists on the box. If a future release renames
// something again, add the new name to the front of its list here — nothing
// else in the app changes. Payload shapes are also centralized here for the
// same reason.
// ============================================================================

const CANDIDATES = {
  'snapshot.query':  ['pool.snapshot.query', 'zfs.snapshot.query'],
  'snapshot.create': ['pool.snapshot.create', 'zfs.snapshot.create'],
  'snapshot.clone':  ['pool.snapshot.clone', 'zfs.snapshot.clone'],
  'dataset.query':   ['pool.dataset.query'],
  'dataset.update':  ['pool.dataset.update'],
  'dataset.delete':  ['pool.dataset.delete'],
  'extent.query':       ['iscsi.extent.query'],
  'extent.create':      ['iscsi.extent.create'],
  'extent.delete':      ['iscsi.extent.delete'],
  'target.query':       ['iscsi.target.query'],
  'target.create':      ['iscsi.target.create'],
  'target.delete':      ['iscsi.target.delete'],
  'targetextent.query':  ['iscsi.targetextent.query'],
  'targetextent.create': ['iscsi.targetextent.create'],
  'targetextent.delete': ['iscsi.targetextent.delete'],
  'sessions':        ['iscsi.global.sessions', 'iscsi.session.query'],
  'system.info':     ['system.info'],
};

// Logical ops that mutate the box — intercepted in DRY_RUN mode.
const MUTATING = new Set([
  'snapshot.create', 'snapshot.clone',
  'dataset.update', 'dataset.delete',
  'extent.create', 'extent.delete',
  'target.create', 'target.delete',
  'targetextent.create', 'targetextent.delete',
]);

class Adapter {
  /**
   * @param {object} opts
   * @param {{call: Function}} opts.client   TrueNAS ws client
   * @param {boolean} opts.dryRun            log-not-execute mutations
   * @param {Function} opts.onDryRun         cb(logicalOp, method, params)
   * @param {object} opts.logger
   */
  constructor({ client, dryRun = false, onDryRun = null, logger = console }) {
    this.client = client;
    this.dryRun = dryRun;
    this.onDryRun = onDryRun;
    this.log = logger;
    this.resolved = {};   // logicalOp -> concrete method name
    this.missing = [];    // logicalOps with no live candidate
    this._dryId = 0;
  }

  async introspect() {
    const methods = await this.client.call('core.get_methods');
    // core.get_methods returns {name: info} on modern versions; tolerate a
    // plain array of names too.
    const available = new Set(Array.isArray(methods) ? methods : Object.keys(methods));
    this.resolved = {};
    this.missing = [];
    for (const [op, candidates] of Object.entries(CANDIDATES)) {
      const hit = candidates.find((m) => available.has(m));
      if (hit) this.resolved[op] = hit;
      else this.missing.push(op);
    }
    if (this.missing.length) {
      this.log.warn(`[adapter] no live method found for: ${this.missing.join(', ')}`);
    }
    this.log.info(`[adapter] resolved: ${JSON.stringify(this.resolved)}`);
    return this.resolved;
  }

  _call(op, params) {
    const method = this.resolved[op];
    if (!method) return Promise.reject(new Error(`no TrueNAS method resolved for '${op}' — check adapter CANDIDATES`));
    if (this.dryRun && MUTATING.has(op)) {
      if (this.onDryRun) this.onDryRun(op, method, params);
      this.log.info(`[DRY RUN] ${method} ${JSON.stringify(params)}`);
      // Fake result with an id so callers' bookkeeping still works.
      return Promise.resolve({ id: `dry-${++this._dryId}`, dry_run: true });
    }
    return this.client.call(method, params);
  }

  // ---- snapshots -----------------------------------------------------------

  listSnapshots(dataset) {
    return this._call('snapshot.query', [[['dataset', '=', dataset]]]);
  }

  createSnapshot(dataset, name) {
    return this._call('snapshot.create', [{ dataset, name }]);
  }

  // snapshot: "Main_pool/iscsi/win-golden@gold-v2", dst: "Main_pool/iscsi/client01"
  cloneSnapshot(snapshot, dstDataset) {
    return this._call('snapshot.clone', [{ snapshot, dataset_dst: dstDataset }]);
  }

  // ---- datasets / zvols ----------------------------------------------------

  queryDatasets(filters = [], extraProperties = ['used', 'origin', 'volsize', 'referenced']) {
    return this._call('dataset.query', [filters, {
      extra: { retrieve_children: false, flat: true, properties: extraProperties },
    }]);
  }

  getDataset(id) {
    return this.queryDatasets([['id', '=', id]]).then((r) => (r && r[0]) || null);
  }

  updateDataset(id, payload) {
    return this._call('dataset.update', [id, payload]);
  }

  deleteDataset(id, { recursive = false, force = false } = {}) {
    return this._call('dataset.delete', [id, { recursive, force }]);
  }

  // ---- iSCSI ---------------------------------------------------------------

  listExtents(filters = []) { return this._call('extent.query', [filters]); }

  // zvol path "Main_pool/iscsi/client01" -> extent disk "zvol/Main_pool/iscsi/client01"
  createExtent(name, zvol) {
    return this._call('extent.create', [{ name, type: 'DISK', disk: `zvol/${zvol}` }]);
  }

  deleteExtent(id, { remove = false, force = true } = {}) {
    return this._call('extent.delete', [id, remove, force]);
  }

  listTargets(filters = []) { return this._call('target.query', [filters]); }

  createTarget(name, groups) {
    return this._call('target.create', [{ name, mode: 'ISCSI', groups }]);
  }

  deleteTarget(id, { force = true } = {}) {
    return this._call('target.delete', [id, force]);
  }

  listTargetExtents(filters = []) { return this._call('targetextent.query', [filters]); }

  createTargetExtent(targetId, extentId, lunid = 0) {
    return this._call('targetextent.create', [{ target: targetId, extent: extentId, lunid }]);
  }

  deleteTargetExtent(id, { force = true } = {}) {
    return this._call('targetextent.delete', [id, force]);
  }

  // Live iSCSI sessions — shape differs slightly across versions; callers
  // should match target names defensively (see poller.js).
  sessions() { return this._call('sessions', []); }

  systemInfo() { return this._call('system.info', []); }
}

module.exports = { Adapter, CANDIDATES, MUTATING };
