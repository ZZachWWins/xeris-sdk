'use strict';

/**
 * Ed25519 keypair wrapper and canonical-pubkey helpers.
 *
 * Key material is the Solana `Keypair` format the node's own tools use: a
 * 64-byte secret key = `seed(32) ‖ publicKey(32)`, stored on disk as a JSON
 * array of 64 integers (`src/bin/wallet.rs:96-105`, `src/bin/keypair_gen.rs:14-16`).
 * Addresses are the base58 public key (`src/bin/wallet.rs:106`).
 *
 * Signing and verification use `@noble/curves` (pure JavaScript, the library
 * `@solana/web3.js` itself signs with), so the module runs in browsers as well
 * as Node. Ed25519 signing is deterministic (RFC 8032): the signatures are the
 * same bytes `@solana/web3.js` and OpenSSL produce for the same key and
 * message, so `sign()` can produce the detached co-signatures the node checks
 * with `solana_sdk::signature::Signature::verify` (`src/contracts.rs:57-109`,
 * `src/ledger.rs:5299-5319`). `verify()` applies the same acceptance rule as
 * that function (see `verifyStrict`). The file helpers (`fromJsonFile`,
 * `saveToFile`) load `fs` only when called; `package.json` maps `fs` to an
 * empty module for browser bundlers.
 *
 * @module xeris-sdk/keypair
 */

const { Buffer } = require('buffer');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const { ed25519 } = require('@noble/curves/ed25519');
const { sha512 } = require('@noble/hashes/sha512');
const { EncodingError } = require('./errors.js');

/** Byte length of a Solana secret key (`Keypair::to_bytes()`, 32-byte seed ‖ 32-byte public key). */
const SECRET_KEY_LEN = 64;
/** Byte length of the Ed25519 seed. */
const SEED_LEN = 32;
/** Byte length of an Ed25519 public key (`solana_sdk::pubkey::Pubkey`). */
const PUBKEY_LEN = 32;
/** Byte length of an Ed25519 signature (`solana_sdk::signature::Signature`). */
const SIGNATURE_LEN = 64;
/**
 * Longest base58 string a 32-byte key can produce; `Pubkey::from_str` rejects
 * longer input before decoding (`MAX_BASE58_LEN` in solana-pubkey).
 */
const MAX_BASE58_PUBKEY_LEN = 44;

/** Order of the Ed25519 base point (`ℓ = 2^252 + 27742317777372353535851937790883648493`). */
const ED25519_L = ed25519.CURVE.n;
/** Edwards point class of `@noble/curves` 1.x. */
const EdPoint = ed25519.ExtendedPoint;

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/**
 * Loads Node's `fs` on first use, so that importing this module needs no
 * file system (browser bundles map `fs` to an empty module through the
 * `browser` field of `package.json`).
 * @returns {typeof import('fs')}
 * @throws {Error} When no file system is available (browser bundle).
 */
function fileSystem() {
  const fs = require('fs');
  if (!fs || typeof fs.readFileSync !== 'function') {
    throw new Error('XerisKeypair file helpers need a Node.js file system (fs); load the key bytes and use fromSecretKey in a browser');
  }
  return fs;
}

/**
 * Little-endian bytes to an unsigned BigInt.
 * @param {Uint8Array} bytes
 * @returns {bigint}
 */
