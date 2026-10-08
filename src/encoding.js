'use strict';

/**
 * bincode 1.x primitives for the `XerisInstruction` wire format and exact
 * decimal unit conversion.
 *
 * The node embeds `XerisInstruction` in `instruction.data` with
 * `bincode::serialize` / `bincode::deserialize` (`token.rs:29` derives
 * `Serialize, Deserialize`; ingress decode at `network.rs:187-192`). bincode
 * 1.3.x's legacy entry points are fixed to fixint little-endian encoding
 * (`DefaultOptions::new().with_fixint_encoding().allow_trailing_bytes()`):
 *
 *   enum discriminant   u32 LE (variant index in declaration order)
 *   u8 / u32 / u64      1 / 4 / 8 bytes LE
 *   bool                1 byte, 0x00 or 0x01
 *   String              u64 LE byte length, then UTF-8 bytes
 *   Vec<u8>             u64 LE length, then bytes
 *   Vec<String>         u64 LE count, then each String
 *   Option<T>           0x00 = None; 0x01 then T = Some
 *   [u8; N]             N bytes, no length prefix
 *
 * Reference encoder and arbiter: `scratchpad/tools/xeris_bincode.py` with
 * `vectors.json` (91 vectors verified against the bincode 1.3.3 crate).
 *
 * Validation rules (blueprint §2, §6): a wrong JavaScript type throws a native
 * `TypeError`; a right-typed value outside the field's domain throws a native
 * `RangeError`. Both carry `.field` (the field name used in the message) and
 * `.code` (`'type'` / `'range'`). Nothing is clamped, rounded or defaulted.
 * Structural failures (`encodeVariant`, `readVariant`) throw `EncodingError`.
 * Every function takes an optional trailing `field` string used only in
 * messages. Every encoder returns a `Buffer`.
 *
 * @module xeris-sdk/encoding
 */

const { EncodingError } = require('./errors');
const { INSTRUCTION_COUNT, XRS_DECIMALS } = require('./constants');

/** Largest value of a Rust `u64`. */
const U64_MAX = 18446744073709551615n;
/** Largest value of a Rust `u32`. */
const U32_MAX = 4294967295n;
/** Largest value of a Rust `u8`. */
const U8_MAX = 255n;
/** `Number.MAX_SAFE_INTEGER` as a BigInt. */
const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);
/** Largest `decimals` accepted by `toBaseUnits` / `fromBaseUnits` (10^38 < 2^128). */
const MAX_DECIMALS = 38;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalises the `field` argument used in messages.
 * @param {unknown} field
 * @param {string} fallback
 * @returns {string}
 */
function fieldName(field, fallback) {
  return typeof field === 'string' && field.length > 0 ? field : fallback;
}

/**
 * Short, safe rendering of a caller value for an error message.
 * @param {unknown} v
 * @returns {string}
 */
function describe(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  const t = typeof v;
  if (t === 'bigint') return `${v}n`;
  if (t === 'number') return Object.is(v, -0) ? '-0' : String(v);
  if (t === 'boolean') return `${v} (boolean)`;
  if (t === 'string') {
    const shown = v.length > 48 ? `${v.slice(0, 45)}...` : v;
    return JSON.stringify(shown);
  }
  if (t === 'symbol') return 'symbol';
  if (t === 'function') return 'function';
  if (Array.isArray(v)) return 'array';
  if (Buffer.isBuffer(v)) return 'Buffer';
  if (ArrayBuffer.isView(v)) return v.constructor && v.constructor.name ? v.constructor.name : 'TypedArray';
  return 'object';
}

/**
 * @param {string} field
 * @param {string} message Message body; the field name is prefixed.
 * @returns {TypeError}
 */
function typeError(field, message) {
  const err = new TypeError(`${field}: ${message}`);
  err.field = field;
  err.code = 'type';
  return err;
}

/**
 * @param {string} field
 * @param {string} message Message body; the field name is prefixed.
 * @returns {RangeError}
 */
function rangeError(field, message) {
  const err = new RangeError(`${field}: ${message}`);
  err.field = field;
  err.code = 'range';
  return err;
}

/**
 * True for a `Buffer` or `Uint8Array` (including cross-realm instances);
 * false for every other typed array, `number[]`, strings and `DataView`.
 * @param {unknown} v
 * @returns {boolean}
 */
