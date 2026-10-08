'use strict';

/**
 * @file Builders for `XerisInstruction` variants 18-45 (`token.rs:268-596`,
 * the ARI protocol layer: identity, reputation, messaging, conditional orders,
 * oracles, hardware attestation, capabilities, tasks, models, disputes,
 * slashing, governance, state channels, heartbeats) plus the two canonical
 * state-channel message encoders that counterparties sign off-chain
 * (`contracts.rs:57-109`).
 *
 * Wire format: the node embeds `XerisInstruction` values in transaction
 * instruction `data` with `bincode::serialize` (bincode 1.3.3 default options;
 * serde derive at `token.rs:29`). Each instruction is `u32le(variant index)`
 * followed by the variant's fields in declaration order; strings and `Vec<T>`
 * carry a `u64le` length prefix, `Option<T>` a `0x00`/`0x01` tag, `bool` one
 * byte, `u8`/`u32`/`u64` are 1/4/8 bytes little-endian. The variant index is
 * the declaration position in the enum (`token.rs:30`), so the indices below
 * must never be reordered.
 *
 * These builders are pure wire encoders. They reject only what bincode cannot
 * encode (wrong JavaScript type, integer outside the field's domain, lone UTF-16
 * surrogate, wrong argument count) and never substitute a default for a caller
 * value or apply a node business rule. The node rules that apply to each
 * variant are cited in the builder's JSDoc; `XerisClient` (`src/client.js`)
 * enforces them before any network call. The `zero-values` vectors in
 * `test/vectors.json` (CreateIdentity, AttestReputation, RegisterOracle,
 * RegisterCapability, PostTask, RegisterModel, CreateProposal, OpenChannel)
 * encode empty strings and zeros byte-for-byte; 4.x substituted defaults for
 * them, which is why those builders were rewritten.
 *
 * Integers: `number` must be a safe integer; values above 2^53-1 must be passed
 * as `bigint`. Bytes: `Buffer | Uint8Array` only. `Option<T>` fields take `null`
 * or `undefined` for `None`; `0`, `''` and `[]` are `Some`.
 *
 * Every builder throws `EncodingError` (`code: 'arity'`) when called with the
 * wrong number of arguments: bincode has no field names, so a dropped or extra
 * positional argument would shift every later field on the wire. 4.x omitted
 * `OpenDispute.defendant` and `ForceCloseChannel.counterparty_signature`, and
 * the node could not decode either instruction.
 *
 * Variant 22 (`SubDelegate`) is refused by the node at ingress
 * (`ledger.rs:1445-1450`) and skipped in blocks (`ledger.rs:6911-6914`); the
 * public `subDelegate` throws `FeatureDisabledError` and the raw encoder is
 * exported as `_raw.subDelegate` for wire-format tests only.
 */

const {
  assertString,
  concat,
  encodeBool,
  encodeBytes,
  encodeOption,
  encodeString,
  encodeStringVec,
  encodeU32,
  encodeU64,
  encodeU8,
  encodeVariant,
  toBytes,
} = require('../encoding');
const { Buffer } = require('buffer');
const { EncodingError, disabledFeature } = require('../errors');
const { CHANNEL_STATE_TAG, CHANNEL_CLOSE_TAG } = require('../constants');

/** Domain tag of the hardware-attestation challenge (`ledger.rs:5310`). */
const HW_ATTEST_TAG = 'XRS_HW_ATTEST_V2';
// bs58 is used only by the channel message helpers, to mirror
// `id.parse::<solana_sdk::pubkey::Pubkey>()` in `push_identity` (contracts.rs:21-30).
const bs58 = require('bs58');

// Variant indices = declaration order of `enum XerisInstruction` (token.rs:30).
// The line cited on each entry is the variant's declaration.
const IDX = Object.freeze({
  CreateIdentity: 18, // token.rs:268
  UpdateIdentity: 19, // token.rs:282
  AttestReputation: 20, // token.rs:290
  AgentMessage: 21, // token.rs:300
  SubDelegate: 22, // token.rs:311
  ConditionalOrder: 23, // token.rs:325
  CancelConditionalOrder: 24, // token.rs:336
  RegisterOracle: 25, // token.rs:343
  OracleSubmit: 26, // token.rs:352
  HardwareAttest: 27, // token.rs:361
  RegisterCapability: 28, // token.rs:375
  UpdateCapability: 29, // token.rs:396
  QueryCapabilities: 30, // token.rs:414
  PostTask: 31, // token.rs:427
  ClaimTask: 32, // token.rs:456
  ResolveTask: 33, // token.rs:463
  RegisterModel: 34, // token.rs:477
  UpdateModel: 35, // token.rs:489
  OpenDispute: 36, // token.rs:499
  ResolveDispute: 37, // token.rs:517
  SlashReport: 38, // token.rs:524
  CreateProposal: 39, // token.rs:533
  CastVote: 40, // token.rs:544
  ExecuteProposal: 41, // token.rs:550
  OpenChannel: 42, // token.rs:555
  CloseChannel: 43, // token.rs:564
  ForceCloseChannel: 44, // token.rs:581
  AgentHeartbeat: 45, // token.rs:590
});

// `solana_sdk::pubkey::Pubkey::from_str` (solana-pubkey 2.4.0, Cargo.lock:3849)
// rejects inputs longer than MAX_BASE58_LEN = 44 before decoding, then requires
// the base58 decode (Bitcoin alphabet) to be exactly 32 bytes.
const MAX_BASE58_PUBKEY_LEN = 44;
const PUBKEY_LEN = 32;

/**
 * Throws when a builder is called with the wrong number of arguments.
 * @param {number} actual `arguments.length` of the caller
 * @param {number} expected the variant's field count
 * @param {string} qualifiedName name shown in the message, e.g. `Instructions.createIdentity`
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

// ---------------------------------------------------------------------------
// Identity and reputation (variants 18-20)
// ---------------------------------------------------------------------------

/**
 * CreateIdentity (variant 18, `token.rs:268-279`): create the on-chain identity
 * contract `identity_<sha256(identityPubkey)[..32]>` (`ledger.rs:1545-1547`)
 * for `identityPubkey`.
 *
 * Node rules, not enforced here: signer must equal `identityPubkey`
 * (`ledger.rs:6690`); `identityType` must be one of `agent, device, service,
 * human` (`ledger.rs:6696`); `metadataJson` at most 4096 bytes
 * (`ledger.rs:6702`); `displayName` at most 128 bytes (`ledger.rs:6706`); a
 * non-empty `parentIdentity` must be a required co-signer of the transaction
 * (`ledger.rs:6717-6727`, XWC-18), which a single-signer `sendInstruction`
 * cannot provide, so `XerisClient.createIdentity` always sends `''`; an
 * identity that already exists is logged and skipped (`ledger.rs:6757`). The
 * identity gates AttestReputation, AgentMessage, RegisterCapability,
 * ClaimTask, RegisterModel, AgentHeartbeat and bound HardwareAttest
 * (`has_active_identity`, `ledger.rs:1582`).
 * @param {string} identityPubkey address the identity is bound to (must be the signer)
 * @param {string} displayName display name
 * @param {string} identityType identity type string
 * @param {string} parentIdentity parent identity address, `''` for a root identity
 * @param {string} metadataJson metadata as JSON text
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or contains a lone surrogate
 */
function createIdentity(identityPubkey, displayName, identityType, parentIdentity, metadataJson) {
  assertArity(arguments.length, 5, 'Instructions.createIdentity',
    'identityPubkey, displayName, identityType, parentIdentity, metadataJson');
  return concat([
    encodeVariant(IDX.CreateIdentity),
    encodeString(identityPubkey, 'identityPubkey'),
    encodeString(displayName, 'displayName'),
    encodeString(identityType, 'identityType'),
    encodeString(parentIdentity, 'parentIdentity'),
    encodeString(metadataJson, 'metadataJson'),
  ]);
}

/**
 * UpdateIdentity (variant 19, `token.rs:282-287`): change an identity's display
 * name or metadata, or deactivate it.
 *
 * `null`/`undefined` encodes `None` (the node keeps the current value,
 * `ledger.rs:6797-6799`); any other value, including `''`, encodes `Some`.
 *
 * Node rules, not enforced here: the identity contract must exist
 * (`ledger.rs:6801`); the engine's `update` method requires the signer to be
 * the identity (`contracts.rs:3546`); `deactivated: true` sets the identity
 * inactive and `false` does not reactivate it (`contracts.rs:3558-3560`).
 * @param {string} identityPubkey the identity to update (the signer)
 * @param {string|null|undefined} newDisplayName `Option<String>`
 * @param {string|null|undefined} newMetadata `Option<String>`, JSON text
 * @param {boolean} deactivated true to deactivate the identity
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or contains a lone surrogate
 */