function leToBigInt(bytes) {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

/**
 * Ed25519 verification with the acceptance rule of
 * `ed25519_dalek::PublicKey::verify_strict` 1.0.1, which
 * `solana_signature::Signature::verify` calls (solana-signature 2.3.0
 * `lib.rs:63-75`) and therefore every node signature check uses:
 * `s` must be below ℓ; `R` and `A` must decompress and must not be of small
 * order; and `[s]B - [k]A` must equal `R` with `k = SHA-512(R ‖ A ‖ M) mod ℓ`
 * (cofactorless). Point decompression accepts the same encodings as
 * curve25519-dalek.
 * @param {Uint8Array} pk 32 bytes.
 * @param {Uint8Array} msg
 * @param {Uint8Array} sig 64 bytes.
 * @returns {boolean}
 */
function verifyStrict(pk, msg, sig) {
  const rBytes = sig.subarray(0, 32);
  const s = leToBigInt(sig.subarray(32, 64));
  if (s >= ED25519_L) return false;
  let A;
  let R;
  try {
    A = EdPoint.fromHex(pk, true);
    R = EdPoint.fromHex(rBytes, true);
  } catch (_) {
    return false;
  }
  if (A.isSmallOrder() || R.isSmallOrder()) return false;
  const h = sha512(Buffer.concat([rBytes, pk, msg]));
  const k = leToBigInt(h) % ED25519_L;
  const check = EdPoint.BASE.multiplyUnsafe(s).add(A.negate().multiplyUnsafe(k));
  return check.equals(R);
}

/** @param {unknown} v @returns {boolean} */
function isByteArray(v) {
  return v instanceof Uint8Array; // Buffer is a Uint8Array subclass
}

/** @param {unknown} v @returns {string} */
function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `an array of length ${v.length}`;
  if (isByteArray(v)) return `${v.constructor.name} of length ${v.length}`;
  if (typeof v === 'bigint') return `bigint ${v}n`;
  if (typeof v === 'string') return `string of length ${v.length}`;
  return typeof v;
}

/**
 * Validates byte input for a fixed-length key field and returns a copy.
 * @param {unknown} value
 * @param {number} length Required length in bytes.
 * @param {string} field
 * @returns {Buffer}
 * @throws {TypeError} Not a `Buffer`/`Uint8Array`.
 * @throws {RangeError} Wrong length.
 */
function fixedBytes(value, length, field) {
  if (!isByteArray(value)) throw new TypeError(`${field}: pass a Buffer or Uint8Array, got ${describe(value)}`);
  if (value.length !== length) throw new RangeError(`${field}: expected exactly ${length} bytes, got ${value.length}`);
  return Buffer.from(value);
}

/**
 * Validates arbitrary message bytes and returns a copy.
 * @param {unknown} value
 * @param {string} field
 * @returns {Buffer}
 * @throws {TypeError}
 */
function messageBytes(value, field) {
  if (!isByteArray(value)) throw new TypeError(`${field}: pass a Buffer or Uint8Array, got ${describe(value)}`);
  return Buffer.from(value);
}

/**
 * Validates a 64-element secret key given as `number[]`, `Uint8Array` or `Buffer`.
 * `number[]` is accepted here only (it is the JSON keypair-file shape); every
 * element must be an integer `0..=255` — `Uint8Array.from([256])` would wrap.
 * @param {unknown} secretKey
 * @returns {Uint8Array} 64-byte copy.
 * @throws {TypeError} Not an array/`Uint8Array`, or an element that is not a number.
 * @throws {RangeError} Wrong length, or an element outside `0..=255` / not an integer.
 */
function secretKeyBytes(secretKey) {
  if (Array.isArray(secretKey)) {
    if (secretKey.length !== SECRET_KEY_LEN) {
      throw new RangeError(`secretKey: expected ${SECRET_KEY_LEN} bytes, got an array of length ${secretKey.length}`);
    }
    const out = new Uint8Array(SECRET_KEY_LEN);
    for (let i = 0; i < SECRET_KEY_LEN; i += 1) {
      const b = secretKey[i];
      if (typeof b !== 'number') throw new TypeError(`secretKey[${i}]: expected a number, got ${describe(b)}`);
      if (!Number.isInteger(b) || b < 0 || b > 255) throw new RangeError(`secretKey[${i}]: expected an integer 0..=255, got ${b}`);
      out[i] = b;
    }
    return out;
  }
  if (!isByteArray(secretKey)) {
    throw new TypeError(`secretKey: pass a Uint8Array, Buffer or number[] of ${SECRET_KEY_LEN} bytes, got ${describe(secretKey)}`);
  }
  if (secretKey.length !== SECRET_KEY_LEN) {
    throw new RangeError(`secretKey: expected ${SECRET_KEY_LEN} bytes, got ${secretKey.length}`);
  }
  return Uint8Array.from(secretKey);
}


