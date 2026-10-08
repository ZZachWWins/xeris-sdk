'use strict';

/**
 * Transaction assembly, signing, serialization and `/submit` response parsing.
 *
 * The node deserializes every write-route body as
 * `{"tx_base64": base64(bincode::serialize(&solana_sdk::transaction::Transaction))}`
 * (`src/network.rs:1575-1578, 4668-4675`): compact-u16 `short_vec` lengths,
 * raw 64-byte signatures, 3-byte header, raw 32-byte keys and blockhash,
 * compact-u16 account indexes and data (`src/ledger.rs:109-119`,
 * `src/tx_pool.rs:25-30`); the signature covers the message bytes, which is
 * what the node's `tx.verify()` checks (`src/network.rs:201`). The reference
 * wallet builds the identical transaction in Rust (`src/bin/wallet.rs:180-190,
 * 516-525`). A `@solana/web3.js` legacy `Transaction` is the carrier object;
 * for the layout `buildTransaction` produces, this module encodes the message
 * and the wire bytes itself (`messageBytes`), because web3.js 1.x refuses
 * messages above 1232 bytes while the node admits instruction data up to 8192
 * bytes (65,535 for SlashReport) and transactions up to 128 KiB
 * (`src/network.rs:145-189`, `src/tx_pool.rs:183`).
 *
 * Single-signer layout (blueprint §9.4 golden vector, 206 bytes for a 36-byte
 * NativeTransfer):
 *
 *   [0]        0x01            one signature (compact-u16)
 *   [1..65]    signature       Ed25519 over bytes [65..]
 *   [65..68]   01 00 01        num_required_signatures, readonly signed, readonly unsigned
 *   [68]       0x02            two account keys
 *   [69..101]  payer           account_keys[0] = signer and fee payer (ledger.rs:5506, 1383)
 *   [101..133] 00 × 32         program id, never read by the node (bin/wallet.rs:181, 519)
 *   [133..165] blockhash       one of the last 150 block hashes (ledger.rs:239, 4006-4035)
 *   [165]      0x01            one instruction
 *   [166]      0x01            program_id_index
 *   [167..169] 01 00           one account index: 0 (payer)
 *   [169]      len             compact-u16 data length
 *   [170..]    data            bincode XerisInstruction
 *
 * @module xeris-sdk/transaction
 */

