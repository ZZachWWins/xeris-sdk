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
 * The module also holds the SDK's only JSON writer and reader
 * (`stringifyJson`, `parseJson`). Contract-call arguments, contract-deploy
 * parameters and request bodies are written with `stringifyJson` so that
 * `bigint` values reach the node as exact integers; responses are read with
 * `parseJson` so that integers above 2^53-1 arrive as `bigint` instead of a
 * rounded `number`.
 *
 * @module xeris-sdk/encoding
 */

const { Buffer } = require('buffer');
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
/** Smallest value of a Rust `i64`. */
const I64_MIN = -9223372036854775808n;
/** `-Number.MAX_SAFE_INTEGER` as a BigInt. */
const MIN_SAFE_BIG = -MAX_SAFE_BIG;
/**
 * Deepest container nesting `serde_json::from_slice` accepts: its
 * deserializer starts with `remaining_depth: 128` and fails with
 * `RecursionLimitExceeded` when entering an array or object brings it to 0
 * (serde_json 1.0.145 `de.rs`, `check_recursion!`; the node pins that version,
 * `Cargo.lock`), so 127 nested containers parse and 128 do not.
 */
const JSON_MAX_DEPTH = 127;
/**
 * Most significant decimal digits a `number` amount may carry: every decimal
 * with at most 15 significant digits survives the round trip through an IEEE
 * 754 double and back through `String()` unchanged (DBL_DIG = 15).
 */
const MAX_EXACT_NUMBER_DIGITS = 15;

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
    if (Number.isInteger(amount) && !Number.isSafeInteger(amount)) {
      throw rangeError(field, 'numbers above 2^53-1 lose precision; pass a decimal string');
    }
    // String(n) is the shortest decimal that converts back to the same double.
    // It equals the decimal the caller wrote only when that decimal has at most
    // 15 significant digits (safe integers are always exact); a longer literal
    // such as 9999999.999999999 reads as a double that prints as
    // 9999999.999999998, so it is refused instead of being converted.
    // Exponent forms (1e-7) are refused by the pattern below.
    raw = String(amount);
    if (!Number.isInteger(amount)) {
      const digits = raw.replace('.', '').replace(/^0+/, '');
      if (/^\d+$/.test(digits) && digits.length > MAX_EXACT_NUMBER_DIGITS) {
        throw rangeError(field, `numbers with more than ${MAX_EXACT_NUMBER_DIGITS} significant digits are not exact; pass a decimal string`);
      }
    }
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
 * @param {number|string} amount Non-negative finite `number` (a safe integer, or a
 *   non-integer with at most 15 significant digits), or decimal string matching
 *   `^\d+(\.\d{1,decimals})?$` after trimming (no sign, no exponent, no separators).
 * @param {number} decimals Integer `0..=38`.
 * @param {string} [field='amount'] Field name for messages.
 * @returns {bigint} Base units, `0..=2^64-1`.
 * @throws {TypeError} When `amount` is not a number or string, or `decimals` is not a number.
 * @throws {RangeError} Negative, NaN/Infinity, exponent notation, more than `decimals`
 *   fractional digits, an integer `number` above 2^53-1, a non-integer `number` with more
 *   than 15 significant digits, or a result above `2^64-1`; `decimals` outside `0..=38`.
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
 * A `number` is converted only when its value is certainly the decimal the
 * caller wrote: a safe integer, or a non-integer with at most 15 significant
 * digits. Longer numbers (`9999999.999999999` reads as the double printed
 * `9999999.999999998`) and numbers that `String()` renders in exponent form
 * (`1e-7`) are rejected; pass such amounts as decimal strings.
 * @param {number|string} xrs Non-negative finite `number` or decimal string with at most 9 fractional digits.
 * @param {string} [field='xrs'] Field name for messages.
 * @returns {bigint} Lamports, `0..=2^64-1`.
 * @throws {TypeError} When `xrs` is not a number or string.
 * @throws {RangeError} `"<field>: XRS amounts must be a non-negative decimal with at most 9 fractional digits (got '1e-7'); pass a decimal string"`,
 *   `"<field>: numbers with more than 15 significant digits are not exact; pass a decimal string"`,
 *   an integer `number` above 2^53-1, negatives, NaN/Infinity, or more than `2^64-1` lamports.
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
// Strict JSON writer and lossless JSON reader
// ---------------------------------------------------------------------------

