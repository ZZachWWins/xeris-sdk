'use strict';

/**
 * @file Builders for `XerisInstruction` variants 0-17 (`token.rs:30-253`).
 *
 * Wire format: the node embeds `XerisInstruction` values in transaction
 * instruction `data` with `bincode::serialize` (bincode 1.3.3 default options;
 * serde derive at `token.rs:29`). Each instruction is `u32le(variant index)`
 * followed by the variant's fields in declaration order; strings and `Vec<T>`
 * carry a `u64le` length prefix, `Option<T>` a `0x00`/`0x01` tag, `bool` one
 * byte. The variant index is the declaration position in the enum
 * (`token.rs:30`), so the indices below must never be reordered.
 *
 * These builders are pure wire encoders. They reject only what bincode cannot
 * encode (wrong JavaScript type, integer outside the field's domain, lone UTF-16
 * surrogate, wrong argument count) and never substitute a default for a caller
 * value or apply a node business rule. The node rules that apply to each
 * variant are cited in the builder's JSDoc; `XerisClient` (`src/client.js`)
 * enforces them before any network call.
 *
 * Integers: `number` must be a safe integer; values above 2^53-1 must be passed
 * as `bigint`. Bytes: `Buffer | Uint8Array` only. `Option<T>` fields take `null`
 * or `undefined` for `None`; `0`, `''` and `[]` are `Some`.
 *
 * Every builder throws `EncodingError` (`code: 'arity'`) when called with the
 * wrong number of arguments: bincode has no field names, so a dropped or extra
 * positional argument would shift every later field on the wire.
 */

const { Buffer } = require('buffer');
const {
  assertString,
  concat,
  encodeBool,
  encodeBytes,
  encodeOption,
  encodeString,
  encodeStringVec,
  encodeU64,
  encodeU8,
  encodeVariant,
  assertJsonObjectText,
  stringifyJson,
  toBytes,
} = require('../encoding');
const { EncodingError } = require('../errors');

// Variant indices = declaration order of `enum XerisInstruction` (token.rs:30).
// The line cited on each entry is the variant's declaration.
const IDX = Object.freeze({
  TokenMint: 0, // token.rs:32
  TokenTransfer: 1, // token.rs:38
  TokenBurn: 2, // token.rs:45
  TokenCreate: 3, // token.rs:51
  ContractCall: 4, // token.rs:60
  ContractDeploy: 5, // token.rs:66
  TokenCreateRWA: 6, // token.rs:83
  RWAUpdateStatus: 7, // token.rs:108
  RWATransfer: 8, // token.rs:118
  Stake: 9, // token.rs:132
  Unstake: 10, // token.rs:139
  NativeTransfer: 11, // token.rs:152
  ValidatorAttestation: 12, // token.rs:166
  WrapXrs: 13, // token.rs:184
  UnwrapXrs: 14, // token.rs:191
  RegisterAgent: 15, // token.rs:204
  UpdateAgent: 16, // token.rs:225
  AgentExecute: 17, // token.rs:246
});

// The two Swap methods whose `args` the dispatcher passes through as raw bytes
// when the payload is exactly 16 bytes (ledger.rs:2367-2370; engine reads
// `input_amount` at bytes 0..8 and `min_output` at 8..16, contracts.rs:2419-2441
// and 2484-2499).
const SWAP_METHODS = Object.freeze(['swap_a_to_b', 'swap_b_to_a']);

/**
 * Throws when a builder is called with the wrong number of arguments.
 * @param {number} actual `arguments.length` of the caller
 * @param {number} expected the variant's field count
 * @param {string} qualifiedName name shown in the message, e.g. `Instructions.tokenMint`
 * @param {string} fields comma-separated parameter list shown in the message
 * @returns {void}
 * @throws {EncodingError} `code: 'arity'`
 */
function assertArity(actual, expected, qualifiedName, fields) {
  if (actual !== expected) {
    throw new EncodingError(
      `${qualifiedName} expects exactly ${expected} arguments (${fields}), got ${actual}`,
      { code: 'arity', details: { builder: qualifiedName, expected, got: actual } },
    );
  }
}

/**
 * True for `Buffer` and `Uint8Array` (including instances from another realm).
 * Other typed arrays are excluded on purpose: `Buffer.from(new Uint16Array(...))`
 * would truncate each element.
 * @param {unknown} value
 * @returns {boolean}
 */
function isByteArray(value) {
  return value instanceof Uint8Array
    || Object.prototype.toString.call(value) === '[object Uint8Array]';
}

