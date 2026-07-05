'use strict';

// In-process fake of a TrueNAS SCALE box: legacy DDP WebSocket endpoint at
// /websocket with stateful ZFS + iSCSI emulation. Enough behavior to exercise
// the full FleetDeck stack (introspection, clone lifecycle, sessions).

const http = require('http');
const { WebSocketServer } = require('ws');

const API_KEY = 'test-api-key';

function makeState() {
  return {
    snapshots: [
      { dataset: 'Main_pool/iscsi/win-golden', name: 'Main_pool/iscsi/win-golden@gold-v1', snapshot_name: 'gold-v1', properties: { used: { parsed: 1024 } } },
      { dataset: 'Main_pool/iscsi/win-golden', name: 'Main_pool/iscsi/win-golden@gold-v2', snapshot_name: 'gold-v2', properties: { used: { parsed: 2048 } } },
    ],
    datasets: new Map([
      ['Main_pool/iscsi/win-golden', { id: 'Main_pool/iscsi/win-golden', type: 'VOLUME', properties: { used: { parsed: 107374182400 }, volsize: { parsed: 137438953472 }, origin: { value: '' } } }],
    ]),
    extents: [{ id: 1, name: 'win-golden', type: 'DISK', disk: 'zvol/Main_pool/iscsi/win-golden' }],
    targets: [{ id: 1, name: 'win-golden', mode: 'ISCSI', groups: [{ portal: 1, initiator: 1, authmethod: 'NONE', auth: null }] }],
    targetextents: [{ id: 1, target: 1, extent: 1, lunid: 0 }],
    sessions: [],   // push {target: 'iqn.2005-10.org.freenas.ctl:name'} to simulate a booted client
    nextId: 100,
    calls: [],      // [method, params] audit for assertions
  };
}

const METHOD_NAMES = [
  'core.get_methods', 'auth.login_with_api_key', 'system.info',
  'pool.snapshot.query', 'pool.snapshot.create', 'pool.snapshot.clone',
  'pool.dataset.query', 'pool.dataset.update', 'pool.dataset.delete',
  'iscsi.extent.query', 'iscsi.extent.create', 'iscsi.extent.delete',
  'iscsi.target.query', 'iscsi.target.create', 'iscsi.target.delete',
  'iscsi.targetextent.query', 'iscsi.targetextent.create', 'iscsi.targetextent.delete',
  'iscsi.global.sessions',
];

function matchFilter(obj, [field, op, value]) {
  const v = obj[field];
  if (op === '=') return v === value;
  if (op === '^') return typeof v === 'string' && v.startsWith(value);
  if (op === 'in') return Array.isArray(value) && value.includes(v);
  throw new Error(`mock: unsupported filter op ${op}`);
}
const applyFilters = (rows, filters = []) => rows.filter((r) => (filters || []).every((f) => matchFilter(r, f)));