/**
 * True for an object created by `{}`, `Object.create(null)` or `JSON.parse`
 * (prototype `null` or a realm's `Object.prototype`); false for arrays, class
 * instances, `Buffer`/typed arrays, `Date`, `Map` and every primitive.
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainJsonObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Object.prototype.toString.call(value) !== '[object Object]') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

/**
 * Appends the JSON text of `value` to `out`. See `stringifyJson`.
 * @param {unknown} value
 * @param {string} path field path for messages
 * @param {number} depth containers already open around `value`
 * @param {Set<object>} open containers on the current path (cycle detection)
 * @param {string[]} out
 * @returns {void}
 */
function writeJson(value, path, depth, open, out) {
  if (value === null) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'string':
      out.push(JSON.stringify(assertString(value, path)));
      return;
    case 'number':
      if (!Number.isFinite(value)) {
        throw rangeError(path, `${describe(value)} has no JSON representation (JSON.stringify would write null)`);
      }
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        throw rangeError(path, 'numbers above 2^53-1 lose precision; pass a BigInt');
      }
      out.push(JSON.stringify(value));
      return;
    case 'bigint':
      if (value < I64_MIN || value > U64_MAX) {
        throw rangeError(path, `${value}n is outside -2^63..2^64-1, the integer range serde_json reads exactly (outside it the node sees an f64)`);
      }
      out.push(value.toString());
      return;
    case 'undefined':
      throw typeError(path, 'undefined has no JSON representation (JSON.stringify would drop it); pass null or leave the key out');
    case 'function':
    case 'symbol':
      throw typeError(path, `a ${typeof value} has no JSON representation (JSON.stringify would drop it)`);
    default:
      break;
  }
  const isArray = Array.isArray(value);
  if (!isArray && !isPlainJsonObject(value)) {
    throw typeError(path, `expected a plain object, array, string, number, bigint, boolean or null, got ${describe(value)}`);
  }
  if (open.has(value)) throw typeError(path, 'circular reference');
  if (depth + 1 > JSON_MAX_DEPTH) {
    throw rangeError(path, `nesting deeper than ${JSON_MAX_DEPTH} levels; serde_json refuses it (RecursionLimitExceeded)`);
  }
  open.add(value);
  if (isArray) {
    out.push('[');
    for (let i = 0; i < value.length; i += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) {
        throw typeError(`${path}[${i}]`, 'array hole has no JSON representation (JSON.stringify would write null)');
      }
      if (i > 0) out.push(',');
      writeJson(value[i], `${path}[${i}]`, depth + 1, open, out);
    }
    out.push(']');
  } else {
    if (Object.getOwnPropertySymbols(value).some((s) => Object.prototype.propertyIsEnumerable.call(value, s))) {
      throw typeError(path, 'symbol keys have no JSON representation (JSON.stringify would drop them)');
    }
    out.push('{');
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      assertString(key, `${path} key ${JSON.stringify(key)}`);
      if (i > 0) out.push(',');
      out.push(JSON.stringify(key), ':');
      writeJson(value[key], `${path}.${key}`, depth + 1, open, out);
    }
    out.push('}');
  }
  open.delete(value);
}