/**
 * True for a plain object (`{}` or a class instance without a custom
 * `Symbol.toStringTag`); false for arrays, `null`, typed arrays and primitives.
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

/**
 * Converts the `args` parameter of `contractCall` into the exact bytes placed in
 * `ContractCall.args: Vec<u8>` (`token.rs:63`).
 *
 * The node accepts two payload shapes (`ledger.rs:2359-2370`): a UTF-8 JSON
 * object for every method (the dispatcher inserts `current_slot` into it and
 * refuses non-object JSON and non-UTF-8 with "contract args must be a JSON
 * object"), or, for a Swap contract's `swap_a_to_b`/`swap_b_to_a` only, exactly
 * 16 raw bytes. A JSON payload the node cannot parse fails in the block, after
 * the fee is charged. This function therefore accepts:
 *
 * - `Buffer | Uint8Array`: used verbatim (a copy is taken). This is the only way
 *   to send the 16-byte swap payload; see `encodeSwapCall`.
 * - a plain object: written with `stringifyJson` as UTF-8. `bigint` values in
 *   `0..2^64-1` are written as exact integers (the node reads them with
 *   `as_u64`, e.g. `contracts.rs:2847-2850, 2944-2947`); an integer `number`
 *   above 2^53-1, `NaN`/`Infinity`, `undefined`, functions, non-plain objects
 *   and lone surrogates throw instead of being rewritten the way
 *   `JSON.stringify` would (a dropped or `null` `min_tokens_out` is read as 0
 *   by the node, `contracts.rs:2849-2850`).
 * - a string: taken as already-serialised JSON text and sent byte-for-byte. It
 *   must be JSON text of an object that serde_json reads unchanged
 *   (`assertJsonObjectText` in `src/encoding.js`); this catches a hex string,
 *   a bare number, a `\ud800` escape or a `1e400` passed by mistake before it
 *   is signed.
 *
 * Anything else (array, number, boolean, `null`, `undefined`) is rejected: 4.x
 * JSON-encoded whatever it received, which put `{"type":"Buffer",...}` on the
 * wire for a Buffer and `"..."` (a JSON string, refused by the node) for a
 * string.
 * @param {Buffer|Uint8Array|object|string} args
 * @returns {Buffer} the raw `Vec<u8>` payload (without its length prefix)
 * @throws {TypeError} unsupported type, non-JSON string or unserialisable object
 * @throws {RangeError} lone UTF-16 surrogate, non-finite number, integer `number` above 2^53-1,
 *   `bigint` outside `-2^63..2^64-1`, nesting deeper than 127
 */
function contractCallArgsBytes(args) {
  if (isByteArray(args)) {
    return toBytes(args, 'args');
  }
  if (isPlainObject(args)) {
    return Buffer.from(stringifyJson(args, 'args'), 'utf8');
  }
  if (typeof args === 'string') {
    assertString(args, 'args');
    assertJsonObjectText(args, 'contractCall: args', 'ledger.rs:2359-2363', 'pass a Buffer/Uint8Array for raw bytes');
    return Buffer.from(args, 'utf8');
  }
  throw new TypeError(
    'contractCall: args must be a Buffer/Uint8Array (raw bytes) or a plain object (JSON)',
  );
}

// ---------------------------------------------------------------------------
// Token instructions (variants 0-3)
// ---------------------------------------------------------------------------