/**
 * Is `s` the canonical base58 form of a 32-byte public key? Mirrors the node's
 * destination rule `to.parse::<Pubkey>()` + `pk.to_string() == to`
 * (`src/ledger.rs:1569-1577`): the string must decode to exactly 32 bytes and
 * re-encode to the identical string, which excludes alternate encodings of an
 * otherwise valid key. `Pubkey::from_str` also rejects strings longer than 44
 * characters before decoding. Does not check the `__` reserved prefix
 * (`src/ledger.rs:1562-1564`); that is `checks.transferTarget`.
 * @param {string} s Candidate address.
 * @returns {boolean} `true` only for a canonical 32-byte base58 public key.
 */
function isCanonicalPubkey(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > MAX_BASE58_PUBKEY_LEN) return false;
  let bytes;
  try {
    bytes = bs58.decode(s);
  } catch (_) {
    return false;
  }
  return bytes.length === PUBKEY_LEN && bs58.encode(bytes) === s;
}

/**
 * Decodes a canonical base58 public key to its 32 raw bytes.
 * @param {string} s Canonical base58 public key (see `isCanonicalPubkey`).
 * @returns {Buffer} 32 bytes.
 * @throws {EncodingError} When `s` is not a canonical 32-byte base58 public key (`.field === 'pubkey'`).
 * @see ledger.rs:1569-1577
 */
function pubkeyBytes(s) {
  if (!isCanonicalPubkey(s)) {
    throw new EncodingError(
      `pubkey: expected a canonical base58 32-byte public key, got ${typeof s === 'string' ? `'${s}'` : describe(s)}`,
      { field: 'pubkey' },
    );
  }
  return Buffer.from(bs58.decode(s));
}

/**
 * An Ed25519 keypair in the node's `Keypair` format (64-byte secret key =
 * seed ‖ public key; address = base58 public key). Wraps `@solana/web3.js`
 * `Keypair` so `transaction.js` can sign with web3's legacy `Transaction`, and
 * exposes `sign`/`verify` over raw messages (`@noble/curves`).
 *
 * Secret bytes are never logged or stringified: `toJSON()` and `util.inspect`
 * show only the public key. Use `toJsonBytes()`/`secretKey` deliberately.
 */
class XerisKeypair {
  /** @type {Keypair} */
  #keypair;

  /**
   * Wraps an existing web3 `Keypair`.
   * @param {Keypair} solanaKeypair Instance of `@solana/web3.js` `Keypair`.
   * @throws {TypeError} When `solanaKeypair` is not a web3 `Keypair`.
   */
  constructor(solanaKeypair) {
    if (!(solanaKeypair instanceof Keypair)) {
      throw new TypeError(`XerisKeypair: expected a @solana/web3.js Keypair, got ${describe(solanaKeypair)}`);
    }
    this.#keypair = solanaKeypair;
  }

  /**
   * Generates a new random keypair (web3 `Keypair.generate()`, CSPRNG-backed on Node).
   * @returns {XerisKeypair}
   */
  static generate() {
    return new XerisKeypair(Keypair.generate());
  }