/**
 * Serialises a value to JSON text without changing it, for bytes the node will
 * parse with `serde_json` (contract-call `args`, `ledger.rs:2359-2365`;
 * contract-deploy `params_json`, `ledger.rs:6187`; request bodies such as
 * `POST /agent/plan`, `network.rs:5386-5577`).
 *
 * Unlike `JSON.stringify`, nothing is dropped or rewritten:
 * - `bigint` in `-2^63..2^64-1` is written as its exact decimal digits, so a
 *   u64 above 2^53-1 reaches the node's `as_u64` exactly (serde_json 1 without
 *   `arbitrary_precision`, `Cargo.toml:11`, reads integers in that range as
 *   `u64`/`i64`);
 * - an integer `number` above 2^53-1 throws `RangeError` (it has already lost
 *   precision; pass a `bigint`), and `NaN`/`Infinity` throw `RangeError`
 *   (`JSON.stringify` writes `null`, which the node reads as a missing field:
 *   `min_tokens_out` then defaults to 0, `contracts.rs:2849-2850`);
 * - `undefined`, functions, symbols, symbol keys and array holes throw
 *   `TypeError` (`JSON.stringify` drops or nulls them);
 * - strings and object keys must be well-formed UTF-16 (`RangeError`
 *   otherwise; serde_json refuses the `\ud800` escape `JSON.stringify` writes);
 * - only plain objects and arrays are accepted as containers (`TypeError` for
 *   `Buffer`, `Date`, `Map`, class instances; `toJSON` is never called);
 * - cycles throw `TypeError`; nesting deeper than 127 throws `RangeError`
 *   (serde_json's recursion limit).
 * @param {unknown} value
 * @param {string} [field='json'] Field name used as the root of error paths, e.g. `'args'`.
 * @returns {string} Compact JSON text (no whitespace), keys in `Object.keys` order.
 * @throws {TypeError|RangeError} As listed above; `.field` names the offending path (e.g. `args.min_tokens_out`).
 */
function stringifyJson(value, field = 'json') {
  const out = [];
  writeJson(value, fieldName(field, 'json'), 0, new Set(), out);
  return out.join('');
}

/**
 * @param {string} field
 * @param {number} pos
 * @param {string} message
 * @returns {SyntaxError}
 */
function jsonSyntaxError(field, pos, message) {
  const err = new SyntaxError(`${field}: invalid JSON at position ${pos}: ${message}`);
  err.field = field;
  err.code = 'syntax';
  return err;
}

const JSON_NUMBER = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;

/**
 * Recursive-descent JSON reader behind `parseJson`.
 */
class JsonReader {
  /**
   * @param {string} text
   * @param {string} field
   * @param {boolean} forNode apply the serde_json integer-range and depth rules
   */
  constructor(text, field, forNode) {
    this.text = text;
    this.field = field;
    this.forNode = forNode;
    this.pos = 0;
  }