const { Transaction, TransactionInstruction, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const { readVariant } = require('./encoding.js');
const { XerisError, EncodingError, RpcError, DISABLED_FEATURES, disabledFeature } = require('./errors.js');
const {
  INSTRUCTION_COUNT,
  DISABLED_VARIANTS,
  MAX_IX_DATA_SIZE,
  MAX_SLASH_IX_DATA_SIZE,
  MAX_IX_PER_TX,
  MAX_TX_BYTES,
} = require('./constants.js');
const { XerisKeypair, isCanonicalPubkey } = require('./keypair.js');

/**
 * Variant index of `XerisInstruction::SlashReport` (`src/token.rs:524`), the
 * only instruction admitted above `MAX_IX_DATA_SIZE`, up to
 * `MAX_SLASH_IX_DATA_SIZE` (`src/network.rs:168-179`, `src/ledger.rs:119, 125-130`).
 */
const SLASH_REPORT_VARIANT = 38;

/**
 * Variant index -> `DISABLED_FEATURES` key for every entry of
 * `DISABLED_VARIANTS`. The keys are the PascalCase Rust variant names.
 * 22 is refused at ingress (`src/ledger.rs:1445-1450`); 48, 49 and 52 are
 * skipped by the block dispatcher after the fee is charged
 * (`src/ledger.rs:8669-8685, 8687-8697, 8809-8828`).
 */
const DISABLED_VARIANT_FEATURES = Object.freeze({
  22: 'SubDelegate',
  48: 'ZkPrivateTransfer',
  49: 'ZkIdentityProof',
  52: 'PqSignedTransfer',
});
for (const v of DISABLED_VARIANTS) {
  const key = DISABLED_VARIANT_FEATURES[v];
  if (key === undefined || !Object.prototype.hasOwnProperty.call(DISABLED_FEATURES, key)) {
    throw new Error(`transaction.js: DISABLED_VARIANTS contains ${v} but DISABLED_VARIANT_FEATURES has no DISABLED_FEATURES key for it`);
  }
}

/**
 * Program id placed at `account_keys[1]`: 32 zero bytes (`Pubkey::default()`,
 * base58 `11111111111111111111111111111111`), as the reference wallet uses
 * (`src/bin/wallet.rs:181, 519`). The node never reads `program_id_index`
 * beyond `sanitize()`, which only requires it to be a valid index other than
 * the payer's (`src/network.rs:146-148`).
 */
const PROGRAM_ID = new PublicKey(Buffer.alloc(32));

/** Length of a serialized Ed25519 signature. */
const SIGNATURE_LEN = 64;
/** Offset of the message in a single-signature serialized transaction: 1 count byte + 64-byte signature. */
const MESSAGE_OFFSET = 1 + SIGNATURE_LEN;
/** Length of a block hash (`[u8; 32]`, `src/ledger.rs:297`). */
const BLOCKHASH_LEN = 32;

const BASE58_ALPHABET = /^[1-9A-HJ-NP-Za-km-z]+$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** @param {unknown} v @returns {boolean} */
function isByteArray(v) {
  return v instanceof Uint8Array;
}

/** Largest value a Solana `short_vec` (compact-u16) length can carry. */
const COMPACT_U16_MAX = 0xffff;

/**
 * Solana `short_vec` length prefix (compact-u16: 7 bits per byte, LSB first,
 * high bit = continuation; 1-3 bytes). Used for the signature, account-key,
 * instruction, account-index and data lengths of a legacy transaction.
 * @param {number} n
 * @returns {Buffer}
 * @throws {RangeError} When `n` is not an integer in `0..=65535`.
 */
function compactU16(n) {
  if (!Number.isInteger(n) || n < 0 || n > COMPACT_U16_MAX) {
    throw new RangeError(`short_vec length ${n} is outside 0..=${COMPACT_U16_MAX}`);
  }
  const out = [];
  let rem = n;
  for (;;) {
    const byte = rem & 0x7f;
    rem >>= 7;
    if (rem === 0) {
      out.push(byte);
      return Buffer.from(out);
    }
    out.push(byte | 0x80);
  }
}

/**
 * True when `tx` has the layout `buildTransaction` produces: fee payer and
 * blockhash set, no durable nonce, and every instruction with the zero
 * program id and exactly one account, the fee payer as writable signer.
 * Such a transaction is serialized by this module (`messageBytes`) rather
 * than by web3.js.
 * @param {Transaction} tx
 * @returns {boolean}
 */
function isSdkShape(tx) {
  if (!tx.feePayer || !tx.recentBlockhash || tx.nonceInfo || tx.instructions.length === 0) return false;
  if (tx.feePayer.equals(PROGRAM_ID)) return false;
  return tx.instructions.every((ix) => ix.programId.equals(PROGRAM_ID)
    && ix.keys.length === 1
    && ix.keys[0].pubkey.equals(tx.feePayer)
    && ix.keys[0].isSigner === true
    && ix.keys[0].isWritable === true);
}

/**
 * Serializes the legacy message of an SDK-shaped transaction (`isSdkShape`)
 * exactly as `bincode::serialize(&solana_sdk::message::Message)` does:
 * header `[1, 0, 1]`, `short_vec` of the two account keys `[payer, zero
 * program id]`, the 32-byte blockhash, then `short_vec` of instructions, each
 * `program_id_index = 1`, `short_vec` accounts `[0]`, `short_vec` data.
 *
 * web3.js 1.x `Message.serialize()` writes the instructions into a fixed
 * `PACKET_DATA_SIZE` (1232-byte) buffer and throws above it. The node has no
 * such cap: it admits instruction data up to `MAX_IX_DATA_SIZE` (65,535 for
 * SlashReport) and transactions up to `MAX_TX_BYTES` (`network.rs:145-189`,
 * `tx_pool.rs:183`), and a PqKeyRegister alone is 2035 bytes. This encoder
 * produces the same bytes as web3.js below 1232 bytes (checked against the
 * golden vector in `test/transaction.test.js`) and keeps working above it.
 * @param {Transaction} tx An SDK-shaped transaction.
 * @returns {Buffer} message bytes (what the signature covers, `network.rs:201`).
 * @throws {EncodingError} When the blockhash is not 32 bytes of base58.
 * @throws {RangeError} When an instruction's data exceeds 65,535 bytes.
 */
function messageBytes(tx) {
  let blockhash;
  try {
    blockhash = Buffer.from(bs58.decode(tx.recentBlockhash));
  } catch (cause) {
    throw new EncodingError('tx: recentBlockhash is not base58', { field: 'tx', cause });
  }
  if (blockhash.length !== BLOCKHASH_LEN) {
    throw new EncodingError(`tx: recentBlockhash decodes to ${blockhash.length} bytes, expected ${BLOCKHASH_LEN}`, { field: 'tx' });
  }
  const parts = [
    Buffer.from([1, 0, 1]),
    compactU16(2),
    tx.feePayer.toBuffer(),
    PROGRAM_ID.toBuffer(),
    blockhash,
    compactU16(tx.instructions.length),
  ];
  for (const ix of tx.instructions) {
    const data = Buffer.from(ix.data);
    parts.push(Buffer.from([1]), compactU16(1), Buffer.from([0]), compactU16(data.length), data);
  }
  return Buffer.concat(parts);
}

/**
 * Message bytes of any legacy transaction: `messageBytes` for the SDK shape,
 * otherwise web3.js `serializeMessage()` (limited by web3.js to 1232 bytes).
 * @param {Transaction} tx
 * @param {string} field Name used in error messages.
 * @returns {Buffer}
 * @throws {EncodingError} When the message cannot be serialized.
 */
function messageOf(tx, field) {
  if (isSdkShape(tx)) return messageBytes(tx);
  try {
    return Buffer.from(tx.serializeMessage());
  } catch (cause) {
    throw new EncodingError(`${field}: cannot serialize message: ${cause && cause.message ? cause.message : String(cause)}`, { field, cause });
  }
}

/** @param {unknown} v @returns {string} */
function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `an array of length ${v.length}`;
  if (isByteArray(v)) return `${v.constructor.name} of length ${v.length}`;
  if (typeof v === 'bigint') return `bigint ${v}n`;
  if (typeof v === 'string') return `string of length ${v.length}`;
  if (typeof v === 'object') return `object (${v.constructor && v.constructor.name ? v.constructor.name : 'no constructor'})`;
  return typeof v;
}