/**
 * TokenMint (variant 0, `token.rs:32-36`): credit `amount` base units of
 * `tokenId` to `to`.
 *
 * Node rules, not enforced here: signer must equal the token's `mint_authority`
 * (`token.rs:1080`); `amount > 0` (`token.rs:1057`; refused at ingress,
 * `ledger.rs:1420`); launchpad-managed tokens cannot be minted (`token.rs:1076`);
 * `current_supply + amount <= max_supply` (`token.rs:1084-1088`); RWA holder
 * gate on `to` (`token.rs:1066`).
 * @param {string} tokenId token identifier
 * @param {string} to recipient address
 * @param {number|bigint} amount base units of the token
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function tokenMint(tokenId, to, amount) {
  assertArity(arguments.length, 3, 'Instructions.tokenMint', 'tokenId, to, amount');
  return concat([
    encodeVariant(IDX.TokenMint),
    encodeString(tokenId, 'tokenId'),
    encodeString(to, 'to'),
    encodeU64(amount, 'amount'),
  ]);
}

/**
 * TokenTransfer (variant 1, `token.rs:38-43`): move `amount` base units of
 * `tokenId` from `from` to `to`.
 *
 * Node rules, not enforced here: token must exist (`token.rs:1101`); signer must
 * equal `from` (`token.rs:1104`); `from != to` (`token.rs:1111`); `amount > 0`
 * (`token.rs:1114`); RWA status/holder gate on `to` (`token.rs:1122`).
 * @param {string} tokenId token identifier
 * @param {string} from sender address (the signer)
 * @param {string} to recipient address
 * @param {number|bigint} amount base units of the token
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function tokenTransfer(tokenId, from, to, amount) {
  assertArity(arguments.length, 4, 'Instructions.tokenTransfer', 'tokenId, from, to, amount');
  return concat([
    encodeVariant(IDX.TokenTransfer),
    encodeString(tokenId, 'tokenId'),
    encodeString(from, 'from'),
    encodeString(to, 'to'),
    encodeU64(amount, 'amount'),
  ]);
}

/**
 * TokenBurn (variant 2, `token.rs:45-49`): destroy `amount` base units of
 * `tokenId` held by `from`, reducing supply.
 *
 * Node rules, not enforced here: token must exist (`token.rs:1148`); signer must
 * equal `from` (`token.rs:1151`); `amount > 0` (`token.rs:1157`); balance and
 * supply must cover the burn (`token.rs:1167-1172`).
 * @param {string} tokenId token identifier
 * @param {string} from holder address (the signer)
 * @param {number|bigint} amount base units of the token
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function tokenBurn(tokenId, from, amount) {
  assertArity(arguments.length, 3, 'Instructions.tokenBurn', 'tokenId, from, amount');
  return concat([
    encodeVariant(IDX.TokenBurn),
    encodeString(tokenId, 'tokenId'),
    encodeString(from, 'from'),
    encodeU64(amount, 'amount'),
  ]);
}

/**
 * TokenCreate (variant 3, `token.rs:51-58`): register a new token.
 *
 * Node rules, not enforced here: `tokenId` must not exist (`token.rs:1032`);
 * signer must equal `mintAuthority` (`token.rs:1036`). The token is created with
 * `MintPolicy::Standard` and zero supply (`token.rs:1040-1050`).
 * @param {string} tokenId token identifier
 * @param {string} name display name
 * @param {string} symbol ticker symbol
 * @param {number|bigint} decimals `u8`, number of decimal places (0..=255)
 * @param {number|bigint} maxSupply `u64`, maximum supply in base units
 * @param {string} mintAuthority address allowed to mint (must be the signer)
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function tokenCreate(tokenId, name, symbol, decimals, maxSupply, mintAuthority) {
  assertArity(arguments.length, 6, 'Instructions.tokenCreate',
    'tokenId, name, symbol, decimals, maxSupply, mintAuthority');
  return concat([
    encodeVariant(IDX.TokenCreate),
    encodeString(tokenId, 'tokenId'),
    encodeString(name, 'name'),
    encodeString(symbol, 'symbol'),
    encodeU8(decimals, 'decimals'),
    encodeU64(maxSupply, 'maxSupply'),
    encodeString(mintAuthority, 'mintAuthority'),
  ]);
}

// ---------------------------------------------------------------------------
// Contract instructions (variants 4-5)
// ---------------------------------------------------------------------------

/**
 * ContractCall (variant 4, `token.rs:60-64`): invoke `method` on the deployed
 * contract `contractId` with `args` as the `Vec<u8>` payload.
 *
 * `args` accepts raw bytes (`Buffer | Uint8Array`, used verbatim), a plain
 * object (JSON-serialised) or a string of JSON text that parses as an object
 * (sent byte-for-byte). See `contractCallArgsBytes` for the node's payload
 * rules (`ledger.rs:2359-2370`): every method except the 16-byte Swap form must
 * receive a JSON object, so a method with no parameters is called with `{}`.
 *
 * Node rules, not enforced here: protected protocol-registry methods are
 * refused through generic ContractCall (`ledger.rs:5833`, table at
 * `ledger.rs:2184-2320`); each contract method authorises the signer itself
 * (`ledger.rs:5910`).
 * @param {string} contractId contract identifier
 * @param {string} method method name
 * @param {Buffer|Uint8Array|object|string} args raw bytes, a JSON object, or JSON text of an object
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type, `args` has an unsupported shape, or a string is malformed
 */
function contractCall(contractId, method, args) {
  assertArity(arguments.length, 3, 'Instructions.contractCall', 'contractId, method, args');
  return concat([
    encodeVariant(IDX.ContractCall),
    encodeString(contractId, 'contractId'),
    encodeString(method, 'method'),
    encodeBytes(contractCallArgsBytes(args), 'args'),
  ]);
}