function isByteArray(v) {
  if (v instanceof Uint8Array) return true;
  return ArrayBuffer.isView(v) && Object.prototype.toString.call(v) === '[object Uint8Array]';
}

/**
 * Shared unsigned-integer normalisation.
 * @param {unknown} value
 * @param {bigint} max Inclusive upper bound of the Rust type.
 * @param {string} field
 * @returns {bigint}
 */
function normalizeUnsigned(value, max, field) {
  if (typeof value === 'bigint') {
    if (value < 0n) throw rangeError(field, `expected an unsigned integer >= 0, got ${value}n`);
    if (value > max) throw rangeError(field, `expected an unsigned integer <= ${max}, got ${value}n`);
    return value;
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) throw rangeError(field, 'expected an unsigned integer, got NaN');
    if (!Number.isFinite(value)) throw rangeError(field, `expected an unsigned integer, got ${value}`);
    if (!Number.isInteger(value)) throw rangeError(field, `expected an unsigned integer, got ${value}`);
    if (value < 0) throw rangeError(field, `expected an unsigned integer >= 0, got ${value}`);
    if (value > Number.MAX_SAFE_INTEGER) {
      if (max <= MAX_SAFE_BIG) {
        throw rangeError(field, `expected an unsigned integer <= ${max}, got ${value}`);
      }
      throw rangeError(field, 'numbers above 2^53-1 lose precision; pass a BigInt');
    }
    const big = BigInt(value);
    if (big > max) throw rangeError(field, `expected an unsigned integer <= ${max}, got ${value}`);
    return big;
  }
  throw typeError(field, `expected a number or bigint, got ${describe(value)}`);
}

/**
 * Validates a `decimals` argument.
 * @param {unknown} decimals
 * @returns {number}
 */
function normalizeDecimals(decimals) {
  if (typeof decimals !== 'number') throw typeError('decimals', `expected a number, got ${describe(decimals)}`);
  if (!Number.isInteger(decimals)) throw rangeError('decimals', `expected an integer 0..${MAX_DECIMALS}, got ${describe(decimals)}`);
  if (decimals < 0 || decimals > MAX_DECIMALS) throw rangeError('decimals', `expected an integer 0..${MAX_DECIMALS}, got ${decimals}`);
  return decimals;
}

/**
 * Little-endian u64 of a validated BigInt.
 * @param {bigint} big
 * @returns {Buffer}
 */
function u64le(big) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(big, 0);
  return buf;
}

// ---------------------------------------------------------------------------
// Normalisers
// ---------------------------------------------------------------------------

/**
 * Validates a `u64` field value and returns it as a BigInt.
 * @param {number|bigint} value Safe integer `number` or `bigint`, `0..=2^64-1`.
 * @param {string} [field='u64'] Field name for messages.
 * @returns {bigint}
 * @throws {TypeError} For anything other than a `number` or `bigint` (booleans and numeric strings included).
 * @throws {RangeError} For negatives, non-integers, NaN/Infinity, numbers above `Number.MAX_SAFE_INTEGER`
 *   (`"<field>: numbers above 2^53-1 lose precision; pass a BigInt"`) and BigInts above `2^64-1`.
 */
function normalizeU64(value, field = 'u64') {
  return normalizeUnsigned(value, U64_MAX, fieldName(field, 'u64'));
}

/**
 * Validates a `u32` field value and returns it as a number.
 * @param {number|bigint} value Integer `0..=4294967295`.
 * @param {string} [field='u32'] Field name for messages.
 * @returns {number}
 * @throws {TypeError} For anything other than a `number` or `bigint`.
 * @throws {RangeError} For negatives, non-integers and values above `4294967295`.
 */
function normalizeU32(value, field = 'u32') {
  return Number(normalizeUnsigned(value, U32_MAX, fieldName(field, 'u32')));
}

/**
 * Validates a `u8` field value and returns it as a number.
 * @param {number|bigint} value Integer `0..=255`.
 * @param {string} [field='u8'] Field name for messages.
 * @returns {number}
 * @throws {TypeError} For anything other than a `number` or `bigint`.
 * @throws {RangeError} For negatives, non-integers and values above `255`.
 */
