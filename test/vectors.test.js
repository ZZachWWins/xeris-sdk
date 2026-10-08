'use strict';

/** TestVectors (blueprint §13): 20 embedded reference vectors, recomputed by the builders. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { TestVectors } = require('..');

const REFERENCE = JSON.parse(fs.readFileSync(path.join(__dirname, 'vectors.json'), 'utf8'));

test('verify() passes and all() returns the 20 entries', () => {
  assert.deepEqual(TestVectors.verify(), { ok: true, failures: [] });
  const all = TestVectors.all();
  assert.equal(all.length, 20);
  for (const v of all) {
    assert.equal(v.hex, v.expectedHex, v.name);
    assert.equal(v.bytes.toString('hex'), v.hex, v.name);
    assert.equal(v.length, v.bytes.length, v.name);
  }
});

test('the five classic entries equal the sdk-test-js vectors of the bincode-checked reference', () => {
  const classic = REFERENCE.filter((v) => v.label === 'sdk-test-js');
  assert.ok(classic.length >= 5);
  const byName = Object.fromEntries(TestVectors.all().map((v) => [v.name, v]));
  for (const ref of classic) {
    const name = ref.variant.charAt(0).toLowerCase() + ref.variant.slice(1);
    if (!byName[name]) continue;
    assert.equal(byName[name].hex, ref.hex, name);
  }
  for (const n of ['nativeTransfer', 'stake', 'tokenMint', 'tokenTransfer', 'wrapXrs']) assert.ok(byName[n], n);
});

test('printAll() writes one line per entry and does not throw', (t) => {
  const lines = [];
  t.mock.method(console, 'log', (...a) => lines.push(a.join(' ')));
  TestVectors.printAll();
  assert.ok(lines.length >= 20);
});