/**
 * ContractDeploy (variant 5, `token.rs:66-70`): deploy a contract of type
 * `contractTypeStr` under `contractId` with constructor parameters
 * `paramsJson`.
 *
 * `paramsJson` is the JSON text itself (`params_json: String`); callers holding
 * an object pass `stringifyJson(params)`. The node parses it with
 * `serde_json::from_str(params_json).unwrap_or(json!({}))` (`ledger.rs:6187`):
 * text it cannot parse is silently replaced by `{}`, and the contract is then
 * built from defaults or fails in the block after the fee is charged. Like
 * every builder here this one only encodes (any well-formed string is a valid
 * `String` field), but the transaction layer refuses to sign a ContractDeploy
 * whose `params_json` is not JSON text of an object that serde_json reads
 * unchanged (`buildTransaction` → `assertTransactionSemantics` in
 * `src/transaction.js`), so it never reaches the node through the SDK.
 *
 * Node rules, not enforced here: `contractId` must not exist (`ledger.rs:6162`)
 * and must not use a reserved namespace (prefixes `xeris_`, `identity_`,
 * `agent_registry_`, `__`, suffix `_xrs_pool`; `ledger.rs:1524-1530, 6171`);
 * `contractTypeStr` is matched case-insensitively against the aliases in
 * `ContractType::from_str` (`contracts.rs:385-411`), an unknown type is skipped
 * (`ledger.rs:6237`); protocol-managed registry types cannot be user-deployed
 * (`ledger.rs:2344-2349, 6182`). The signer becomes the contract owner
 * (`ledger.rs:6189`).
 * @param {string} contractId contract identifier
 * @param {string} contractTypeStr contract type alias, e.g. `'swap'`, `'launchpad'`
 * @param {string} paramsJson constructor parameters as JSON text of an object
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or contains a lone surrogate
 */
function contractDeploy(contractId, contractTypeStr, paramsJson) {
  assertArity(arguments.length, 3, 'Instructions.contractDeploy',
    'contractId, contractTypeStr, paramsJson');
  return concat([
    encodeVariant(IDX.ContractDeploy),
    encodeString(contractId, 'contractId'),
    encodeString(contractTypeStr, 'contractTypeStr'),
    encodeString(paramsJson, 'paramsJson'),
  ]);
}

// ---------------------------------------------------------------------------
// RWA token instructions (variants 6-8)
// ---------------------------------------------------------------------------