/**
 * @param {unknown} tx
 * @param {string} field
 * @throws {TypeError}
 */
function assertTransaction(tx, field) {
  if (!(tx instanceof Transaction)) {
    throw new TypeError(`${field}: expected a @solana/web3.js legacy Transaction, got ${describe(tx)}`);
  }
}

/**
 * @param {string} message
 * @param {unknown} [cause]
 * @returns {XerisError} code `'provider'`
 */
function providerError(message, cause) {
  return new XerisError(`wallet result: ${message}`, { code: 'provider', cause });
}

/**
 * Decodes the node's hex block hash (JSON-RPC `getLatestBlockhash` →
 * `result.value.blockhash`, `src/explorer.rs:1489-1500`, `bytes_to_hex`) to the
 * 32 raw bytes a transaction carries. The reference wallet does the same
 * conversion (`src/bin/wallet.rs:138-145, 498-505`).
 * @param {string} hex 64 hexadecimal characters, either case, no prefix.
 * @returns {Buffer} 32 bytes.
 * @throws {TypeError} When `hex` is not a string.
 * @throws {EncodingError} `'blockhash: expected 64 hex characters'` (`.field === 'blockhash'`).
 */
function blockhashFromHex(hex) {
  if (typeof hex !== 'string') throw new TypeError(`blockhash: expected a hex string, got ${describe(hex)}`);
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new EncodingError('blockhash: expected 64 hex characters', { field: 'blockhash' });
  return Buffer.from(hex, 'hex');
}

/**
 * Checks that encoded instruction data can pass the node's ingress gate as far
 * as the SDK can tell without state, and returns its variant index.
 *
 * Mirrors, in this order: the data must carry a `u32le` variant index that is a
 * `XerisInstruction` (`src/network.rs:183-187` "Instruction data is not a
 * recognized type"; `src/token.rs:30-808` has 62 variants); the variant must
 * not be one the node refuses (22 at ingress, `src/ledger.rs:1445-1450`) or
 * skips after charging the fee (48/49/52, `src/ledger.rs:8669-8685, 8687-8697,
 * 8809-8828`); the data must be at most `MAX_IX_DATA_SIZE` bytes, or
 * `MAX_SLASH_IX_DATA_SIZE` for `SlashReport` (`src/network.rs:168-179`,
 * `src/ledger.rs:93, 119, 125-130` "Instruction data exceeds size limit").
 * Field-level decoding is not re-checked here; the builders in
 * `instructions/*` emit canonical bincode.
 * @param {Buffer|Uint8Array} data Encoded `XerisInstruction`.
 * @param {number} [index] Position in the transaction, used only in error messages.
 * @returns {number} The variant index (`0..INSTRUCTION_COUNT-1`).
 * @throws {TypeError} When `data` is not a `Buffer`/`Uint8Array`, or `index` is not a non-negative integer.
 * @throws {EncodingError} When `data` is shorter than 4 bytes or the variant index is `>= INSTRUCTION_COUNT`.
 * @throws {FeatureDisabledError} For variants 22, 48, 49 and 52.
 * @throws {RangeError} When `data` exceeds the node's size cap for its variant.
 */
function assertInstructionSubmittable(data, index) {
  if (index !== undefined && (typeof index !== 'number' || !Number.isInteger(index) || index < 0)) {
    throw new TypeError(`index: expected a non-negative integer, got ${describe(index)}`);
  }
  const label = index === undefined ? 'instruction' : `instructions[${index}]`;
  if (!isByteArray(data)) throw new TypeError(`${label}: pass a Buffer or Uint8Array, got ${describe(data)}`);
  if (data.length < 4) {
    throw new EncodingError(`${label}: expected at least 4 bytes of instruction data (u32le variant index), got ${data.length}`, { field: label });
  }
  const variant = readVariant(data);
  if (variant >= INSTRUCTION_COUNT) {
    throw new EncodingError(
      `${label}: variant index ${variant} is not a XerisInstruction (0..${INSTRUCTION_COUNT - 1}); the node rejects it with "Instruction data is not a recognized type"`,
      { field: label },
    );
  }
  const disabledKey = DISABLED_VARIANT_FEATURES[variant];
  if (disabledKey !== undefined) throw disabledFeature(disabledKey);
  const cap = variant === SLASH_REPORT_VARIANT ? MAX_SLASH_IX_DATA_SIZE : MAX_IX_DATA_SIZE;
  if (data.length > cap) {
    const what = variant === SLASH_REPORT_VARIANT ? `SlashReport (variant ${variant})` : `variant ${variant}`;
    throw new RangeError(
      `${label}: ${data.length} bytes exceeds the node's ${cap}-byte limit for ${what}; the node rejects it with "Instruction data exceeds size limit"`,
    );
  }
  return variant;
}

