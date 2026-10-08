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

const { Buffer } = require('buffer');
const { Transaction, TransactionInstruction, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const { readVariant, parseJson, isPlainJsonObject } = require('./encoding.js');
const { XerisError, EncodingError, RpcError, DISABLED_FEATURES, disabledFeature } = require('./errors.js');
const {
  INSTRUCTION_COUNT,
  DISABLED_VARIANTS,
  MAX_IX_DATA_SIZE,
  MAX_SLASH_IX_DATA_SIZE,
  MAX_IX_PER_TX,
  MAX_TX_BYTES,
  AGENT_INNER_VARIANTS,
  CONDITION_TYPES,
  MAX_CONDITIONAL_INNER_BYTES,
} = require('./constants.js');
const { XerisKeypair, isCanonicalPubkey } = require('./keypair.js');
const { decodeInstruction, tryDecodeInstruction, VARIANT_NAMES } = require('./instructions/index.js');

/**
 * Variant index of `XerisInstruction::SlashReport` (`src/token.rs:524`), the
 * only instruction admitted above `MAX_IX_DATA_SIZE`, up to
 * `MAX_SLASH_IX_DATA_SIZE` (`src/network.rs:168-179`, `src/ledger.rs:119, 125-130`).
 */
const SLASH_REPORT_VARIANT = 38;

/**
 * Variant index of `XerisInstruction::QueryCapabilities` (`src/token.rs:414`).
 * Its builder encodes it (the node decodes it), but the block dispatcher's arm
 * is empty (`src/ledger.rs:7460-7464`): the fee is charged and nothing runs,
 * so it is refused here like the `DISABLED_VARIANTS`.
 */
const QUERY_CAPABILITIES_VARIANT = 30;

/**
 * Variant index -> `DISABLED_FEATURES` key for every variant this module
 * refuses to put in a transaction: the four `DISABLED_VARIANTS` plus
 * QueryCapabilities. The keys are the PascalCase Rust variant names.
 * 22 is refused at ingress (`src/ledger.rs:1445-1450`); 48, 49 and 52 are
 * skipped by the block dispatcher after the fee is charged
 * (`src/ledger.rs:8669-8685, 8687-8697, 8809-8828`); 30 is a no-op in blocks
 * after the fee is charged (`src/ledger.rs:7460-7464`).
 */
const DISABLED_VARIANT_FEATURES = Object.freeze({
  22: 'SubDelegate',
  30: 'QueryCapabilities',
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
for (const [v, key] of Object.entries(DISABLED_VARIANT_FEATURES)) {
  if (!DISABLED_VARIANTS.includes(Number(v)) && Number(v) !== QUERY_CAPABILITIES_VARIANT) {
    throw new Error(`transaction.js: DISABLED_VARIANT_FEATURES refuses variant ${v}, which is neither in DISABLED_VARIANTS nor QueryCapabilities`);
  }
  if (!Object.prototype.hasOwnProperty.call(DISABLED_FEATURES, key)) {
    throw new Error(`transaction.js: DISABLED_VARIANT_FEATURES maps ${v} to '${key}', which is not a DISABLED_FEATURES key`);
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
 * Checks one encoded instruction on its own: variant index, refused
 * variants and size. Returns the variant index.
 *
 * Mirrors, in this order: the data must carry a `u32le` variant index that is a
 * `XerisInstruction` (`src/network.rs:183-187` "Instruction data is not a
 * recognized type"; `src/token.rs:30-808` has 62 variants); the variant must
 * not be one the node refuses (22 at ingress, `src/ledger.rs:1445-1450`) or
 * skips after charging the fee (48/49/52, `src/ledger.rs:8669-8685, 8687-8697,
 * 8809-8828`; 30, an empty dispatcher arm, `src/ledger.rs:7460-7464`); the
 * data must be at most `MAX_IX_DATA_SIZE` bytes, or `MAX_SLASH_IX_DATA_SIZE`
 * for `SlashReport` (`src/network.rs:168-179`, `src/ledger.rs:93, 119, 125-130`
 * "Instruction data exceeds size limit"); the whole data must decode as
 * `bincode::deserialize::<XerisInstruction>` does (`decodeInstruction`: no
 * truncated field, `String` valid UTF-8, `Option` tag and `bool` byte 0 or 1;
 * trailing bytes ignored), as the node's ingress requires
 * (`src/network.rs:180-187`).
 *
 * Field-level rules are not checked here. `buildTransaction` (and therefore
 * every send path of the SDK) additionally applies the node's stateless
 * semantic gate, which needs the signer (`assertTransactionSemantics`).
 * @param {Buffer|Uint8Array} data Encoded `XerisInstruction`.
 * @param {number} [index] Position in the transaction, used only in error messages.
 * @returns {number} The variant index (`0..INSTRUCTION_COUNT-1`).
 * @throws {TypeError} When `data` is not a `Buffer`/`Uint8Array`, or `index` is not a non-negative integer.
 * @throws {EncodingError} When `data` is shorter than 4 bytes, the variant index is `>= INSTRUCTION_COUNT`,
 *   or the fields do not decode.
 * @throws {FeatureDisabledError} For variants 22, 30, 48, 49 and 52.
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
  const decoded = tryDecodeInstruction(data);
  if (!decoded.ok) {
    // network.rs:180-187: ingress admits only data that bincode-decodes as a
    // XerisInstruction (or a SystemInstruction, which this SDK never builds).
    throw new EncodingError(
      `${label}: does not decode as a XerisInstruction (${decoded.reason}); the node rejects it with "Instruction data is not a recognized type" (network.rs:180-187)`,
      { field: label },
    );
  }
  return variant;
}

// ---------------------------------------------------------------------------
// Stateless semantic gate (ledger.rs:1382-1455)
// ---------------------------------------------------------------------------

/** Strict UTF-8 decoder: bincode decodes `String` with `str::from_utf8`, which refuses invalid UTF-8. */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Methods whose 16-byte binary args a Swap contract accepts (`src/ledger.rs:2367-2371`). */
const BINARY_SWAP_METHODS = Object.freeze(['swap_a_to_b', 'swap_b_to_a']);

/**
 * `validate_native_transfer_destination` (`src/ledger.rs:1569-1577`).
 * @param {string} to
 * @param {bigint} amount
 * @returns {string|null} the node's error text, or `null` when accepted
 */
function nativeTransferProblem(to, amount) {
  if (amount === 0n) return 'NativeTransfer amount must be positive';
  if (!isCanonicalPubkey(to) || to.startsWith('__')) return 'NativeTransfer destination must be a canonical public key';
  return null;
}

/**
 * Variants whose block handler skips the instruction (after the fee is
 * charged, `ledger.rs:5516-5546`) unless one string field equals the account
 * the instruction runs as: the signer (`account_keys[0]`, `ledger.rs:5506`)
 * at the top level. `field` is the Rust field name (`VARIANT_FIELDS`).
 * Variants 1, 2, 3, 6 and 8 have no dispatcher arm of their own and reach
 * `token::process_token_instruction` (`ledger.rs:8873-8880`), which compares
 * the field with the signer it is given.
 * @type {Readonly<Record<number, {field: string, cite: string}>>}
 */
const SIGNER_BOUND_FIELDS = Object.freeze({
  1: { field: 'from', cite: 'token.rs:38-43, 1104; ledger.rs:8873-8880' }, // TokenTransfer
  2: { field: 'from', cite: 'token.rs:45-49, 1151; ledger.rs:8873-8880' }, // TokenBurn
  3: { field: 'mint_authority', cite: 'token.rs:51-58, 1036; ledger.rs:8873-8880' }, // TokenCreate
  6: { field: 'mint_authority', cite: 'token.rs:83-89, 1225; ledger.rs:8873-8880' }, // TokenCreateRWA
  8: { field: 'from', cite: 'token.rs:118-123, 1306; ledger.rs:8873-8880' }, // RWATransfer
  9: { field: 'pubkey', cite: 'token.rs:132; ledger.rs:5686-5689' }, // Stake
  10: { field: 'pubkey', cite: 'token.rs:139; ledger.rs:5737-5740' }, // Unstake
  11: { field: 'from', cite: 'token.rs:152; ledger.rs:5593-5597' }, // NativeTransfer
  18: { field: 'identity_pubkey', cite: 'token.rs:268; ledger.rs:6687-6693' }, // CreateIdentity
  28: { field: 'provider_identity', cite: 'token.rs:375; ledger.rs:7389-7392' }, // RegisterCapability
  29: { field: 'provider_identity', cite: 'token.rs:396; ledger.rs:7435-7438' }, // UpdateCapability
  32: { field: 'claimant_identity', cite: 'token.rs:456; ledger.rs:7507-7524' }, // ClaimTask
  34: { field: 'identity_pubkey', cite: 'token.rs:477; ledger.rs:7633-7643' }, // RegisterModel
  45: { field: 'identity_pubkey', cite: 'token.rs:590; ledger.rs:8420-8439' }, // AgentHeartbeat
  51: { field: 'ed25519_pubkey', cite: 'token.rs:694; ledger.rs:8738-8753' }, // PqKeyRotate
});

/**
 * The `SIGNER_BOUND_FIELDS` variants that `token::process_token_instruction`
 * binds. An AgentExecute inner instruction of these runs through it with the
 * owner as signer (`ledger.rs:6522, 6648-6655`); a ConditionalOrder inner one
 * with the order owner, who is the transaction signer (`contracts.rs:3804-3806`,
 * `ledger.rs:7106, 9270-9272`).
 * @type {ReadonlyArray<number>}
 */
const TOKEN_PROCESSOR_BOUND = Object.freeze([1, 2, 3, 6, 8]);

/**
 * Block-level signer binding: the instruction's actor field must be the
 * transaction signer, or the block skips the instruction after charging the
 * fee. HardwareAttest (variant 27, `token.rs:361-369`) needs the signer to be
 * `bound_identity` when that is non-empty and `device_pubkey` otherwise
 * (`ledger.rs:7237-7253`). Returns `null` for other variants.
 * @param {import('./instructions/index.js').DecodedInstruction} d
 * @param {string} signer
 * @returns {{message: string, cite: string, inBlock: true}|null}
 */
function signerBindingProblem(d, signer) {
  const f = d.fields;
  const skipped = 'the block skips it after charging the fee';
  if (d.variant === 27) {
    const device = f.device_pubkey;
    const bound = f.bound_identity;
    const cite = 'token.rs:361-369; ledger.rs:7237-7253';
    if (bound === '' && device !== signer) {
      return { message: `HardwareAttest.device_pubkey ${device} is not the signer ${signer} and bound_identity is empty; ${skipped}`, cite, inBlock: true };
    }
    if (bound !== '' && bound !== signer) {
      return { message: `HardwareAttest.bound_identity ${bound} is not the signer ${signer}; ${skipped}`, cite, inBlock: true };
    }
    return null;
  }
  const spec = SIGNER_BOUND_FIELDS[d.variant];
  if (spec === undefined) return null;
  const value = f[spec.field];
  if (value === signer) return null;
  return { message: `${d.name}.${spec.field} ${value} is not the signer ${signer}; ${skipped}`, cite: spec.cite, inBlock: true };
}

/**
 * The node's ingress error for one instruction, or a payload the block would
 * reject after the fee (signer binding, inner-instruction rules, unparseable
 * contract JSON), or `null`. Ingress checks are reported first. Data that
 * does not decode returns `null`; `assertInstructionSubmittable` refuses it.
 * @param {Uint8Array} data
 * @param {string} signer
 * @returns {{message: string, cite: string, inBlock?: boolean}|null} `inBlock` marks a
 *   payload the node admits but fails (or rewrites) in the block.
 */
function semanticProblem(data, signer) {
  const d = decodeInstruction(data);
  if (d === null) return null;
  const p = statelessProblem(d, signer);
  return p !== null ? p : signerBindingProblem(d, signer);
}

/**
 * `validate_tx_semantics` for one decoded instruction, plus the stateless
 * block checks on AgentExecute / ConditionalOrder inner instructions and the
 * JSON checks on ContractCall args and ContractDeploy params; see
 * `semanticProblem`.
 * @param {import('./instructions/index.js').DecodedInstruction} d
 * @param {string} signer
 * @returns {{message: string, cite: string, inBlock?: boolean}|null}
 */
function statelessProblem(d, signer) {
  const { variant } = d;
  const f = d.fields;
  if (variant === 12) {
    if (f.block_hash_prefix.length !== 32) {
      return { message: `ValidatorAttestation block_hash_prefix must be exactly 32 bytes (got ${f.block_hash_prefix.length})`, cite: 'ledger.rs:1398-1404' };
    }
    if (f.validator !== signer) return { message: 'ValidatorAttestation validator must equal the transaction signer', cite: 'ledger.rs:1405-1409' };
    return null;
  }
  if (variant === 11) {
    const m = nativeTransferProblem(f.to, f.amount);
    return m === null ? null : { message: m, cite: 'ledger.rs:1417-1419, 1569-1577' };
  }
  if (variant === 0) {
    return f.amount === 0n ? { message: 'TokenMint amount must be positive', cite: 'ledger.rs:1420-1422' } : null;
  }
  if (variant === 8) {
    return f.amount === 0n || f.from === f.to
      ? { message: 'RWATransfer requires positive amount and distinct accounts', cite: 'ledger.rs:1423-1427' }
      : null;
  }
  if (variant === 17 || variant === 23) return wrappedProblem(d, signer);
  if (variant === 4) {
    // contract_call_args (ledger.rs:2367-2371): 16 raw bytes pass through only for the
    // two Swap methods; everything else must be a JSON object serde_json accepts, or the
    // call is rejected in the block after the fee is charged (ledger.rs:2359-2365, 5884-5891).
    if (BINARY_SWAP_METHODS.includes(f.method) && f.args.length === 16) return null;
    const why = jsonObjectProblem(f.args, 'args');
    return why === null ? null : {
      message: `ContractCall ${f.contract_id}.${f.method}: args must be a JSON object the node can parse (${why}); the block would reject the call after charging the fee`,
      cite: 'ledger.rs:2359-2371, 5884-5891',
      inBlock: true,
    };
  }
  if (variant === 5) {
    // ledger.rs:6187 replaces unparseable params_json with {} and deploys from defaults.
    const why = jsonObjectProblem(Buffer.from(f.params_json, 'utf8'), 'params_json');
    return why === null ? null : {
      message: `ContractDeploy ${f.contract_id}: params_json must be JSON text of an object (${why}); the node would deploy from {} instead`,
      cite: 'ledger.rs:6187',
      inBlock: true,
    };
  }
  return null;
}

/**
 * AgentExecute (17) / ConditionalOrder (23). First the ingress rules of
 * `validate_tx_semantics` for a decodable inner instruction
 * (`ledger.rs:1428-1443`), then the stateless rules the block applies after
 * charging the fee (`ledger.rs:5516-5546`):
 * - ConditionalOrder `condition_type` in `CONDITION_TYPES` (`ledger.rs:6916-6921`);
 * - the inner instruction decodes (`ledger.rs:6399-6405`, `6923-6927`);
 * - ConditionalOrder inner instruction at most `MAX_CONDITIONAL_INNER_BYTES`
 *   (`ledger.rs:6941-6944`);
 * - AgentExecute inner variant in `AGENT_INNER_VARIANTS` (`ledger.rs:6478-6484`);
 * - AgentExecute inner ContractCall not targeting an `agent_registry_`
 *   contract (`ledger.rs:6428-6431`);
 * - inner ContractCall args (see `statelessProblem`);
 * - inner TokenTransfer/TokenBurn `from` (and, for ConditionalOrder, also
 *   TokenCreate/TokenCreateRWA `mint_authority` and RWATransfer `from`) equal
 *   to the account it runs as: the AgentExecute owner, or the ConditionalOrder
 *   signer.
 * @param {import('./instructions/index.js').DecodedInstruction} d
 * @param {string} signer
 * @returns {{message: string, cite: string, inBlock?: boolean}|null}
 */
function wrappedProblem(d, signer) {
  const { variant } = d;
  const f = d.fields;
  const innerBytes = f.inner_instruction;
  const inner = decodeInstruction(innerBytes);
  if (inner !== null) {
    const g = inner.fields;
    const cite = 'ledger.rs:1428-1443';
    switch (inner.variant) {
      case 11: {
        const m = nativeTransferProblem(g.to, g.amount);
        if (m !== null) return { message: m, cite: `${cite}, 1569-1577` };
        break;
      }
      case 0:
        if (g.amount === 0n) return { message: 'nested TokenMint amount must be positive', cite };
        break;
      case 8:
        if (g.amount === 0n || g.from === g.to) return { message: 'nested RWATransfer requires positive amount and distinct accounts', cite };
        break;
      case 17:
      case 23:
        return { message: 'recursive delegated/conditional instructions are not allowed', cite };
      default:
        break;
    }
  }
  const skipped = 'the block skips it after charging the fee';
  if (variant === 23 && !CONDITION_TYPES.includes(f.condition_type)) {
    return {
      message: `ConditionalOrder condition_type ${JSON.stringify(f.condition_type)} is not one of ${CONDITION_TYPES.join(', ')}; ${skipped}`,
      cite: 'ledger.rs:6916-6921',
      inBlock: true,
    };
  }
  if (inner === null) {
    const why = tryDecodeInstruction(innerBytes).reason;
    return {
      message: `${d.name} inner_instruction does not decode as a XerisInstruction (${why}); ${skipped}`,
      cite: variant === 17 ? 'ledger.rs:6399-6405' : 'ledger.rs:6923-6927',
      inBlock: true,
    };
  }
  if (variant === 23 && innerBytes.length > MAX_CONDITIONAL_INNER_BYTES) {
    return {
      message: `ConditionalOrder inner_instruction is ${innerBytes.length} bytes, above the ${MAX_CONDITIONAL_INNER_BYTES}-byte cap; ${skipped}`,
      cite: 'ledger.rs:6941-6944',
      inBlock: true,
    };
  }
  if (variant === 17 && !AGENT_INNER_VARIANTS.includes(inner.variant)) {
    return {
      message: `AgentExecute inner ${inner.name} (variant ${inner.variant}) is not in the delegation allow-list (${AGENT_INNER_VARIANTS.map((v) => VARIANT_NAMES[v]).join(', ')}); ${skipped}`,
      cite: 'ledger.rs:6425-6484',
      inBlock: true,
    };
  }
  const g = inner.fields;
  if (variant === 17 && inner.variant === 4 && g.contract_id.startsWith('agent_registry_')) {
    return {
      message: `nested ContractCall ${g.contract_id}.${g.method}: AgentExecute may not call an agent registry; ${skipped}`,
      cite: 'ledger.rs:6428-6431',
      inBlock: true,
    };
  }
  if (inner.variant === 4) {
    // AgentExecute: the inner args must parse as a JSON object, with no binary-swap
    // exemption, or the block skips it after the fee (ledger.rs:6436-6442, 5516-5546).
    // ConditionalOrder: the inner call goes through contract_call_args when the order
    // fires (ledger.rs:9181), which keeps the 16-byte swap payload and otherwise
    // parses the args with inject_consensus_slot (ledger.rs:2359-2371); a failure
    // cancels the order.
    if (variant === 23 && BINARY_SWAP_METHODS.includes(g.method) && g.args.length === 16) return null;
    const why = jsonObjectProblem(g.args, 'args');
    if (why === null) return null;
    return variant === 17
      ? {
        message: `nested ContractCall ${g.contract_id}.${g.method}: AgentExecute args must be a JSON object the node can parse (${why}); the block would skip the call after charging the fee`,
        cite: 'ledger.rs:6436-6442, 5516-5546',
        inBlock: true,
      }
      : {
        message: `nested ContractCall ${g.contract_id}.${g.method}: ConditionalOrder args must be a JSON object the node can parse (${why}); the order would be cancelled when it fires`,
        cite: 'ledger.rs:2359-2371, 9181',
        inBlock: true,
      };
  }
  if (TOKEN_PROCESSOR_BOUND.includes(inner.variant)) {
    const spec = SIGNER_BOUND_FIELDS[inner.variant];
    const value = g[spec.field];
    const tokenCite = spec.cite.split(';')[0];
    if (variant === 17 && value !== f.owner_pubkey) {
      return {
        message: `nested ${inner.name}.${spec.field} ${value} is not the AgentExecute owner ${f.owner_pubkey}; the block runs it as the owner and drops it after charging the fee`,
        cite: `ledger.rs:6522, 6648-6655; ${tokenCite}`,
        inBlock: true,
      };
    }
    if (variant === 23 && value !== signer) {
      return {
        message: `nested ${inner.name}.${spec.field} ${value} is not the ConditionalOrder signer ${signer}; the order runs it as its owner (the signer) when it fires, the token processor refuses it and the order is cancelled`,
        cite: `contracts.rs:3804-3806; ledger.rs:9270-9272; ${tokenCite}`,
        inBlock: true,
      };
    }
  }
  return null;
}

/**
 * Why `bytes` would not reach a contract as the JSON object it looks like, or
 * `null` when the node's serde_json reads it unchanged (`parseJson` with
 * `forNode`: UTF-8, well-formed, an object, no lone surrogate, numbers in
 * range, nesting at most 127).
 * @param {Uint8Array} bytes
 * @param {string} label field name for the reason text
 * @returns {string|null}
 */
function jsonObjectProblem(bytes, label) {
  let text;
  try {
    text = UTF8.decode(bytes);
  } catch (_) {
    return `${label}: not valid UTF-8`;
  }
  let value;
  try {
    value = parseJson(text, label, { forNode: true });
  } catch (err) {
    if (err instanceof SyntaxError || err instanceof RangeError || err instanceof TypeError) return err.message;
    throw err;
  }
  return isPlainJsonObject(value) ? null : `${label}: not a JSON object`;
}

/**
 * Applies the node's stateless semantic gate to the instructions of a
 * transaction signed by `signer`, before anything is signed. Mirrors
 * `validate_tx_semantics` (`src/ledger.rs:1382-1455`, called for every ingress
 * path at `src/network.rs:208`):
 * - NativeTransfer: `amount > 0`, `to` a canonical public key not starting
 *   with `__` (`ledger.rs:1417-1419, 1569-1577`);
 * - TokenMint: `amount > 0`; RWATransfer: `amount > 0` and `from != to`;
 * - ValidatorAttestation: hash exactly 32 bytes and `validator == signer`;
 * - AgentExecute / ConditionalOrder: the same rules for a decodable inner
 *   NativeTransfer, TokenMint or RWATransfer, and no nested AgentExecute /
 *   ConditionalOrder.
 * It also refuses payloads the node accepts at ingress but rejects in the
 * block after charging the fee (`ledger.rs:5516-5546`):
 * - ContractCall args that are not a JSON object serde_json can parse (except
 *   the 16-byte swap payload; `ledger.rs:2359-2371`), at the top level and as
 *   the inner instruction of AgentExecute (no swap exception there,
 *   `ledger.rs:6436-6442`) or ConditionalOrder (`ledger.rs:9181`);
 * - ContractDeploy `params_json` that is not JSON text of an object (the
 *   node substitutes `{}`, `ledger.rs:6187`);
 * - an AgentExecute / ConditionalOrder inner instruction that does not decode
 *   (`ledger.rs:6399-6405, 6923-6927`), an AgentExecute inner variant outside
 *   `AGENT_INNER_VARIANTS` (`ledger.rs:6478-6484`), a ConditionalOrder
 *   `condition_type` outside `CONDITION_TYPES` (`ledger.rs:6916-6921`) or an
 *   inner instruction above `MAX_CONDITIONAL_INNER_BYTES` (`ledger.rs:6941-6944`),
 *   or an AgentExecute inner ContractCall to an `agent_registry_` contract
 *   (`ledger.rs:6428-6431`);
 * - an actor field that is not the signer: TokenTransfer / TokenBurn /
 *   RWATransfer / NativeTransfer `from`, TokenCreate / TokenCreateRWA
 *   `mint_authority`, Stake/Unstake `pubkey`, CreateIdentity / RegisterModel /
 *   AgentHeartbeat `identity_pubkey`, Register/UpdateCapability
 *   `provider_identity`, ClaimTask `claimant_identity`, PqKeyRotate
 *   `ed25519_pubkey`, and for HardwareAttest `bound_identity` when set, else
 *   `device_pubkey` (see `SIGNER_BOUND_FIELDS` for the lines);
 * - an AgentExecute inner TokenTransfer / TokenBurn whose `from` is not the
 *   owner (`ledger.rs:6522, 6648-6655`), and a ConditionalOrder inner
 *   TokenTransfer / TokenBurn / RWATransfer / TokenCreate / TokenCreateRWA
 *   whose `from` / `mint_authority` is not the signer (the order is cancelled
 *   when it fires, `ledger.rs:9270-9272`).
 * Data that does not decode is refused by `assertInstructionSubmittable`
 * before this runs; here it is skipped.
 * @param {string} signer Base58 fee payer (`account_keys[0]`).
 * @param {Array<Uint8Array>} list Encoded instructions.
 * @returns {void}
 * @throws {RangeError} `instructions[i]: the node rejects this at ingress with "<node message>" (<citation>)`,
 *   or `instructions[i]: <reason> (<citation>)` for a payload the block would reject or rewrite.
 */
function assertTransactionSemantics(signer, list) {
  for (let i = 0; i < list.length; i += 1) {
    const p = semanticProblem(list[i], signer);
    if (p !== null) {
      throw new RangeError(p.inBlock
        ? `instructions[${i}]: ${p.message} (${p.cite})`
        : `instructions[${i}]: the node rejects this at ingress with "${p.message}" (${p.cite})`);
    }
  }
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
 *   instruction or an array of 1..16; each is checked with `assertInstructionSubmittable`,
 *   then all of them with the node's stateless semantic gate for this payer
 *   (`validate_tx_semantics`, `src/ledger.rs:1382-1455`; see `assertTransactionSemantics`).
 * @param {Buffer|Uint8Array} recentBlockhash 32 raw bytes (from `blockhashFromHex`).
 * @returns {Transaction} Unsigned; `feePayer` and `recentBlockhash` set.
 * @throws {TypeError} Wrong types.
 * @throws {RangeError} Non-canonical payer, 0 or more than 16 instructions, blockhash not 32 bytes, oversize
 *   instruction, or an instruction the node's semantic gate rejects (message quotes the node's error).
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
  for (let i = 0; i < list.length; i += 1) assertInstructionSubmittable(list[i], i);
  assertTransactionSemantics(payerPubkey, list);
  const payer = new PublicKey(payerPubkey);
  const tx = new Transaction();
  for (let i = 0; i < list.length; i += 1) {
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