/**
 * TokenCreateRWA (variant 6, `token.rs:83-104`): register a token carrying RWA
 * metadata (legal document hash and URI, jurisdiction, compliance flags,
 * valuation).
 *
 * Node rules, not enforced here: `tokenId` must not exist (`token.rs:1211`);
 * `legalDocHash` must be non-empty (`token.rs:1214`); `assetType` must be one of
 * `real_estate, equity, debt, commodity, ip, collectible, fund, bond`
 * (`token.rs:1217`); signer must equal `mintAuthority` (`token.rs:1225`). The
 * token starts with status `"active"` and `mintAuthority` as the only approved
 * holder (`token.rs:1244-1248`).
 * @param {string} tokenId token identifier
 * @param {string} name display name
 * @param {string} symbol ticker symbol
 * @param {number|bigint} decimals `u8`, number of decimal places (0..=255)
 * @param {number|bigint} maxSupply `u64`, maximum supply in base units
 * @param {string} mintAuthority issuer address (must be the signer)
 * @param {string} assetType asset class string
 * @param {string} legalDocHash SHA-256 hex of the legal document
 * @param {string} legalDocUri URI of the legal document
 * @param {string} jurisdiction jurisdiction code, e.g. `'US-WY'`
 * @param {boolean} transferRestricted true if transfers require issuer approval
 * @param {boolean} accreditedOnly true if only accredited holders are allowed
 * @param {number|bigint} valuation `u64`, appraised value in USD cents
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function tokenCreateRWA(
  tokenId, name, symbol, decimals, maxSupply, mintAuthority,
  assetType, legalDocHash, legalDocUri, jurisdiction,
  transferRestricted, accreditedOnly, valuation,
) {
  assertArity(arguments.length, 13, 'Instructions.tokenCreateRWA',
    'tokenId, name, symbol, decimals, maxSupply, mintAuthority, assetType, legalDocHash, '
    + 'legalDocUri, jurisdiction, transferRestricted, accreditedOnly, valuation');
  return concat([
    encodeVariant(IDX.TokenCreateRWA),
    encodeString(tokenId, 'tokenId'),
    encodeString(name, 'name'),
    encodeString(symbol, 'symbol'),
    encodeU8(decimals, 'decimals'),
    encodeU64(maxSupply, 'maxSupply'),
    encodeString(mintAuthority, 'mintAuthority'),
    encodeString(assetType, 'assetType'),
    encodeString(legalDocHash, 'legalDocHash'),
    encodeString(legalDocUri, 'legalDocUri'),
    encodeString(jurisdiction, 'jurisdiction'),
    encodeBool(transferRestricted, 'transferRestricted'),
    encodeBool(accreditedOnly, 'accreditedOnly'),
    encodeU64(valuation, 'valuation'),
  ]);
}

/**
 * RWAUpdateStatus (variant 7, `token.rs:108-114`): set the status of an RWA
 * token and optionally replace its valuation, legal document hash or URI.
 *
 * `null`/`undefined` encodes `None` (the node keeps the current value,
 * `token.rs:1281-1289`); any other value, including `0` or `''`, encodes
 * `Some`.
 *
 * Node rules, not enforced here: token must exist and be an RWA token
 * (`token.rs:1261-1265`); signer must equal the token's `mint_authority`
 * (`token.rs:1268`); `newStatus` must be one of `active, frozen, redeemed,
 * disputed, revoked` (`token.rs:1272`).
 * @param {string} tokenId token identifier
 * @param {string} newStatus new status string
 * @param {number|bigint|null|undefined} newValuation `Option<u64>`, USD cents
 * @param {string|null|undefined} newLegalDocHash `Option<String>`
 * @param {string|null|undefined} newLegalDocUri `Option<String>`
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function rwaUpdateStatus(tokenId, newStatus, newValuation, newLegalDocHash, newLegalDocUri) {
  assertArity(arguments.length, 5, 'Instructions.rwaUpdateStatus',
    'tokenId, newStatus, newValuation, newLegalDocHash, newLegalDocUri');
  return concat([
    encodeVariant(IDX.RWAUpdateStatus),
    encodeString(tokenId, 'tokenId'),
    encodeString(newStatus, 'newStatus'),
    encodeOption(newValuation, encodeU64, 'newValuation'),
    encodeOption(newLegalDocHash, encodeString, 'newLegalDocHash'),
    encodeOption(newLegalDocUri, encodeString, 'newLegalDocUri'),
  ]);
}

/**
 * RWATransfer (variant 8, `token.rs:118-123`): move `amount` base units of an
 * RWA token from `from` to `to` through the compliance gate.
 *
 * Node rules, not enforced here: `amount > 0` and `from != to`
 * (`token.rs:1297-1302`; refused at ingress, `ledger.rs:1423-1427`); signer must
 * equal `from` (`token.rs:1306`); status and approved-holder gate on `to`
 * (`token.rs:1315`).
 * @param {string} tokenId RWA token identifier
 * @param {string} from sender address (the signer)
 * @param {string} to recipient address
 * @param {number|bigint} amount base units of the token
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function rwaTransfer(tokenId, from, to, amount) {
  assertArity(arguments.length, 4, 'Instructions.rwaTransfer', 'tokenId, from, to, amount');
  return concat([
    encodeVariant(IDX.RWATransfer),
    encodeString(tokenId, 'tokenId'),
    encodeString(from, 'from'),
    encodeString(to, 'to'),
    encodeU64(amount, 'amount'),
  ]);
}

// ---------------------------------------------------------------------------
// Staking (variants 9-10)
// ---------------------------------------------------------------------------

/**
 * Stake (variant 9, `token.rs:132-135`): move `amount` lamports from the
 * signer's balance into stake.
 *
 * Node rules, not enforced here: signer must equal `pubkey` (`ledger.rs:5687`),
 * which must parse as a public key (`ledger.rs:5699`); `amount > 0`
 * (`ledger.rs:5709`); the resulting stake must be at least `MIN_STAKE_TO_MINE`
 * = 1,000 XRS (`ledger.rs:232, 5713-5718`). On a federated node a Stake whose
 * `pubkey` is not in the producer roster is refused ("Public self-staking is
 * closed during federated beta", `network.rs:2407-2417`).
 * @param {string} pubkey staker address (must be the signer)
 * @param {number|bigint} amount lamports
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function stake(pubkey, amount) {
  assertArity(arguments.length, 2, 'Instructions.stake', 'pubkey, amount');
  return concat([
    encodeVariant(IDX.Stake),
    encodeString(pubkey, 'pubkey'),
    encodeU64(amount, 'amount'),
  ]);
}

/**
 * Unstake (variant 10, `token.rs:139-142`): move `amount` lamports from stake
 * into the unbonding queue.
 *
 * Node rules, not enforced here: signer must equal `pubkey` (`ledger.rs:5738`);
 * `amount > 0` (`ledger.rs:5755`); a partial unstake must be at least
 * `MIN_UNSTAKE_AMOUNT` = 1 XRS unless it exits the full stake
 * (`ledger.rs:210, 5759`); the remainder must be 0 or at least
 * `MIN_STAKE_TO_MINE` (`ledger.rs:5772-5776`); at most 10 pending entries per
 * account (`ledger.rs:5789-5798`); funds unlock after `UNBONDING_PERIOD_SLOTS`
 * = 151,200 slots (`ledger.rs:201, 5818`).
 * @param {string} pubkey staker address (must be the signer)
 * @param {number|bigint} amount lamports
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function unstake(pubkey, amount) {
  assertArity(arguments.length, 2, 'Instructions.unstake', 'pubkey, amount');
  return concat([
    encodeVariant(IDX.Unstake),
    encodeString(pubkey, 'pubkey'),
    encodeU64(amount, 'amount'),
  ]);
}

// ---------------------------------------------------------------------------
// Native transfer and attestation (variants 11-12)
// ---------------------------------------------------------------------------

/**
 * NativeTransfer (variant 11, `token.rs:152-156`): move `amount` lamports of
 * native XRS from `from` to `to`.
 *
 * Node rules, not enforced here: signer must equal `from` (`ledger.rs:5594`);
 * `amount > 0` and `to` must be a canonical base58 public key that is not a
 * `__*` protocol pseudo-account (`ledger.rs:1562-1577`; checked at ingress,
 * `ledger.rs:1417-1419`, and in the block, `ledger.rs:5602-5607`); sender balance
 * must cover `amount` (`ledger.rs:5612`).
 * @param {string} from sender address (the signer)
 * @param {string} to recipient address
 * @param {number|bigint} amount lamports
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function nativeTransfer(from, to, amount) {
  assertArity(arguments.length, 3, 'Instructions.nativeTransfer', 'from, to, amount');
  return concat([
    encodeVariant(IDX.NativeTransfer),
    encodeString(from, 'from'),
    encodeString(to, 'to'),
    encodeU64(amount, 'amount'),
  ]);
}

/**
 * ValidatorAttestation (variant 12, `token.rs:166-173`): claim the attestation
 * reward for having verified the block at `blockSlot`.
 *
 * `blockHashPrefix` is encoded as the `Vec<u8>` it is declared as; this builder
 * accepts any length. The node refuses the transaction at ingress unless it is
 * exactly 32 bytes (`ledger.rs:1400`) and `validator` equals the signer
 * (`ledger.rs:1407`); in the block the 32 bytes must equal the hash of the
 * block at `blockSlot` (`ledger.rs:6278-6286`). Further node rules: attestor
 * stake >= 100 XRS (`ledger.rs:6255-6256`), `blockSlot` within
 * `ATTESTATION_SLOT_WINDOW` = 200 slots of the current slot (`ledger.rs:218,
 * 6263`), one reward per validator per 10 blocks (`ledger.rs:6289-6296`),
 * reward `ATTESTATION_REWARD` = 10,000,000 lamports (`ledger.rs:214, 6307`).
 * @param {string} validator attestor address (must be the signer)
 * @param {number|bigint} blockSlot slot of the verified block
 * @param {Buffer|Uint8Array} blockHashPrefix the block hash (32 bytes for the node to accept it)
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function validatorAttestation(validator, blockSlot, blockHashPrefix) {
  assertArity(arguments.length, 3, 'Instructions.validatorAttestation',
    'validator, blockSlot, blockHashPrefix');
  return concat([
    encodeVariant(IDX.ValidatorAttestation),
    encodeString(validator, 'validator'),
    encodeU64(blockSlot, 'blockSlot'),
    encodeBytes(blockHashPrefix, 'blockHashPrefix'),
  ]);
}

// ---------------------------------------------------------------------------
// Wrap / unwrap (variants 13-14)
// ---------------------------------------------------------------------------

/**
 * WrapXrs (variant 13, `token.rs:184-186`): convert `amount` lamports of the
 * signer's native balance into the `xrs_native` token balance.
 *
 * Node rules, not enforced here: `amount > 0` (`ledger.rs:5632`); native balance
 * must cover `amount` (`ledger.rs:5637`). The signer is implicit
 * (`ledger.rs:5631-5657`).
 * @param {number|bigint} amount lamports
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} `amount` has the wrong type or is out of range
 */
