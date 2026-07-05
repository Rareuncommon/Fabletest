'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { render } = require('../lib/ipxe');
const { DEFAULT_TEMPLATE } = require('../lib/db');

test('renders the default sanboot template exactly', () => {
  const out = render(DEFAULT_TEMPLATE, {
    name: 'client01',
    mac: 'a1:b2:c3:d4:e5:f6',
    portal_ip: '192.168.1.36',
    iqn_prefix: 'iqn.2005-10.org.freenas.ctl',
    target_name: 'client01',
  });
  assert.ok(out.startsWith('#!ipxe\n'));
  assert.ok(out.includes('sanboot iscsi:192.168.1.36::::iqn.2005-10.org.freenas.ctl:client01'));
});

test('substitutes with and without inner whitespace', () => {
  assert.equal(render('x {{a}} y {{ a }} z', { a: 1 }), 'x 1 y 1 z');
});

test('unknown vars render empty, not literal', () => {
  assert.equal(render('a{{nope}}b', {}), 'ab');
  assert.equal(render('a{{n}}b', { n: null }), 'ab');
});

test('does not recurse into substituted values', () => {
  assert.equal(render('{{a}}', { a: '{{b}}', b: 'X' }), '{{b}}');
});