function normalizeU8(value, field = 'u8') {
  return Number(normalizeUnsigned(value, U8_MAX, fieldName(field, 'u8')));
}

/**
 * Validates a `String` field value: must be a JavaScript string that is
 * well-formed UTF-16, because a lone surrogate has no UTF-8 encoding and
 * `Buffer.from(s, 'utf8')` would silently substitute U+FFFD.
 * @param {string} value
 * @param {string} [field='string'] Field name for messages.
 * @returns {string} The same string.
 * @throws {TypeError} When `value` is not a string.
 * @throws {RangeError} `"<field>: string contains a lone UTF-16 surrogate and is not valid UTF-8"`.
 */
function assertString(value, field = 'string') {
  const f = fieldName(field, 'string');
  if (typeof value !== 'string') throw typeError(f, `expected a string, got ${describe(value)}`);
  const wellFormed = typeof value.isWellFormed === 'function'
    ? value.isWellFormed()
    // Node 18 has no String.prototype.isWellFormed: a high surrogate not followed
    // by a low surrogate, or a low surrogate not preceded by a high surrogate.
    : !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
  if (!wellFormed) throw rangeError(f, 'string contains a lone UTF-16 surrogate and is not valid UTF-8');
  return value;
}

/**
 * Validates a byte-field value and returns a copy as a `Buffer`.
 * `number[]` and strings are rejected: `Buffer.from([256])` would wrap and a
 * string's encoding would be ambiguous.
 * @param {Buffer|Uint8Array} value
 * @param {string} [field='bytes'] Field name for messages.
 * @returns {Buffer} A new `Buffer` holding a copy of `value`'s bytes (never the caller's object).
 * @throws {TypeError} `"<field>: pass a Buffer or Uint8Array"`.
 */
function toBytes(value, field = 'bytes') {
  const f = fieldName(field, 'bytes');
  if (!isByteArray(value)) throw typeError(f, 'pass a Buffer or Uint8Array');
  return Buffer.from(value);
}

// ---------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------

/**
 * Encodes a `u8` as one byte.
 * @param {number|bigint} value `0..=255`.
 * @param {string} [field='u8']
 * @returns {Buffer} 1 byte.
 * @throws {TypeError|RangeError} See `normalizeU8`.
 */
function encodeU8(value, field = 'u8') {
  return Buffer.from([normalizeU8(value, field)]);
}

/**
 * Encodes a `u32` as 4 little-endian bytes.
 * @param {number|bigint} value `0..=4294967295`.
 * @param {string} [field='u32']
 * @returns {Buffer} 4 bytes.
 * @throws {TypeError|RangeError} See `normalizeU32`.
 */
function encodeU32(value, field = 'u32') {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(normalizeU32(value, field), 0);
  return buf;
}

/**
 * Encodes a `u64` as 8 little-endian bytes.
 * @param {number|bigint} value Safe integer `number` or `bigint`, `0..=2^64-1`.
 * @param {string} [field='u64']
 * @returns {Buffer} 8 bytes.
 * @throws {TypeError|RangeError} See `normalizeU64`.
 */
function encodeU64(value, field = 'u64') {
  return u64le(normalizeU64(value, field));
}

/**
 * Encodes a `bool` as one byte, `0x00` or `0x01`. Only `true`/`false` are
 * accepted (`1` is not `true`).
 * @param {boolean} value
 * @param {string} [field='bool']
 * @returns {Buffer} 1 byte.
 * @throws {TypeError} When `value` is not a boolean.
 */
function encodeBool(value, field = 'bool') {
  const f = fieldName(field, 'bool');
  if (typeof value !== 'boolean') throw typeError(f, `expected a boolean, got ${describe(value)}`);
  return Buffer.from([value ? 1 : 0]);
}

/**
 * Encodes a Rust `String`: `u64le(utf8 byte length) ‖ utf8 bytes`.
 * @param {string} value Well-formed string (see `assertString`).
 * @param {string} [field='string']
 * @returns {Buffer}
 * @throws {TypeError|RangeError} See `assertString`.
 */
function encodeString(value, field = 'string') {
  const bytes = Buffer.from(assertString(value, field), 'utf8');
  return Buffer.concat([u64le(BigInt(bytes.length)), bytes]);
}