function wrapXrs(amount) {
  assertArity(arguments.length, 1, 'Instructions.wrapXrs', 'amount');
  return concat([
    encodeVariant(IDX.WrapXrs),
    encodeU64(amount, 'amount'),
  ]);
}

/**
 * UnwrapXrs (variant 14, `token.rs:191-193`): convert `amount` of the signer's
 * `xrs_native` token balance back into native lamports.
 *
 * Node rules, not enforced here: `amount > 0` (`ledger.rs:5659`); `xrs_native`
 * balance must cover `amount` (`ledger.rs:5665`). The signer is implicit
 * (`ledger.rs:5658-5684`).
 * @param {number|bigint} amount base units of `xrs_native` (= lamports)
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} `amount` has the wrong type or is out of range
 */
function unwrapXrs(amount) {
  assertArity(arguments.length, 1, 'Instructions.unwrapXrs', 'amount');
  return concat([
    encodeVariant(IDX.UnwrapXrs),
    encodeU64(amount, 'amount'),
  ]);
}

// ---------------------------------------------------------------------------
// Agent delegation (variants 15-17)
// ---------------------------------------------------------------------------

/**
 * RegisterAgent (variant 15, `token.rs:204-221`): the signer (owner) delegates
 * bounded spending authority to `agentPubkey`.
 *
 * `allowedOperations` entries are matched by exact string equality against the
 * operation names the node derives from the inner instruction of an
 * AgentExecute: `NativeTransfer, TokenTransfer, ContractCall, WrapXrs,
 * UnwrapXrs, Stake, Unstake, TokenMint, TokenBurn` (`ledger.rs:6425-6477`;
 * matcher `contracts.rs:3471-3477`). An empty list allows every operation;
 * an empty `allowedContracts` allows every contract (`token.rs:213-217`).
 *
 * Node rules, not enforced here: the owner's registry
 * `agent_registry_<sha256(owner)[..32]>` is auto-created (`ledger.rs:6323-6340`,
 * `1551-1553`); at most 50 agents per registry (`contracts.rs:3334`); a
 * duplicate `agentPubkey` is refused (`contracts.rs:3337`). `expiresAtSlot = 0`
 * means no expiry (`token.rs:219-220`).
 * @param {string} agentName display name
 * @param {string} agentPubkey the agent's signing address
 * @param {number|bigint} maxPerTx lamports per AgentExecute
 * @param {number|bigint} maxDaily lamports per 21,600-slot window (`contracts.rs:3439`)
 * @param {string[]} allowedContracts contract ids the agent may call (empty = all)
 * @param {string[]} allowedOperations operation names (empty = all)
 * @param {number|bigint} expiresAtSlot expiry slot (0 = none)
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function registerAgent(
  agentName, agentPubkey, maxPerTx, maxDaily, allowedContracts, allowedOperations, expiresAtSlot,
) {
  assertArity(arguments.length, 7, 'Instructions.registerAgent',
    'agentName, agentPubkey, maxPerTx, maxDaily, allowedContracts, allowedOperations, expiresAtSlot');
  return concat([
    encodeVariant(IDX.RegisterAgent),
    encodeString(agentName, 'agentName'),
    encodeString(agentPubkey, 'agentPubkey'),
    encodeU64(maxPerTx, 'maxPerTx'),
    encodeU64(maxDaily, 'maxDaily'),
    encodeStringVec(allowedContracts, 'allowedContracts'),
    encodeStringVec(allowedOperations, 'allowedOperations'),
    encodeU64(expiresAtSlot, 'expiresAtSlot'),
  ]);
}

/**
 * UpdateAgent (variant 16, `token.rs:225-240`): change an agent's limits or
 * revoke it.
 *
 * `null`/`undefined` encodes `None` (the node keeps the current value,
 * `ledger.rs:6375-6379`); any other value, including `0` or `[]`, encodes
 * `Some`. `revoked: true` disables the agent immediately (`token.rs:239`).
 *
 * Node rules, not enforced here: the signer must own the registry
 * (`contracts.rs:3363`) and it must already exist (`ledger.rs:6381-6391`);
 * `newAllowedOperations` entries follow the `registerAgent` matcher rules.
 * @param {string} agentPubkey the agent to update
 * @param {number|bigint|null|undefined} newMaxPerTx `Option<u64>`, lamports
 * @param {number|bigint|null|undefined} newMaxDaily `Option<u64>`, lamports
 * @param {string[]|null|undefined} newAllowedContracts `Option<Vec<String>>`
 * @param {string[]|null|undefined} newAllowedOperations `Option<Vec<String>>`
 * @param {number|bigint|null|undefined} newExpiresAtSlot `Option<u64>`, slot
 * @param {boolean} revoked true to revoke the agent
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function updateAgent(
  agentPubkey, newMaxPerTx, newMaxDaily, newAllowedContracts, newAllowedOperations,
  newExpiresAtSlot, revoked,
) {
  assertArity(arguments.length, 7, 'Instructions.updateAgent',
    'agentPubkey, newMaxPerTx, newMaxDaily, newAllowedContracts, newAllowedOperations, '
    + 'newExpiresAtSlot, revoked');
  return concat([
    encodeVariant(IDX.UpdateAgent),
    encodeString(agentPubkey, 'agentPubkey'),
    encodeOption(newMaxPerTx, encodeU64, 'newMaxPerTx'),
    encodeOption(newMaxDaily, encodeU64, 'newMaxDaily'),
    encodeOption(newAllowedContracts, encodeStringVec, 'newAllowedContracts'),
    encodeOption(newAllowedOperations, encodeStringVec, 'newAllowedOperations'),
    encodeOption(newExpiresAtSlot, encodeU64, 'newExpiresAtSlot'),
    encodeBool(revoked, 'revoked'),
  ]);
}

/**
 * AgentExecute (variant 17, `token.rs:246-253`): the signing agent executes
 * `innerInstruction` (an encoded `XerisInstruction`) with the balances of
 * `ownerPubkey`.
 *
 * The inner bytes are wrapped as `Vec<u8>` and are not inspected here. Node
 * rules, not enforced here (`ledger.rs:6394-6683`): the inner instruction must
 * be one of `NativeTransfer, TokenTransfer, ContractCall, WrapXrs, UnwrapXrs,
 * Stake, Unstake, TokenMint, TokenBurn` (`ledger.rs:6425-6477`); an inner
 * ContractCall must carry JSON-object args (`ledger.rs:6436-6441`), a method
 * with a derivable spend (`ledger.rs:2138-2175, 6443-6466`) and a target that is
 * not an agent registry (`ledger.rs:6429`); a nested AgentExecute or
 * ConditionalOrder is refused at ingress (`ledger.rs:1439-1440`); the agent
 * must be registered, unrevoked, unexpired and within `max_per_tx`/`max_daily`
 * (`contracts.rs:3399-3487`). `XerisClient.checks.agentInner` mirrors these.
 * @param {string} ownerPubkey the delegating owner's address
 * @param {Buffer|Uint8Array} innerInstruction encoded inner `XerisInstruction`
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type
 */
