'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { Adapter } = require('../lib/adapter');

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

function fakeClient(methodNames, onCall) {
  return {
    async call(method, params) {
      if (method === 'core.get_methods') {
        return Object.fromEntries(methodNames.map((m) => [m, {}]));
      }
      if (onCall) return onCall(method, params);
      return null;
    },
  };
}

test('introspection prefers modern names (pool.snapshot.*)', async () => {
  const client = fakeClient([
    'pool.snapshot.query', 'pool.snapshot.create', 'pool.snapshot.clone',
    'zfs.snapshot.query', // legacy alias also present
    'pool.dataset.query', 'pool.dataset.update', 'pool.dataset.delete',
    'iscsi.extent.query', 'iscsi.extent.create', 'iscsi.extent.delete',
    'iscsi.target.query', 'iscsi.target.create', 'iscsi.target.delete',
    'iscsi.targetextent.query', 'iscsi.targetextent.create', 'iscsi.targetextent.delete',
    'iscsi.global.sessions', 'system.info',
  ]);
  const a = new Adapter({ client, logger: quiet });
  await a.introspect();
  assert.equal(a.resolved['snapshot.query'], 'pool.snapshot.query');
  assert.equal(a.resolved['sessions'], 'iscsi.global.sessions');
  assert.deepEqual(a.missing, []);
});

test('introspection falls back to legacy names on an older box', async () => {
  const client = fakeClient([
    'zfs.snapshot.query', 'zfs.snapshot.create', 'zfs.snapshot.clone',
    'pool.dataset.query', 'pool.dataset.update', 'pool.dataset.delete',
    'iscsi.extent.query', 'iscsi.extent.create', 'iscsi.extent.delete',
    'iscsi.target.query', 'iscsi.target.create', 'iscsi.target.delete',
    'iscsi.targetextent.query', 'iscsi.targetextent.create', 'iscsi.targetextent.delete',
    'iscsi.session.query', 'system.info',
  ]);
  const a = new Adapter({ client, logger: quiet });
  await a.introspect();
  assert.equal(a.resolved['snapshot.clone'], 'zfs.snapshot.clone');
  assert.equal(a.resolved['sessions'], 'iscsi.session.query');
});

test('missing methods are reported, and calls to them fail loudly', async () => {
  const client = fakeClient(['pool.dataset.query']);
  const a = new Adapter({ client, logger: quiet });
  await a.introspect();
  assert.ok(a.missing.includes('snapshot.clone'));
  await assert.rejects(() => a.cloneSnapshot('x@y', 'z'), /no TrueNAS method resolved/);
});

test('introspection tolerates an array-of-names response', async () => {
  const client = { async call() { return ['pool.dataset.query', 'system.info']; } };
  const a = new Adapter({ client, logger: quiet });
  await a.introspect();
  assert.equal(a.resolved['dataset.query'], 'pool.dataset.query');
});

test('DRY_RUN intercepts mutations but lets reads through', async () => {
  const executed = [];
  const dryLogged = [];
  const client = fakeClient(
    ['pool.snapshot.query', 'pool.snapshot.clone', 'pool.dataset.query', 'pool.dataset.delete', 'system.info'],
    (method, params) => { executed.push(method); return []; }
  );
  const a = new Adapter({ client, dryRun: true, onDryRun: (op, m, p) => dryLogged.push(op), logger: quiet });
  await a.introspect();

  await a.listSnapshots('Main_pool/iscsi/win-golden');   // read: executes
  const res = await a.cloneSnapshot('a@b', 'c');          // mutation: intercepted
  await a.deleteDataset('Main_pool/iscsi/x');             // mutation: intercepted

  assert.deepEqual(executed, ['pool.snapshot.query']);
  assert.deepEqual(dryLogged, ['snapshot.clone', 'dataset.delete']);
  assert.equal(res.dry_run, true);
  assert.ok(res.id, 'dry-run result still carries an id for rollback bookkeeping');
});