function updateIdentity(identityPubkey, newDisplayName, newMetadata, deactivated) {
  assertArity(arguments.length, 4, 'Instructions.updateIdentity',
    'identityPubkey, newDisplayName, newMetadata, deactivated');
  return concat([
    encodeVariant(IDX.UpdateIdentity),
    encodeString(identityPubkey, 'identityPubkey'),
    encodeOption(newDisplayName, encodeString, 'newDisplayName'),
    encodeOption(newMetadata, encodeString, 'newMetadata'),
    encodeBool(deactivated, 'deactivated'),
  ]);
}

/**
 * AttestReputation (variant 20, `token.rs:290-295`): record a reputation score
 * for another identity in `category`.
 *
 * `score` is encoded exactly as given (`u8`, 0..=255). The node clamps it to
 * 100 (`contracts.rs:3568`); `XerisClient.attestReputation` refuses values
 * above 100 instead of letting the node alter what was signed.
 *
 * Node rules, not enforced here: the signer must have an active identity
 * (`ledger.rs:6811-6818`); `category` must be one of `reliability, accuracy,
 * speed, honesty, safety, general` (`ledger.rs:6820`); `evidence` at most 512
 * bytes (`ledger.rs:6826`); the subject identity must exist
 * (`ledger.rs:6830-6838`); self-attestation is refused (`contracts.rs:3572`).
 * @param {string} subjectPubkey identity being rated
 * @param {number|bigint} score `u8`, 0..=255 (node clamps to 100)
 * @param {string} category reputation category
 * @param {string} evidence free-text or reference evidence
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function attestReputation(subjectPubkey, score, category, evidence) {
  assertArity(arguments.length, 4, 'Instructions.attestReputation',
    'subjectPubkey, score, category, evidence');
  return concat([
    encodeVariant(IDX.AttestReputation),
    encodeString(subjectPubkey, 'subjectPubkey'),
    encodeU8(score, 'score'),
    encodeString(category, 'category'),
    encodeString(evidence, 'evidence'),
  ]);
}

// ---------------------------------------------------------------------------
// Inter-agent messaging (variant 21)
// ---------------------------------------------------------------------------

/**
 * AgentMessage (variant 21, `token.rs:300-306`): publish a message to another
 * identity. The node validates and accepts it but writes no contract state;
 * the message exists only in the block and is read back through the explorer
 * (`ledger.rs:6865-6870`).
 *
 * Node rules, not enforced here: `messageType` must be one of `proposal,
 * counteroffer, accept, reject, info, request` (`ledger.rs:6846`);
 * `payloadJson` at most 8192 bytes (`ledger.rs:6852`); the signer must have an
 * active identity (`ledger.rs:6857-6864`).
 * @param {string} toIdentity recipient identity address
 * @param {string} messageType message type string
 * @param {string} payloadJson payload as JSON text
 * @param {string} replyTo signature or id of the message being answered, `''` if none
 * @param {number|bigint} expiresAtSlot slot after which the message is stale (informational)
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function agentMessage(toIdentity, messageType, payloadJson, replyTo, expiresAtSlot) {
  assertArity(arguments.length, 5, 'Instructions.agentMessage',
    'toIdentity, messageType, payloadJson, replyTo, expiresAtSlot');
  return concat([
    encodeVariant(IDX.AgentMessage),
    encodeString(toIdentity, 'toIdentity'),
    encodeString(messageType, 'messageType'),
    encodeString(payloadJson, 'payloadJson'),
    encodeString(replyTo, 'replyTo'),
    encodeU64(expiresAtSlot, 'expiresAtSlot'),
  ]);
}

// ---------------------------------------------------------------------------
// Hierarchical delegation (variant 22) — disabled on the node
// ---------------------------------------------------------------------------

/**
 * Raw encoder for SubDelegate (variant 22, `token.rs:311-320`). Wire-exact,
 * kept only so `test/vectors.json` can be asserted; it is not reachable through
 * `Instructions` and is not re-exported by `index.js`.
 *
 * The node refuses this variant at ingress with `"SubDelegate is disabled
 * (XWC-82)"` (`ledger.rs:1445-1450`) and skips it in blocks
 * (`ledger.rs:6911-6914`), so bytes produced here can never execute.
 * `transaction.assertInstructionSubmittable` and `XerisClient.sendInstruction`
 * reject variant 22 as well.
 * @param {string} subAgentPubkey the sub-agent's signing address
 * @param {string} subAgentName display name
 * @param {number|bigint} maxPerTx lamports per transaction
 * @param {number|bigint} maxDaily lamports per daily window
 * @param {string[]} allowedContracts contract ids
 * @param {string[]} allowedOperations operation names
 * @param {number|bigint} expiresAtSlot expiry slot
 * @param {number|bigint} maxDepth `u8`, delegation depth
 * @returns {Buffer} encoded instruction (undecodable by the node's dispatcher path, see above)
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function rawSubDelegate(
  subAgentPubkey, subAgentName, maxPerTx, maxDaily, allowedContracts, allowedOperations,
  expiresAtSlot, maxDepth,
) {
  assertArity(arguments.length, 8, '_raw.subDelegate',
    'subAgentPubkey, subAgentName, maxPerTx, maxDaily, allowedContracts, allowedOperations, '
    + 'expiresAtSlot, maxDepth');
  return concat([
    encodeVariant(IDX.SubDelegate),
    encodeString(subAgentPubkey, 'subAgentPubkey'),
    encodeString(subAgentName, 'subAgentName'),
    encodeU64(maxPerTx, 'maxPerTx'),
    encodeU64(maxDaily, 'maxDaily'),
    encodeStringVec(allowedContracts, 'allowedContracts'),
    encodeStringVec(allowedOperations, 'allowedOperations'),
    encodeU64(expiresAtSlot, 'expiresAtSlot'),
    encodeU8(maxDepth, 'maxDepth'),
  ]);
}

/**
 * SubDelegate (variant 22, `token.rs:311-320`) is disabled on the node: the
 * ingress validator returns `"SubDelegate is disabled (XWC-82)"`
 * (`ledger.rs:1445-1450`) and the block dispatcher skips the variant
 * (`ledger.rs:6911-6914`). This function always throws, synchronously, before
 * reading any argument; `XerisClient.subDelegate` and `XerisAgent.subDelegate`
 * throw the same error and never touch the network. Register each agent
 * directly with `registerAgent` (variant 15) instead.
 * @returns {never}
 * @throws {FeatureDisabledError} always (`feature: 'SubDelegate'`)
 */
function subDelegate() {
  throw disabledFeature('SubDelegate');
}

// ---------------------------------------------------------------------------
// Conditional execution (variants 23-24)
// ---------------------------------------------------------------------------

/**
 * ConditionalOrder (variant 23, `token.rs:325-333`): escrow `lockedAmount`
 * lamports and register `innerInstruction` (an encoded `XerisInstruction`) to
 * execute once `conditionType` on `conditionSource` crosses
 * `conditionThreshold`.
 *
 * The inner bytes are wrapped as `Vec<u8>` and are not inspected here. Node
 * rules, not enforced here: `conditionType` must be one of `price_above,
 * price_below, balance_above, balance_below, slot_reached, oracle_value`
 * (`ledger.rs:6918`); the inner bytes must decode as a `XerisInstruction`
 * (`ledger.rs:6924`) and may not be AgentExecute or ConditionalOrder
 * (ingress, `ledger.rs:1429-1440`); `block.slot < expiresAtSlot <= block.slot +
 * MAX_ORDER_LIFETIME_SLOTS` = 650,000 (`ledger.rs:6929-6940, 1295`); inner
 * bytes at most 2048 (`ledger.rs:6942`); an `oracle_value` order needs an
 * existing active feed (`ledger.rs:6960-6978`, XWC-88); price orders need a
 * deployed Swap pool (`ledger.rs:6986-6994`); `lockedAmount >=
 * ORDER_STORAGE_BOND` = 10,000,000 lamports (`ledger.rs:6998, 1290`); an inner
 * NativeTransfer must name a canonical destination and be covered by the lock
 * (`ledger.rs:7008-7030`); at most 100 active orders per owner
 * (`ledger.rs:1325`). The lock is refunded on cancel or expiry.
 * @param {string} orderId order identifier
 * @param {string} conditionType condition type string
 * @param {string} conditionSource pool id, oracle id or address the condition reads
 * @param {number|bigint} conditionThreshold threshold compared against the source value
 * @param {Buffer|Uint8Array} innerInstruction encoded inner `XerisInstruction`
 * @param {number|bigint} expiresAtSlot expiry slot
 * @param {number|bigint} lockedAmount lamports escrowed from the signer
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function conditionalOrder(
  orderId, conditionType, conditionSource, conditionThreshold, innerInstruction,
  expiresAtSlot, lockedAmount,
) {
  assertArity(arguments.length, 7, 'Instructions.conditionalOrder',
    'orderId, conditionType, conditionSource, conditionThreshold, innerInstruction, '
    + 'expiresAtSlot, lockedAmount');
  return concat([
    encodeVariant(IDX.ConditionalOrder),
    encodeString(orderId, 'orderId'),
    encodeString(conditionType, 'conditionType'),
    encodeString(conditionSource, 'conditionSource'),
    encodeU64(conditionThreshold, 'conditionThreshold'),
    encodeBytes(innerInstruction, 'innerInstruction'),
    encodeU64(expiresAtSlot, 'expiresAtSlot'),
    encodeU64(lockedAmount, 'lockedAmount'),
  ]);
}

/**
 * CancelConditionalOrder (variant 24, `token.rs:336-338`): cancel an order and
 * refund its escrow.
 *
 * Node rules, not enforced here: the escrow is refunded only when the signer
 * owns the order (`ledger.rs:7131-7140`); the engine's `cancel_order` then
 * removes it (`ledger.rs:7146-7156`).
 * @param {string} orderId order identifier
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} `orderId` is not a string or contains a lone surrogate
 */