function agentExecute(ownerPubkey, innerInstruction) {
  assertArity(arguments.length, 2, 'Instructions.agentExecute', 'ownerPubkey, innerInstruction');
  return concat([
    encodeVariant(IDX.AgentExecute),
    encodeString(ownerPubkey, 'ownerPubkey'),
    encodeBytes(innerInstruction, 'innerInstruction'),
  ]);
}

// ---------------------------------------------------------------------------
// Helpers built on the variants above
// ---------------------------------------------------------------------------

/**
 * Builds the ContractCall for an AMM swap with the 16-byte binary payload the
 * Swap contract reads: `u64le(inputAmount) ‖ u64le(minOutput)`
 * (`contracts.rs:2419-2441` for `swap_a_to_b`, `2484-2499` for `swap_b_to_a`).
 * The dispatcher forwards these bytes unchanged only when the target is a Swap
 * contract, the method is one of the two swap methods and the payload is
 * exactly 16 bytes (`ledger.rs:2367-2370`); a JSON payload would be read as
 * bytes by the engine, so swaps must use this form.
 *
 * Node rules, not enforced here: `inputAmount > 0` (`contracts.rs:2422`);
 * `minOutput` is the slippage floor and is required (`contracts.rs:2430-2441`);
 * the signer must hold the input token balance (`contracts.rs:2442-2444`).
 * @param {string} contractId the Swap pool contract id
 * @param {'swap_a_to_b'|'swap_b_to_a'} method swap direction
 * @param {number|bigint} inputAmount base units of the input token
 * @param {number|bigint} minOutput minimum acceptable base units of the output token
 * @returns {Buffer} encoded ContractCall instruction (variant 4)
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError} a field has the wrong type
 * @throws {RangeError} `method` is not a swap method, or an amount is out of range
 */
