'use strict';

// Accepts any common MAC notation: aa:bb:cc:dd:ee:ff, AA-BB-CC-DD-EE-FF,
// aabb.ccdd.eeff, aabbccddeeff. Returns canonical lowercase colon form,
// or null if it isn't a MAC.
function normalizeMac(input) {
  if (typeof input !== 'string') return null;
  const hex = input.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return null;
  // Reject inputs that had non-separator garbage (e.g. "zz:aa..." collapses
  // to <12 hex and is caught above; "aabbccddeeff0" is caught above too).
  const stripped = input.toLowerCase().replace(/[\s:.\-]/g, '');
  if (!/^[0-9a-f]{12}$/.test(stripped)) return null;
  return hex.match(/.{2}/g).join(':');
}

// iPXE requests arrive as /boot/a1-b2-c3-d4-e5-f6.ipxe (hexhyp).
function macToHexhyp(mac) {
  return mac.replace(/:/g, '-');
}

function hexhypToMac(hexhyp) {
  return normalizeMac(hexhyp);
}

module.exports = { normalizeMac, macToHexhyp, hexhypToMac };