/**
 * Validates a 32-byte block hash and returns a copy.
 * @param {unknown} value
 * @returns {Buffer}
 * @throws {TypeError|RangeError}
 */
function blockhashBytes(value) {
  if (!isByteArray(value)) {
    throw new TypeError(`recentBlockhash: pass the 32 raw bytes as a Buffer or Uint8Array (see blockhashFromHex), got ${describe(value)}`);
  }
  if (value.length !== BLOCKHASH_LEN) throw new RangeError(`recentBlockhash: expected exactly ${BLOCKHASH_LEN} bytes, got ${value.length}`);
  return Buffer.from(value);
}

/**
 * Builds an unsigned single-signer legacy `Transaction` with one
 * `TransactionInstruction` per `XerisInstruction`, in the layout the node's
 * handlers read: `account_keys[0]` = payer = signer (`src/ledger.rs:5506,
 * 1383`; `src/network.rs:4372`), a zero program id, and the instruction data
 * as-is. Instruction count is `1..=MAX_IX_PER_TX` (`src/network.rs:159-164`,
 * `src/ledger.rs:94`). Instructions execute in order without atomicity: a
 * failing instruction does not roll back earlier ones (`src/ledger.rs:5557-5570`).
 * @param {string} payerPubkey Canonical base58 public key of the signer and fee payer.
 * @param {Buffer|Uint8Array|Array<Buffer|Uint8Array>} instructions One encoded
 *   instruction or an array of 1..16; each is checked with `assertInstructionSubmittable`.
 * @param {Buffer|Uint8Array} recentBlockhash 32 raw bytes (from `blockhashFromHex`).
 * @returns {Transaction} Unsigned; `feePayer` and `recentBlockhash` set.
 * @throws {TypeError} Wrong types.
 * @throws {RangeError} Non-canonical payer, 0 or more than 16 instructions, blockhash not 32 bytes, oversize instruction.
 * @throws {EncodingError|FeatureDisabledError} From `assertInstructionSubmittable`.
 */
function buildTransaction(payerPubkey, instructions, recentBlockhash) {
  if (typeof payerPubkey !== 'string') throw new TypeError(`payerPubkey: expected a base58 string, got ${describe(payerPubkey)}`);
  if (!isCanonicalPubkey(payerPubkey)) {
    throw new RangeError(`payerPubkey: '${payerPubkey}' is not a canonical base58 32-byte public key`);
  }
  let list;
  if (Array.isArray(instructions)) list = instructions;
  else if (isByteArray(instructions)) list = [instructions];
  else throw new TypeError(`instructions: pass a Buffer or an array of Buffers, got ${describe(instructions)}`);
  if (list.length === 0) {
    throw new RangeError('instructions: a transaction needs at least 1 instruction; the node rejects it with "Transaction has no instructions" (network.rs:159-161)');
  }
  if (list.length > MAX_IX_PER_TX) {
    throw new RangeError(`instructions: ${list.length} instructions exceeds MAX_IX_PER_TX = ${MAX_IX_PER_TX} (ledger.rs:94; network.rs:162-164)`);
  }
  const blockhash = blockhashBytes(recentBlockhash);
  const payer = new PublicKey(payerPubkey);
  const tx = new Transaction();
  for (let i = 0; i < list.length; i += 1) {
    assertInstructionSubmittable(list[i], i);
    tx.add(new TransactionInstruction({
      keys: [{ pubkey: payer, isSigner: true, isWritable: true }],
      programId: PROGRAM_ID,
      data: Buffer.from(list[i]),
    }));
  }
  tx.feePayer = payer;
  // web3.js accepts the blockhash only as base58; the serialized form is the raw 32 bytes.
  tx.recentBlockhash = bs58.encode(blockhash);
  return tx;
}

/**
 * Signs a transaction with the fee payer's keypair. The signature covers the
 * serialized message, which is what the node's `tx.verify()` checks
 * (`src/network.rs:201`). For the layout `buildTransaction` produces, the
 * message is encoded by this module (no 1232-byte web3.js limit) and the
 * signature is stored as `tx.signatures = [{ publicKey: feePayer, signature }]`;
 * any other legacy transaction is signed with web3.js `tx.sign`.
 * @param {Transaction} tx Output of `buildTransaction` (or any legacy `Transaction` with `feePayer` and `recentBlockhash` set).
 * @param {XerisKeypair} keypair Must be the fee payer.
 * @returns {Transaction} The same object, now signed.
 * @throws {TypeError} Wrong types.
 * @throws {EncodingError} When `tx` has no `feePayer` or no `recentBlockhash`.
 * @throws {RangeError} When `keypair.publicKey` is not `tx.feePayer`.
 */
