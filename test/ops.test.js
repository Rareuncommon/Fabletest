'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../lib/db');
const { Ops, compareGoldVersions } = require('../lib/ops');

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

// Fake adapter that records every call in order and can be told to fail at a
// specific step — used to prove rollback ordering.
function fakeAdapter(overrides = {}) {
  const calls = [];
  const rec = (name, ret) => async (...args) => {
    calls.push([name, ...args]);
    if (overrides[name] instanceof Error) throw overrides[name];
    if (typeof overrides[name] === 'function') return overrides[name](...args);
    return ret;
  };
  return {
    calls,
    listSnapshots: rec('listSnapshots', [
      { snapshot_name: 'gold-v1' }, { snapshot_name: 'gold-v2' }, { snapshot_name: 'gold-v10' },
    ]),
    createSnapshot: rec('createSnapshot', { id: 'snap' }),
    cloneSnapshot: rec('cloneSnapshot', { id: 'clone' }),
    queryDatasets: rec('queryDatasets', []),
    updateDataset: rec('updateDataset', {}),
    deleteDataset: rec('deleteDataset', true),
    listExtents: rec('listExtents', [{ id: 71, name: 'clienttest' }]),
    createExtent: rec('createExtent', { id: 71 }),
    deleteExtent: rec('deleteExtent', true),
    listTargets: rec('listTargets', [{ id: 41, name: 'clienttest', groups: [{ portal: 1, initiator: 3, authmethod: 'NONE', auth: null }] }]),
    createTarget: rec('createTarget', { id: 41 }),
    deleteTarget: rec('deleteTarget', true),
    listTargetExtents: rec('listTargetExtents', [{ id: 91, target: 41, extent: 71 }]),
    createTargetExtent: rec('createTargetExtent', { id: 91 }),
    deleteTargetExtent: rec('deleteTargetExtent', true),
    sessions: rec('sessions', []),
  };
}

function makeOps(adapter, activeTargets = new Set()) {
  const db = openDb(':memory:', 'wss://192.168.1.36:8444/websocket');
  const ops = new Ops({ adapter, db, activeTargets: () => activeTargets, logger: quiet });
  return { ops, db };
}

test('gold version comparison is numeric, not lexical', () => {
  assert.ok(compareGoldVersions('gold-v10', 'gold-v9') > 0);
  assert.ok(compareGoldVersions('gold-v2', 'gold-v10') < 0);
});

test('latestGoldenSnapshot picks the highest vN', async () => {
  const { ops } = makeOps(fakeAdapter());
  assert.equal(await ops.latestGoldenSnapshot(), 'gold-v10');
});

test('createClient success runs steps in order and records the row', async () => {
  const a = fakeAdapter();
  const { ops, db } = makeOps(a);
  const row = await ops.createClient({ name: 'clienttest', mac: 'A1-B2-C3-D4-E5-F6' });
  assert.equal(row.zvol, 'Main_pool/iscsi/clienttest');
  assert.equal(row.mac, 'a1:b2:c3:d4:e5:f6');
  assert.equal(row.golden_snapshot, 'gold-v10');
  const names = a.calls.map((c) => c[0]);
  const creation = names.filter((n) => ['cloneSnapshot', 'createExtent', 'createTarget', 'createTargetExtent'].includes(n));
  assert.deepEqual(creation, ['cloneSnapshot', 'createExtent', 'createTarget', 'createTargetExtent']);
  assert.equal(db.listClients().length, 1);
});

test('createClient failure at targetextent rolls back in exact reverse order', async () => {
  const a = fakeAdapter({ createTargetExtent: new Error('boom') });
  const { ops, db } = makeOps(a);
  await assert.rejects(() => ops.createClient({ name: 'clienttest', mac: 'a1:b2:c3:d4:e5:f6' }), /rolled back/);
  const after = a.calls.map((c) => c[0]);
  const i = after.indexOf('createTargetExtent');
  // Everything after the failing step must be the undo, newest-first (LIFO).
  assert.deepEqual(after.slice(i + 1), ['deleteTarget', 'deleteExtent', 'deleteDataset']);
  assert.equal(db.listClients().length, 0, 'no DB row on failure');
  // the zvol rollback must delete the clone we made
  const del = a.calls.find((c) => c[0] === 'deleteDataset');
  assert.equal(del[1], 'Main_pool/iscsi/clienttest');
});

test('createClient failure at extent rolls back only the clone', async () => {
  const a = fakeAdapter({ createExtent: new Error('nope') });
  const { ops } = makeOps(a);
  await assert.rejects(() => ops.createClient({ name: 'clienttest', mac: 'a1:b2:c3:d4:e5:f6' }));
  const after = a.calls.map((c) => c[0]);
  assert.deepEqual(after.slice(after.indexOf('createExtent') + 1), ['deleteDataset']);
});

test('createClient rejects duplicate names/MACs and bad input before touching TrueNAS', async () => {
  const a = fakeAdapter();
  const { ops } = makeOps(a);
  await ops.createClient({ name: 'client01', mac: 'aa:bb:cc:dd:ee:01' });
  const callsAfterFirst = a.calls.length;
  await assert.rejects(() => ops.createClient({ name: 'client01', mac: 'aa:bb:cc:dd:ee:02' }), /already exists/);
  await assert.rejects(() => ops.createClient({ name: 'client02', mac: 'aa:bb:cc:dd:ee:01' }), /already assigned/);
  await assert.rejects(() => ops.createClient({ name: 'Client 02!', mac: 'aa:bb:cc:dd:ee:03' }), /invalid client name/);
  await assert.rejects(() => ops.createClient({ name: 'client02', mac: 'not-a-mac' }), /invalid MAC/);
  assert.equal(a.calls.length, callsAfterFirst, 'no TrueNAS calls for rejected creates');
});

