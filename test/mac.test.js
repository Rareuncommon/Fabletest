'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeMac, macToHexhyp, hexhypToMac } = require('../lib/mac');

test('normalizeMac accepts common notations', () => {
  assert.equal(normalizeMac('aa:bb:cc:dd:ee:ff'), 'aa:bb:cc:dd:ee:ff');
  assert.equal(normalizeMac('AA:BB:CC:DD:EE:FF'), 'aa:bb:cc:dd:ee:ff');
  assert.equal(normalizeMac('aa-bb-cc-dd-ee-ff'), 'aa:bb:cc:dd:ee:ff');
  assert.equal(normalizeMac('AA-BB-CC-DD-EE-FF'), 'aa:bb:cc:dd:ee:ff');
  assert.equal(normalizeMac('aabb.ccdd.eeff'), 'aa:bb:cc:dd:ee:ff');
  assert.equal(normalizeMac('aabbccddeeff'), 'aa:bb:cc:dd:ee:ff');
  assert.equal(normalizeMac(' aa:bb:cc:dd:ee:ff '), 'aa:bb:cc:dd:ee:ff');
  assert.equal(normalizeMac('A1-B2-C3-D4-E5-F6'), 'a1:b2:c3:d4:e5:f6');
});

test('normalizeMac rejects garbage', () => {
  assert.equal(normalizeMac('aa:bb:cc:dd:ee'), null);          // too short
  assert.equal(normalizeMac('aa:bb:cc:dd:ee:ff:00'), null);    // too long
  assert.equal(normalizeMac('zz:bb:cc:dd:ee:ff'), null);       // non-hex
  assert.equal(normalizeMac('aabbccddeeff0'), null);
  assert.equal(normalizeMac(''), null);
  assert.equal(normalizeMac(null), null);
  assert.equal(normalizeMac(undefined), null);
  assert.equal(normalizeMac(12), null);
  assert.equal(normalizeMac('hello world!'), null);
});

test('hexhyp round trip', () => {
  assert.equal(macToHexhyp('a1:b2:c3:d4:e5:f6'), 'a1-b2-c3-d4-e5-f6');
  assert.equal(hexhypToMac('a1-b2-c3-d4-e5-f6'), 'a1:b2:c3:d4:e5:f6');
});