  /** @returns {void} */
  skipWs() {
    const t = this.text;
    let p = this.pos;
    for (;;) {
      const c = t.charCodeAt(p);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) p += 1;
      else break;
    }
    this.pos = p;
  }

  /**
   * @param {string} message
   * @returns {SyntaxError}
   */
  fail(message) {
    return jsonSyntaxError(this.field, this.pos, message);
  }

  /**
   * @param {number} depth containers already open
   * @param {string} path
   * @returns {unknown}
   */
  value(depth, path) {
    this.skipWs();
    const t = this.text;
    const c = t[this.pos];
    if (c === '{') return this.object(depth, path);
    if (c === '[') return this.array(depth, path);
    if (c === '"') return this.string(path);
    if (c === '-' || (c >= '0' && c <= '9')) return this.number(path);
    if (t.startsWith('true', this.pos)) { this.pos += 4; return true; }
    if (t.startsWith('false', this.pos)) { this.pos += 5; return false; }
    if (t.startsWith('null', this.pos)) { this.pos += 4; return null; }
    throw this.fail(c === undefined ? 'unexpected end of input' : `unexpected character ${JSON.stringify(c)}`);
  }

  /**
   * @param {number} depth
   * @param {string} path
   * @returns {void}
   */
  enter(depth, path) {
    if (this.forNode && depth + 1 > JSON_MAX_DEPTH) {
      throw rangeError(path, `nesting deeper than ${JSON_MAX_DEPTH} levels; serde_json refuses it (RecursionLimitExceeded)`);
    }
  }

  /**
   * @param {number} depth
   * @param {string} path
   * @returns {object}
   */
  object(depth, path) {
    this.enter(depth, path);
    this.pos += 1;
    const out = {};
    this.skipWs();
    if (this.text[this.pos] === '}') { this.pos += 1; return out; }
    for (;;) {
      this.skipWs();
      if (this.text[this.pos] !== '"') throw this.fail('expected a string key');
      const key = this.string(`${path} key`);
      this.skipWs();
      if (this.text[this.pos] !== ':') throw this.fail("expected ':' after an object key");
      this.pos += 1;
      const v = this.value(depth + 1, `${path}.${key}`);
      if (key === '__proto__') {
        Object.defineProperty(out, key, { value: v, writable: true, enumerable: true, configurable: true });
      } else {
        out[key] = v;
      }
      this.skipWs();
      const c = this.text[this.pos];
      if (c === ',') { this.pos += 1; continue; }
      if (c === '}') { this.pos += 1; return out; }
      throw this.fail("expected ',' or '}' in an object");
    }
  }

  /**
   * @param {number} depth
   * @param {string} path
   * @returns {unknown[]}
   */
  array(depth, path) {
    this.enter(depth, path);
    this.pos += 1;
    const out = [];
    this.skipWs();
    if (this.text[this.pos] === ']') { this.pos += 1; return out; }
    for (;;) {
      out.push(this.value(depth + 1, `${path}[${out.length}]`));
      this.skipWs();
      const c = this.text[this.pos];
      if (c === ',') { this.pos += 1; continue; }
      if (c === ']') { this.pos += 1; return out; }
      throw this.fail("expected ',' or ']' in an array");
    }
  }

  /**
   * @param {string} path
   * @returns {string}
   */
  string(path) {
    const t = this.text;
    let p = this.pos + 1;
    let chunkStart = p;
    let s = '';
    for (;;) {
      const c = t.charCodeAt(p);
      if (Number.isNaN(c)) { this.pos = p; throw this.fail('unterminated string'); }
      if (c === 0x22) {
        s += t.slice(chunkStart, p);
        this.pos = p + 1;
        // A lone surrogate, written raw or as a \u escape, is refused: serde_json
        // rejects the escape (LoneLeadingSurrogateInHexEscape) and a JavaScript
        // string holding one has no UTF-8 form.
        return assertString(s, path);
      }
      if (c < 0x20) { this.pos = p; throw this.fail('unescaped control character in a string'); }
      if (c !== 0x5c) { p += 1; continue; }
      s += t.slice(chunkStart, p);
      const e = t[p + 1];
      switch (e) {
        case '"': s += '"'; p += 2; break;
        case '\\': s += '\\'; p += 2; break;
        case '/': s += '/'; p += 2; break;
        case 'b': s += '\b'; p += 2; break;
        case 'f': s += '\f'; p += 2; break;
        case 'n': s += '\n'; p += 2; break;
        case 'r': s += '\r'; p += 2; break;
        case 't': s += '\t'; p += 2; break;
        case 'u': {
          const hex = t.slice(p + 2, p + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) { this.pos = p; throw this.fail('invalid \\u escape'); }
          s += String.fromCharCode(parseInt(hex, 16));
          p += 6;
          break;
        }
        default:
          this.pos = p;
          throw this.fail('invalid escape sequence');
      }
      chunkStart = p;
    }
  }

  /**
   * @param {string} path
   * @returns {number|bigint}
   */
  number(path) {
    JSON_NUMBER.lastIndex = this.pos;
    const m = JSON_NUMBER.exec(this.text);
    if (m === null) throw this.fail('invalid number');
    const lit = m[0];
    this.pos += lit.length;
    if (m[1] === undefined && m[2] === undefined) {
      if (lit.length <= MAX_EXACT_NUMBER_DIGITS) return Number(lit);
      const big = BigInt(lit);
      if (this.forNode && (big < I64_MIN || big > U64_MAX)) {
        throw rangeError(path, `integer ${lit} is outside -2^63..2^64-1; serde_json reads it as an f64, so as_u64 returns None on the node`);
      }
      return big >= MIN_SAFE_BIG && big <= MAX_SAFE_BIG ? Number(big) : big;
    }
    const n = Number(lit);
    if (!Number.isFinite(n)) {
      throw rangeError(path, `number ${lit} is outside the f64 range; serde_json refuses it (NumberOutOfRange)`);
    }
    return n;
  }
}

