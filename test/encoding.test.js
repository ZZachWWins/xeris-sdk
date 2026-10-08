'use strict';

/**
 * Tests for `src/encoding.js` (bincode 1.x primitives, exact unit conversion)
 * and for the values exported by `src/constants.js`.
 *
 * Every expected byte string below was produced by the reference encoder
 * `scratchpad/tools/xeris_bincode.py`, which is verified byte-identical
 * against the `bincode` 1.3.3 crate. bincode's legacy entry points use fixint
 * little-endian integers, `u64` length prefixes and a `u8` Option tag; the
 * node decodes instruction data with `bincode::deserialize` at
 * `network.rs:187-192` and `ledger.rs:1385`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const enc = require('../src/encoding');
const C = require('../src/constants');
const { EncodingError } = require('../src/errors');

const hex = (b) => Buffer.from(b).toString('hex');

/**
 * Asserts that `fn` throws an error of class `cls` whose `.field` is `field`
 * (when given) and whose message starts with `<field>:`.
 */
function throwsField(fn, cls, field) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof cls, `expected ${cls.name}, got ${err && err.constructor && err.constructor.name}: ${err && err.message}`);
    if (field !== undefined) {
      assert.equal(err.field, field, `.field should be '${field}' (message: ${err.message})`);
      assert.ok(err.message.startsWith(`${field}:`), `message should start with '${field}:' (got '${err.message}')`);
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Unsigned integers
// ---------------------------------------------------------------------------

test('encodeU8: 1 byte, range 0..=255, no wrap-around', () => {
  assert.equal(hex(enc.encodeU8(0)), '00');
  assert.equal(hex(enc.encodeU8(9)), '09');
  assert.equal(hex(enc.encodeU8(255)), 'ff');
  assert.equal(enc.encodeU8(255).length, 1);
  assert.ok(Buffer.isBuffer(enc.encodeU8(1)));
  // 4.x wrapped 256 to 0x00 (probes.md "u8 given 256"); 5.x must refuse.
  throwsField(() => enc.encodeU8(256), RangeError, 'u8');
  throwsField(() => enc.encodeU8(-1), RangeError, 'u8');
  throwsField(() => enc.encodeU8(1.5), RangeError, 'u8');
  throwsField(() => enc.encodeU8(true), TypeError, 'u8');
  throwsField(() => enc.encodeU8('1'), TypeError, 'u8');
  throwsField(() => enc.encodeU8(null), TypeError, 'u8');
  throwsField(() => enc.encodeU8(256, 'decimals'), RangeError, 'decimals');
  assert.equal(enc.normalizeU8(200, 'score'), 200);
});

test('encodeU32: 4 bytes LE, range 0..=4294967295, bigint accepted', () => {
  assert.equal(hex(enc.encodeU32(11)), '0b000000');
  assert.equal(hex(enc.encodeU32(0)), '00000000');
  assert.equal(hex(enc.encodeU32(4294967295)), 'ffffffff');
  assert.equal(hex(enc.encodeU32(4294967295n)), 'ffffffff');
  assert.equal(hex(enc.encodeU32(9n)), '09000000');
  assert.equal(enc.normalizeU32(7n), 7);
  assert.equal(typeof enc.normalizeU32(7n), 'number');
  // 4.x wrapped 2^32 to 0x00000000 (probes.md "u32 given 2^32").
  throwsField(() => enc.encodeU32(2 ** 32), RangeError, 'u32');
  throwsField(() => enc.encodeU32(2n ** 32n), RangeError, 'u32');
  throwsField(() => enc.encodeU32(-1), RangeError, 'u32');
  throwsField(() => enc.encodeU32(-1n), RangeError, 'u32');
  throwsField(() => enc.encodeU32(1.5), RangeError, 'u32');
  throwsField(() => enc.encodeU32(true), TypeError, 'u32');
  throwsField(() => enc.encodeU32('5'), TypeError, 'u32');
  throwsField(() => enc.encodeU32(2 ** 32, 'maxConcurrent'), RangeError, 'maxConcurrent');
});

test('encodeU64: 8 bytes LE, number must be a safe integer, bigint up to 2^64-1', () => {
  assert.equal(hex(enc.encodeU64(5_000_000_000)), '00f2052a01000000');
  assert.equal(hex(enc.encodeU64(0)), '0000000000000000');
  assert.equal(hex(enc.encodeU64(1)), '0100000000000000');
  assert.equal(hex(enc.encodeU64(2n ** 64n - 1n)), 'ffffffffffffffff');
  assert.equal(hex(enc.encodeU64(Number.MAX_SAFE_INTEGER)), 'ffffffffffff1f00');
  assert.equal(hex(enc.encodeU64(BigInt(Number.MAX_SAFE_INTEGER) + 1n)), '0000000000002000');
  // probes.md: 4.x encoded Number 9007199254740993 as 0000000000002000 (precision lost).
  // The exact value is only representable as a BigInt.
  assert.equal(hex(enc.encodeU64(9007199254740993n)), '0100000000002000');
  assert.equal(hex(enc.encodeU64(1234567123456789n)), '1553d80ed5620400');
  assert.equal(enc.normalizeU64(5), 5n);
  assert.equal(typeof enc.normalizeU64(5), 'bigint');
  assert.equal(enc.normalizeU64(2n ** 64n - 1n), 18446744073709551615n);
});

test('encodeU64 rejections: negatives, non-integers, > 2^53-1 numbers, > 2^64-1 bigints, wrong types', () => {
  throwsField(() => enc.encodeU64(-1), RangeError, 'u64');
  throwsField(() => enc.encodeU64(-1n), RangeError, 'u64');
  throwsField(() => enc.encodeU64(2n ** 64n), RangeError, 'u64');
  throwsField(() => enc.encodeU64(1.5), RangeError, 'u64');
  throwsField(() => enc.encodeU64(NaN), RangeError, 'u64');
  throwsField(() => enc.encodeU64(Infinity), RangeError, 'u64');
  throwsField(() => enc.encodeU64(-Infinity), RangeError, 'u64');
  // Numbers above 2^53-1 cannot be exact; the message must tell the caller to pass a BigInt.
  assert.throws(() => enc.encodeU64(9007199254740992), (err) => {
    assert.ok(err instanceof RangeError);
    assert.ok(/pass a BigInt/.test(err.message), err.message);
    assert.ok(/2\^53/.test(err.message), err.message);
    return true;
  });
  throwsField(() => enc.encodeU64(9007199254740993), RangeError, 'u64');
  throwsField(() => enc.encodeU64(1e21), RangeError, 'u64');
  // Booleans are never integers (blueprint §2); strings are never parsed.
  throwsField(() => enc.encodeU64(true), TypeError, 'u64');
  throwsField(() => enc.encodeU64(false), TypeError, 'u64');
  throwsField(() => enc.encodeU64('5'), TypeError, 'u64');
  throwsField(() => enc.encodeU64(''), TypeError, 'u64');
  throwsField(() => enc.encodeU64(null), TypeError, 'u64');
  throwsField(() => enc.encodeU64(undefined), TypeError, 'u64');
  throwsField(() => enc.encodeU64({}), TypeError, 'u64');
  throwsField(() => enc.encodeU64([1]), TypeError, 'u64');
  // The field argument is used in `.field` and the message prefix.
  throwsField(() => enc.encodeU64(-1, 'amount'), RangeError, 'amount');
  throwsField(() => enc.encodeU64('5', 'bond'), TypeError, 'bond');
  throwsField(() => enc.normalizeU64(2n ** 64n, 'quorum'), RangeError, 'quorum');
});

// ---------------------------------------------------------------------------
// bool
// ---------------------------------------------------------------------------

test('encodeBool: exactly one byte 0x00/0x01; only booleans accepted', () => {
  assert.equal(hex(enc.encodeBool(true)), '01');
  assert.equal(hex(enc.encodeBool(false)), '00');
  throwsField(() => enc.encodeBool(1), TypeError, 'bool');
  throwsField(() => enc.encodeBool(0), TypeError, 'bool');
  throwsField(() => enc.encodeBool('true'), TypeError, 'bool');
  throwsField(() => enc.encodeBool(null), TypeError, 'bool');
  throwsField(() => enc.encodeBool(undefined), TypeError, 'bool');
  throwsField(() => enc.encodeBool(1, 'revoked'), TypeError, 'revoked');
});

// ---------------------------------------------------------------------------
// String
// ---------------------------------------------------------------------------

test('encodeString: u64le byte length then UTF-8, no terminator', () => {
  assert.equal(hex(enc.encodeString('Alice')), '0500000000000000416c696365');
  assert.equal(hex(enc.encodeString('')), '0000000000000000');
  // Length is the UTF-8 byte length, not the UTF-16 code unit count.
  assert.equal(hex(enc.encodeString('é')), '0200000000000000c3a9');
  assert.equal(hex(enc.encodeString('🗳')), '0400000000000000f09f97b3');
  // vectors.json CastVote utf8-multibyte proposal_id
  assert.equal(hex(enc.encodeString('prop-ü-🗳')), '0c0000000000000070726f702dc3bc2df09f97b3');
  assert.equal(enc.assertString('ok', 'f'), 'ok');
});

test('encodeString: lone UTF-16 surrogates are not UTF-8 and are refused (4.x emitted U+FFFD)', () => {
  // probes.md: 4.x encoded '\ud800' as 0300000000000000efbfbd (silent substitution).
  throwsField(() => enc.encodeString('\ud800'), RangeError, 'string');
  throwsField(() => enc.encodeString('\udc00'), RangeError, 'string');
  throwsField(() => enc.encodeString('a\ud800b'), RangeError, 'string');
  throwsField(() => enc.encodeString('\udfff\ud800'), RangeError, 'string');
  assert.throws(() => enc.encodeString('\ud800', 'displayName'), (err) => {
    assert.ok(err instanceof RangeError);
    assert.equal(err.field, 'displayName');
    assert.equal(err.message, 'displayName: string contains a lone UTF-16 surrogate and is not valid UTF-8');
    return true;
  });
  throwsField(() => enc.assertString('\ud800', 'x'), RangeError, 'x');
});

test('encodeString: non-strings are a TypeError, never coerced', () => {
  throwsField(() => enc.encodeString(5), TypeError, 'string');
  throwsField(() => enc.encodeString(null), TypeError, 'string');
  throwsField(() => enc.encodeString(undefined), TypeError, 'string');
  throwsField(() => enc.encodeString(['a']), TypeError, 'string');
  throwsField(() => enc.encodeString(Buffer.from('a')), TypeError, 'string');
  throwsField(() => enc.encodeString({ toString: () => 'a' }), TypeError, 'string');
  throwsField(() => enc.encodeString(5, 'tokenId'), TypeError, 'tokenId');
  throwsField(() => enc.assertString(5, 'tokenId'), TypeError, 'tokenId');
});

// ---------------------------------------------------------------------------
// Vec<u8> / [u8; N]
// ---------------------------------------------------------------------------

test('encodeBytes: u64le length then raw bytes; Buffer or Uint8Array only', () => {
  assert.equal(hex(enc.encodeBytes(Buffer.from([1, 2, 3]))), '0300000000000000010203');
  assert.equal(hex(enc.encodeBytes(new Uint8Array([1, 2, 3]))), '0300000000000000010203');
  assert.equal(hex(enc.encodeBytes(Buffer.alloc(0))), '0000000000000000');
  assert.equal(hex(enc.encodeBytes(new Uint8Array(0))), '0000000000000000');
  // `Buffer.from([256])` would silently wrap, so number[] is refused (blueprint §2).
  throwsField(() => enc.encodeBytes([1, 2]), TypeError, 'bytes');
  throwsField(() => enc.encodeBytes('0102'), TypeError, 'bytes');
  throwsField(() => enc.encodeBytes(null), TypeError, 'bytes');
  throwsField(() => enc.encodeBytes(undefined), TypeError, 'bytes');
  throwsField(() => enc.encodeBytes(5), TypeError, 'bytes');
  throwsField(() => enc.encodeBytes(new Uint16Array(2)), TypeError, 'bytes');
  assert.throws(() => enc.encodeBytes([1], 'args'), (err) => {
    assert.ok(err instanceof TypeError);
    assert.equal(err.field, 'args');
    assert.equal(err.message, 'args: pass a Buffer or Uint8Array');
    return true;
  });
});

test('toBytes: returns a copy, never the caller\'s object', () => {
  const input = Buffer.from([9, 9, 9]);
  const out = enc.toBytes(input, 'x');
  assert.ok(Buffer.isBuffer(out));
  assert.notEqual(out, input);
  // (`out.buffer` may legitimately be the shared Buffer pool; mutation is the real test.)
  input[0] = 0;
  assert.equal(hex(out), '090909');
  const u8 = new Uint8Array([7, 8]);
  const out2 = enc.toBytes(u8);
  u8[0] = 1;
  assert.equal(hex(out2), '0708');
  throwsField(() => enc.toBytes([1], 'sig'), TypeError, 'sig');
  throwsField(() => enc.toBytes('ab', 'sig'), TypeError, 'sig');
});

test('encodeBytes: output does not alias the input', () => {
  const input = Buffer.from([1, 2, 3]);
  const out = enc.encodeBytes(input);
  input[0] = 0xff;
  assert.equal(hex(out), '0300000000000000010203');
});

test('encodeFixedBytes: [u8; N] is raw with no length prefix, exact length enforced', () => {
  const h = Buffer.alloc(32, 0xab);
  assert.equal(hex(enc.encodeFixedBytes(h, 32)), 'ab'.repeat(32));
  assert.equal(enc.encodeFixedBytes(h, 32).length, 32);
  assert.equal(hex(enc.encodeFixedBytes(new Uint8Array(32).fill(0xcd), 32)), 'cd'.repeat(32));
  assert.equal(hex(enc.encodeFixedBytes(Buffer.alloc(0), 0)), '');
  throwsField(() => enc.encodeFixedBytes(Buffer.alloc(31), 32), RangeError, 'bytes');
  throwsField(() => enc.encodeFixedBytes(Buffer.alloc(33), 32), RangeError, 'bytes');
  throwsField(() => enc.encodeFixedBytes(Buffer.alloc(31), 32, 'expectedTermsHash'), RangeError, 'expectedTermsHash');
  throwsField(() => enc.encodeFixedBytes(new Array(32).fill(0), 32), TypeError, 'bytes');
  throwsField(() => enc.encodeFixedBytes('ab'.repeat(32), 32), TypeError, 'bytes');
});

// ---------------------------------------------------------------------------
// Vec<String>
// ---------------------------------------------------------------------------

test('encodeStringVec: u64le count then each String', () => {
  assert.equal(hex(enc.encodeStringVec([])), '0000000000000000');
  assert.equal(hex(enc.encodeStringVec(['hi'])), '010000000000000002000000000000006869');
  assert.equal(hex(enc.encodeStringVec(['a', 'b'])), '0200000000000000010000000000000061010000000000000062');
  assert.equal(hex(enc.encodeStringVec([''])), '01000000000000000000000000000000');
  throwsField(() => enc.encodeStringVec('x'), TypeError, 'string[]');
  throwsField(() => enc.encodeStringVec(null), TypeError, 'string[]');
  throwsField(() => enc.encodeStringVec(undefined), TypeError, 'string[]');
  throwsField(() => enc.encodeStringVec(new Set(['a'])), TypeError, 'string[]');
  assert.throws(() => enc.encodeStringVec([1]), TypeError);
  assert.throws(() => enc.encodeStringVec(['ok', null]), TypeError);
  assert.throws(() => enc.encodeStringVec(['\ud800']), RangeError);
  throwsField(() => enc.encodeStringVec('x', 'tags'), TypeError, 'tags');
});

// ---------------------------------------------------------------------------
// Option<T>
// ---------------------------------------------------------------------------

test('encodeOption: None only from null/undefined; 0, "", [], false are Some', () => {
  assert.equal(hex(enc.encodeOption(null, enc.encodeU64)), '00');
  assert.equal(hex(enc.encodeOption(undefined, enc.encodeU64)), '00');
  assert.equal(hex(enc.encodeOption(7, enc.encodeU64)), '010700000000000000');
  assert.equal(hex(enc.encodeOption(7n, enc.encodeU64)), '010700000000000000');
  // probes.md "Option<u32> newMaxConcurrent: 0": Some(0), not None.
  assert.equal(hex(enc.encodeOption(0, enc.encodeU32)), '0100000000');
  assert.equal(hex(enc.encodeOption(0, enc.encodeU64)), '010000000000000000');
  assert.equal(hex(enc.encodeOption('', enc.encodeString)), '010000000000000000');
  assert.equal(hex(enc.encodeOption([], enc.encodeStringVec)), '010000000000000000');
  assert.equal(hex(enc.encodeOption(false, enc.encodeBool)), '0100');
  assert.equal(hex(enc.encodeOption('x', enc.encodeString)), '01010000000000000078');
  // The inner encoder's validation still applies to a Some value.
  assert.throws(() => enc.encodeOption(-1, enc.encodeU64), RangeError);
  assert.throws(() => enc.encodeOption('5', enc.encodeU64), TypeError);
  assert.throws(() => enc.encodeOption(5, enc.encodeString), TypeError);
});

test('encodeOption: forwards the field name to the inner encoder', () => {
  throwsField(() => enc.encodeOption(-1, enc.encodeU64, 'newMaxPerTx'), RangeError, 'newMaxPerTx');
  throwsField(() => enc.encodeOption(5, enc.encodeString, 'newMetadata'), TypeError, 'newMetadata');
});

// ---------------------------------------------------------------------------
// Variant discriminant
// ---------------------------------------------------------------------------

test('encodeVariant / readVariant: u32le index in 0..INSTRUCTION_COUNT-1', () => {
  assert.equal(C.INSTRUCTION_COUNT, 62);
  assert.equal(hex(enc.encodeVariant(0)), '00000000');
  assert.equal(hex(enc.encodeVariant(11)), '0b000000');
  assert.equal(hex(enc.encodeVariant(61)), '3d000000');
  assert.throws(() => enc.encodeVariant(62), EncodingError);
  assert.throws(() => enc.encodeVariant(-1), EncodingError);
  assert.throws(() => enc.encodeVariant(1.5), EncodingError);
  assert.throws(() => enc.encodeVariant('11'), EncodingError);
  assert.throws(() => enc.encodeVariant(null), EncodingError);
  assert.equal(enc.readVariant(Buffer.from('0b000000ff', 'hex')), 11);
  assert.equal(enc.readVariant(Buffer.from('3d000000', 'hex')), 61);
  assert.equal(enc.readVariant(new Uint8Array([36, 0, 0, 0])), 36);
  // readVariant only reads; it does not range-check (assertInstructionSubmittable does).
  assert.equal(enc.readVariant(Buffer.from('ffffffff', 'hex')), 4294967295);
  assert.throws(() => enc.readVariant(Buffer.alloc(3)), EncodingError);
  assert.throws(() => enc.readVariant(Buffer.alloc(0)), EncodingError);
  assert.throws(() => enc.readVariant('0b000000'), TypeError);
  assert.throws(() => enc.readVariant([11, 0, 0, 0]), TypeError);
});

test('concat: joins parts into one Buffer', () => {
  const out = enc.concat([enc.encodeVariant(11), enc.encodeString('a'), enc.encodeU64(1)]);
  assert.ok(Buffer.isBuffer(out));
  assert.equal(hex(out), '0b000000' + '010000000000000061' + '0100000000000000');
  assert.equal(hex(enc.concat([])), '');
});

// ---------------------------------------------------------------------------
// Exact unit conversion (XRS has 9 decimals: token.rs:901, bin/wallet.rs:113)
// ---------------------------------------------------------------------------

test('xrsToLamports: exact decimal parsing, no float rounding', () => {
  assert.equal(enc.xrsToLamports(0.29), 290000000n);
  assert.equal(enc.xrsToLamports('0.29'), 290000000n);
  assert.equal(enc.xrsToLamports('1234567.123456789'), 1234567123456789n);
  assert.equal(enc.xrsToLamports(5), 5000000000n);
  assert.equal(enc.xrsToLamports('5'), 5000000000n);
  assert.equal(enc.xrsToLamports(0), 0n);
  assert.equal(enc.xrsToLamports('0'), 0n);
  assert.equal(enc.xrsToLamports('0.000000001'), 1n);
  assert.equal(enc.xrsToLamports('1.1'), 1100000000n);
  assert.equal(enc.xrsToLamports(' 0.29 '), 290000000n);
  assert.equal(enc.xrsToLamports('007.5'), 7500000000n);
  assert.equal(enc.xrsToLamports('18446744073.709551615'), 2n ** 64n - 1n);
  assert.equal(typeof enc.xrsToLamports(1), 'bigint');
});

test('xrsToLamports: rejects what cannot be represented exactly', () => {
  assert.throws(() => enc.xrsToLamports('0.0000000001'), RangeError);   // 10 fractional digits
  assert.throws(() => enc.xrsToLamports(1e-7), RangeError);             // String(1e-7) === '1e-7'
  assert.throws(() => enc.xrsToLamports(1e21), RangeError);             // '1e+21'
  // Float artefacts are refused, never rounded: String(0.1 + 0.2) === '0.30000000000000004'.
  assert.throws(() => enc.xrsToLamports(0.1 + 0.2), RangeError);
  assert.throws(() => enc.xrsToLamports(-1), RangeError);
  assert.throws(() => enc.xrsToLamports('-1'), RangeError);
  assert.throws(() => enc.xrsToLamports(NaN), RangeError);
  assert.throws(() => enc.xrsToLamports(Infinity), RangeError);
  assert.throws(() => enc.xrsToLamports(''), RangeError);
  assert.throws(() => enc.xrsToLamports('.5'), RangeError);
  assert.throws(() => enc.xrsToLamports('5.'), RangeError);
  assert.throws(() => enc.xrsToLamports('1,000'), RangeError);
  assert.throws(() => enc.xrsToLamports('0x10'), RangeError);
  assert.throws(() => enc.xrsToLamports('1 XRS'), RangeError);
  assert.throws(() => enc.xrsToLamports('18446744073.709551616'), RangeError); // 2^64
  assert.throws(() => enc.xrsToLamports(1n), TypeError);
  assert.throws(() => enc.xrsToLamports(null), TypeError);
  assert.throws(() => enc.xrsToLamports(undefined), TypeError);
  assert.throws(() => enc.xrsToLamports(true), TypeError);
  assert.throws(() => enc.xrsToLamports(1e-7), (err) => {
    assert.ok(/at most 9 fractional digits/.test(err.message), err.message);
    assert.ok(/1e-7/.test(err.message), err.message);
    return true;
  });
});

test('lamportsToXrs: exact decimal string, trailing zeros trimmed', () => {
  assert.equal(enc.lamportsToXrs(290000000), '0.29');
  assert.equal(enc.lamportsToXrs(290000000n), '0.29');
  assert.equal(enc.lamportsToXrs(5000000000), '5');
  assert.equal(enc.lamportsToXrs(1234567123456789n), '1234567.123456789');
  assert.equal(enc.lamportsToXrs(0), '0');
  assert.equal(enc.lamportsToXrs(1), '0.000000001');
  assert.equal(enc.lamportsToXrs(1000000), '0.001');          // BASE_TX_FEE
  assert.equal(enc.lamportsToXrs(10000000), '0.01');          // ATTESTATION_REWARD
  assert.equal(enc.lamportsToXrs(2n ** 64n - 1n), '18446744073.709551615');
  assert.equal(typeof enc.lamportsToXrs(1), 'string');
  assert.throws(() => enc.lamportsToXrs(-1), RangeError);
  assert.throws(() => enc.lamportsToXrs(1.5), RangeError);
  assert.throws(() => enc.lamportsToXrs(2n ** 64n), RangeError);
  assert.throws(() => enc.lamportsToXrs(2 ** 53), RangeError);
  assert.throws(() => enc.lamportsToXrs('5'), TypeError);
});

test('toBaseUnits / fromBaseUnits: generalisation over decimals 0..=38', () => {
  assert.equal(enc.toBaseUnits('1.5', 6), 1500000n);
  assert.equal(enc.toBaseUnits(1.5, 6), 1500000n);
  assert.equal(enc.toBaseUnits('1', 0), 1n);
  assert.equal(enc.toBaseUnits('0.000001', 6), 1n);
  // decimals up to 38 are accepted, but the result is still a u64 amount.
  assert.equal(enc.toBaseUnits('0.' + '0'.repeat(37) + '1', 38), 1n);
  assert.equal(enc.toBaseUnits('0.' + '0'.repeat(37) + '1', 38), 1n);
  assert.throws(() => enc.toBaseUnits('1', 38), RangeError);        // 10^38 > 2^64-1
  assert.equal(enc.fromBaseUnits(1500000n, 6), '1.5');
  assert.equal(enc.fromBaseUnits(1500000, 6), '1.5');
  assert.equal(enc.fromBaseUnits(123, 0), '123');
  assert.equal(enc.fromBaseUnits(1n, 6), '0.000001');
  assert.equal(enc.fromBaseUnits(0, 6), '0');
  for (const x of ['0.29', '1234567.123456789', '5', 0.29, 5]) {
    assert.equal(enc.toBaseUnits(x, 9), enc.xrsToLamports(x));
  }
  assert.throws(() => enc.toBaseUnits('1.5', 0), RangeError);      // too many fractional digits
  assert.throws(() => enc.toBaseUnits('1.1234567', 6), RangeError);
  assert.throws(() => enc.toBaseUnits('1', 39), RangeError);
  assert.throws(() => enc.toBaseUnits('1', -1), RangeError);
  assert.throws(() => enc.toBaseUnits('1', 1.5), RangeError);
  assert.throws(() => enc.toBaseUnits('1', '6'), TypeError);
  assert.throws(() => enc.toBaseUnits(1n, 6), TypeError);
  assert.throws(() => enc.fromBaseUnits(-1, 6), RangeError);
  assert.throws(() => enc.fromBaseUnits('1', 6), TypeError);
});

// ---------------------------------------------------------------------------
// 4.x aliases
// ---------------------------------------------------------------------------

test('encodeBincode* aliases are the same function objects', () => {
  assert.equal(enc.encodeBincodeString, enc.encodeString);
  assert.equal(enc.encodeBincodeVec, enc.encodeBytes);
  assert.equal(enc.encodeBincodeStringVec, enc.encodeStringVec);
});

test('encoding.js exports exactly the names in the cross-module contract', () => {
  const expected = [
    'normalizeU64', 'normalizeU32', 'normalizeU8', 'assertString', 'toBytes',
    'encodeU8', 'encodeU32', 'encodeU64', 'encodeBool', 'encodeString', 'encodeBytes',
    'encodeFixedBytes', 'encodeStringVec', 'encodeOption', 'encodeVariant', 'readVariant',
    'concat', 'xrsToLamports', 'lamportsToXrs', 'toBaseUnits', 'fromBaseUnits',
    'encodeBincodeString', 'encodeBincodeVec', 'encodeBincodeStringVec',
    'stringifyJson', 'parseJson', 'isPlainJsonObject', 'assertJsonObjectText',
  ];
  for (const name of expected) {
    assert.equal(typeof enc[name], 'function', `encoding.${name} should be a function`);
  }
  assert.deepEqual(Object.keys(enc).sort(), expected.slice().sort());
});

// ---------------------------------------------------------------------------
// src/constants.js — every value verbatim (blueprint §5; citations in the
// node source were re-checked while writing this file)
// ---------------------------------------------------------------------------

test('constants: units, fees, ports, chain ids, slot timing', () => {
  assert.equal(C.VERSION, '5.0.0');
  assert.equal(C.XRS_DECIMALS, 9);                      // token.rs:901
  assert.equal(C.LAMPORTS_PER_XRS, 1_000_000_000);
  assert.equal(C.BASE_TX_FEE, 1_000_000);               // ledger.rs:58
  assert.equal(C.BASE_TX_FEE_XRS, 0.001);
  assert.equal(C.DEFAULT_RPC_PORT, 56001);              // main.rs:831
  assert.equal(C.DEFAULT_EXPLORER_PORT, 50008);         // main.rs:832
  assert.equal(C.DEFAULT_P2P_PORT, 4000);               // main.rs:830
  assert.equal(C.TESTNET_SEED, '138.197.116.81');       // network.rs:298
  assert.equal(C.MAINNET_HOST_ENV, 'XERIS_MAINNET_HOST');
  assert.equal(C.CHAIN_ID_TESTNET, 'xeris-testnet-v1'); // ledger.rs:287
  assert.equal(C.CHAIN_ID_MAINNET, 'xeris-mainnet-v1'); // ledger.rs:286
  assert.equal(C.SLOT_MS, 4000);                        // main.rs:33
  assert.equal(C.BLOCKHASH_EXPIRY_WINDOW, 150);         // ledger.rs:239
});

test('constants: transaction and instruction limits', () => {
  assert.equal(C.MAX_IX_DATA_SIZE, 8192);               // ledger.rs:93
  assert.equal(C.MAX_SLASH_IX_DATA_SIZE, 65535);        // ledger.rs:119
  assert.equal(C.MAX_IX_PER_TX, 16);                    // ledger.rs:94
  assert.equal(C.MAX_ACCOUNTS_PER_TX, 64);              // ledger.rs:95
  assert.equal(C.MAX_TX_BYTES, 131072);                 // tx_pool.rs:183
  assert.equal(C.WRITE_BODY_LIMIT_BYTES, 262144);       // network.rs:4664
  assert.deepEqual(C.WRITE_RPC_LIMIT, { max: 30, windowSec: 60 }); // network.rs:4308
  assert.equal(C.MAX_RECENT_BLOCKS, 1000);              // ledger.rs:36
  assert.equal(C.INSTRUCTION_COUNT, 62);
  assert.deepEqual(C.DISABLED_VARIANTS, [22, 48, 49, 52]);
  for (const v of C.DISABLED_VARIANTS) assert.ok(v >= 0 && v <= 61);
});

test('constants: staking, attestation and emission', () => {
  assert.equal(C.MIN_STAKE_LAMPORTS, 1_000_000_000_000);         // ledger.rs:232
  assert.equal(C.MIN_ATTESTOR_STAKE_LAMPORTS, 100_000_000_000);  // ledger.rs:1285
  assert.equal(C.MIN_UNSTAKE_LAMPORTS, 1_000_000_000);           // ledger.rs:210
  assert.equal(C.UNBONDING_PERIOD_SLOTS, 151_200);               // ledger.rs:201
  assert.equal(C.ATTESTATION_REWARD_LAMPORTS, 10_000_000);       // ledger.rs:214
  assert.equal(C.ATTESTATION_SLOT_WINDOW, 200);                  // ledger.rs:218
  assert.equal(C.STAKING_REWARD_INTERVAL_BLOCKS, 900);           // ledger.rs:5138
  assert.equal(C.STAKING_APY_PCT, 7);                            // ledger.rs:5144-5145
  assert.equal(C.BASE_BLOCK_REWARD_LAMPORTS, 10_000_000_000);    // ledger.rs:70
  assert.equal(C.HALVING_INTERVAL_BLOCKS, 25_000_000);           // ledger.rs:75
  assert.equal(typeof C.MAX_EMISSION_SUPPLY_LAMPORTS, 'bigint');
  assert.equal(C.MAX_EMISSION_SUPPLY_LAMPORTS, 500_000_000_000_000_000n); // ledger.rs:65
  assert.ok(C.MAX_EMISSION_SUPPLY_LAMPORTS > BigInt(Number.MAX_SAFE_INTEGER));
});

test('constants: post-quantum, channels, groth16', () => {
  assert.equal(C.SUPPORTED_PQ_ALGORITHM, 'dilithium3');  // crypto.rs:924
  assert.equal(C.PQ_PUBLIC_KEY_LEN, 1952);               // crypto.rs:1162-1186
  assert.equal(C.PQ_SECRET_KEY_LEN, 4032);
  assert.equal(C.PQ_SIGNATURE_LEN, 3309);
  assert.equal(C.PQ_SECURITY_LEVEL, 3);                  // contracts.rs:6199-6209
  assert.deepEqual(C.PQ_CLAIM_TOKENS, ['pq', 'post-quantum', 'post_quantum', 'postquantum', 'post quantum', 'dilithium', 'mldsa', 'ml-dsa', 'ml_dsa']); // ledger.rs:5367-5372
  assert.equal(C.PQ_ROTATE_TAG, 'xrs_pq_rotate_v5');     // crypto.rs:864
  assert.equal(C.CHANNEL_STATE_TAG, 'XRS_CH_STATE_V3');  // contracts.rs:69
  assert.equal(C.CHANNEL_CLOSE_TAG, 'XRS_CLOSE_CH_V4');  // contracts.rs:98
  assert.equal(C.CHANNEL_CHALLENGE_PERIOD_SLOTS, 1000);  // ledger.rs:8308
  assert.equal(C.MAX_GROTH16_PROOF_BYTES, 512);          // crypto.rs:1041
  assert.equal(C.MAX_GROTH16_VK_BYTES, 16384);           // crypto.rs:1042
  assert.equal(C.MAX_GROTH16_PUBLIC_INPUTS, 64);         // crypto.rs:1043
});

test('constants: agent delegation', () => {
  assert.deepEqual(C.AGENT_OPERATIONS, ['NativeTransfer', 'TokenTransfer', 'ContractCall', 'WrapXrs', 'UnwrapXrs', 'Stake', 'Unstake', 'TokenMint', 'TokenBurn']); // ledger.rs:6425-6477
  assert.equal(C.AGENT_OPERATIONS.length, 9);
  assert.deepEqual(C.AGENT_INNER_VARIANTS, [11, 1, 4, 13, 14, 9, 10, 0, 2]);
  assert.deepEqual(C.DELEGATED_CALL_METHODS, ['buy_tokens', 'sell_tokens', 'swap', 'add_liquidity', 'remove_liquidity', 'create_dca_order', 'distribute', 'post', 'open', 'create', 'place_order', 'cancel', 'reclaim', 'claim_rewards', 'redeem', 'amend', 'list', 'status', 'get_stats', 'get_key']); // ledger.rs:2141-2171
  assert.ok(!C.DELEGATED_CALL_METHODS.includes('confirm'));   // ledger.rs:2165 fails closed
  assert.ok(!C.DELEGATED_CALL_METHODS.includes('verify'));
  assert.ok(!C.DELEGATED_CALL_METHODS.includes('swap_a_to_b'));
  assert.equal(C.AGENT_DAILY_WINDOW_SLOTS, 21_600);           // contracts.rs:3439
  assert.equal(C.MAX_AGENTS_PER_REGISTRY, 50);                // contracts.rs:3334
});

test('constants: enumerations checked by the node', () => {
  assert.deepEqual(C.IDENTITY_TYPES, ['agent', 'device', 'service', 'human']);                                   // ledger.rs:6696
  assert.deepEqual(C.REPUTATION_CATEGORIES, ['reliability', 'accuracy', 'speed', 'honesty', 'safety', 'general']); // ledger.rs:6820
  assert.deepEqual(C.MESSAGE_TYPES, ['proposal', 'counteroffer', 'accept', 'reject', 'info', 'request']);          // ledger.rs:6846
  assert.deepEqual(C.CONDITION_TYPES, ['price_above', 'price_below', 'balance_above', 'balance_below', 'slot_reached', 'oracle_value']); // ledger.rs:6918
  assert.deepEqual(C.FEED_TYPES, ['price', 'event', 'sensor', 'weather', 'custom']);                             // ledger.rs:7164
  assert.deepEqual(C.DEVICE_TYPES, ['humanoid', 'terminal', 'iot', 'mobile', 'secure_element']);                 // ledger.rs:7232
  assert.deepEqual(C.TASK_VERIFICATION_MODES, ['poster_confirm', 'oracle']);                                     // contracts.rs:4776-4783 ('automatic' removed, XWC-74)
  assert.deepEqual(C.TASK_RESOLUTIONS, ['complete', 'verify', 'reject', 'cancel']);                              // ledger.rs:7603-7607
  assert.deepEqual(C.DISPUTE_ACTIONS, ['evidence', 'defendant_evidence', 'vote_disputer', 'vote_defendant', 'vote_dismiss', 'expire']); // ledger.rs:7739-7749
  assert.deepEqual(C.VOTES, ['yes', 'no', 'abstain']);                                                           // contracts.rs:5585-5587
  assert.deepEqual(C.RWA_ASSET_TYPES, ['real_estate', 'equity', 'debt', 'commodity', 'ip', 'collectible', 'fund', 'bond']); // token.rs:1217
  assert.deepEqual(C.RWA_STATUSES, ['active', 'frozen', 'redeemed', 'disputed', 'revoked']);                     // token.rs:1272
  assert.deepEqual(C.TX_STATUSES, ['confirmed', 'failed', 'partial', 'included']);                               // tx_store.rs:116-120; explorer.rs:680-690
});

test('constants: contract types, ids and protocol registries', () => {
  // contracts.rs:385-411 (ContractType::from_str), lower-cased aliases.
  const expectedAliases = {
    timelock: 'TimeLock', time_lock: 'TimeLock',
    escrow: 'Escrow',
    swap: 'Swap',
    vesting: 'Vesting',
    multisig: 'MultiSig', multi_sig: 'MultiSig',
    rwa: 'RealWorldAsset', real_world_asset: 'RealWorldAsset', realworldasset: 'RealWorldAsset',
    launchpad: 'Launchpad', launch_pad: 'Launchpad',
    agent_registry: 'AgentRegistry', agent: 'AgentRegistry', agents: 'AgentRegistry',
    identity: 'IdentityRegistry', identity_registry: 'IdentityRegistry',
    conditional: 'ConditionalOrderBook', conditional_orders: 'ConditionalOrderBook', orders: 'ConditionalOrderBook',
    limit: 'LimitOrder', limit_order: 'LimitOrder', limit_orders: 'LimitOrder',
    dca: 'DcaOrder', dca_order: 'DcaOrder', dollar_cost_averaging: 'DcaOrder',
    oracle: 'OracleRegistry', oracle_registry: 'OracleRegistry', oracles: 'OracleRegistry',
    device: 'DeviceRegistry', device_registry: 'DeviceRegistry', hardware: 'DeviceRegistry',
    capability: 'CapabilityRegistry', capabilities: 'CapabilityRegistry', cap_registry: 'CapabilityRegistry',
    task: 'TaskBoard', tasks: 'TaskBoard', task_board: 'TaskBoard', bounty: 'TaskBoard',
    model: 'ModelRegistry', model_registry: 'ModelRegistry', models: 'ModelRegistry',
    dispute: 'DisputeRegistry', disputes: 'DisputeRegistry', arbitration: 'DisputeRegistry',
    governance: 'Governance', gov: 'Governance', dao: 'Governance',
    channel: 'StateChannelRegistry', channels: 'StateChannelRegistry', state_channel: 'StateChannelRegistry',
    zk: 'ZkVerifierRegistry', zk_verifier: 'ZkVerifierRegistry', zero_knowledge: 'ZkVerifierRegistry',
    pq: 'PqKeyRegistry', pq_keys: 'PqKeyRegistry', post_quantum: 'PqKeyRegistry', quantum: 'PqKeyRegistry',
    deal: 'DealRegistry', deals: 'DealRegistry', escrow_deal: 'DealRegistry',
  };
  assert.deepEqual({ ...C.CONTRACT_TYPE_ALIASES }, expectedAliases);
  // blueprint §5 said 24 enum names; contracts.rs:385-411 maps aliases onto 23.
  assert.equal(new Set(Object.values(C.CONTRACT_TYPE_ALIASES)).size, 23);
  assert.equal(Object.keys(C.CONTRACT_TYPE_ALIASES).length, 61);
  assert.deepEqual(C.PROTOCOL_MANAGED_CONTRACT_TYPES, ['DeviceRegistry', 'ZkVerifierRegistry', 'PqKeyRegistry', 'ConditionalOrderBook', 'DisputeRegistry', 'DealRegistry', 'TaskBoard', 'StateChannelRegistry']); // ledger.rs:2344-2349
  assert.deepEqual(C.RESERVED_CONTRACT_ID_PREFIXES, ['xeris_', 'identity_', 'agent_registry_', '__']); // ledger.rs:1524-1530
  assert.deepEqual(C.RESERVED_CONTRACT_ID_SUFFIXES, ['_xrs_pool']);
  assert.ok(C.CONTRACT_ID_PATTERN instanceof RegExp);
  assert.equal(C.CONTRACT_ID_PATTERN.source, '^[A-Za-z0-9_-]{1,128}$');    // contracts.rs:1316-1320
  assert.ok(C.CONTRACT_ID_PATTERN.test('pool_xusdc-xrs'));
  assert.ok(!C.CONTRACT_ID_PATTERN.test(''));
  assert.ok(!C.CONTRACT_ID_PATTERN.test('a'.repeat(129)));
  assert.ok(!C.CONTRACT_ID_PATTERN.test('bad id'));
  assert.deepEqual({ ...C.PROTOCOL_CONTRACT_IDS }, {
    oracles: 'xeris_oracles', devices: 'xeris_devices', capabilities: 'xeris_capabilities',
    tasks: 'xeris_tasks', models: 'xeris_models', disputes: 'xeris_disputes', deals: 'xeris_deals',
    governance: 'xeris_governance', channels: 'xeris_channels', zkVerifier: 'xeris_zk_verifier',
    pqKeys: 'xeris_pq_keys', heartbeats: 'xeris_heartbeats',
  });
});

test('constants: contract-level amounts, windows and limits', () => {
  assert.equal(C.MIN_DEAL_DISPUTE_BOND, 1_000_000_000);         // contracts.rs:1008
  assert.equal(C.DEAL_TIMEOUT_SLOTS, 648_000);                  // contracts.rs:1079
  assert.equal(C.DISPUTE_CHALLENGE_PERIOD_SLOTS, 21_600);       // contracts.rs:995
  assert.equal(C.DISPUTE_MAX_LIFETIME_SLOTS, 648_000);          // contracts.rs:1000
  assert.equal(C.MAX_TASK_LIFETIME_SLOTS, 648_000);             // contracts.rs:916
  assert.equal(C.ORDER_STORAGE_BOND, 10_000_000);               // ledger.rs:1290
  assert.equal(C.MAX_ORDER_LIFETIME_SLOTS, 650_000);            // ledger.rs:1295
  assert.equal(C.MAX_CONDITIONAL_INNER_BYTES, 2048);            // ledger.rs:6942
  assert.equal(C.MIN_ORACLE_STAKE_LAMPORTS, 1_000_000_000);     // ledger.rs:7170
  assert.equal(C.MIN_VOTING_PERIOD_SLOTS, 21_600);              // ledger.rs:8267
  assert.equal(C.MAX_VOTING_PERIOD_SLOTS, 1_296_000);           // contracts.rs:5528
  assert.equal(C.DEFAULT_PROPOSAL_QUORUM, 5_000_000_000_000);   // contracts.rs:163
  assert.equal(C.MIN_PROPOSAL_STAKE_LAMPORTS, 100_000_000_000); // contracts.rs:1826-1827
  assert.equal(C.LAUNCHPAD_XERIS_FEE_BPS, 77);                  // contracts.rs:308
  assert.equal(C.REGISTRY_PAGE_ITEMS, 32);                      // explorer.rs:126
  assert.equal(C.ACCOUNT_HISTORY_MAX_PAGE_SIZE, 200);           // tx_store.rs:57
  assert.equal(C.ACCOUNT_HISTORY_MAX_PAGE, 50);                 // explorer.rs:1305
  assert.equal(C.LIST_MAX_PAGE_SIZE, 100);                      // explorer.rs:1020
  assert.equal(C.SIGNATURES_MAX_LIMIT, 200);                    // tx_store.rs:57, 351
  assert.equal(C.PRICE_HISTORY_MAX_LIMIT, 10080);               // network.rs:6033
  assert.deepEqual({ ...C.STRING_LIMITS }, {
    identityDisplayName: 128, identityMetadata: 4096, reputationEvidence: 512, messagePayload: 8192,
    oracleDescription: 512, oracleMetadata: 1024, taskTitle: 256, taskDescription: 4096,
    taskRejectReason: 512, channelId: 128, channelType: 64,
  });
});

test('constants: every object and array export is frozen', () => {
  for (const [name, value] of Object.entries(C)) {
    if (value !== null && typeof value === 'object' && !(value instanceof RegExp)) {
      assert.ok(Object.isFrozen(value), `${name} should be frozen`);
    }
  }
  assert.throws(() => { C.AGENT_OPERATIONS.push('x'); }, TypeError);
});

// ---------------------------------------------------------------------------
// Exact XRS numbers and the strict JSON writer / lossless reader (review fixes)
// ---------------------------------------------------------------------------

test('xrsToLamports / toBaseUnits refuse numbers that are not the decimal the caller wrote', () => {
  const digits = /more than 15 significant digits/;
  assert.throws(() => enc.xrsToLamports(9999999.999999999), (e) => e instanceof RangeError && digits.test(e.message));
  assert.throws(() => enc.xrsToLamports(12345678.123456789), RangeError);
  assert.throws(() => enc.toBaseUnits(1.123456789123456789, 18), RangeError);
  assert.throws(() => enc.toBaseUnits(123456789012345678, 0), (e) => e instanceof RangeError && /2\^53-1/.test(e.message));
  assert.equal(enc.xrsToLamports('9999999.999999999'), 9999999999999999n);
  assert.equal(enc.xrsToLamports(0.29), 290000000n);
  assert.equal(enc.xrsToLamports(123456.789012345), 123456789012345n);
  assert.equal(enc.toBaseUnits(9007199254740991, 0), 9007199254740991n);
  assert.equal(enc.toBaseUnits(1e15, 0), 1000000000000000n);
  assert.equal(enc.toBaseUnits(0.000001234, 9), 1234n);
});

test('stringifyJson equals JSON.stringify for plain values and writes bigint exactly', () => {
  for (const v of [null, true, 0, -0, 1.5, 1e-7, 'é💰"\\\n', [], {}, [1, 'a', [null]], { a: { b: [1, 2] }, c: 'x' }]) {
    assert.equal(enc.stringifyJson(v), JSON.stringify(v));
  }
  assert.equal(enc.stringifyJson({ a: 18446744073709551615n, b: -9223372036854775808n, c: 5n }), '{"a":18446744073709551615,"b":-9223372036854775808,"c":5}');
  assert.equal(enc.stringifyJson(Object.assign(Object.create(null), { k: 1 })), '{"k":1}');
});

test('stringifyJson refuses what JSON.stringify would drop, null or round', () => {
  const cyc = {};
  cyc.self = cyc;
  let deep = 0;
  for (let i = 0; i < 128; i += 1) deep = [deep];
  class Box { constructor() { this.a = 1; } }
  for (const [v, E, field] of [
    [{ a: NaN }, RangeError, 'args.a'],
    [{ a: -Infinity }, RangeError, 'args.a'],
    [{ a: undefined }, TypeError, 'args.a'],
    [{ a: [1, undefined] }, TypeError, 'args.a[1]'],
    [{ a: () => 1 }, TypeError, 'args.a'],
    [{ a: Symbol('s') }, TypeError, 'args.a'],
    [{ a: 9007199254740992 }, RangeError, 'args.a'],
    [{ a: 1e21 }, RangeError, 'args.a'],
    [{ a: 18446744073709551616n }, RangeError, 'args.a'],
    [{ a: -9223372036854775809n }, RangeError, 'args.a'],
    [{ a: 'x\uD800' }, RangeError, 'args.a'],
    [{ a: Buffer.from('ab') }, TypeError, 'args.a'],
    [{ a: new Date(0) }, TypeError, 'args.a'],
    [{ a: new Map() }, TypeError, 'args.a'],
    [new Box(), TypeError, 'args'],
    [[, 1], TypeError, 'args[0]'], // eslint-disable-line no-sparse-arrays
    [{ [Symbol('k')]: 1 }, TypeError, 'args'],
    [cyc, TypeError, 'args.self'],
    [deep, RangeError, undefined],
  ]) {
    assert.throws(() => enc.stringifyJson(v, 'args'), (e) => e instanceof E && (field === undefined || e.field === field), `${field}`);
  }
  assert.throws(() => enc.stringifyJson({ '\uDC00': 1 }, 'args'), RangeError);
});

test('parseJson matches JSON.parse except for big integers, out-of-range floats and lone surrogates', () => {
  for (const t of ['null', ' true ', '0', '-0', '1.5e3', '"a\\u00e9\\ud83d\\udcb0\\n\\/"', '[1,[2,{"a":null}]]', '{"a":1,"a":2}', '{"__proto__":{"x":1}}']) {
    assert.deepEqual(enc.parseJson(t), JSON.parse(t), t);
  }
  assert.equal(Object.getPrototypeOf(enc.parseJson('{"__proto__":{"x":1}}')), Object.prototype);
  assert.deepEqual(enc.parseJson('{"b":123456789012345678,"s":9007199254740991,"n":-9007199254740992}'), { b: 123456789012345678n, s: 9007199254740991, n: -9007199254740992n });
  assert.equal(enc.parseJson('184467440737095516150'), 184467440737095516150n);
  for (const bad of ['', '{', '[1,]', '{"a":1,}', '01', '1.', '.5', '+1', '"\\x"', 'NaN', '"\t"', '{} x', "'a'", '﻿{}']) {
    assert.throws(() => enc.parseJson(bad), (e) => e instanceof SyntaxError && e.code === 'syntax', JSON.stringify(bad));
  }
  for (const bad of ['"\\ud800"', '{"\\udc00":1}', '"\\ud800\\u0041"', '1e400', '-1e400']) {
    assert.throws(() => enc.parseJson(bad), RangeError, bad);
  }
  // forNode: the node's serde_json reading rules.
  assert.throws(() => enc.parseJson('{"a":18446744073709551616}', 'args', { forNode: true }), RangeError);
  assert.throws(() => enc.parseJson('{"a":-9223372036854775809}', 'args', { forNode: true }), RangeError);
  assert.equal(enc.parseJson('18446744073709551615', 'args', { forNode: true }), 18446744073709551615n);
  assert.throws(() => enc.parseJson(`${'['.repeat(128)}${']'.repeat(128)}`, 'args', { forNode: true }), RangeError);
  assert.doesNotThrow(() => enc.parseJson(`${'['.repeat(127)}${']'.repeat(127)}`, 'args', { forNode: true }));
  assert.doesNotThrow(() => enc.parseJson(`${'['.repeat(500)}${']'.repeat(500)}`));
  // Options: only a boolean `forNode`, in an object.
  assert.throws(() => enc.parseJson('{}', 'x', { fornode: true }), (e) => e instanceof RangeError && /x: opts\.fornode: unknown option \(allowed: forNode\)/.test(e.message));
  assert.throws(() => enc.parseJson('{"a":18446744073709551616}', 'x', { forNode: 'yes' }), TypeError);
  assert.throws(() => enc.parseJson('{}', 'x', []), TypeError);
  assert.throws(() => enc.parseJson('{}', 'x', null), TypeError);
  assert.deepEqual(enc.parseJson('{}', 'x', { forNode: false }), {});
  assert.deepEqual(enc.parseJson('{}', 'x', {}), {});
});

test('stringifyJson and parseJson round-trip random values like the native JSON functions', () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const strs = ['', 'a', 'é', '💰', '"', '\\', '\n', '\u0001', '/', ' ', 'x'.repeat(40)];
  const val = (d) => {
    const r = rnd(d > 3 ? 5 : 7);
    if (r === 0) return null;
    if (r === 1) return rnd(2) === 0;
    if (r === 2) return [0, 1, -1, 1.5, 1e-7, 123456789012345, -9007199254740991, 0.1, 3.14e10][rnd(9)];
    if (r === 3) return strs[rnd(strs.length)];
    if (r === 4) return rnd(100000);
    if (r === 5) return Array.from({ length: rnd(4) }, () => val(d + 1));
    const o = {};
    for (let i = rnd(4); i > 0; i -= 1) o[strs[rnd(strs.length)] + i] = val(d + 1);
    return o;
  };
  for (let i = 0; i < 2000; i += 1) {
    const v = val(0);
    const text = JSON.stringify(v);
    assert.equal(enc.stringifyJson(v), text);
    assert.deepEqual(enc.parseJson(text), JSON.parse(text));
    assert.deepEqual(enc.parseJson(JSON.stringify(v, null, 2)), JSON.parse(text));
  }
});