function dispatch(state, method, params, authed) {
  state.calls.push([method, params]);
  if (method === 'auth.login_with_api_key') return params[0] === API_KEY;
  if (!authed()) throw { reason: 'not authenticated' };

  switch (method) {
    case 'core.get_methods':
      return Object.fromEntries(METHOD_NAMES.map((m) => [m, { description: '' }]));
    case 'system.info':
      return { version: '25.10.3-MOCK', hostname: 'truenas-mock', uptime: '1 day' };

    case 'pool.snapshot.query':
      return applyFilters(state.snapshots, params[0]);
    case 'pool.snapshot.create': {
      const { dataset, name } = params[0];
      if (!state.datasets.has(dataset)) throw { reason: `dataset ${dataset} not found` };
      const snap = { dataset, name: `${dataset}@${name}`, snapshot_name: name, properties: { used: { parsed: 0 } } };
      state.snapshots.push(snap);
      return snap;
    }
    case 'pool.snapshot.clone': {
      const { snapshot, dataset_dst } = params[0];
      if (!state.snapshots.some((s) => s.name === snapshot)) throw { reason: `snapshot ${snapshot} not found` };
      if (state.datasets.has(dataset_dst)) throw { reason: `dataset ${dataset_dst} already exists` };
      state.datasets.set(dataset_dst, {
        id: dataset_dst, type: 'VOLUME',
        properties: { used: { parsed: 64 }, volsize: { parsed: 137438953472 }, origin: { value: snapshot } },
      });
      return true;
    }

    case 'pool.dataset.query':
      return applyFilters([...state.datasets.values()], params[0]);
    case 'pool.dataset.update': {
      const ds = state.datasets.get(params[0]);
      if (!ds) throw { reason: `dataset ${params[0]} not found` };
      if (params[1]?.volsize) ds.properties.volsize = { parsed: params[1].volsize };
      return ds;
    }
    case 'pool.dataset.delete': {
      if (!state.datasets.has(params[0])) throw { reason: `dataset ${params[0]} not found` };
      state.datasets.delete(params[0]);
      return true;
    }

    case 'iscsi.extent.query':
      return applyFilters(state.extents, params[0]);
    case 'iscsi.extent.create': {
      const ext = { id: state.nextId++, ...params[0] };
      const zvol = String(params[0].disk || '').replace(/^zvol\//, '');
      if (!state.datasets.has(zvol)) throw { reason: `extent disk ${params[0].disk} does not exist` };
      state.extents.push(ext);
      return ext;
    }
    case 'iscsi.extent.delete': {
      const i = state.extents.findIndex((e) => e.id === params[0]);
      if (i < 0) throw { reason: `extent ${params[0]} not found` };
      state.extents.splice(i, 1);
      return true;
    }

    case 'iscsi.target.query':
      return applyFilters(state.targets, params[0]);
    case 'iscsi.target.create': {
      const t = { id: state.nextId++, ...params[0] };
      state.targets.push(t);
      return t;
    }
    case 'iscsi.target.delete': {
      const i = state.targets.findIndex((t) => t.id === params[0]);
      if (i < 0) throw { reason: `target ${params[0]} not found` };
      if (state.targetextents.some((te) => te.target === params[0])) throw { reason: 'target is in use by a targetextent' };
      state.targets.splice(i, 1);
      return true;
    }

    case 'iscsi.targetextent.query':
      return applyFilters(state.targetextents, params[0]);
    case 'iscsi.targetextent.create': {
      const te = { id: state.nextId++, lunid: 0, ...params[0] };
      state.targetextents.push(te);
      return te;
    }
    case 'iscsi.targetextent.delete': {
      const i = state.targetextents.findIndex((te) => te.id === params[0]);
      if (i < 0) throw { reason: `targetextent ${params[0]} not found` };
      state.targetextents.splice(i, 1);
      return true;
    }

    case 'iscsi.global.sessions':
      return state.sessions;

    default:
      throw { reason: `mock: unknown method ${method}` };
  }
}

// Starts the mock; resolves {url, state, close}.
function startMockTrueNAS() {
  const state = makeState();
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: '/websocket' });

  wss.on('connection', (ws) => {
    let connected = false;
    let authed = false;
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.msg === 'connect') {
        connected = true;
        return ws.send(JSON.stringify({ msg: 'connected', session: 'mock' }));
      }
      if (!connected || msg.msg !== 'method') return;
      try {
        const result = dispatch(state, msg.method, msg.params || [], () => authed);
        if (msg.method === 'auth.login_with_api_key' && result === true) authed = true;
        ws.send(JSON.stringify({ id: msg.id, msg: 'result', result }));
      } catch (err) {
        ws.send(JSON.stringify({ id: msg.id, msg: 'result', error: { reason: err.reason || err.message } }));
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `ws://127.0.0.1:${port}/websocket`,
        state,
        close: () => new Promise((r) => { wss.close(); server.close(r); }),
      });
    });
  });
}

module.exports = { startMockTrueNAS, API_KEY };