function signTransaction(tx, keypair) {
  assertTransaction(tx, 'tx');
  if (!(keypair instanceof XerisKeypair)) throw new TypeError(`keypair: expected a XerisKeypair, got ${describe(keypair)}`);
  if (!tx.feePayer) throw new EncodingError('tx: feePayer is not set; build the transaction with buildTransaction', { field: 'tx' });
  if (!tx.recentBlockhash) throw new EncodingError('tx: recentBlockhash is not set; build the transaction with buildTransaction', { field: 'tx' });
  const feePayer = tx.feePayer.toBase58();
  if (feePayer !== keypair.publicKey) {
    throw new RangeError(
      `keypair: ${keypair.publicKey} is not the fee payer ${feePayer}; the node treats account_keys[0] as signer and fee payer (ledger.rs:5506)`,
    );
  }
  if (isSdkShape(tx)) {
    tx.signatures = [{ publicKey: tx.feePayer, signature: keypair.sign(messageBytes(tx)) }];
  } else {
    tx.sign(keypair.solanaKeypair);
  }
  return tx;
}

/**
 * Serializes a signed transaction to the bytes the node deserializes
 * (`bincode::deserialize::<Transaction>`, `src/network.rs:4672`):
 * `short_vec` signatures ‖ message. The signature is verified first, so an
 * unsigned or mis-signed transaction throws here rather than at the node.
 * The layout `buildTransaction` produces is serialized by this module (see
 * `messageBytes`); any other legacy transaction by web3.js `serialize()`.
 * @param {Transaction} tx Signed legacy transaction.
 * @returns {Buffer} Serialized bytes, at most `MAX_TX_BYTES`.
 * @throws {TypeError} When `tx` is not a legacy `Transaction`.
 * @throws {EncodingError} When it cannot be serialized (missing or invalid signature, no blockhash).
 * @throws {RangeError} When the result exceeds `MAX_TX_BYTES` (`src/tx_pool.rs:183`).
 */
function serializeTransaction(tx) {
  assertTransaction(tx, 'tx');
  let buf;
  if (isSdkShape(tx)) {
    const message = messageBytes(tx);
    const entry = tx.signatures.length === 1 ? tx.signatures[0] : null;
    if (!entry || !entry.publicKey || !entry.publicKey.equals(tx.feePayer) || !entry.signature) {
      throw new EncodingError('tx: cannot serialize: missing the fee payer signature (sign it with signTransaction)', { field: 'tx' });
    }
    const signature = Buffer.from(entry.signature);
    if (signature.length !== SIGNATURE_LEN || !XerisKeypair.verify(tx.feePayer.toBuffer(), message, signature)) {
      throw new EncodingError(`tx: cannot serialize: signature does not verify for fee payer ${tx.feePayer.toBase58()}`, { field: 'tx' });
    }
    buf = Buffer.concat([compactU16(1), signature, message]);
  } else {
    let bytes;
    try {
      bytes = tx.serialize();
    } catch (cause) {
      throw new EncodingError(`tx: cannot serialize: ${cause && cause.message ? cause.message : String(cause)}`, { field: 'tx', cause });
    }
    buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  }
  if (buf.length > MAX_TX_BYTES) {
    throw new RangeError(`tx: serialized transaction is ${buf.length} bytes, above MAX_TX_BYTES = ${MAX_TX_BYTES} (tx_pool.rs:183); the mempool refuses it`);
  }
  return buf;
}

/**
 * The transaction identity: base58 of the first signature, which is the dedup
 * key in the mempool, `processed_signatures` and receipts (`src/ledger.rs:3806`,
 * `src/network.rs:4685`) and the `signature` the write routes echo back.
 * @param {Buffer|Uint8Array} txBytes Serialized single-signature transaction.
 * @returns {string} base58 signature.
 * @throws {TypeError} When `txBytes` is not a `Buffer`/`Uint8Array`.
 * @throws {EncodingError} When `txBytes` is shorter than 65 bytes or its first byte (signature count) is not `0x01`.
 */
function signatureOf(txBytes) {
  if (!isByteArray(txBytes)) throw new TypeError(`txBytes: pass a Buffer or Uint8Array, got ${describe(txBytes)}`);
  if (txBytes.length < MESSAGE_OFFSET) {
    throw new EncodingError(`txBytes: expected at least ${MESSAGE_OFFSET} bytes (signature count + 64-byte signature), got ${txBytes.length}`, { field: 'txBytes' });
  }
  if (txBytes[0] !== 1) {
    throw new EncodingError(`txBytes: expected a single-signature transaction (first byte 0x01), got 0x${txBytes[0].toString(16).padStart(2, '0')}`, { field: 'txBytes' });
  }
  return bs58.encode(Buffer.from(txBytes.subarray(1, MESSAGE_OFFSET)));
}

/**
 * Result of `assembleSignedTransaction`.
 * @typedef {object} SignedTransactionBytes
 * @property {Buffer} txBytes Serialized signed transaction.
 * @property {string} txBase64 `txBytes` as standard base64 with padding (the `tx_base64` body value).
 * @property {string} signature base58 first signature (the node's transaction id).
 */

