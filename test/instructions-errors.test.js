'use strict';

/** Builder arity, field-level errors and disabled variants (blueprint §15). */

const test = require('node:test');
const assert = require('node:assert/strict');

const { Instructions, BUILDER_NAMES, DISABLED_VARIANTS, EncodingError, FeatureDisabledError, DISABLED_FEATURES } = require('..');

const DISABLED = new Set(DISABLED_VARIANTS.map((i) => BUILDER_NAMES[i]));

test('every live builder throws EncodingError(arity) for one argument too few and too many', () => {
  for (const name of BUILDER_NAMES) {
    if (DISABLED.has(name)) continue;
    const fn = Instructions[name];
    const n = fn.length;
    assert.ok(n >= 1, name);
    const isArity = (e) => e instanceof EncodingError && e.code === 'arity';
    assert.throws(() => fn(...Array(n - 1).fill(null)), isArity, `${name} with ${n - 1}`);
    assert.throws(() => fn(...Array(n + 1).fill(null)), isArity, `${name} with ${n + 1}`);
  }
});

test('field errors name the parameter', () => {
  assert.throws(() => Instructions.openDispute('d', 't', 's', 'def', 'r', 'e', -1), (e) => e instanceof RangeError && /bond/.test(e.message));
  assert.throws(() => Instructions.acceptDeal('d', 1, 'a', 1, Buffer.alloc(31)), (e) => e instanceof RangeError && /expectedTermsHash/.test(e.message));
  assert.throws(() => Instructions.postTask('t', 'T', '', '', [], 256, 1, 0, 1, 'poster_confirm', '', 0), (e) => e instanceof RangeError && /minReputation/.test(e.message));
  assert.throws(() => Instructions.registerAgent('a', 'b', 1, 1, 'x', [], 0), (e) => e instanceof TypeError && /allowedContracts/.test(e.message));
  assert.throws(() => Instructions.nativeTransfer('a', 'b', 2 ** 53), (e) => e instanceof RangeError && /amount/.test(e.message));
  assert.throws(() => Instructions.castVote('\ud800', 'yes'), (e) => e instanceof RangeError && /proposalId/.test(e.message));
});

test('disabled builders throw FeatureDisabledError synchronously without reading arguments', () => {
  for (const name of DISABLED) {
    assert.throws(() => Instructions[name](), (e) => {
      assert.ok(e instanceof FeatureDisabledError, name);
      assert.equal(e.code, 'feature_disabled');
      assert.ok(Object.prototype.hasOwnProperty.call(DISABLED_FEATURES, e.feature), `${name} feature ${e.feature}`);
      assert.match(e.citation, /ledger\.rs:\d+/);
      return true;
    }, name);
  }
});