function cancelConditionalOrder(orderId) {
  assertArity(arguments.length, 1, 'Instructions.cancelConditionalOrder', 'orderId');
  return concat([
    encodeVariant(IDX.CancelConditionalOrder),
    encodeString(orderId, 'orderId'),
  ]);
}

// ---------------------------------------------------------------------------
// Oracle data feeds (variants 25-26)
// ---------------------------------------------------------------------------

/**
 * RegisterOracle (variant 25, `token.rs:343-349`): register a data feed owned
 * by the signer, locking `stakeAmount` lamports.
 *
 * Node rules, not enforced here: `feedType` must be one of `price, event,
 * sensor, weather, custom` (`ledger.rs:7164`); `stakeAmount >= 1,000,000,000`
 * lamports (`ledger.rs:7170`; `contracts.rs:4307`); `description` at most 512
 * bytes (`ledger.rs:7175`); the active feed id must be unique and at most
 * 1,000 feeds may be active (`contracts.rs:4281-4284`); the stake is debited
 * from the signer's native balance (`contracts.rs:4315-4323`).
 * `updateIntervalSlots` bounds the freshness window of `oracle_value`
 * conditional orders (`ledger.rs:2379`, clamped to 1..=900 there).
 * @param {string} oracleId feed identifier
 * @param {string} description feed description
 * @param {string} feedType feed type string
 * @param {number|bigint} updateIntervalSlots expected slots between submissions
 * @param {number|bigint} stakeAmount lamports locked as collateral
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function registerOracle(oracleId, description, feedType, updateIntervalSlots, stakeAmount) {
  assertArity(arguments.length, 5, 'Instructions.registerOracle',
    'oracleId, description, feedType, updateIntervalSlots, stakeAmount');
  return concat([
    encodeVariant(IDX.RegisterOracle),
    encodeString(oracleId, 'oracleId'),
    encodeString(description, 'description'),
    encodeString(feedType, 'feedType'),
    encodeU64(updateIntervalSlots, 'updateIntervalSlots'),
    encodeU64(stakeAmount, 'stakeAmount'),
  ]);
}

/**
 * OracleSubmit (variant 26, `token.rs:352-356`): publish `value` on the feed
 * `oracleId`.
 *
 * Node rules, not enforced here: `metadata` at most 1024 bytes
 * (`ledger.rs:7211`); the signer must be the feed owner and the feed must be
 * active (`contracts.rs:4352-4355`); the last 1,000 points are retained
 * (`contracts.rs:4363-4365`).
 * @param {string} oracleId feed identifier
 * @param {number|bigint} value the data point (`u64`)
 * @param {string} metadata free-form metadata, usually JSON text
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function oracleSubmit(oracleId, value, metadata) {
  assertArity(arguments.length, 3, 'Instructions.oracleSubmit', 'oracleId, value, metadata');
  return concat([
    encodeVariant(IDX.OracleSubmit),
    encodeString(oracleId, 'oracleId'),
    encodeU64(value, 'value'),
    encodeString(metadata, 'metadata'),
  ]);
}

// ---------------------------------------------------------------------------
// Hardware attestation (variant 27)
// ---------------------------------------------------------------------------

/**
 * HardwareAttest (variant 27, `token.rs:361-369`): register or re-attest a
 * device in `xeris_devices`.
 *
 * `attestationProof` is encoded as the `Vec<u8>` it is declared as; this
 * builder accepts any length. On every live block the node requires exactly 64
 * bytes: an Ed25519 signature by `devicePubkey` over the challenge
 * `"XRS_HW_ATTEST_V2" ‖ identity(devicePubkey) ‖ identity(boundIdentity) ‖
 * lp(deviceType) ‖ lp(manufacturer) ‖ lp(model) ‖ lp(firmwareVersion) ‖
 * u64le(block slot)` (`ledger.rs:7311-7332`; challenge layout
 * `ledger.rs:5299-5319`, `lp` and `identity` as in `contracts.rs:12-30`;
 * build it with `hardwareAttestChallenge`). The challenge binds the slot of
 * the block that includes the transaction (`block.slot`, `ledger.rs:7320-7322`),
 * which the submitter cannot know in advance; the node offers no tolerance
 * window. A proof signed for any other slot fails, the instruction is skipped
 * and the fee is still charged, so sign for the slot you expect the next
 * block to have and expect to retry with a new proof.
 *
 * Further node rules, not enforced here: `deviceType` must be one of
 * `humanoid, terminal, iot, mobile, secure_element` (`ledger.rs:7232`); the
 * signer must equal `devicePubkey` or `boundIdentity` (`ledger.rs:7238`); the
 * proof must be 1..=1024 bytes (`ledger.rs:7244`); a non-empty `boundIdentity`
 * must be the signer and an active identity (`ledger.rs:7249-7254`); a stored
 * binding is authoritative on re-attestation (`ledger.rs:7259-7270`, XWC-73).
 * @param {string} devicePubkey the device's signing address
 * @param {string} deviceType device type string
 * @param {string} manufacturer manufacturer name
 * @param {string} model model name
 * @param {string} firmwareVersion firmware version string
 * @param {Buffer|Uint8Array} attestationProof 64-byte Ed25519 signature by the device key over
 *   `hardwareAttestChallenge(..., slot)` for the slot of the including block
 * @param {string} boundIdentity identity the device is bound to, `''` for none
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or contains a lone surrogate
 */
function hardwareAttest(
  devicePubkey, deviceType, manufacturer, model, firmwareVersion, attestationProof, boundIdentity,
) {
  assertArity(arguments.length, 7, 'Instructions.hardwareAttest',
    'devicePubkey, deviceType, manufacturer, model, firmwareVersion, attestationProof, boundIdentity');
  return concat([
    encodeVariant(IDX.HardwareAttest),
    encodeString(devicePubkey, 'devicePubkey'),
    encodeString(deviceType, 'deviceType'),
    encodeString(manufacturer, 'manufacturer'),
    encodeString(model, 'model'),
    encodeString(firmwareVersion, 'firmwareVersion'),
    encodeBytes(attestationProof, 'attestationProof'),
    encodeString(boundIdentity, 'boundIdentity'),
  ]);
}

// ---------------------------------------------------------------------------
// Capability discovery (variants 28-30)
// ---------------------------------------------------------------------------