/**
 * `buildTransaction` → `signTransaction` → `serializeTransaction` → `signatureOf`
 * for a keypair-held signer.
 * @param {XerisKeypair} keypair Signer and fee payer.
 * @param {Buffer|Uint8Array|Array<Buffer|Uint8Array>} instructions 1..16 encoded instructions.
 * @param {Buffer|Uint8Array} recentBlockhash 32 raw bytes.
 * @returns {SignedTransactionBytes}
 * @throws {TypeError|RangeError|EncodingError|FeatureDisabledError} As the four steps.
 */
function assembleSignedTransaction(keypair, instructions, recentBlockhash) {
  if (!(keypair instanceof XerisKeypair)) throw new TypeError(`keypair: expected a XerisKeypair, got ${describe(keypair)}`);
  const tx = buildTransaction(keypair.publicKey, instructions, recentBlockhash);
  signTransaction(tx, keypair);
  const txBytes = serializeTransaction(tx);
  return { txBytes, txBase64: txBytes.toString('base64'), signature: signatureOf(txBytes) };
}

/**
 * The JSON body of `POST /submit`, `/stake`, `/unstake` and `/pq-register`:
 * `SubmitRequest { tx_base64 }` (`src/network.rs:1575-1578`), decoded with
 * `base64::decode` (standard alphabet, padded; `src/network.rs:4668`).
 * @param {Buffer|Uint8Array} txBytes Serialized signed transaction.
 * @returns {{tx_base64: string}}
 * @throws {TypeError} When `txBytes` is not a `Buffer`/`Uint8Array`.
 * @throws {RangeError} When `txBytes` exceeds `MAX_TX_BYTES` (`src/tx_pool.rs:183`).
 */
function submitBody(txBytes) {
  if (!isByteArray(txBytes)) throw new TypeError(`txBytes: pass a Buffer or Uint8Array, got ${describe(txBytes)}`);
  if (txBytes.length > MAX_TX_BYTES) {
    throw new RangeError(`txBytes: ${txBytes.length} bytes is above MAX_TX_BYTES = ${MAX_TX_BYTES} (tx_pool.rs:183); the mempool refuses it`);
  }
  return { tx_base64: Buffer.from(txBytes).toString('base64') };
}

/**
 * Strict base64 decode (standard alphabet, padding required).
 * @param {string} s
 * @param {string} what Used in the error message.
 * @returns {Buffer}
 * @throws {XerisError} code `'provider'`
 */
function base64Bytes(s, what) {
  if (s.length === 0 || s.length % 4 !== 0 || !BASE64_PATTERN.test(s)) {
    throw providerError(`${what} is not a padded standard-alphabet base64 string`);
  }
  return Buffer.from(s, 'base64');
}

/**
 * Normalises the `signature` value of a wallet result to 64 bytes.
 * @param {unknown} value `Uint8Array`/`Buffer` or `number[]` of 64, a base58 string, or a base64 string.
 * @returns {Buffer} 64 bytes.
 * @throws {XerisError} code `'provider'`
 */
function signatureFromValue(value) {
  if (isByteArray(value)) {
    if (value.length !== SIGNATURE_LEN) throw providerError(`signature must be ${SIGNATURE_LEN} bytes, got ${value.length}`);
    return Buffer.from(value);
  }
  if (Array.isArray(value)) {
    if (value.length !== SIGNATURE_LEN) throw providerError(`signature must be ${SIGNATURE_LEN} bytes, got an array of length ${value.length}`);
    const out = Buffer.alloc(SIGNATURE_LEN);
    for (let i = 0; i < SIGNATURE_LEN; i += 1) {
      const b = value[i];
      if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 255) {
        throw providerError(`signature[${i}] is not an integer 0..=255`);
      }
      out[i] = b;
    }
    return out;
  }
  if (typeof value === 'string') {
    if (BASE58_ALPHABET.test(value)) {
      let decoded = null;
      try {
        decoded = Buffer.from(bs58.decode(value));
      } catch (_) {
        decoded = null;
      }
      if (decoded !== null && decoded.length === SIGNATURE_LEN) return decoded;
    }
    if (value.length % 4 === 0 && BASE64_PATTERN.test(value)) {
      const decoded = Buffer.from(value, 'base64');
      if (decoded.length === SIGNATURE_LEN) return decoded;
    }
    throw providerError(`signature string (${value.length} chars) is neither base58 nor base64 of ${SIGNATURE_LEN} bytes`);
  }
  throw providerError(`signature must be ${SIGNATURE_LEN} bytes as Uint8Array, number[], base58 or base64, got ${describe(value)}`);
}

/**
 * Classifies raw wallet bytes as either a complete signed transaction for
 * `message` or a detached 64-byte signature.
 * @param {Buffer} raw
 * @param {Buffer} message the message bytes of the unsigned transaction
 * @returns {{txBytes: Buffer|null, signature: Buffer|null}}
 * @throws {XerisError} code `'provider'`
 */