function encodeSwapCall(contractId, method, inputAmount, minOutput) {
  assertArity(arguments.length, 4, 'encodeSwapCall', 'contractId, method, inputAmount, minOutput');
  assertString(method, 'method');
  if (!SWAP_METHODS.includes(method)) {
    throw new RangeError(
      `method: expected 'swap_a_to_b' or 'swap_b_to_a' (contracts.rs:2419, 2484), got ${JSON.stringify(method)}`,
    );
  }
  const args = concat([
    encodeU64(inputAmount, 'inputAmount'),
    encodeU64(minOutput, 'minOutput'),
  ]);
  return contractCall(contractId, method, args);
}

/**
 * The 18 builders for variants 0-17, keyed by camelCase builder name.
 * Aggregated into `Instructions` by `src/instructions/index.js`.
 * @type {Readonly<Record<string, Function>>}
 */
const core = Object.freeze({
  tokenMint,
  tokenTransfer,
  tokenBurn,
  tokenCreate,
  contractCall,
  contractDeploy,
  tokenCreateRWA,
  rwaUpdateStatus,
  rwaTransfer,
  stake,
  unstake,
  nativeTransfer,
  validatorAttestation,
  wrapXrs,
  unwrapXrs,
  registerAgent,
  updateAgent,
  agentExecute,
});

/**
 * Raw encoders for variants whose public builder throws `FeatureDisabledError`.
 * None of variants 0-17 is disabled on the node, so this is empty; it exists so
 * every instructions module has the same shape.
 * @type {Readonly<{}>}
 */
const _raw = Object.freeze({});

module.exports = { core, encodeSwapCall, _raw };