/**
 * RegisterCapability (variant 28, `token.rs:375-393`): list a capability under
 * the key `providerIdentity:category` in `xeris_capabilities`.
 *
 * Node rules, not enforced here: the signer must equal `providerIdentity` and
 * have an active identity (`ledger.rs:7390-7393`; `contracts.rs:4548-4550`);
 * the key must not already be listed (`contracts.rs:4551-4554`); at most 100
 * listings per provider and 50,000 overall (`contracts.rs:4561-4571`);
 * `description` at most 2048 characters and `metadataJson` at most 4096
 * (`contracts.rs:4577, 4581`). The node snapshots the provider's `reliability`
 * reputation into the listing (`ledger.rs:7407-7414`). The value `region` is
 * stored as given; search matches it exactly or the literal `global`
 * (`contracts.rs:4663`).
 * @param {string} providerIdentity the signer's identity address
 * @param {string} category capability category
 * @param {string[]} tags capability tags
 * @param {string} region region string
 * @param {string} description description
 * @param {number|bigint} pricePerUnit lamports per unit of work (0 = free or negotiable)
 * @param {number|bigint} maxConcurrent `u32`, concurrent task capacity (0 = unlimited)
 * @param {string} metadataJson metadata as JSON text
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function registerCapability(
  providerIdentity, category, tags, region, description, pricePerUnit, maxConcurrent, metadataJson,
) {
  assertArity(arguments.length, 8, 'Instructions.registerCapability',
    'providerIdentity, category, tags, region, description, pricePerUnit, maxConcurrent, metadataJson');
  return concat([
    encodeVariant(IDX.RegisterCapability),
    encodeString(providerIdentity, 'providerIdentity'),
    encodeString(category, 'category'),
    encodeStringVec(tags, 'tags'),
    encodeString(region, 'region'),
    encodeString(description, 'description'),
    encodeU64(pricePerUnit, 'pricePerUnit'),
    encodeU32(maxConcurrent, 'maxConcurrent'),
    encodeString(metadataJson, 'metadataJson'),
  ]);
}

/**
 * UpdateCapability (variant 29, `token.rs:396-407`): replace fields of the
 * listing `providerIdentity:category`, or delete it.
 *
 * `null`/`undefined` encodes `None` (the node keeps the current value,
 * `ledger.rs:7445-7449`); any other value, including `0`, `''` or `[]`,
 * encodes `Some`. `removed: true` deletes the listing outright
 * (`contracts.rs:4628-4636`).
 *
 * Node rules, not enforced here: the signer must equal `providerIdentity` and
 * have an active identity (`ledger.rs:7436-7439`); the listing must exist and
 * belong to the signer (`contracts.rs:4613`).
 * @param {string} providerIdentity the signer's identity address
 * @param {string} category capability category (part of the listing key)
 * @param {string[]|null|undefined} newTags `Option<Vec<String>>`
 * @param {string|null|undefined} newDescription `Option<String>`
 * @param {number|bigint|null|undefined} newPricePerUnit `Option<u64>`, lamports
 * @param {number|bigint|null|undefined} newMaxConcurrent `Option<u32>`
 * @param {string|null|undefined} newMetadata `Option<String>`, JSON text
 * @param {boolean} removed true to delete the listing
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function updateCapability(
  providerIdentity, category, newTags, newDescription, newPricePerUnit, newMaxConcurrent,
  newMetadata, removed,
) {
  assertArity(arguments.length, 8, 'Instructions.updateCapability',
    'providerIdentity, category, newTags, newDescription, newPricePerUnit, newMaxConcurrent, '
    + 'newMetadata, removed');
  return concat([
    encodeVariant(IDX.UpdateCapability),
    encodeString(providerIdentity, 'providerIdentity'),
    encodeString(category, 'category'),
    encodeOption(newTags, encodeStringVec, 'newTags'),
    encodeOption(newDescription, encodeString, 'newDescription'),
    encodeOption(newPricePerUnit, encodeU64, 'newPricePerUnit'),
    encodeOption(newMaxConcurrent, encodeU32, 'newMaxConcurrent'),
    encodeOption(newMetadata, encodeString, 'newMetadata'),
    encodeBool(removed, 'removed'),
  ]);
}

/**
 * QueryCapabilities (variant 30, `token.rs:414-420`): encodes the variant for
 * wire-format completeness only. The block dispatcher's arm for this variant
 * is empty (`ledger.rs:7460-7464`): a transaction carrying it is admitted, the
 * flat fee is charged, and nothing is executed or returned. The SDK's
 * transaction layer therefore refuses to sign it
 * (`assertInstructionSubmittable` throws `FeatureDisabledError`
 * `'QueryCapabilities'`), and no `XerisClient` wrapper exists for it.
 * @deprecated Use `XerisClient.searchCapabilities` (`GET /capabilities/search`,
 *   `network.rs:5583-5615`), which runs the same engine `search`
 *   (`contracts.rs:4655-4674`) without a transaction.
 * @param {string} category capability category
 * @param {string[]} tags tags, any of which must match
 * @param {string} region region string
 * @param {number|bigint} minReputation `u8`, minimum reputation snapshot
 * @param {number|bigint} maxPrice maximum `pricePerUnit` in lamports
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function queryCapabilities(category, tags, region, minReputation, maxPrice) {
  assertArity(arguments.length, 5, 'Instructions.queryCapabilities',
    'category, tags, region, minReputation, maxPrice');
  return concat([
    encodeVariant(IDX.QueryCapabilities),
    encodeString(category, 'category'),
    encodeStringVec(tags, 'tags'),
    encodeString(region, 'region'),
    encodeU8(minReputation, 'minReputation'),
    encodeU64(maxPrice, 'maxPrice'),
  ]);
}

// ---------------------------------------------------------------------------
// Task and bounty system (variants 31-33)
// ---------------------------------------------------------------------------

/**
 * PostTask (variant 31, `token.rs:427-452`): post a task and escrow `reward`
 * lamports from the signer.
 *
 * All twelve fields are encoded as given. Node rules, not enforced here
 * (`contracts.rs:4686-4826`): `minReputation` must be 0 (`contracts.rs:4698-4700`,
 * XWC-70); `block.slot < expiresAtSlot <= block.slot + MAX_TASK_LIFETIME_SLOTS`
 * = 648,000 (`contracts.rs:4702-4707, 916`); `title` at most 256 and
 * `description` at most 4096 characters (`contracts.rs:4723, 4726`); `reward >
 * 0` (`contracts.rs:4741`); non-empty `requiredTags` need a non-empty
 * `requiredCategory` (`contracts.rs:4748`); `verification` must be
 * `poster_confirm` or `oracle`, the latter with a non-empty
 * `verificationOracle` (`contracts.rs:4751-4760`; `automatic` is refused,
 * XWC-74); `verificationThreshold` is stored but never evaluated
 * (`contracts.rs:4933-4937`); at most 100,000 live tasks (`contracts.rs:4712`).
 * `XerisClient.checks.taskPost` mirrors these.
 * @param {string} taskId task identifier
 * @param {string} title title
 * @param {string} description description
 * @param {string} requiredCategory capability category a claimant must list, `''` for none
 * @param {string[]} requiredTags tags, at least one of which a claimant's listing must carry
 * @param {number|bigint} minReputation `u8` (the node requires 0)
 * @param {number|bigint} reward lamports escrowed from the poster
 * @param {number|bigint} expiresAtSlot expiry slot
 * @param {number|bigint} maxClaimants `u32`, number of agents that may claim
 * @param {string} verification verification mode string
 * @param {string} verificationOracle oracle id for `oracle` verification, `''` otherwise
 * @param {number|bigint} verificationThreshold stored, not evaluated by the node
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function postTask(
  taskId, title, description, requiredCategory, requiredTags, minReputation, reward,
  expiresAtSlot, maxClaimants, verification, verificationOracle, verificationThreshold,
) {
  assertArity(arguments.length, 12, 'Instructions.postTask',
    'taskId, title, description, requiredCategory, requiredTags, minReputation, reward, '
    + 'expiresAtSlot, maxClaimants, verification, verificationOracle, verificationThreshold');
  return concat([
    encodeVariant(IDX.PostTask),
    encodeString(taskId, 'taskId'),
    encodeString(title, 'title'),
    encodeString(description, 'description'),
    encodeString(requiredCategory, 'requiredCategory'),
    encodeStringVec(requiredTags, 'requiredTags'),
    encodeU8(minReputation, 'minReputation'),
    encodeU64(reward, 'reward'),
    encodeU64(expiresAtSlot, 'expiresAtSlot'),
    encodeU32(maxClaimants, 'maxClaimants'),
    encodeString(verification, 'verification'),
    encodeString(verificationOracle, 'verificationOracle'),
    encodeU64(verificationThreshold, 'verificationThreshold'),
  ]);
}

/**
 * ClaimTask (variant 32, `token.rs:456-460`): claim an open task as
 * `claimantIdentity`.
 *
 * Node rules, not enforced here: `claimantIdentity` must equal the signer
 * (`ledger.rs:7521`, XWC-74) and be an active identity (`ledger.rs:7527`);
 * when the task has a `required_category`, the claimant must hold an active
 * listing `claimant:category` carrying one of the required tags, failing
 * closed if the registry is missing (`ledger.rs:7539-7566`, XWC-28); the task
 * must be open, before its deadline and below `max_claimants`
 * (`contracts.rs:4827-4883`).
 * @param {string} taskId task identifier
 * @param {string} claimantIdentity the signer's identity address
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or contains a lone surrogate
 */
function claimTask(taskId, claimantIdentity) {
  assertArity(arguments.length, 2, 'Instructions.claimTask', 'taskId, claimantIdentity');
  return concat([
    encodeVariant(IDX.ClaimTask),
    encodeString(taskId, 'taskId'),
    encodeString(claimantIdentity, 'claimantIdentity'),
  ]);
}

/**
 * ResolveTask (variant 33, `token.rs:463-470`): advance a task's state.
 *
 * Node rules, not enforced here: `resolution` is mapped at
 * `ledger.rs:7603-7612` and anything else is refused: `complete` → engine
 * `submit_proof` (signer must be a claimant, `contracts.rs:4889`); `verify` →
 * `verify` (signer must be the poster for `poster_confirm`, or the designated
 * oracle for `oracle`, `contracts.rs:4931-4935`; pays the escrow to the
 * completer); `reject` → `reject` (same approver; `proof` is read as the
 * reason, at most 512 bytes, `contracts.rs:4975-4979`); `cancel` → `cancel`
 * (poster only, open tasks only, `contracts.rs:5029-5032`). The `dispute`
 * value mentioned in `token.rs:465-467` is not accepted by the dispatcher.
 * @param {string} taskId task identifier
 * @param {string} resolution one of `complete`, `verify`, `reject`, `cancel`
 * @param {string} proof completion proof, or the rejection reason for `reject`
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or contains a lone surrogate
 */