/**
 * Encodes a Rust `Vec<u8>`: `u64le(length) ‖ bytes`.
 * @param {Buffer|Uint8Array} value
 * @param {string} [field='bytes']
 * @returns {Buffer}
 * @throws {TypeError} See `toBytes`.
 */
function encodeBytes(value, field = 'bytes') {
  const bytes = toBytes(value, field);
  return Buffer.concat([u64le(BigInt(bytes.length)), bytes]);
}

/**
 * Encodes a Rust `[u8; n]`: the raw bytes with no length prefix
 * (e.g. `AcceptDeal.expected_terms_hash: [u8; 32]`, `token.rs:753-759`).
 * @param {Buffer|Uint8Array} value Exactly `n` bytes.
 * @param {number} n Array length declared in the Rust type.
 * @param {string} [field='bytes']
 * @returns {Buffer} `n` bytes.
 * @throws {TypeError} When `value` is not bytes or `n` is not a number.
 * @throws {RangeError} When `n` is not a non-negative safe integer or `value.length !== n`.
 */
function encodeFixedBytes(value, n, field = 'bytes') {
  const f = fieldName(field, 'bytes');
  if (typeof n !== 'number') throw typeError(f, `fixed array length must be a number, got ${describe(n)}`);
  if (!Number.isSafeInteger(n) || n < 0) throw rangeError(f, `fixed array length must be a non-negative integer, got ${describe(n)}`);
  const bytes = toBytes(value, f);
  if (bytes.length !== n) throw rangeError(f, `expected exactly ${n} bytes, got ${bytes.length}`);
  return bytes;
}

/**
 * Encodes a Rust `Vec<String>`: `u64le(count) ‖ encodeString(each)`.
 * @param {string[]} values
 * @param {string} [field='string[]']
 * @returns {Buffer}
 * @throws {TypeError} When `values` is not an array or an element is not a string.
 * @throws {RangeError} When an element contains a lone surrogate.
 */
function encodeStringVec(values, field = 'string[]') {
  const f = fieldName(field, 'string[]');
  if (!Array.isArray(values)) throw typeError(f, `expected an array of strings, got ${describe(values)}`);
  const parts = [u64le(BigInt(values.length))];
  for (let i = 0; i < values.length; i += 1) {
    parts.push(encodeString(values[i], `${f}[${i}]`));
  }
  return Buffer.concat(parts);
}

/**
 * Encodes a Rust `Option<T>`: `0x00` for `None`, `0x01 ‖ encoder(value, field)`
 * for `Some`. Only `null` and `undefined` are `None`; `0`, `''`, `[]` and
 * `false` are `Some` (`vectors.json` `options-some-empty-vecs`, `u32` `Some(0)`).
 * @template T
 * @param {T|null|undefined} value
 * @param {(value: T, field?: string) => Buffer} encoder Encoder for `T`, e.g. `encodeU64`.
 * @param {string} [field] Field name forwarded to `encoder`; when omitted the encoder's own default applies.
 * @returns {Buffer}
 * @throws {TypeError} When `value` is `Some` and `encoder` is not a function, or whatever `encoder` throws.
 */
function encodeOption(value, encoder, field) {
  if (value === null || value === undefined) return Buffer.from([0]);
  if (typeof encoder !== 'function') {
    throw typeError(fieldName(field, 'option'), `encodeOption needs an encoder function for a Some value, got ${describe(encoder)}`);
  }
  const inner = field === undefined ? encoder(value) : encoder(value, field);
  if (!isByteArray(inner)) {
    throw typeError(fieldName(field, 'option'), `encoder returned ${describe(inner)} instead of bytes`);
  }
  return Buffer.concat([Buffer.from([1]), inner]);
}

/**
 * Encodes the `XerisInstruction` enum discriminant: `u32le(index)`
 * (`token.rs:29-30`, declaration order).
 * @param {number} index Integer `0..INSTRUCTION_COUNT-1`.
 * @returns {Buffer} 4 bytes.
 * @throws {EncodingError} When `index` is not an integer number in range (`.field === 'variant'`).
 */
function encodeVariant(index) {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= INSTRUCTION_COUNT) {
    throw new EncodingError(
      `variant: expected an integer 0..${INSTRUCTION_COUNT - 1}, got ${describe(index)}`,
      { field: 'variant' },
    );
  }
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(index, 0);
  return buf;
}