  /**
   * Loads a keypair from a 64-byte secret key (`Keypair::to_bytes()` layout:
   * 32-byte seed followed by the 32-byte public key).
   * @param {Uint8Array|Buffer|number[]} secretKey 64 bytes. `number[]` is accepted
   *   here only (the JSON file shape); each element must be an integer `0..=255`.
   * @returns {XerisKeypair}
   * @throws {TypeError} Wrong container type or a non-number element.
   * @throws {RangeError} Length other than 64, an element outside `0..=255`, or a
   *   public-key half that does not match the seed half.
   * @see bin/wallet.rs:103-105 (`Keypair::from_bytes`)
   */
  static fromSecretKey(secretKey) {
    const bytes = secretKeyBytes(secretKey);
    let kp;
    try {
      // web3 re-derives the public key from the seed and rejects a mismatch,
      // the same check `Keypair::from_bytes` performs in the node's tools.
      kp = Keypair.fromSecretKey(bytes);
    } catch (cause) {
      const err = new RangeError('secretKey: the public-key half (bytes 32..64) does not match the seed half (bytes 0..32)');
      err.cause = cause;
      throw err;
    }
    return new XerisKeypair(kp);
  }

  /**
   * Derives a keypair from a 32-byte Ed25519 seed.
   * @param {Uint8Array|Buffer} seed Exactly 32 bytes.
   * @returns {XerisKeypair}
   * @throws {TypeError} Not a `Buffer`/`Uint8Array`.
   * @throws {RangeError} Length other than 32.
   */
  static fromSeed(seed) {
    return new XerisKeypair(Keypair.fromSeed(fixedBytes(seed, SEED_LEN, 'seed')));
  }