function resolveTask(taskId, resolution, proof) {
  assertArity(arguments.length, 3, 'Instructions.resolveTask', 'taskId, resolution, proof');
  return concat([
    encodeVariant(IDX.ResolveTask),
    encodeString(taskId, 'taskId'),
    encodeString(resolution, 'resolution'),
    encodeString(proof, 'proof'),
  ]);
}

// ---------------------------------------------------------------------------
// Model registry (variants 34-35)
// ---------------------------------------------------------------------------

/**
 * RegisterModel (variant 34, `token.rs:477-486`): register a model keyed by
 * `modelHash` under the signer's identity in `xeris_models`.
 *
 * Node rules, not enforced here: `identityPubkey` must equal the signer
 * (`ledger.rs:7640`, XWC-26) and be an active identity (`ledger.rs:7645`); a
 * duplicate `modelHash` is refused; field limits `modelName` 512 bytes,
 * `capabilitiesJson` 1024, `modelHash` 128, `modelVersion`/`framework`/
 * `executionEnvironment` 128 each, all string fields together 2048
 * (`contracts.rs:1933-1971`); at most 10,000 active models
 * (`contracts.rs:2059`); RegisterModel and UpdateModel count toward
 * `MAX_MODEL_MUTATIONS_PER_BLOCK` = 16 (`ledger.rs:1981, 1986`).
 * @param {string} identityPubkey the signer's identity address
 * @param {string} modelName model name
 * @param {string} modelHash content hash identifying the model (map key)
 * @param {string} modelVersion version string
 * @param {string} framework framework name
 * @param {string} capabilitiesJson capabilities as JSON text
 * @param {number|bigint} modelSizeBytes model size in bytes
 * @param {string} executionEnvironment execution environment string
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function registerModel(
  identityPubkey, modelName, modelHash, modelVersion, framework, capabilitiesJson,
  modelSizeBytes, executionEnvironment,
) {
  assertArity(arguments.length, 8, 'Instructions.registerModel',
    'identityPubkey, modelName, modelHash, modelVersion, framework, capabilitiesJson, '
    + 'modelSizeBytes, executionEnvironment');
  return concat([
    encodeVariant(IDX.RegisterModel),
    encodeString(identityPubkey, 'identityPubkey'),
    encodeString(modelName, 'modelName'),
    encodeString(modelHash, 'modelHash'),
    encodeString(modelVersion, 'modelVersion'),
    encodeString(framework, 'framework'),
    encodeString(capabilitiesJson, 'capabilitiesJson'),
    encodeU64(modelSizeBytes, 'modelSizeBytes'),
    encodeString(executionEnvironment, 'executionEnvironment'),
  ]);
}

/**
 * UpdateModel (variant 35, `token.rs:489-496`): change a registered model's
 * version, capabilities or environment, or retire it.
 *
 * `null`/`undefined` encodes `None` (the node keeps the current value,
 * `ledger.rs:7668-7670`); any other value, including `''`, encodes `Some`.
 * The dispatcher ignores `identityPubkey` (`ledger.rs:7671`); ownership is
 * checked against the signer by the engine (`contracts.rs:2074-2076`). The
 * field is still encoded because it is part of the wire layout.
 *
 * Node rules, not enforced here: the model must exist; `retired: false` on a
 * retired model un-retires it subject to the 10,000 active-model cap
 * (`contracts.rs:2084-2088`); counts toward `MAX_MODEL_MUTATIONS_PER_BLOCK`
 * (`ledger.rs:1986`).
 * @param {string} identityPubkey the model owner's identity address (ignored by the node)
 * @param {string} modelHash hash of the model to update
 * @param {string|null|undefined} newVersion `Option<String>`
 * @param {string|null|undefined} newCapabilities `Option<String>`, JSON text
 * @param {string|null|undefined} newEnvironment `Option<String>`
 * @param {boolean} retired true to retire the model
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or contains a lone surrogate
 */
function updateModel(identityPubkey, modelHash, newVersion, newCapabilities, newEnvironment, retired) {
  assertArity(arguments.length, 6, 'Instructions.updateModel',
    'identityPubkey, modelHash, newVersion, newCapabilities, newEnvironment, retired');
  return concat([
    encodeVariant(IDX.UpdateModel),
    encodeString(identityPubkey, 'identityPubkey'),
    encodeString(modelHash, 'modelHash'),
    encodeOption(newVersion, encodeString, 'newVersion'),
    encodeOption(newCapabilities, encodeString, 'newCapabilities'),
    encodeOption(newEnvironment, encodeString, 'newEnvironment'),
    encodeBool(retired, 'retired'),
  ]);
}

// ---------------------------------------------------------------------------
// Disputes and slashing (variants 36-38)
// ---------------------------------------------------------------------------

/**
 * OpenDispute (variant 36, `token.rs:499-509`): open a dispute in
 * `xeris_disputes`, locking `bond` lamports from the signer.
 *
 * Seven fields: `defendant` sits between `subjectId` and `reason`
 * (`token.rs:503-505`). 4.x omitted it, so every later field shifted and the
 * node could not decode the instruction.
 *
 * Node rules, not enforced here: `disputeId` may not start with `deal_`
 * (`ledger.rs:7690`; `XerisClient.checks.disputeId`); the arbitration panel
 * (validators staking at least 1,000 XRS, minus the parties) must be non-empty
 * (`ledger.rs:7705`; `contracts.rs:5146-5156`); a `disputeType` of `deal`
 * requires `bond >= 1,000,000,000` lamports, other types may use 0
 * (`contracts.rs:5160-5173`); challenge window 21,600 slots and lifetime
 * 648,000 slots (`contracts.rs:995, 1000`); at most 10,000 open disputes
 * (`contracts.rs:5127`). A non-empty `defendant` is the only address allowed
 * to submit `defendant_evidence` (`ledger.rs:7748-7749`).
 * @param {string} disputeId dispute identifier
 * @param {string} disputeType dispute type string (e.g. `task_result`)
 * @param {string} subjectId id of the disputed object (task, deal, ...)
 * @param {string} defendant counterparty address, `''` for none
 * @param {string} reason reason text
 * @param {string} evidence initial evidence, `''` for none
 * @param {number|bigint} bond lamports locked from the signer
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function openDispute(disputeId, disputeType, subjectId, defendant, reason, evidence, bond) {
  assertArity(arguments.length, 7, 'Instructions.openDispute',
    'disputeId, disputeType, subjectId, defendant, reason, evidence, bond');
  return concat([
    encodeVariant(IDX.OpenDispute),
    encodeString(disputeId, 'disputeId'),
    encodeString(disputeType, 'disputeType'),
    encodeString(subjectId, 'subjectId'),
    encodeString(defendant, 'defendant'),
    encodeString(reason, 'reason'),
    encodeString(evidence, 'evidence'),
    encodeU64(bond, 'bond'),
  ]);
}

/**
 * ResolveDispute (variant 37, `token.rs:517-521`): submit evidence, a ruling
 * vote or an expiry on a dispute.
 *
 * Node rules, not enforced here (`ledger.rs:7739-7756`): `action` is one of
 * `evidence` (signer must be the disputer), `defendant_evidence` (signer must
 * be the named defendant), `vote_disputer` / `vote_defendant` / `vote_dismiss`
 * (signer must stake at least `MIN_STAKE_TO_MINE` = 1,000 XRS and be on the
 * panel snapshotted at open; votes are refused during the challenge window), or
 * `expire` (anyone, once the lifetime has passed); any other value is refused.
 * A ruling finalizes on an absolute majority of the panel's snapshotted stake
 * (`contracts.rs:5244-5313`).
 * @param {string} disputeId dispute identifier
 * @param {string} action action string
 * @param {string} data evidence text for the evidence actions, otherwise free-form
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or contains a lone surrogate
 */
function resolveDispute(disputeId, action, data) {
  assertArity(arguments.length, 3, 'Instructions.resolveDispute', 'disputeId, action, data');
  return concat([
    encodeVariant(IDX.ResolveDispute),
    encodeString(disputeId, 'disputeId'),
    encodeString(action, 'action'),
    encodeString(data, 'data'),
  ]);
}