test('reset refuses on active session unless forced', async () => {
  const a = fakeAdapter();
  const { ops, db } = makeOps(a, new Set(['client01']));
  const c = await ops.createClient({ name: 'client01', mac: 'aa:bb:cc:dd:ee:01' });
  await assert.rejects(() => ops.resetClient(c.id), /active iSCSI session/);
  assert.ok(!a.calls.some((x) => x[0] === 'deleteDataset'), 'nothing destroyed on refusal');
  await ops.resetClient(c.id, { force: true });
  const del = a.calls.find((x) => x[0] === 'deleteDataset');
  assert.equal(del[1], 'Main_pool/iscsi/client01');
  const clone = a.calls.filter((x) => x[0] === 'cloneSnapshot').pop();
  assert.equal(clone[1], 'Main_pool/iscsi/win-golden@gold-v10');
  assert.equal(clone[2], 'Main_pool/iscsi/client01');
});

test('rebase updates the recorded golden snapshot', async () => {
  const a = fakeAdapter();
  const { ops, db } = makeOps(a);
  const c = await ops.createClient({ name: 'client01', mac: 'aa:bb:cc:dd:ee:01', goldenSnapshot: 'gold-v1' });
  await ops.resetClient(c.id, { toSnapshot: 'gold-v10' });
  assert.equal(db.getClient(c.id).golden_snapshot, 'gold-v10');
  const clone = a.calls.filter((x) => x[0] === 'cloneSnapshot').pop();
  assert.equal(clone[1], 'Main_pool/iscsi/win-golden@gold-v10');
});

test('guardrails: reset can never touch the golden zvol or foreign paths', async () => {
  const a = fakeAdapter();
  const { ops, db } = makeOps(a);
  const c = await ops.createClient({ name: 'client01', mac: 'aa:bb:cc:dd:ee:01' });
  // Simulate a corrupted/hostile DB row pointing at the golden zvol.
  db.raw.prepare('UPDATE clients SET zvol = ? WHERE id = ?').run('Main_pool/iscsi/win-golden', c.id);
  await assert.rejects(() => ops.resetClient(c.id, { force: true }), /golden zvol/);
  db.raw.prepare('UPDATE clients SET zvol = ? WHERE id = ?').run('Main_pool/other/thing', c.id);
  await assert.rejects(() => ops.resetClient(c.id, { force: true }), /outside managed prefix/);
  db.raw.prepare('UPDATE clients SET zvol = ? WHERE id = ?').run('Main_pool/iscsi/a/b', c.id);
  await assert.rejects(() => ops.resetClient(c.id, { force: true }), /direct child/);
});

test('retire deletes in order targetextent -> target -> extent -> zvol -> row', async () => {
  const a = fakeAdapter();
  const { ops, db } = makeOps(a);
  const c = await ops.createClient({ name: 'clienttest', mac: 'aa:bb:cc:dd:ee:01' });
  await assert.rejects(() => ops.retireClient(c.id, { confirmName: 'wrong' }), /confirmation name mismatch/);
  const before = a.calls.length;
  const r = await ops.retireClient(c.id, { confirmName: 'clienttest' });
  const deletes = a.calls.slice(before).map((x) => x[0])
    .filter((n) => ['deleteTargetExtent', 'deleteTarget', 'deleteExtent', 'deleteDataset'].includes(n));
  assert.deepEqual(deletes, ['deleteTargetExtent', 'deleteTarget', 'deleteExtent', 'deleteDataset']);
  assert.equal(db.listClients().length, 0);
  assert.equal(r.steps.length, 4);
});

test('promoteGolden names the next version and only ever creates', async () => {
  const a = fakeAdapter();
  const { ops } = makeOps(a);
  const name = await ops.promoteGolden();
  assert.equal(name, 'gold-v11');
  const snap = a.calls.find((x) => x[0] === 'createSnapshot');
  assert.deepEqual([snap[1], snap[2]], ['Main_pool/iscsi/win-golden', 'gold-v11']);
  assert.ok(!a.calls.some((x) => x[0].startsWith('delete')), 'promote never deletes anything');
});

test('resolveTargetGroups copies portal/initiator bindings from an existing target', async () => {
  const a = fakeAdapter();
  const { ops } = makeOps(a);
  const groups = await ops.resolveTargetGroups();
  assert.deepEqual(groups, [{ portal: 1, initiator: 3, authmethod: 'NONE' }]);
});

test('bulkReset reports per-client outcomes without aborting', async () => {
  const a = fakeAdapter();
  const { ops } = makeOps(a, new Set(['client02']));
  const c1 = await ops.createClient({ name: 'client01', mac: 'aa:bb:cc:dd:ee:01' });
  const c2 = await ops.createClient({ name: 'client02', mac: 'aa:bb:cc:dd:ee:02' });
  const results = await ops.bulkReset([c1.id, c2.id, 9999]);
  assert.deepEqual(results.map((r) => r.ok), [true, false, false]);
  assert.match(results[1].error, /active iSCSI session/);
  assert.match(results[2].error, /no client/);
});
