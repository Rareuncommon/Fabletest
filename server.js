'use strict';

const path = require('path');
const express = require('express');

const config = require('./lib/config');
const { openDb } = require('./lib/db');
const { TrueNASClient } = require('./lib/truenas');
const { Adapter } = require('./lib/adapter');
const { Ops } = require('./lib/ops');
const { Poller } = require('./lib/poller');
const { Scheduler } = require('./lib/scheduler');
const { buildAuth } = require('./lib/auth');
const { buildApiRouter } = require('./lib/api');
const { buildBootRouter } = require('./lib/boot');

const log = {
  info: (...a) => console.log(new Date().toISOString(), ...a),
  warn: (...a) => console.warn(new Date().toISOString(), ...a),
  error: (...a) => console.error(new Date().toISOString(), ...a),
};

async function main() {
  log.info(`FleetDeck starting${config.dryRun ? ' [DRY RUN — TrueNAS mutations are logged, not executed]' : ''}`);

  const db = openDb(config.dbPath, config.truenasUrl);

  const tnClient = new TrueNASClient({
    url: config.truenasUrl,
    apiKey: config.apiKey,
    verifyTls: config.verifyTls,
    logger: log,
  });

  const adapter = new Adapter({
    client: tnClient,
    dryRun: config.dryRun,
    onDryRun: (op, method, params) => db.logEvent('dry_run', null, { op, method, params }),
    logger: log,
  });

  const poller = new Poller({ adapter, db, intervalMs: config.pollIntervalMs, isConnected: () => tnClient.connected, logger: log });
  const ops = new Ops({ adapter, db, activeTargets: () => poller.activeTargets(), logger: log });
  const scheduler = new Scheduler({ ops, db, logger: log });
  const auth = buildAuth({ db, adminPassword: config.adminPassword, logger: log });

  // (Re-)introspect method names on every (re)connect — version drift safety.
  tnClient.on('connected', () => {
    adapter.introspect().catch((err) => log.error(`[adapter] introspection failed: ${err.message}`));
  });

  // The HTTP server must come up even when TrueNAS is unreachable: /boot/*
  // serving works purely from SQLite, which is exactly what you want during a
  // NAS reboot with clients power-cycling.
  if (config.apiKey) {
    tnClient.connect()
      .then(() => adapter.introspect())
      .then(() => log.info('[adapter] introspection complete'))
      .catch((err) => {
        log.warn(`[truenas] initial connect failed (${err.message}) — will keep retrying in the background`);
        retryLoop();
      });
  } else {
    log.warn('[truenas] TRUENAS_API_KEY not set — running disconnected (boot script serving still works)');
  }

  let retryTimer = null;
  function retryLoop() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (tnClient.connected) return;
      tnClient.connect().catch((err) => {
        log.warn(`[truenas] reconnect failed: ${err.message}`);
        retryLoop();
      });
    }, 15000);
    retryTimer.unref?.();
  }

  poller.start();
  scheduler.start();

  const app = express();
  app.disable('x-powered-by');

  app.use(buildBootRouter({ db, logger: log }));
  app.use(buildApiRouter({ db, ops, poller, adapter, tnClient, auth, config, logger: log }));

  app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  app.get('/healthz', (_req, res) => res.json({ ok: true, truenas: tnClient.connected, dry_run: config.dryRun }));

  const server = app.listen(config.httpPort, config.bindAddress, () => {
    log.info(`FleetDeck listening on http://${config.bindAddress}:${config.httpPort}`);
    log.info(`iPXE boot endpoint: GET /boot/<aa-bb-cc-dd-ee-ff>.ipxe (unauthenticated by design)`);
  });

  const shutdown = () => {
    log.info('shutting down');
    poller.stop();
    scheduler.stop();
    tnClient.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