/**
 * SlashReport (variant 38, `token.rs:524-530`): report a validator double-sign
 * at `violationSlot` with signed block-header evidence.
 *
 * Despite the field name, `ownerPubkey` is the validator whose stake is
 * slashed; `agentPubkey` is only logged (`ledger.rs:8258`). This is the one
 * variant whose instruction data may exceed 8 KiB: up to
 * `MAX_SLASH_IX_DATA_SIZE` = 65,535 bytes (`ledger.rs:119, 125-130`);
 * `transaction.assertInstructionSubmittable` applies that limit for variant 38.
 *
 * Node rules, not enforced here (`ledger.rs:7916-8263`): `ownerPubkey` must
 * parse and not be the zero key, and the signer must differ from it
 * (`ledger.rs:7948-7970`); the owner must have a slashable balance
 * (`ledger.rs:7975-7980`); `violationSlot` within 302,400 slots of the current
 * slot (`ledger.rs:7996`); `evidence` is a JSON array of exactly two distinct
 * block headers at `violationSlot`, both validly signed by `ownerPubkey`
 * (`ledger.rs:8026-8137`); the same offence cannot be reported twice
 * (`ledger.rs:8179-8202`); the penalty is 10% of the slashable balance, of
 * which 5% goes to the reporter and 95% is burned (`ledger.rs:8219-8255`).
 * @param {string} agentPubkey address recorded in the log line only
 * @param {string} ownerPubkey the validator to slash
 * @param {string} violationType violation type string
 * @param {string} evidence JSON text with the two conflicting block headers
 * @param {number|bigint} violationSlot slot of the double-sign
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function slashReport(agentPubkey, ownerPubkey, violationType, evidence, violationSlot) {
  assertArity(arguments.length, 5, 'Instructions.slashReport',
    'agentPubkey, ownerPubkey, violationType, evidence, violationSlot');
  return concat([
    encodeVariant(IDX.SlashReport),
    encodeString(agentPubkey, 'agentPubkey'),
    encodeString(ownerPubkey, 'ownerPubkey'),
    encodeString(violationType, 'violationType'),
    encodeString(evidence, 'evidence'),
    encodeU64(violationSlot, 'violationSlot'),
  ]);
}

// ---------------------------------------------------------------------------
// Governance (variants 39-41)
// ---------------------------------------------------------------------------

/**
 * CreateProposal (variant 39, `token.rs:533-541`): open a governance proposal
 * in `xeris_governance`.
 *
 * `quorum` is encoded as given; the node substitutes `DEFAULT_PROPOSAL_QUORUM`
 * = 5,000 XRS when it is 0 (`ledger.rs:8287`; `contracts.rs:163`).
 *
 * Node rules, not enforced here: `votingPeriodSlots` must be at least 21,600
 * (`ledger.rs:8267-8272`) and at most 1,296,000 (`contracts.rs:5527-5530`);
 * the signer's consensus stake must be at least `min_proposal_stake`, 100 XRS
 * on the protocol registry (`ledger.rs:8284-8288`; `contracts.rs:5494-5499,
 * 1826-1827`); at most 1,000 proposals in voting (`contracts.rs:5505`).
 * @param {string} proposalId proposal identifier
 * @param {string} title title
 * @param {string} description description
 * @param {string} proposalType proposal type string
 * @param {string} parameterJson parameters as JSON text
 * @param {number|bigint} votingPeriodSlots voting period in slots
 * @param {number|bigint} quorum lamports of stake required (0 selects the node default)
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function createProposal(
  proposalId, title, description, proposalType, parameterJson, votingPeriodSlots, quorum,
) {
  assertArity(arguments.length, 7, 'Instructions.createProposal',
    'proposalId, title, description, proposalType, parameterJson, votingPeriodSlots, quorum');
  return concat([
    encodeVariant(IDX.CreateProposal),
    encodeString(proposalId, 'proposalId'),
    encodeString(title, 'title'),
    encodeString(description, 'description'),
    encodeString(proposalType, 'proposalType'),
    encodeString(parameterJson, 'parameterJson'),
    encodeU64(votingPeriodSlots, 'votingPeriodSlots'),
    encodeU64(quorum, 'quorum'),
  ]);
}

/**
 * CastVote (variant 40, `token.rs:544-547`): vote on a proposal with the
 * signer's consensus stake as weight (`ledger.rs:8294`).
 *
 * Node rules, not enforced here: `vote` must be `yes`, `no` or `abstain`
 * (`contracts.rs:5584-5588`); one vote per address (`contracts.rs:5581`);
 * before `voting_end_slot` (`contracts.rs:5580`).
 * @param {string} proposalId proposal identifier
 * @param {string} vote vote string
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or contains a lone surrogate
 */
function castVote(proposalId, vote) {
  assertArity(arguments.length, 2, 'Instructions.castVote', 'proposalId, vote');
  return concat([
    encodeVariant(IDX.CastVote),
    encodeString(proposalId, 'proposalId'),
    encodeString(vote, 'vote'),
  ]);
}

/**
 * ExecuteProposal (variant 41, `token.rs:550-552`): tally a proposal whose
 * voting period has ended. Anyone may send it (`contracts.rs:5593-5625`);
 * quorum not met → `rejected`, otherwise `yes > no` → `passed`.
 * @param {string} proposalId proposal identifier
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} `proposalId` is not a string or contains a lone surrogate
 */
function executeProposal(proposalId) {
  assertArity(arguments.length, 1, 'Instructions.executeProposal', 'proposalId');
  return concat([
    encodeVariant(IDX.ExecuteProposal),
    encodeString(proposalId, 'proposalId'),
  ]);
}

// ---------------------------------------------------------------------------
// State channels (variants 42-44)
// ---------------------------------------------------------------------------