  /**
   * Loads a keypair from a JSON file holding an array of 64 integers, the
   * format written by `xrs-wallet keygen` and `keypair_gen`
   * (`bin/wallet.rs:96-105`, `bin/keypair_gen.rs:14-16, 33`).
   * @param {string} path File path.
   * @returns {XerisKeypair}
   * @throws {TypeError} When `path` is not a string.
   * @throws {EncodingError} When the file is not JSON, is not an array of exactly 64
   *   integers `0..=255`, or its public-key half does not match its seed
   *   (`.field === 'keypairFile'`). File-system errors propagate unchanged.
   */
  static fromJsonFile(path) {
    if (typeof path !== 'string') throw new TypeError(`fromJsonFile: path must be a string, got ${describe(path)}`);
    const text = fileSystem().readFileSync(path, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new EncodingError(`keypairFile: ${path} is not valid JSON`, { field: 'keypairFile', cause });
    }
    if (!Array.isArray(parsed) || parsed.length !== SECRET_KEY_LEN) {
      throw new EncodingError(
        `keypairFile: ${path} must contain a JSON array of ${SECRET_KEY_LEN} integers, got ${describe(parsed)}`,
        { field: 'keypairFile' },
      );
    }
    for (let i = 0; i < SECRET_KEY_LEN; i += 1) {
      const b = parsed[i];
      if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 255) {
        throw new EncodingError(
          `keypairFile: ${path} element ${i} is not an integer 0..=255 (got ${describe(b) === 'number' ? b : describe(b)})`,
          { field: 'keypairFile' },
        );
      }
    }
    try {
      return XerisKeypair.fromSecretKey(parsed);
    } catch (cause) {
      throw new EncodingError(`keypairFile: ${path} holds an inconsistent secret key (${cause.message})`, { field: 'keypairFile', cause });
    }
  }

  /** @returns {string} The address: base58 public key (`bin/wallet.rs:106`). */
  get publicKey() {
    return this.#keypair.publicKey.toBase58();
  }

  /** @returns {Buffer} A 32-byte copy of the raw public key. */
  get publicKeyBytes() {
    return Buffer.from(this.#keypair.publicKey.toBytes());
  }

  /** @returns {Keypair} The wrapped `@solana/web3.js` `Keypair` (used by `transaction.signTransaction`). */
  get solanaKeypair() {
    return this.#keypair;
  }

  /** @returns {Uint8Array} A 64-byte copy of the secret key (seed ‖ public key). */
  get secretKey() {
    return new Uint8Array(this.#keypair.secretKey);
  }

  /**
   * Exports the secret key as the JSON file shape (64 integers).
   * @returns {number[]} 64 integers `0..=255`.
   */
  toJsonBytes() {
    return Array.from(this.#keypair.secretKey);
  }

  /**
   * Writes the keypair as a JSON array of 64 integers, the format
   * `fromJsonFile` and the node's tools read.
   * @param {string} path File path.
   * @param {{mode?: number}} [opts] `mode` is the permission bits applied when the
   *   file is created (default `0o600`, as `bin/keypair_gen.rs:24-32`); like that
   *   tool, an existing file keeps its current permissions.
   * @returns {void}
   * @throws {TypeError} When `path` is not a string or `mode` is not an integer.
   * @throws {RangeError} When `mode` is outside `0..=0o7777`.
   */
  saveToFile(path, opts = { mode: 0o600 }) {
    if (typeof path !== 'string') throw new TypeError(`saveToFile: path must be a string, got ${describe(path)}`);
    const o = opts === null || typeof opts !== 'object' ? {} : opts;
    const mode = o.mode === undefined ? 0o600 : o.mode;
    if (typeof mode !== 'number' || !Number.isInteger(mode)) throw new TypeError(`saveToFile: mode must be an integer, got ${describe(mode)}`);
    if (mode < 0 || mode > 0o7777) throw new RangeError(`saveToFile: mode must be within 0..=0o7777, got ${mode}`);
    fileSystem().writeFileSync(path, JSON.stringify(this.toJsonBytes()), { mode, flag: 'w' });
  }

  /**
   * Signs `message` with Ed25519 (detached, 64 bytes). Identical bytes to
   * `@solana/web3.js` signing the same message, and to what the node checks with
   * `Signature::verify` for channel co-signatures (`channelStateMessage`,
   * `channelCloseMessage`; `src/contracts.rs:57-109`) and `HardwareAttest`
   * proofs (`src/ledger.rs:5299-5319`).
   * @param {Buffer|Uint8Array} message Raw bytes to sign (no hashing is applied).
   * @returns {Buffer} 64-byte signature.
   * @throws {TypeError} When `message` is not a `Buffer`/`Uint8Array`.
   */
  sign(message) {
    const msg = messageBytes(message, 'message');
    return Buffer.from(ed25519.sign(msg, this.#keypair.secretKey.subarray(0, SEED_LEN)));
  }

  /**
   * Verifies a detached Ed25519 signature with the node's acceptance rule
   * (`ed25519_dalek` `verify_strict`, see `verifyStrict`).
   * @param {string|Uint8Array|Buffer} publicKey Canonical base58 address or 32 raw bytes.
   * @param {Buffer|Uint8Array} message The signed bytes.
   * @param {Buffer|Uint8Array} signature 64 bytes.
   * @returns {boolean} `true` when `signature` is valid for `message` under `publicKey`.
   * @throws {TypeError} Wrong types.
   * @throws {EncodingError} When a string `publicKey` is not canonical base58 (see `pubkeyBytes`).
   * @throws {RangeError} When a byte `publicKey` is not 32 bytes or `signature` is not 64 bytes.
   */
  static verify(publicKey, message, signature) {
    const pk = typeof publicKey === 'string' ? pubkeyBytes(publicKey) : fixedBytes(publicKey, PUBKEY_LEN, 'publicKey');
    const msg = messageBytes(message, 'message');
    const sig = fixedBytes(signature, SIGNATURE_LEN, 'signature');
    return verifyStrict(pk, msg, sig);
  }

  /**
   * JSON form without secret material.
   * @returns {{publicKey: string}}
   */
  toJSON() {
    return { publicKey: this.publicKey };
  }

  /**
   * `util.inspect` form without secret material.
   * @returns {string}
   */
  [INSPECT]() {
    return `XerisKeypair { publicKey: '${this.publicKey}' }`;
  }
}

module.exports = { XerisKeypair, isCanonicalPubkey, pubkeyBytes };