function classifyBytes(raw, message) {
  const fullLen = MESSAGE_OFFSET + message.length;
  if (raw[0] === 1 && raw.length === fullLen && raw.subarray(MESSAGE_OFFSET).equals(message)) {
    return { txBytes: raw, signature: null };
  }
  if (raw.length === SIGNATURE_LEN) return { txBytes: null, signature: raw };
  throw providerError(
    `${raw.length} bytes are neither a ${SIGNATURE_LEN}-byte detached signature nor the ${fullLen}-byte signed transaction for this message`,
  );
}

/**
 * Resolves what a Xeris-compatible wallet returned from `signTransaction(tx)`
 * into the serialized signed transaction, and verifies it before returning.
 *
 * Accepted shapes (the same ones the Xeris sites handle, `XerisDex/src/lib/xerisTx.ts:467-520`):
 *  1. a web3 `Transaction` (has `serialize()`): the fee payer's entry in
 *     `signatures` placed over the message, else `serialize()`;
 *  2. `Uint8Array`/`Buffer`: the complete serialized signed transaction
 *     (`bytes[0] === 1`, length `65 + message.length`, message bytes equal), or a
 *     64-byte detached signature;
 *  3. `{ signature }`: 64 bytes as `Uint8Array`/`number[]`, or a base58 or base64
 *     string decoding to 64 bytes, placed over the message (`unsignedTx` is not modified);
 *  4. `{ signedTransaction }`: base64 string or bytes, treated as 2.
 *
 * Whatever the shape, the result must be a single-signature transaction whose
 * message equals the message of `unsignedTx` (fee payer, blockhash and
 * instructions unchanged) and whose signature verifies for `unsignedTx.feePayer`
 * (`XerisKeypair.verify`), i.e. what the node's `tx.verify()` will accept
 * (`src/network.rs:201`).
 * @param {unknown} result Return value of the wallet's `signTransaction`.
 * @param {Transaction} unsignedTx The transaction handed to the wallet (from `buildTransaction`).
 * @returns {Buffer} Serialized signed transaction bytes.
 * @throws {TypeError} When `unsignedTx` is not a legacy `Transaction`.
 * @throws {EncodingError} When `unsignedTx` lacks `feePayer`/`recentBlockhash` or requires more than one signer.
 * @throws {XerisError} code `'provider'` for any unrecognised, mismatched or unverifiable result.
 */
function serializedFromWalletResult(result, unsignedTx) {
  assertTransaction(unsignedTx, 'unsignedTx');
  if (!unsignedTx.feePayer) throw new EncodingError('unsignedTx: feePayer is not set; build it with buildTransaction', { field: 'unsignedTx' });
  if (!unsignedTx.recentBlockhash) throw new EncodingError('unsignedTx: recentBlockhash is not set; build it with buildTransaction', { field: 'unsignedTx' });
  const payer = unsignedTx.feePayer;
  const message = messageOf(unsignedTx, 'unsignedTx');
  // message[0] = header.num_required_signatures; the signer/payer layout here is single-signer.
  if (message[0] !== 1) {
    throw new EncodingError(`unsignedTx: requires ${message[0]} signatures; wallet results are resolved for single-signer transactions only`, { field: 'unsignedTx' });
  }

  let txBytes = null;
  let signature = null;
  if (result !== null && typeof result === 'object' && !isByteArray(result) && typeof result.serialize === 'function') {
    // 1. web3 Transaction (any web3.js copy; duck-typed). The fee payer's
    // signature is taken from `signatures` and placed over `message`, so a
    // transaction whose message is above web3.js's 1232-byte serialize limit
    // still resolves; a wallet that changed the message fails verification below.
    const entry = Array.isArray(result.signatures)
      ? result.signatures.find((e) => e && e.publicKey && typeof e.publicKey.toBase58 === 'function' && e.publicKey.toBase58() === payer.toBase58())
      : undefined;
    if (entry && entry.signature) {
      signature = signatureFromValue(entry.signature instanceof Uint8Array ? entry.signature : Buffer.from(entry.signature));
    } else {
      try {
        txBytes = Buffer.from(result.serialize());
      } catch (cause) {
        throw providerError(`returned Transaction cannot be serialized (unsigned or invalid signature): ${cause && cause.message ? cause.message : String(cause)}`, cause);
      }
    }
  } else if (isByteArray(result)) {
    // 2. raw bytes
    ({ txBytes, signature } = classifyBytes(Buffer.from(result), message));
  } else if (result !== null && typeof result === 'object' && !Array.isArray(result) && result.signature !== undefined && result.signature !== null) {
    // 3. { signature }
    signature = signatureFromValue(result.signature);
  } else if (result !== null && typeof result === 'object' && !Array.isArray(result) && result.signedTransaction !== undefined && result.signedTransaction !== null) {
    // 4. { signedTransaction }
    const st = result.signedTransaction;
    let raw;
    if (typeof st === 'string') raw = base64Bytes(st, 'signedTransaction');
    else if (isByteArray(st)) raw = Buffer.from(st);
    else throw providerError(`signedTransaction must be a base64 string or bytes, got ${describe(st)}`);
    ({ txBytes, signature } = classifyBytes(raw, message));
  } else {
    throw providerError(
      `unrecognised signTransaction result (${describe(result)}): expected a web3 Transaction, the signed transaction bytes, {signature} or {signedTransaction}`,
    );
  }

  if (txBytes === null) {
    // Single-signer wire layout: short_vec(1) ‖ signature ‖ message; verified below.
    txBytes = Buffer.concat([compactU16(1), signature, message]);
  }

  if (txBytes.length < MESSAGE_OFFSET || txBytes[0] !== 1) {
    throw providerError(`expected a single-signature transaction (first byte 0x01), got ${txBytes.length} bytes starting with 0x${txBytes.length ? txBytes[0].toString(16).padStart(2, '0') : ''}`);
  }
  if (txBytes.length !== MESSAGE_OFFSET + message.length || !txBytes.subarray(MESSAGE_OFFSET).equals(message)) {
    throw providerError('the signed message differs from the transaction the wallet was asked to sign (fee payer, blockhash or instructions changed)');
  }
  const sig = txBytes.subarray(1, MESSAGE_OFFSET);
  if (!XerisKeypair.verify(Buffer.from(payer.toBytes()), message, sig)) {
    throw providerError(`signature does not verify for fee payer ${payer.toBase58()}`);
  }
  return txBytes;
}