/**
 * OpenChannel (variant 42, `token.rs:555-561`): open a state channel with the
 * signer as `party_a`, escrowing `deposit` lamports. The counterparty funds
 * its side with the generic ContractCall `join` on `xeris_channels`
 * (`contracts.rs:5710-5745`).
 *
 * The node binds the channel to the chain id (`network_domain =
 * hex(chain_id)`, `ledger.rs:8310`; decoded back to the raw bytes at
 * `contracts.rs:5646-5648`) and assigns a per-instance `generation` and
 * `created_slot` (`contracts.rs:5643-5645`); both go into every signed channel
 * message (`channelStateMessage`, `channelCloseMessage`).
 *
 * Node rules, not enforced here: `channelId` 1..=128 bytes
 * (`contracts.rs:5637`); `channelType` 1..=64 bytes (`contracts.rs:5652-5654`);
 * `counterparty` at most 64 bytes and not the signer (`contracts.rs:5668-5670`);
 * `deposit > 0`; `expiresAtSlot` in the future; at most 100,000 unsettled
 * channels (`contracts.rs:2105`); challenge period 1,000 slots
 * (`ledger.rs:8308`).
 * @param {string} channelId channel identifier
 * @param {string} counterparty the other party's address
 * @param {number|bigint} deposit lamports escrowed by the signer
 * @param {string} channelType channel type string (e.g. `payment`)
 * @param {number|bigint} expiresAtSlot expiry slot
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function openChannel(channelId, counterparty, deposit, channelType, expiresAtSlot) {
  assertArity(arguments.length, 5, 'Instructions.openChannel',
    'channelId, counterparty, deposit, channelType, expiresAtSlot');
  return concat([
    encodeVariant(IDX.OpenChannel),
    encodeString(channelId, 'channelId'),
    encodeString(counterparty, 'counterparty'),
    encodeU64(deposit, 'deposit'),
    encodeString(channelType, 'channelType'),
    encodeU64(expiresAtSlot, 'expiresAtSlot'),
  ]);
}

/**
 * CloseChannel (variant 43, `token.rs:564-570`): cooperatively close a channel
 * with an agreed final split.
 *
 * `counterpartySignature` is encoded as the `Vec<u8>` it is declared as; this
 * builder accepts any length. The node requires exactly 64 bytes: an Ed25519
 * signature by the party other than the signer over
 * `channelCloseMessage(domain, channelId, generation, createdSlot, partyA,
 * partyB, finalBalanceA, finalBalanceB, messageCount)` (`ledger.rs:8332-8388`;
 * re-verified by the engine, `contracts.rs:5776-5779`). Balances are in
 * canonical (A, B) order whichever party submits.
 *
 * Further node rules, not enforced here: the signer must be a party
 * (`ledger.rs:8339-8348`); `finalBalanceA + finalBalanceB` must equal the
 * total deposits exactly (`contracts.rs:5754-5760`, XWC-06); the record is
 * removed on close (`contracts.rs:5784`).
 * @param {string} channelId channel identifier
 * @param {number|bigint} finalBalanceA lamports paid to `party_a`
 * @param {number|bigint} finalBalanceB lamports paid to `party_b`
 * @param {number|bigint} messageCount number of off-chain messages exchanged
 * @param {Buffer|Uint8Array} counterpartySignature 64-byte Ed25519 signature by the other party
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function closeChannel(channelId, finalBalanceA, finalBalanceB, messageCount, counterpartySignature) {
  assertArity(arguments.length, 5, 'Instructions.closeChannel',
    'channelId, finalBalanceA, finalBalanceB, messageCount, counterpartySignature');
  return concat([
    encodeVariant(IDX.CloseChannel),
    encodeString(channelId, 'channelId'),
    encodeU64(finalBalanceA, 'finalBalanceA'),
    encodeU64(finalBalanceB, 'finalBalanceB'),
    encodeU64(messageCount, 'messageCount'),
    encodeBytes(counterpartySignature, 'counterpartySignature'),
  ]);
}

/**
 * ForceCloseChannel (variant 44, `token.rs:581-587`): unilaterally start the
 * close of a channel, opening a 1,000-slot challenge window
 * (`ledger.rs:8308`; `contracts.rs:5787-5842`).
 *
 * Five fields: `counterpartySignature` is the last (`token.rs:586`). 4.x
 * omitted it and the node could not decode the instruction. It is encoded as
 * the `Vec<u8>` it is declared as; this builder accepts any length. The node
 * rules (`contracts.rs:5820-5836`): with `stateSequence === 0` the signature
 * must be empty and the claims must equal the original deposits (refund-only
 * close); with `stateSequence >= 1` it must be a 64-byte Ed25519 signature by
 * the other party over `channelStateMessage(domain, channelId, generation,
 * createdSlot, partyA, partyB, balanceA, balanceB, stateSequence)` where the
 * balances are in canonical (A, B) order — the node swaps `claimedBalanceSelf`
 * and `claimedBalanceOther` when the signer is `party_b`
 * (`contracts.rs:5806-5808`). `XerisClient.checks.channelSignature` mirrors the
 * length rule.
 *
 * Further node rules, not enforced here: the signer must be a party
 * (`contracts.rs:5806`); the claims must sum exactly to the total deposits
 * (`contracts.rs:5818`); `stateSequence` must exceed the recorded one
 * (`contracts.rs:5826`). During the window either party may supersede the
 * state with ContractCall `challenge_update`, and anyone may settle with
 * `finalize_dispute` afterwards (`contracts.rs:5843-5912`).
 * @param {string} channelId channel identifier
 * @param {number|bigint} claimedBalanceSelf lamports claimed by the signer
 * @param {number|bigint} claimedBalanceOther lamports claimed for the other party
 * @param {number|bigint} stateSequence sequence number of the signed state, 0 for none
 * @param {Buffer|Uint8Array} counterpartySignature 64-byte Ed25519 signature, or empty when `stateSequence` is 0
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function forceCloseChannel(
  channelId, claimedBalanceSelf, claimedBalanceOther, stateSequence, counterpartySignature,
) {
  assertArity(arguments.length, 5, 'Instructions.forceCloseChannel',
    'channelId, claimedBalanceSelf, claimedBalanceOther, stateSequence, counterpartySignature');
  return concat([
    encodeVariant(IDX.ForceCloseChannel),
    encodeString(channelId, 'channelId'),
    encodeU64(claimedBalanceSelf, 'claimedBalanceSelf'),
    encodeU64(claimedBalanceOther, 'claimedBalanceOther'),
    encodeU64(stateSequence, 'stateSequence'),
    encodeBytes(counterpartySignature, 'counterpartySignature'),
  ]);
}

// ---------------------------------------------------------------------------
// Heartbeats (variant 45)
// ---------------------------------------------------------------------------

/**
 * AgentHeartbeat (variant 45, `token.rs:590-596`): record a liveness report
 * for the signer's identity in `xeris_heartbeats`.
 *
 * Node rules, not enforced here: `identityPubkey` must equal the signer
 * (`ledger.rs:8435`; engine `contracts.rs:5934`) and be an active identity
 * (`ledger.rs:8441`); records older than 21,600 slots are dropped on every
 * beat and at most 10,000 are kept (`contracts.rs:5947-5963`); `check` reports
 * `alive` for a beat within the last 5,400 slots (`contracts.rs:5984, 6000`).
 * No RPC route exposes heartbeats; read them through `GET
 * /contract/xeris_heartbeats` or the generic `check` / `list_alive` calls.
 * @param {string} identityPubkey the signer's identity address
 * @param {string} currentModelHash hash of the model currently running, `''` if none
 * @param {number|bigint} activeTasks `u32`, tasks in progress
 * @param {number|bigint} availableCapacity `u32`, free task slots
 * @param {string} statusMessage free-text status
 * @returns {Buffer} encoded instruction
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function agentHeartbeat(identityPubkey, currentModelHash, activeTasks, availableCapacity, statusMessage) {
  assertArity(arguments.length, 5, 'Instructions.agentHeartbeat',
    'identityPubkey, currentModelHash, activeTasks, availableCapacity, statusMessage');
  return concat([
    encodeVariant(IDX.AgentHeartbeat),
    encodeString(identityPubkey, 'identityPubkey'),
    encodeString(currentModelHash, 'currentModelHash'),
    encodeU32(activeTasks, 'activeTasks'),
    encodeU32(availableCapacity, 'availableCapacity'),
    encodeString(statusMessage, 'statusMessage'),
  ]);
}

// ---------------------------------------------------------------------------
// Canonical state-channel messages (contracts.rs:12-30, 57-109)
// ---------------------------------------------------------------------------

/**
 * `push_len_prefixed` (`contracts.rs:12-15`): `u32le(length) ‖ bytes`. This
 * prefix is `u32`, unlike the `u64` prefixes of the bincode instruction
 * fields.
 * @param {Buffer} bytes
 * @returns {Buffer}
 */
