'use strict';

// In-app nightly reset: clients with nightly_reset=1 are wiped back to their
// golden snapshot at settings.nightly_reset_time (server-local HH:MM).
// Checks once a minute; runs at most once per day.

class Scheduler {
  constructor({ ops, db, logger = console }) {
    this.ops = ops;
    this.db = db;
    this.log = logger;
    this.timer = null;
    this.lastRunDay = null;
  }

  start() {
    this.timer = setInterval(() => this.check().catch((e) => this.log.error(`[scheduler] ${e.message}`)), 60 * 1000);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); }

  async check(now = new Date()) {
    const s = this.db.allSettings();
    const at = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s.nightly_reset_time || '');
    if (!at) return;
    const day = now.toISOString().slice(0, 10);
    if (this.lastRunDay === day) return;
    if (now.getHours() !== parseInt(at[1], 10) || now.getMinutes() !== parseInt(at[2], 10)) return;

    this.lastRunDay = day;
    const targets = this.db.listClients().filter((c) => c.nightly_reset);
    if (!targets.length) return;
    const force = s.nightly_force === '1';
    this.log.info(`[scheduler] nightly reset of ${targets.length} client(s), force=${force}`);
    const results = await this.ops.bulkReset(targets.map((c) => c.id), { force });
    this.db.logEvent('nightly.reset', null, { results, force });
  }
}

module.exports = { Scheduler };