/**
 * Success body of a write route. `status` reports mempool admission, not
 * confirmation; poll `XerisClient.waitForConfirmation(signature)`.
 * - `POST /submit`: `{status:'ok', signature}`; a `ValidatorAttestation` adds
 *   `attestation_accepted: true, reward: 10000000, reward_xrs: 0.01` (`src/network.rs:4847-4856`).
 * - `POST /stake`: `{status:'queued', message, staked, pubkey, signature}` (`src/network.rs:4424-4430`).
 * - `POST /unstake`: `{status:'queued', message, unstaked, unbonding_period_slots: 151200, pubkey, signature}` (`src/network.rs:4543-4551`).
 * - `POST /pq-register`: `{status:'queued', message, ed25519_pubkey, signature}` (`src/network.rs:4650-4654`).
 * @typedef {object} SubmitResult
 * @property {'ok'|'queued'} status
 * @property {string} signature base58 first signature.
 * @property {string} [message]
 * @property {true} [attestation_accepted]
 * @property {number} [reward] lamports
 * @property {number} [reward_xrs]
 * @property {number} [staked] lamports
 * @property {number} [unstaked] lamports
 * @property {number} [unbonding_period_slots]
 * @property {string} [pubkey]
 * @property {string} [ed25519_pubkey]
 */

/**
 * Turns a write-route JSON body into a `SubmitResult` or an `RpcError`. The
 * handlers reply HTTP 200 with `{"error": ...}` on every failure
 * (`src/network.rs:4336-4432, 4440-4552, 4571-4655, 4664-4858`), optionally
 * with `status` (`rejected_underfunded_quota`, `rejected_mempool_full` on
 * `/submit`, `src/network.rs:4825-4843`; `rejected_not_admitted` on `/stake`,
 * `/unstake`, `/pq-register`; `rate_limited` for a rate-limited attestation),
 * `signature` and `hint` (the `/v2/recent_blockhash` route it names does not
 * exist; use JSON-RPC `getLatestBlockhash`). The write limiter replies
 * `{"error": "Rate limited. Max 30 write RPCs per minute per IP."}` (`src/network.rs:4665-4667`).
 * @param {unknown} body Parsed JSON body.
 * @param {string|null} [route] e.g. `'POST /submit'`, recorded on the error.
 * @param {number|null} [httpStatus] HTTP status, recorded on the error.
 * @returns {SubmitResult} `body` unchanged when it carries no `error`.
 * @throws {TypeError} When `route` is not a string or `httpStatus` not an integer (when given).
 * @throws {RpcError} With `.message = body.error`, `.route`, `.httpStatus`, `.body`, `.nodeStatus`, `.hint`;
 *   also when `body` is not a JSON object.
 */
function parseSubmitResponse(body, route, httpStatus) {
  if (route !== undefined && route !== null && typeof route !== 'string') {
    throw new TypeError(`route: expected a string, got ${describe(route)}`);
  }
  if (httpStatus !== undefined && httpStatus !== null && !Number.isInteger(httpStatus)) {
    throw new TypeError(`httpStatus: expected an integer, got ${describe(httpStatus)}`);
  }
  const r = route === undefined ? null : route;
  const h = httpStatus === undefined ? null : httpStatus;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new RpcError(`unexpected write-route response: expected a JSON object, got ${describe(body)}`, { route: r, httpStatus: h, body });
  }
  if (typeof body.error === 'string') {
    throw new RpcError(body.error, {
      route: r,
      httpStatus: h,
      body,
      nodeStatus: typeof body.status === 'string' ? body.status : null,
      hint: typeof body.hint === 'string' ? body.hint : null,
    });
  }
  return body;
}

module.exports = {
  blockhashFromHex,
  assertInstructionSubmittable,
  buildTransaction,
  signTransaction,
  serializeTransaction,
  signatureOf,
  assembleSignedTransaction,
  submitBody,
  serializedFromWalletResult,
  parseSubmitResponse,
};
