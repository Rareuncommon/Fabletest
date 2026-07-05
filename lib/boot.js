'use strict';

const express = require('express');
const { hexhypToMac, macToHexhyp } = require('./mac');
const { render } = require('./ipxe');

// GET /boot/<aa-bb-cc-dd-ee-ff>.ipxe — the one unauthenticated route.
// iPXE firmware can't do auth; bind address/port scoping is the control.
function buildBootRouter({ db, logger = console }) {
  const router = express.Router();

  router.get('/boot/:file', (req, res) => {
    res.type('text/plain');
    const m = /^([0-9a-fA-F]{2}(?:-[0-9a-fA-F]{2}){5})\.ipxe$/.exec(req.params.file);
    if (!m) return res.status(404).send('#!ipxe\necho FleetDeck: malformed boot path (want /boot/aa-bb-cc-dd-ee-ff.ipxe)\nshell\n');

    const mac = hexhypToMac(m[1]);
    const s = db.allSettings();
    const client = db.getClientByMac(mac);

    if (!client) {
      db.recordDiscovered(mac);
      db.logEvent('boot.unknown', null, { mac });
      logger.info(`[boot] unknown MAC ${mac} — recorded as discovered`);
      return res.send(render(s.ipxe_unknown_template, { mac, mac_hexhyp: macToHexhyp(mac), portal_ip: s.portal_ip }));
    }

    const bootGolden = !!client.boot_golden_once;
    const targetName = bootGolden ? s.golden_target : client.target_name;
    const vars = {
      name: client.name,
      mac,
      mac_hexhyp: macToHexhyp(mac),
      portal_ip: s.portal_ip,
      iqn_prefix: s.iqn_prefix,
      target_name: targetName,
      zvol: client.zvol,
      golden_snapshot: client.golden_snapshot,
    };
    const template = (client.ipxe_override && client.ipxe_override.trim()) ? client.ipxe_override : s.ipxe_template;
    const script = render(template, vars);

    db.updateClient(client.id, { last_boot_at: new Date().toISOString().replace('T', ' ').slice(0, 19) });
    if (bootGolden) {
      // auto-revert: the golden redirect is good for exactly one serve
      db.updateClient(client.id, { boot_golden_once: 0 });
      db.logEvent('boot.serve.golden_once', client.name, { mac, target: targetName, reverted: true });
    } else {
      db.logEvent('boot.serve', client.name, { mac, target: targetName, override: template !== s.ipxe_template });
    }
    return res.send(script);
  });

  return router;
}

module.exports = { buildBootRouter };
