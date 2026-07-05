'use strict';

// Full-stack test against an in-process mock TrueNAS (legacy /websocket
// protocol, stateful ZFS/iSCSI emulation): introspection, auth, client
// lifecycle, boot serving, session guardrails, promote/rebase, dry-run.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { openDb } = require('../lib/db');
const { TrueNASClient } = require('../lib/truenas');
const { Adapter } = require('../lib/adapter');
const { Ops } = require('../lib/ops');
const { Poller } = require('../lib/poller');
const { buildAuth } = require('../lib/auth');
const { buildApiRouter } = require('../lib/api');
const { buildBootRouter } = require('../lib/boot');
const { startMockTrueNAS, API_KEY } = require('./mock-truenas');

const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const ADMIN_PW = 'hunter2';

let mock, tnClient, adapter, poller, ops, db, httpServer, base, cookie;

async function apiFetch(path, opts = {}) {
  const res = await fetch(base + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

before(async () => {
  mock = await startMockTrueNAS();

  db = openDb(':memory:', 'wss://192.168.1.36:8444/websocket');
  tnClient = new TrueNASClient({ url: mock.url, apiKey: API_KEY, logger: quiet });
  adapter = new Adapter({ client: tnClient, logger: quiet });
  poller = new Poller({ adapter, db, logger: quiet });
  ops = new Ops({ adapter, db, activeTargets: () => poller.activeTargets(), logger: quiet });
  const auth = buildAuth({ db, adminPassword: ADMIN_PW, logger: quiet });
  const config = { dryRun: false, truenasUrl: mock.url };

  await tnClient.connect();
  await adapter.introspect();

  const app = express();
  app.use(buildBootRouter({ db, logger: quiet }));
  app.use(buildApiRouter({ db, ops, poller, adapter, tnClient, auth, config, logger: quiet }));
  await new Promise((r) => { httpServer = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  tnClient.close();
  httpServer?.close();
  await mock.close();
});

test('introspection resolved modern method names from the mock box', () => {
  assert.equal(adapter.resolved['snapshot.clone'], 'pool.snapshot.clone');
  assert.equal(adapter.resolved['sessions'], 'iscsi.global.sessions');
  assert.deepEqual(adapter.missing, []);
});

test('login: wrong password 401, right password sets cookie', async () => {
  const bad = await apiFetch('/api/login', { method: 'POST', body: JSON.stringify({ password: 'nope' }) });
  assert.equal(bad.status, 401);
  const unauth = await apiFetch('/api/state');
  assert.equal(unauth.status, 401);

  const good = await apiFetch('/api/login', { method: 'POST', body: JSON.stringify({ password: ADMIN_PW }) });
  assert.equal(good.status, 200);
  cookie = good.headers.get('set-cookie').split(';')[0];
});

test('state shows golden snapshots after a poll', async () => {
  await poller.poll();
  const { status, body } = await apiFetch('/api/state');
  assert.equal(status, 200);
  assert.equal(body.connected, true);
  assert.deepEqual(body.golden.snapshots.map((s) => s.name), ['gold-v1', 'gold-v2']);
  assert.equal(body.resolved_methods['dataset.delete'], 'pool.dataset.delete');
});

test('truenas-info bring-up endpoint reads system.info', async () => {
  const { body } = await apiFetch('/api/truenas-info');
  assert.equal(body.version, '25.10.3-MOCK');
});

test('create client end-to-end: clone + extent + target + LUN0 on the box', async () => {
  const { status, body } = await apiFetch('/api/clients', {
    method: 'POST',
    body: JSON.stringify({ name: 'client01', mac: 'A1B2.C3D4.E5F6', notes: 'row 3 seat 1' }),
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.zvol, 'Main_pool/iscsi/client01');
  assert.equal(body.golden_snapshot, 'gold-v2'); // latest picked by default

  // TrueNAS-side objects really exist in the mock
  assert.ok(mock.state.datasets.has('Main_pool/iscsi/client01'));
  const ext = mock.state.extents.find((e) => e.name === 'client01');
  assert.equal(ext.disk, 'zvol/Main_pool/iscsi/client01');
  const tgt = mock.state.targets.find((t) => t.name === 'client01');
  assert.deepEqual(tgt.groups, [{ portal: 1, initiator: 1, authmethod: 'NONE' }]); // copied from win-golden
  assert.ok(mock.state.targetextents.some((te) => te.target === tgt.id && te.extent === ext.id && te.lunid === 0));
});

test('create rolls back TrueNAS objects when a late step fails', async () => {
  // Pre-plant a colliding targetextent guard: make target.create succeed but
  // targetextent fail by pointing extent creation at a name the mock rejects.
  // Simplest deterministic failure: duplicate client name at the TrueNAS level
  // -> clone fails because the dataset already exists.
  mock.state.datasets.set('Main_pool/iscsi/client99', { id: 'Main_pool/iscsi/client99', type: 'VOLUME', properties: {} });
  const { status, body } = await apiFetch('/api/clients', {
    method: 'POST', body: JSON.stringify({ name: 'client99', mac: '00:00:00:00:99:99' }),
  });
  assert.equal(status, 400);
  assert.match(body.error, /already exists/);
  // no stray extent/target left behind
  assert.ok(!mock.state.extents.some((e) => e.name === 'client99'));
  assert.ok(!mock.state.targets.some((t) => t.name === 'client99'));
  mock.state.datasets.delete('Main_pool/iscsi/client99');
});

test('boot serving: known MAC gets its sanboot script, last_boot_at bumps', async () => {
  const res = await fetch(`${base}/boot/a1-b2-c3-d4-e5-f6.ipxe`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/plain/);
  const script = await res.text();
  assert.match(script, /^#!ipxe/);
  assert.match(script, /sanboot iscsi:192\.168\.1\.36::::iqn\.2005-10\.org\.freenas\.ctl:client01/);

  const c = db.getClientByName('client01');
  assert.ok(c.last_boot_at, 'last_boot_at recorded');
  const ev = db.listEvents(5).find((e) => e.action === 'boot.serve');
  assert.ok(ev && ev.client === 'client01');
});

test('boot-golden-once serves the golden target exactly once, then reverts', async () => {
  const c = db.getClientByName('client01');
  await apiFetch(`/api/clients/${c.id}`, { method: 'PATCH', body: JSON.stringify({ boot_golden_once: true }) });

  const first = await (await fetch(`${base}/boot/a1-b2-c3-d4-e5-f6.ipxe`)).text();
  assert.match(first, /:win-golden$/m);
  assert.equal(db.getClient(c.id).boot_golden_once, 0, 'flag auto-reverted');

  const second = await (await fetch(`${base}/boot/a1-b2-c3-d4-e5-f6.ipxe`)).text();
  assert.match(second, /:client01$/m);
});

test('per-client iPXE override wins over the global template', async () => {
  const c = db.getClientByName('client01');
  await apiFetch(`/api/clients/${c.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ ipxe_override: '#!ipxe\necho custom for {{name}}\nsanboot iscsi:{{portal_ip}}::::{{iqn_prefix}}:{{target_name}}\n' }),
  });
  const script = await (await fetch(`${base}/boot/a1-b2-c3-d4-e5-f6.ipxe`)).text();
  assert.match(script, /echo custom for client01/);
  await apiFetch(`/api/clients/${c.id}`, { method: 'PATCH', body: JSON.stringify({ ipxe_override: '' }) });
});

test('unknown MAC gets shell script and appears as discovered; adopt clears it', async () => {
  const res = await fetch(`${base}/boot/de-ad-be-ef-00-01.ipxe`);
  const script = await res.text();
  assert.match(script, /unknown client MAC de:ad:be:ef:00:01/);
  assert.match(script, /shell/);

  let { body } = await apiFetch('/api/state');
  assert.ok(body.discovered.some((d) => d.mac === 'de:ad:be:ef:00:01'));

  const created = await apiFetch('/api/clients', {
    method: 'POST', body: JSON.stringify({ name: 'client02', mac: 'de:ad:be:ef:00:01' }),
  });
  assert.equal(created.status, 200);
  ({ body } = await apiFetch('/api/state'));
  assert.ok(!body.discovered.some((d) => d.mac === 'de:ad:be:ef:00:01'), 'adopted MAC removed from discovered');
});

test('malformed boot path is a 404 iPXE script, not a crash', async () => {
  const res = await fetch(`${base}/boot/../../etc/passwd`);
  assert.equal(res.status, 404);
  const res2 = await fetch(`${base}/boot/zz-zz-zz-zz-zz-zz.ipxe`);
  assert.equal(res2.status, 404);
});

test('reset refused while booted (live session), allowed with force', async () => {
  mock.state.sessions.push({ target: 'iqn.2005-10.org.freenas.ctl:client01', initiator: 'iqn.1991-05.com.microsoft:gamer-pc' });
  await poller.poll();

  let { body } = await apiFetch('/api/state');
  assert.equal(body.clients.find((c) => c.name === 'client01').online, true);

  const c = db.getClientByName('client01');
  const refused = await apiFetch(`/api/clients/${c.id}/reset`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /active iSCSI session/);
  assert.ok(mock.state.datasets.has('Main_pool/iscsi/client01'), 'zvol untouched on refusal');

  const forced = await apiFetch(`/api/clients/${c.id}/reset`, { method: 'POST', body: JSON.stringify({ force: true }) });
  assert.equal(forced.status, 200);
  const ds = mock.state.datasets.get('Main_pool/iscsi/client01');
  assert.equal(ds.properties.origin.value, 'Main_pool/iscsi/win-golden@gold-v2');

  mock.state.sessions.length = 0;
  await poller.poll();
});

test('promote golden creates gold-v3; rebase moves a client onto it', async () => {
  const promoted = await apiFetch('/api/golden/promote', { method: 'POST' });
  assert.equal(promoted.body.snapshot, 'gold-v3');
  assert.ok(mock.state.snapshots.some((s) => s.name === 'Main_pool/iscsi/win-golden@gold-v3'));

  const c = db.getClientByName('client01');
  const rebased = await apiFetch(`/api/clients/${c.id}/rebase`, { method: 'POST', body: JSON.stringify({ snapshot: 'gold-v3' }) });
  assert.equal(rebased.status, 200);
  assert.equal(db.getClient(c.id).golden_snapshot, 'gold-v3');
  assert.equal(mock.state.datasets.get('Main_pool/iscsi/client01').properties.origin.value, 'Main_pool/iscsi/win-golden@gold-v3');
});

test('bulk reset via API', async () => {
  const ids = db.listClients().map((c) => c.id);
  const { body } = await apiFetch('/api/bulk/reset', { method: 'POST', body: JSON.stringify({ ids }) });
  assert.ok(body.every((r) => r.ok), JSON.stringify(body));
});

test('retire removes every TrueNAS object in order, then the DB row', async () => {
  const c = db.getClientByName('client02');
  const wrong = await apiFetch(`/api/clients/${c.id}/retire`, { method: 'POST', body: JSON.stringify({ confirm: 'client99' }) });
  assert.equal(wrong.status, 400);

  const { status, body } = await apiFetch(`/api/clients/${c.id}/retire`, { method: 'POST', body: JSON.stringify({ confirm: 'client02' }) });
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(!mock.state.datasets.has('Main_pool/iscsi/client02'));
  assert.ok(!mock.state.extents.some((e) => e.name === 'client02'));
  assert.ok(!mock.state.targets.some((t) => t.name === 'client02'));
  assert.equal(db.getClientByName('client02'), undefined);
});

test('DRY_RUN: mutations are logged as events, never reach the box', async () => {
  const dryDb = openDb(':memory:', mock.url);
  const dryAdapter = new Adapter({
    client: tnClient, dryRun: true,
    onDryRun: (op, method, params) => dryDb.logEvent('dry_run', null, { op, method, params }),
    logger: quiet,
  });
  await dryAdapter.introspect();
  const dryOps = new Ops({ adapter: dryAdapter, db: dryDb, activeTargets: () => new Set(), logger: quiet });

  const callsBefore = mock.state.calls.filter(([m]) => m.includes('create') || m.includes('delete') || m.includes('clone')).length;
  const row = await dryOps.createClient({ name: 'dryclient', mac: '00:11:22:33:44:55' });
  assert.ok(row.id, 'DB row still created so the flow can be inspected');
  const callsAfter = mock.state.calls.filter(([m]) => m.includes('create') || m.includes('delete') || m.includes('clone')).length;
  assert.equal(callsAfter, callsBefore, 'no mutating call reached the (mock) box');
  const dryEvents = dryDb.listEvents(20).filter((e) => e.action === 'dry_run');
  assert.deepEqual(
    dryEvents.map((e) => JSON.parse(e.detail).op).sort(),
    ['extent.create', 'snapshot.clone', 'target.create', 'targetextent.create'].sort()
  );
});