/**
 * Reads the variant index from the first four bytes of encoded instruction data.
 * Does not range-check the result; `transaction.assertInstructionSubmittable` does.
 * @param {Buffer|Uint8Array} data Encoded `XerisInstruction`.
 * @returns {number} `u32le` at offset 0.
 * @throws {TypeError} When `data` is not a `Buffer`/`Uint8Array`.
 * @throws {EncodingError} When `data.length < 4` (`.field === 'instruction'`).
 */
function readVariant(data) {
  if (!isByteArray(data)) throw typeError('instruction', 'pass a Buffer or Uint8Array');
  if (data.length < 4) {
    throw new EncodingError(`instruction: expected at least 4 bytes of instruction data, got ${data.length}`, { field: 'instruction' });
  }
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
}

/**
 * Concatenates encoded parts.
 * @param {Array<Buffer|Uint8Array>} parts
 * @returns {Buffer}
 * @throws {TypeError} When `parts` is not an array of `Buffer`/`Uint8Array`.
 */
function concat(parts) {
  if (!Array.isArray(parts)) throw typeError('parts', `expected an array of Buffers, got ${describe(parts)}`);
  for (let i = 0; i < parts.length; i += 1) {
    if (!isByteArray(parts[i])) throw typeError(`parts[${i}]`, `expected a Buffer or Uint8Array, got ${describe(parts[i])}`);
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Exact decimal unit conversion
// ---------------------------------------------------------------------------

/**
 * Parses a non-negative decimal amount into integer base units without
 * floating-point arithmetic.
 * @param {number|string} amount
 * @param {number} decimals Validated `0..=38`.
 * @param {string} field
 * @param {string} unitLabel `'XRS amounts'` or `'amounts'` (message wording).
 * @returns {bigint}
 */
function parseDecimalUnits(amount, decimals, field, unitLabel) {
  let raw;
  if (typeof amount === 'number') {
    if (Number.isNaN(amount)) throw rangeError(field, `${unitLabel} must be a finite non-negative number, got NaN`);
    if (!Number.isFinite(amount)) throw rangeError(field, `${unitLabel} must be a finite non-negative number, got ${amount}`);
    if (amount < 0) throw rangeError(field, `${unitLabel} must be non-negative, got ${amount}`);
    // String(n) is the shortest round-tripping decimal of the double, so the
    // digits below are exactly the number the caller wrote (or an exponent
    // form, which is rejected rather than expanded).
    raw = String(amount);
  } else if (typeof amount === 'string') {
    raw = amount.trim();
  } else {
    throw typeError(field, `expected a number or decimal string, got ${describe(amount)}`);
  }
  const re = decimals === 0 ? /^(\d+)$/ : new RegExp(`^(\\d+)(?:\\.(\\d{1,${decimals}}))?$`);
  const m = re.exec(raw);
  if (m === null) {
    throw rangeError(field, `${unitLabel} must be a non-negative decimal with at most ${decimals} fractional digits (got '${raw}'); pass a decimal string`);
  }
  const intPart = m[1];
  const fracPart = m[2] === undefined ? '' : m[2];
  const scale = 10n ** BigInt(decimals);
  const value = BigInt(intPart) * scale + (fracPart.length > 0 ? BigInt(fracPart.padEnd(decimals, '0')) : 0n);
  if (value > U64_MAX) {
    throw rangeError(field, `${unitLabel.replace(/s$/, '')} '${raw}' exceeds the u64 maximum of ${U64_MAX} base units`);
  }
  return value;
}

/**
 * Formats integer base units as an exact decimal string.
 * @param {bigint} units Validated `0..=2^64-1`.
 * @param {number} decimals Validated `0..=38`.
 * @returns {string}
 */
function formatDecimalUnits(units, decimals) {
  const s = units.toString();
  if (decimals === 0) return s;
  const padded = s.padStart(decimals + 1, '0');
  const intPart = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
}

/**
 * Converts a decimal amount of a token with `decimals` fractional digits into
 * integer base units, exactly. Generalisation of `xrsToLamports`
 * (`xrsToLamports(x) === toBaseUnits(x, 9)`).
 * @param {number|string} amount Non-negative finite `number`, or decimal string
 *   matching `^\d+(\.\d{1,decimals})?$` after trimming (no sign, no exponent, no separators).
 * @param {number} decimals Integer `0..=38`.
 * @param {string} [field='amount'] Field name for messages.
 * @returns {bigint} Base units, `0..=2^64-1`.
 * @throws {TypeError} When `amount` is not a number or string, or `decimals` is not a number.
 * @throws {RangeError} Negative, NaN/Infinity, exponent notation, more than `decimals`
 *   fractional digits, or a result above `2^64-1`; `decimals` outside `0..=38`.
 */
function toBaseUnits(amount, decimals, field = 'amount') {
  const d = normalizeDecimals(decimals);
  return parseDecimalUnits(amount, d, fieldName(field, 'amount'), 'amounts');
}

/**
 * Converts integer base units of a token with `decimals` fractional digits
 * into an exact decimal string with trailing zeros removed
 * (`fromBaseUnits(1500000n, 6) === '1.5'`, `fromBaseUnits(5, 0) === '5'`).
 * @param {number|bigint} units Base units, `0..=2^64-1` (see `normalizeU64`).
 * @param {number} decimals Integer `0..=38`.
 * @param {string} [field='units'] Field name for messages.
 * @returns {string}
 * @throws {TypeError|RangeError} See `normalizeU64`; `decimals` outside `0..=38`.
 */
function fromBaseUnits(units, decimals, field = 'units') {
  const d = normalizeDecimals(decimals);
  return formatDecimalUnits(normalizeU64(units, fieldName(field, 'units')), d);
}

/**
 * Converts an XRS amount into lamports exactly (`XRS_DECIMALS` = 9,
 * `token.rs:901`). `0.29` → `290000000n`; `'1234567.123456789'` → `1234567123456789n`.
 * Numbers that `String()` renders in exponent form (e.g. `1e-7`) are rejected;
 * pass such amounts as decimal strings.
 * @param {number|string} xrs Non-negative finite `number` or decimal string with at most 9 fractional digits.
 * @param {string} [field='xrs'] Field name for messages.
 * @returns {bigint} Lamports, `0..=2^64-1`.
 * @throws {TypeError} When `xrs` is not a number or string.
 * @throws {RangeError} `"<field>: XRS amounts must be a non-negative decimal with at most 9 fractional digits (got '1e-7'); pass a decimal string"`,
 *   negatives, NaN/Infinity, or more than `2^64-1` lamports.
 */
function xrsToLamports(xrs, field = 'xrs') {
  return parseDecimalUnits(xrs, XRS_DECIMALS, fieldName(field, 'xrs'), 'XRS amounts');
}

/**
 * Converts lamports into an exact XRS decimal string with trailing zeros
 * removed: `290000000` → `'0.29'`, `5000000000n` → `'5'`,
 * `1234567123456789n` → `'1234567.123456789'`.
 * @param {number|bigint} lamports `0..=2^64-1` (see `normalizeU64`).
 * @param {string} [field='lamports'] Field name for messages.
 * @returns {string}
 * @throws {TypeError|RangeError} See `normalizeU64`.
 */
function lamportsToXrs(lamports, field = 'lamports') {
  return formatDecimalUnits(normalizeU64(lamports, fieldName(field, 'lamports')), XRS_DECIMALS);
}

// ---------------------------------------------------------------------------
// 4.x names (same function objects)
// ---------------------------------------------------------------------------

/** Alias of `encodeString`, kept for 4.x callers. */
const encodeBincodeString = encodeString;
/** Alias of `encodeBytes`, kept for 4.x callers (`number[]` is no longer accepted). */
const encodeBincodeVec = encodeBytes;
/** Alias of `encodeStringVec`, kept for 4.x callers. */
const encodeBincodeStringVec = encodeStringVec;

module.exports = {
  normalizeU64,
  normalizeU32,
  normalizeU8,
  assertString,
  toBytes,
  encodeU8,
  encodeU32,
  encodeU64,
  encodeBool,
  encodeString,
  encodeBytes,
  encodeFixedBytes,
  encodeStringVec,
  encodeOption,
  encodeVariant,
  readVariant,
  concat,
  xrsToLamports,
  lamportsToXrs,
  toBaseUnits,
  fromBaseUnits,
  encodeBincodeString,
  encodeBincodeVec,
  encodeBincodeStringVec,
};
