'use strict';

// Safety rails around destructive ZFS operations. These are hard blocks, not
// confirmations: no code path in FleetDeck can delete the golden zvol, any
// snapshot, or anything outside the managed prefix. (Note the adapter doesn't
// even expose a snapshot-delete method — snapshots are safe by construction.)

class GuardError extends Error {
  constructor(msg) { super(msg); this.name = 'GuardError'; }
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

function assertValidClientName(name) {
  if (!NAME_RE.test(String(name || ''))) {
    throw new GuardError(`invalid client name '${name}' — use lowercase letters, digits, - and _`);
  }
}

// Every zvol we create or destroy must live under the managed prefix and must
// not be the golden zvol itself.
function assertManagedZvol(zvol, settings) {
  const prefix = settings.managed_prefix;
  const golden = settings.golden_zvol;
  if (!prefix || !prefix.endsWith('/')) {
    throw new GuardError(`managed_prefix setting ('${prefix}') must be a dataset path ending in /`);
  }
  if (typeof zvol !== 'string' || !zvol.startsWith(prefix)) {
    throw new GuardError(`refusing to touch '${zvol}' — outside managed prefix '${prefix}'`);
  }
  const rest = zvol.slice(prefix.length);
  if (!rest || rest.includes('/') || rest.includes('@') || rest.includes('..')) {
    throw new GuardError(`refusing to touch '${zvol}' — must be a direct child of '${prefix}'`);
  }
  if (zvol === golden) {
    throw new GuardError(`refusing to touch the golden zvol '${golden}' — hard block`);
  }
}

// Snapshot names we boot/clone from: "gold-v3" style, but any sane snapshot
// name is allowed (no @, no /).
function assertValidSnapshotName(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(String(name || ''))) {
    throw new GuardError(`invalid snapshot name '${name}'`);
  }
}

module.exports = { GuardError, assertValidClientName, assertManagedZvol, assertValidSnapshotName };