function lenPrefixed(bytes) {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

/**
 * Mirrors `id.parse::<solana_sdk::pubkey::Pubkey>()` (solana-pubkey 2.4.0
 * `FromStr`): the input must be at most 44 characters and base58-decode
 * (Bitcoin alphabet) to exactly 32 bytes. Canonical round-tripping is not
 * required by that parser, so it is not required here either.
 * @param {string} s
 * @returns {Buffer|null} the 32 key bytes, or `null` when `s` is not a public key
 */
function pubkeyBytesOrNull(s) {
  if (s.length > MAX_BASE58_PUBKEY_LEN) return null;
  let decoded;
  try {
    decoded = bs58.decode(s);
  } catch (_err) {
    return null;
  }
  return decoded.length === PUBKEY_LEN ? Buffer.from(decoded) : null;
}

/**
 * `push_identity` (`contracts.rs:21-30`): `0x01 ‖ 32 key bytes` when the string
 * parses as a public key, otherwise `0x00 ‖ u32le(length) ‖ utf8 bytes`.
 * @param {string} id party string
 * @param {string} field field name for messages
 * @returns {Buffer}
 * @throws {TypeError|RangeError} see `assertString`
 */
function identityBytes(id, field) {
  assertString(id, field);
  const key = pubkeyBytesOrNull(id);
  if (key !== null) return Buffer.concat([Buffer.from([1]), key]);
  return Buffer.concat([Buffer.from([0]), lenPrefixed(Buffer.from(id, 'utf8'))]);
}

/**
 * Converts the `networkDomain` argument of the channel message helpers into the
 * raw bytes the node length-prefixes. A string is the chain id
 * (`CHAIN_ID_TESTNET` / `CHAIN_ID_MAINNET`) and is used as its UTF-8 (= ASCII)
 * bytes: the ledger injects `hex::encode(chain_id)` at `ledger.rs:8310` and the
 * contract hex-decodes it back before storing it (`contracts.rs:5646-5648`),
 * so the signed domain is the 16 raw bytes `xeris-testnet-v1`, never the hex
 * string. Bytes (`Buffer | Uint8Array`) are used verbatim, e.g. the
 * `network_domain` array of a channel record after `Buffer.from(array)`.
 * @param {Buffer|Uint8Array|string} networkDomain
 * @returns {Buffer}
 * @throws {TypeError} when `networkDomain` is neither a string nor bytes
 * @throws {RangeError} when a string contains a lone surrogate
 */
function domainBytes(networkDomain) {
  if (typeof networkDomain === 'string') {
    return Buffer.from(assertString(networkDomain, 'networkDomain'), 'utf8');
  }
  if (isByteArray(networkDomain)) return toBytes(networkDomain, 'networkDomain');
  throw new TypeError(
    'networkDomain: pass the chain id string (CHAIN_ID_TESTNET / CHAIN_ID_MAINNET) '
    + 'or its raw bytes as a Buffer/Uint8Array',
  );
}

/**
 * Shared layout of `channel_state_message` and `channel_close_message`
 * (`contracts.rs:57-109`): `ascii(tag) ‖ lp(domain) ‖ lp(utf8(channelId)) ‖
 * u64le(generation) ‖ u64le(createdSlot) ‖ identity(partyA) ‖
 * identity(partyB) ‖ u64le(x) ‖ u64le(y) ‖ u64le(z)`.
 * @param {string} tag `CHANNEL_STATE_TAG` or `CHANNEL_CLOSE_TAG`
 * @param {Buffer|Uint8Array|string} networkDomain
 * @param {string} channelId
 * @param {number|bigint} generation
 * @param {number|bigint} createdSlot
 * @param {string} partyA
 * @param {string} partyB
 * @param {number|bigint} x
 * @param {number|bigint} y
 * @param {number|bigint} z
 * @param {string[]} tailNames field names of `x`, `y`, `z` for messages
 * @returns {Buffer}
 */
function channelMessage(
  tag, networkDomain, channelId, generation, createdSlot, partyA, partyB, x, y, z, tailNames,
) {
  return Buffer.concat([
    Buffer.from(tag, 'ascii'),
    lenPrefixed(domainBytes(networkDomain)),
    lenPrefixed(Buffer.from(assertString(channelId, 'channelId'), 'utf8')),
    encodeU64(generation, 'generation'),
    encodeU64(createdSlot, 'createdSlot'),
    identityBytes(partyA, 'partyA'),
    identityBytes(partyB, 'partyB'),
    encodeU64(x, tailNames[0]),
    encodeU64(y, tailNames[1]),
    encodeU64(z, tailNames[2]),
  ]);
}

/**
 * Builds the canonical channel-state message both parties sign off-chain for
 * every state update (`channel_state_message`, `contracts.rs:57-80`):
 * `"XRS_CH_STATE_V3" ‖ u32le(len) ‖ networkDomain ‖ u32le(len) ‖ channelId ‖
 * u64le(generation) ‖ u64le(createdSlot) ‖ identity(partyA) ‖
 * identity(partyB) ‖ u64le(balanceA) ‖ u64le(balanceB) ‖ u64le(stateSequence)`,
 * where `identity(s)` is `0x01 ‖ 32-byte key` for a base58 public key and
 * `0x00 ‖ u32le(len) ‖ utf8(s)` otherwise (`contracts.rs:12-30`).
 *
 * The node verifies the counterparty's Ed25519 signature over exactly these
 * bytes for `forceCloseChannel` with `stateSequence >= 1`
 * (`contracts.rs:5829-5836`) and for the ContractCall `challenge_update`
 * (`contracts.rs:5843-5879`). Sign with `XerisKeypair.sign(message)`.
 *
 * `generation` and `createdSlot` identify the channel instance; read them from
 * `GET /contract/xeris_channels` →
 * `contract.state.Channels.channels[channelId].{generation, created_slot}`
 * (`ChannelEntry`, `contracts.rs:1130-1156`). `partyA`/`partyB` are the
 * record's `party_a`/`party_b` (the opener and the counterparty), and the
 * balances are in that same (A, B) order regardless of who later submits.
 * @param {Buffer|Uint8Array|string} networkDomain chain id string or its raw bytes (see `domainBytes`)
 * @param {string} channelId channel identifier
 * @param {number|bigint} generation the channel instance's `generation`
 * @param {number|bigint} createdSlot the channel instance's `created_slot`
 * @param {string} partyA `party_a` of the channel record
 * @param {string} partyB `party_b` of the channel record
 * @param {number|bigint} balanceA lamports owed to `party_a` in this state
 * @param {number|bigint} balanceB lamports owed to `party_b` in this state
 * @param {number|bigint} stateSequence sequence number of this state (>= 1)
 * @returns {Buffer} the message bytes to sign
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function channelStateMessage(
  networkDomain, channelId, generation, createdSlot, partyA, partyB, balanceA, balanceB, stateSequence,
) {
  assertArity(arguments.length, 9, 'channelStateMessage',
    'networkDomain, channelId, generation, createdSlot, partyA, partyB, balanceA, balanceB, stateSequence');
  return channelMessage(
    CHANNEL_STATE_TAG, networkDomain, channelId, generation, createdSlot, partyA, partyB,
    balanceA, balanceB, stateSequence, ['balanceA', 'balanceB', 'stateSequence'],
  );
}

/**
 * Builds the canonical cooperative-close message (`channel_close_message`,
 * `contracts.rs:86-109`): `"XRS_CLOSE_CH_V4" ‖ u32le(len) ‖ networkDomain ‖
 * u32le(len) ‖ channelId ‖ u64le(generation) ‖ u64le(createdSlot) ‖
 * identity(partyA) ‖ identity(partyB) ‖ u64le(finalBalanceA) ‖
 * u64le(finalBalanceB) ‖ u64le(messageCount)`; `identity` as in
 * `channelStateMessage`.
 *
 * The node verifies the counterparty's Ed25519 signature over exactly these
 * bytes for `closeChannel` (`ledger.rs:8332-8388`; `contracts.rs:5776-5779`).
 * Sign with `XerisKeypair.sign(message)`. `generation`, `createdSlot`,
 * `partyA` and `partyB` come from the channel record as described on
 * `channelStateMessage`.
 * @param {Buffer|Uint8Array|string} networkDomain chain id string or its raw bytes (see `domainBytes`)
 * @param {string} channelId channel identifier
 * @param {number|bigint} generation the channel instance's `generation`
 * @param {number|bigint} createdSlot the channel instance's `created_slot`
 * @param {string} partyA `party_a` of the channel record
 * @param {string} partyB `party_b` of the channel record
 * @param {number|bigint} finalBalanceA lamports paid to `party_a`
 * @param {number|bigint} finalBalanceB lamports paid to `party_b`
 * @param {number|bigint} messageCount number of off-chain messages exchanged
 * @returns {Buffer} the message bytes to sign
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type or is out of range
 */
function channelCloseMessage(
  networkDomain, channelId, generation, createdSlot, partyA, partyB, finalBalanceA, finalBalanceB,
  messageCount,
) {
  assertArity(arguments.length, 9, 'channelCloseMessage',
    'networkDomain, channelId, generation, createdSlot, partyA, partyB, finalBalanceA, '
    + 'finalBalanceB, messageCount');
  return channelMessage(
    CHANNEL_CLOSE_TAG, networkDomain, channelId, generation, createdSlot, partyA, partyB,
    finalBalanceA, finalBalanceB, messageCount, ['finalBalanceA', 'finalBalanceB', 'messageCount'],
  );
}

/**
 * Builds the hardware-attestation challenge a device key signs for
 * `HardwareAttest` (`hw_attest_challenge`, `ledger.rs:5299-5319`):
 * `"XRS_HW_ATTEST_V2" ‖ identity(devicePubkey) ‖ identity(boundIdentity) ‖
 * lp(deviceType) ‖ lp(manufacturer) ‖ lp(model) ‖ lp(firmwareVersion) ‖
 * u64le(slot)`, where `identity(s)` is `0x01 ‖ 32-byte key` for a base58
 * public key and `0x00 ‖ u32le(len) ‖ utf8(s)` otherwise, and `lp(s)` is
 * `u32le(len) ‖ utf8(s)` (`contracts.rs:12-30`).
 *
 * The node verifies the proof against `slot` = the slot of the block that
 * includes the transaction (`ledger.rs:7320-7322`; V2 is active from slot 1,
 * `ledger.rs:7311`). That slot is not known when the transaction is signed,
 * and the node allows no tolerance window: a proof for any other slot makes
 * the dispatcher skip the instruction after the fee is charged. Read the
 * current slot (`XerisClient.getSlot`), sign for the slot you expect the
 * including block to have, and be prepared to resubmit with a new proof.
 * Sign the result with the device key: `deviceKeypair.sign(challenge)`.
 * @param {string} devicePubkey the device's signing address
 * @param {string} boundIdentity identity the device is bound to, `''` for none
 * @param {string} deviceType device type string
 * @param {string} manufacturer manufacturer name
 * @param {string} model model name
 * @param {string} firmwareVersion firmware version string
 * @param {number|bigint} slot slot of the block expected to include the transaction
 * @returns {Buffer} the challenge bytes to sign
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError|RangeError} a field has the wrong type, is out of range or contains a lone surrogate
 */
function hardwareAttestChallenge(
  devicePubkey, boundIdentity, deviceType, manufacturer, model, firmwareVersion, slot,
) {
  assertArity(arguments.length, 7, 'hardwareAttestChallenge',
    'devicePubkey, boundIdentity, deviceType, manufacturer, model, firmwareVersion, slot');
  const lpString = (value, field) => lenPrefixed(Buffer.from(assertString(value, field), 'utf8'));
  return Buffer.concat([
    Buffer.from(HW_ATTEST_TAG, 'ascii'),
    identityBytes(devicePubkey, 'devicePubkey'),
    identityBytes(boundIdentity, 'boundIdentity'),
    lpString(deviceType, 'deviceType'),
    lpString(manufacturer, 'manufacturer'),
    lpString(model, 'model'),
    lpString(firmwareVersion, 'firmwareVersion'),
    encodeU64(slot, 'slot'),
  ]);
}

/**
 * The 28 builders for variants 18-45, keyed by camelCase builder name;
 * `subDelegate` is the throwing stub. Aggregated into `Instructions` by
 * `src/instructions/index.js`.
 * @type {Readonly<Record<string, Function>>}
 */
const ari = Object.freeze({
  createIdentity,
  updateIdentity,
  attestReputation,
  agentMessage,
  subDelegate,
  conditionalOrder,
  cancelConditionalOrder,
  registerOracle,
  oracleSubmit,
  hardwareAttest,
  registerCapability,
  updateCapability,
  queryCapabilities,
  postTask,
  claimTask,
  resolveTask,
  registerModel,
  updateModel,
  openDispute,
  resolveDispute,
  slashReport,
  createProposal,
  castVote,
  executeProposal,
  openChannel,
  closeChannel,
  forceCloseChannel,
  agentHeartbeat,
});

/**
 * Raw encoders for variants whose public builder throws `FeatureDisabledError`.
 * Not re-exported by `index.js`; used by the wire-format tests only.
 * @type {Readonly<{subDelegate: typeof rawSubDelegate}>}
 */
const _raw = Object.freeze({
  subDelegate: rawSubDelegate,
});

module.exports = { ari, _raw, channelStateMessage, channelCloseMessage, hardwareAttestChallenge };