/**
 * Parses JSON text like `JSON.parse`, except that no value is changed on the
 * way in:
 * - an integer literal outside `-(2^53-1)..2^53-1` is returned as a `bigint`
 *   with its exact value (`JSON.parse('{"b":123456789012345678}').b` is
 *   `123456789012345680`); every other number is a `number`;
 * - a float literal outside the f64 range (`1e400`) throws `RangeError`
 *   instead of becoming `Infinity`;
 * - a string or key holding a lone UTF-16 surrogate (`"\ud800"`) throws
 *   `RangeError`, as serde_json does.
 * The SDK reads every node response with it, so u64 fields above 2^53-1
 * (token balances and supplies, `tokens_out`, `min_tokens_out` in a plan)
 * arrive as `bigint` and can be passed back to a builder unchanged.
 * @param {string} text JSON text.
 * @param {string} [field='json'] Field name for messages.
 * @param {{forNode?: boolean}} [opts] `forNode: true` additionally applies the
 *   limits of the node's serde_json reader to text the SDK is about to send:
 *   integer literals must lie in `-2^63..2^64-1` and nesting must not exceed 127.
 * @returns {unknown}
 * @throws {TypeError} When `text` is not a string, `opts` is not an object or
 *   `opts.forNode` is not a boolean.
 * @throws {SyntaxError} Malformed JSON (`.code === 'syntax'`, message gives the position).
 * @throws {RangeError} As listed above, and for an `opts` key other than `forNode`.
 */
function parseJson(text, field = 'json', opts = {}) {
  const f = fieldName(field, 'json');
  assertString(text, f);
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) throw typeError(f, `opts: expected an object, got ${describe(opts)}`);
  for (const key of Object.keys(opts)) {
    if (key !== 'forNode') throw rangeError(f, `opts.${key}: unknown option (allowed: forNode)`);
  }
  if (opts.forNode !== undefined && typeof opts.forNode !== 'boolean') {
    throw typeError(f, `opts.forNode: expected a boolean, got ${describe(opts.forNode)}`);
  }
  const reader = new JsonReader(text, f, opts.forNode === true);
  const value = reader.value(0, f);
  reader.skipWs();
  if (reader.pos !== text.length) throw reader.fail('unexpected text after the JSON value');
  return value;
}

/**
 * Checks that `text` is JSON text of an object that the node's `serde_json`
 * reader accepts unchanged: well-formed JSON with an object at the top level,
 * no string or key holding a lone surrogate (serde_json refuses `\ud800`), no
 * float outside the f64 range (`1e400`, refused), no integer literal outside
 * `-2^63..2^64-1` (read as an f64, so `as_u64` yields `None`) and at most 127
 * levels of nesting. Used for contract-call `args` text (`ledger.rs:2359-2363`)
 * and contract-deploy `params_json` (`ledger.rs:6187`).
 * @param {string} text
 * @param {string} where Label for messages, e.g. `'contractCall: args'`.
 * @param {string} citation Node `file:line` that parses the text.
 * @param {string} [hint] Extra advice appended to the not-JSON message.
 * @returns {void}
 * @throws {TypeError} Not a string, not JSON, or not an object.
 * @throws {RangeError} Lone surrogate, out-of-range number, nesting deeper than 127.
 */
function assertJsonObjectText(text, where, citation, hint) {
  let parsed;
  try {
    parsed = parseJson(text, where, { forNode: true });
  } catch (err) {
    if (err instanceof SyntaxError) {
      const e = new TypeError(`${where} must be JSON text of an object (${err.message})${hint ? `; ${hint}` : ''}`);
      e.field = where;
      e.code = 'type';
      throw e;
    }
    throw err;
  }
  if (!isPlainJsonObject(parsed)) {
    throw typeError(where, `must be JSON text of an object; the node refuses any other JSON value (${citation})`);
  }
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
  stringifyJson,
  parseJson,
  isPlainJsonObject,
  assertJsonObjectText,
  encodeBincodeString,
  encodeBincodeVec,
  encodeBincodeStringVec,
};
