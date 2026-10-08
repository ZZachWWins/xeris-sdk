'use strict';

/**
 * @file Builders for `XerisInstruction` variants 54-60, the two-party escrowed
 * deal instructions that drive the protocol-managed `xeris_deals` registry
 * (`token.rs:740-781`; registry engine `contracts.rs:5330-5480`), plus
 * `dealTermsHash`, the commitment that `AcceptDeal` carries.
 *
 * Wire format: the node embeds `XerisInstruction` values in transaction
 * instruction `data` with `bincode::serialize` (bincode 1.3.3 default options;
 * serde derive at `token.rs:29`). Each instruction is `u32le(variant index)`
 * followed by the variant's fields in declaration order; strings carry a
 * `u64le` byte-length prefix, `u64` is 8 bytes little-endian, and the one
 * fixed array in this file (`AcceptDeal.expected_terms_hash: [u8; 32]`,
 * `token.rs:758`) is written raw with no length prefix. The variant index is
 * the declaration position in the enum (`token.rs:30`), so the indices below
 * must never be reordered.
 *
 * These builders are pure wire encoders. They reject only what bincode cannot
 * encode (wrong JavaScript type, integer outside the field's domain, lone
 * UTF-16 surrogate, wrong fixed-array length, wrong argument count) and never
 * substitute a default for a caller value or apply a node business rule
 * (`bond >= 1 XRS`, `amount > 0`, `counterparty != signer`). The node rules that
 * apply to each variant are cited in the builder's JSDoc; `XerisClient`
 * (`src/client.js`, `checks.*`) enforces them before any network call.
 *
 * Deal lifecycle on the node (`DealEntry.status`, `contracts.rs:1102-1104`):
 * `proposed` (CreateDeal) → `active` (AcceptDeal) → `completed` (both
 * ConfirmDeal, or ReclaimDeal after the timeout) | `disputed` (DisputeDeal) →
 * `settled` (SettleDeal); `proposed` → `cancelled` (CancelDeal). Every method
 * except `create` requires the `instance` argument to equal the live record's
 * globally monotonic instance number (`require_deal_instance`,
 * `contracts.rs:286-293`; assigned at `contracts.rs:5343`), which binds a
 * signed instruction to one specific deal even after an id is archived and
 * recreated (XWC-62, `contracts.rs:1090-1093`). The seven registry methods
 * are reachable only through these instructions; generic `ContractCall` to
 * `xeris_deals` is refused for all of them (`ledger.rs:2277`), and only the
 * read method `get {deal_id}` is open (`ledger.rs:1845-1846`,
 * `contracts.rs:5474-5477`). The full registry state is also readable without
 * a transaction from `GET /contract/xeris_deals` (`network.rs:5018-5026`,
 * `XerisClient.getContract`): `contract.state.Deals.deals[dealId]`.
 *
 * Integers: `number` must be a safe integer; values above 2^53-1 must be passed
 * as `bigint`. Bytes: `Buffer | Uint8Array` only. Every builder throws
 * `EncodingError` (`code: 'arity'`) when called with the wrong number of
 * arguments: bincode has no field names, so a dropped or extra positional
 * argument would shift every later field on the wire.
 */

const {
  assertString,
  concat,
  encodeFixedBytes,
  encodeString,
  encodeU64,
  encodeVariant,
} = require('../encoding');
const { EncodingError } = require('../errors');
const { Buffer } = require('buffer');
const { sha256 } = require('@noble/hashes/sha256');

// Variant indices = declaration order of `enum XerisInstruction` (token.rs:30).
// The line cited on each entry is the variant's declaration.
const IDX = Object.freeze({
  CreateDeal: 54, // token.rs:743
  AcceptDeal: 55, // token.rs:753
  ConfirmDeal: 56, // token.rs:762
  CancelDeal: 57, // token.rs:765
  DisputeDeal: 58, // token.rs:768
  SettleDeal: 59, // token.rs:777
  ReclaimDeal: 60, // token.rs:781
});

// `AcceptDeal.expected_terms_hash: [u8; 32]` (token.rs:758) and the SHA-256
// digest length of `deal_terms_hash` (contracts.rs:281-284).
const TERMS_HASH_LEN = 32;

/**
 * Throws when a builder is called with the wrong number of arguments.
 * @param {number} actual `arguments.length` of the caller
 * @param {number} expected the variant's field count
 * @param {string} qualifiedName name shown in the message, e.g. `Instructions.createDeal`
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
 * Encodes the `{ deal_id: String, instance: u64 }` body shared by ConfirmDeal,
 * CancelDeal, SettleDeal and ReclaimDeal (`token.rs:762, 765, 777, 781`).
 * The caller has already checked its arity.
 * @param {number} index variant index
 * @param {string} dealId deal identifier
 * @param {number|bigint} instance u64 deal instance number
 * @returns {Buffer} `u32le(index) ‖ string(dealId) ‖ u64le(instance)`
 * @throws {TypeError} `dealId` is not a string or `instance` is not a number/bigint
 * @throws {RangeError} `dealId` contains a lone surrogate or `instance` is outside `0..=2^64-1`
 */
function encodeDealInstance(index, dealId, instance) {
  return concat([
    encodeVariant(index),
    encodeString(dealId, 'dealId'),
    encodeU64(instance, 'instance'),
  ]);
}

// ---------------------------------------------------------------------------
// Deal registry (`xeris_deals`)
// ---------------------------------------------------------------------------

/**
 * Encodes `CreateDeal` (variant 54): propose a two-party escrowed deal; the
 * signer becomes `party_a` and escrows `amount` lamports of native XRS
 * (`token.rs:740-748`).
 *
 * Node handling (`ledger.rs:7781-7788`): the handler creates the protocol
 * registry `xeris_deals` on first use (`ledger.rs:7782-7785`) and calls its
 * `create` method (`contracts.rs:5340-5371`), which in order:
 * - rejects a `dealId` that already exists in the registry (`contracts.rs:5342`);
 * - assigns `instance = total_deals + 1`, a lifetime counter that is never
 *   reused (`contracts.rs:5343, 5369`; `contracts.rs:1090-1093`);
 * - caps live (`proposed`/`active`/`disputed`) deals at 100,000, archiving
 *   terminal records first (`contracts.rs:5347-5353`);
 * - requires `counterparty` to be non-empty and different from the signer
 *   (`contracts.rs:5355`); no other format check is made, so an address that
 *   is not a canonical public key leaves the deal unacceptable by anyone;
 * - requires `amount > 0` (`contracts.rs:5357`) and debits it from the
 *   signer's native balance as `deposit_a` (`contracts.rs:5358-5360`);
 * - stores `terms` verbatim and sets `status = "proposed"`
 *   (`contracts.rs:5362-5368`).
 * The assigned `instance` is required by every later deal instruction; read
 * it from `GET /contract/xeris_deals` (`contract.state.Deals.deals[dealId].instance`).
 * A rejected instruction still costs the transaction fee.
 * `XerisClient.createDeal` applies `checks.pubkey(counterparty)`,
 * `counterparty !== signer` and `checks.positive(amount)` before sending.
 * @param {string} dealId unique deal identifier
 * @param {string} counterparty base58 address of `party_b`, who must accept with `AcceptDeal`
 * @param {number|bigint} amount u64 lamports each party escrows
 * @param {string} terms deal terms, stored verbatim; committed by `dealTermsHash` at acceptance
 * @returns {Buffer} encoded instruction (variant 54)
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError} a field has the wrong type
 * @throws {RangeError} `amount` outside `0..=2^64-1`, or a string contains a lone surrogate
 * @see ledger.rs:7781-7788
 * @see contracts.rs:5340-5371
 */
function createDeal(dealId, counterparty, amount, terms) {
  assertArity(arguments.length, 4, 'Instructions.createDeal', 'dealId, counterparty, amount, terms');
  return concat([
    encodeVariant(IDX.CreateDeal),
    encodeString(dealId, 'dealId'),
    encodeString(counterparty, 'counterparty'),
    encodeU64(amount, 'amount'),
    encodeString(terms, 'terms'),
  ]);
}

/**
 * Encodes `AcceptDeal` (variant 55): the named counterparty accepts one exact
 * deal instance and escrows the matching amount (`token.rs:749-759`).
 *
 * The instruction binds the acceptance to what the acceptor saw: the handler
 * hex-encodes the 32 raw bytes of `expectedTermsHash` (`ledger.rs:7795`) and
 * the registry `accept` method (`contracts.rs:5372-5391`) compares, in order:
 * - `instance` with the live record (`contracts.rs:5375`; `require_deal_instance`,
 *   `contracts.rs:286-293`);
 * - `expectedPartyA` with the stored `party_a` (`contracts.rs:5376-5378`);
 * - `expectedAmount` with the stored `amount` (`contracts.rs:5379-5380`);
 * - the hex of `expectedTermsHash` with `deal_terms_hash(terms)` =
 *   hex(SHA-256(terms)) (`contracts.rs:5381-5382`, `281-284`); compute it
 *   with `dealTermsHash(terms)`;
 * then requires `status == "proposed"` (`contracts.rs:5383`), the signer to be
 * `party_b` (`contracts.rs:5384`) and a native balance of at least `amount`,
 * which it debits as `deposit_b` before setting `status = "active"`
 * (`contracts.rs:5385-5389`). Any mismatch leaves the deal unchanged; the fee
 * is still charged.
 *
 * Wire layout note: `expected_terms_hash` is `[u8; 32]`, written as 32 raw
 * bytes with no length prefix (bincode fixed array; `token.rs:758`). Passing
 * any other length throws here instead of producing bytes the node would
 * decode with every field misaligned.
 * @param {string} dealId deal identifier
 * @param {number|bigint} instance u64 instance number of the deal being accepted
 * @param {string} expectedPartyA base58 address the acceptor expects as the creator
 * @param {number|bigint} expectedAmount u64 lamports the acceptor expects each side to escrow
 * @param {Buffer|Uint8Array} expectedTermsHash exactly 32 bytes: `dealTermsHash(terms)` of the terms the acceptor agreed to
 * @returns {Buffer} encoded instruction (variant 55)
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError} a field has the wrong type (`expectedTermsHash` must be a Buffer/Uint8Array)
 * @throws {RangeError} a u64 outside `0..=2^64-1`, `expectedTermsHash` not exactly 32 bytes, or a string contains a lone surrogate
 * @see ledger.rs:7789-7798
 * @see contracts.rs:5372-5391
 */
function acceptDeal(dealId, instance, expectedPartyA, expectedAmount, expectedTermsHash) {
  assertArity(
    arguments.length,
    5,
    'Instructions.acceptDeal',
    'dealId, instance, expectedPartyA, expectedAmount, expectedTermsHash',
  );
  return concat([
    encodeVariant(IDX.AcceptDeal),
    encodeString(dealId, 'dealId'),
    encodeU64(instance, 'instance'),
    encodeString(expectedPartyA, 'expectedPartyA'),
    encodeU64(expectedAmount, 'expectedAmount'),
    encodeFixedBytes(expectedTermsHash, TERMS_HASH_LEN, 'expectedTermsHash'), // [u8; 32], token.rs:758
  ]);
}

/**
 * Encodes `ConfirmDeal` (variant 56): a party records that the deal completed
 * (`token.rs:760-762`).
 *
 * Node handling (`ledger.rs:7799-7802` → registry `confirm`,
 * `contracts.rs:5392-5409`): `instance` must match (`contracts.rs:5395`), the
 * deal must be `active` (`contracts.rs:5396`) and the signer must be `party_a`
 * or `party_b` (`contracts.rs:5397-5399`). The first confirmation is only
 * recorded (`contracts.rs:5407`); once both parties have confirmed, each is
 * refunded its own deposit and `status` becomes `"completed"`
 * (`contracts.rs:5400-5405`). A rejected instruction still costs the fee.
 * @param {string} dealId deal identifier
 * @param {number|bigint} instance u64 instance number of the deal
 * @returns {Buffer} encoded instruction (variant 56)
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError} `dealId` is not a string or `instance` is not a number/bigint
 * @throws {RangeError} `instance` outside `0..=2^64-1`, or `dealId` contains a lone surrogate
 * @see ledger.rs:7799-7802
 * @see contracts.rs:5392-5409
 */
function confirmDeal(dealId, instance) {
  assertArity(arguments.length, 2, 'Instructions.confirmDeal', 'dealId, instance');
  return encodeDealInstance(IDX.ConfirmDeal, dealId, instance);
}

/**
 * Encodes `CancelDeal` (variant 57): the creator withdraws a deal the
 * counterparty has not yet accepted (`token.rs:763-765`).
 *
 * Node handling (`ledger.rs:7803-7806` → registry `cancel`,
 * `contracts.rs:5410-5419`): `instance` must match (`contracts.rs:5413`), the
 * deal must still be `proposed` (`contracts.rs:5414`) and the signer must be
 * `party_a` (`contracts.rs:5415`). `deposit_a` is refunded and `status`
 * becomes `"cancelled"` (`contracts.rs:5416-5417`). An `active` deal cannot
 * be cancelled: use `confirmDeal`, `disputeDeal` or, after the timeout,
 * `reclaimDeal`. A rejected instruction still costs the fee.
 * @param {string} dealId deal identifier
 * @param {number|bigint} instance u64 instance number of the deal
 * @returns {Buffer} encoded instruction (variant 57)
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError} `dealId` is not a string or `instance` is not a number/bigint
 * @throws {RangeError} `instance` outside `0..=2^64-1`, or `dealId` contains a lone surrogate
 * @see ledger.rs:7803-7806
 * @see contracts.rs:5410-5419
 */
function cancelDeal(dealId, instance) {
  assertArity(arguments.length, 2, 'Instructions.cancelDeal', 'dealId, instance');
  return encodeDealInstance(IDX.CancelDeal, dealId, instance);
}

/**
 * Encodes `DisputeDeal` (variant 58): a party freezes an active deal's escrow
 * and opens a bonded arbitration dispute against the other party
 * (`token.rs:766-773`).
 *
 * Node handling (`ledger.rs:7807-7861`), in order:
 * - `bond` must be at least `MIN_DEAL_DISPUTE_BOND` = 1,000,000,000 lamports
 *   (1 XRS; `contracts.rs:1008`); a smaller bond is rejected before any state
 *   changes (`ledger.rs:7814-7818`, XWC-23);
 * - the deal must exist (`ledger.rs:7821-7829`), `instance` must equal its
 *   live instance (`ledger.rs:7830-7834`) and `status` must be `"active"`
 *   (`ledger.rs:7835`);
 * - the signer must be `party_a` or `party_b`; the other party becomes the
 *   dispute's defendant (`ledger.rs:7836-7838`);
 * - the dispute is opened in `xeris_disputes` (created on first use,
 *   `ledger.rs:7842-7845`) with id `deal_<instance>_<dealId>`
 *   (`ledger.rs:7846`), `dispute_type = "deal"`, empty evidence, this `bond`
 *   and a stake-weighted validator panel snapshot (`ledger.rs:7848-7850`;
 *   `arbitration_panel`, `ledger.rs:5286`). The registry's `open` method
 *   debits the bond from the signer and fails when no validator other than
 *   the parties is staked;
 * - on success the deal's `dispute` method links the dispute id and sets
 *   `status = "disputed"` (`ledger.rs:7857`; `contracts.rs:5438-5449`).
 * The bond is separate from the escrowed pot and follows the dispute rules
 * (refunded when the disputer wins or the dispute expires, forfeited
 * otherwise). `reason` is stored on the dispute record. Panel validators rule
 * with `resolveDispute` (variant 37); the pot is then distributed by
 * `settleDeal`. A disputed deal cannot be reclaimed. A rejected instruction
 * still costs the fee. `XerisClient.disputeDeal` applies `checks.dealBond`
 * before sending.
 * @param {string} dealId deal identifier
 * @param {number|bigint} instance u64 instance number of the deal
 * @param {string} reason free-text reason stored on the dispute record
 * @param {number|bigint} bond u64 lamports of arbitration collateral; the node requires at least 1,000,000,000
 * @returns {Buffer} encoded instruction (variant 58)
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError} a field has the wrong type
 * @throws {RangeError} a u64 outside `0..=2^64-1`, or a string contains a lone surrogate
 * @see ledger.rs:7807-7861
 * @see contracts.rs:1008
 */
function disputeDeal(dealId, instance, reason, bond) {
  assertArity(arguments.length, 4, 'Instructions.disputeDeal', 'dealId, instance, reason, bond');
  return concat([
    encodeVariant(IDX.DisputeDeal),
    encodeString(dealId, 'dealId'),
    encodeU64(instance, 'instance'),
    encodeString(reason, 'reason'),
    encodeU64(bond, 'bond'),
  ]);
}

/**
 * Encodes `SettleDeal` (variant 59): distribute the escrowed pot of a
 * disputed deal according to the on-chain ruling (`token.rs:774-777`).
 *
 * Permissionless: the handler never compares the signer with the parties
 * (`ledger.rs:7862-7866`). Node handling (`ledger.rs:7862-7905`), in order:
 * - the deal must exist (`ledger.rs:7867-7875`) and be `"disputed"`
 *   (`ledger.rs:7876`);
 * - its linked dispute must exist in `xeris_disputes` (`ledger.rs:7877-7885`)
 *   and be resolved: `ruled_for_disputer` awards the pot to the disputer's
 *   side, `ruled_for_defendant` to the defendant's side, `dismissed` and
 *   `expired` refund each party its own deposit; any other dispute status
 *   (still open, in its challenge window, or short of quorum) is rejected
 *   (`ledger.rs:7886-7891`);
 * - the registry `settle` method (`contracts.rs:5450-5473`) re-checks
 *   `instance` (`contracts.rs:5457`) and the `disputed` status
 *   (`contracts.rs:5458`), pays the whole pot (`deposit_a + deposit_b`) to the
 *   winner or refunds each deposit (`contracts.rs:5460-5469`), zeroes both
 *   deposits and sets `status = "settled"` (`contracts.rs:5470-5471`);
 * - the dispute record is then marked `settled` so it can be archived
 *   (`ledger.rs:7898-7903`).
 * A rejected instruction still costs the fee.
 * @param {string} dealId deal identifier
 * @param {number|bigint} instance u64 instance number of the deal
 * @returns {Buffer} encoded instruction (variant 59)
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError} `dealId` is not a string or `instance` is not a number/bigint
 * @throws {RangeError} `instance` outside `0..=2^64-1`, or `dealId` contains a lone surrogate
 * @see ledger.rs:7862-7905
 * @see contracts.rs:5450-5473
 */
function settleDeal(dealId, instance) {
  assertArity(arguments.length, 2, 'Instructions.settleDeal', 'dealId, instance');
  return encodeDealInstance(IDX.SettleDeal, dealId, instance);
}

/**
 * Encodes `ReclaimDeal` (variant 60): after the deal timeout, either party
 * recovers both deposits from an active deal that was never confirmed or
 * disputed (`token.rs:778-781`).
 *
 * Node handling (`ledger.rs:7906-7914` → registry `reclaim`,
 * `contracts.rs:5420-5437`): `instance` must match (`contracts.rs:5427`), the
 * deal must be `active` (`contracts.rs:5428`; a `disputed` deal waits for
 * `settleDeal`), the signer must be `party_a` or `party_b`
 * (`contracts.rs:5429`), and the block slot must be at least
 * `created_slot + DEAL_TIMEOUT_SLOTS` (648,000 slots; `contracts.rs:1079`,
 * `5430-5432`). Both deposits are refunded and `status` becomes
 * `"completed"` (`contracts.rs:5433-5435`); the caller cannot influence the
 * split. A rejected instruction still costs the fee.
 * @param {string} dealId deal identifier
 * @param {number|bigint} instance u64 instance number of the deal
 * @returns {Buffer} encoded instruction (variant 60)
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError} `dealId` is not a string or `instance` is not a number/bigint
 * @throws {RangeError} `instance` outside `0..=2^64-1`, or `dealId` contains a lone surrogate
 * @see ledger.rs:7906-7914
 * @see contracts.rs:5420-5437
 */
function reclaimDeal(dealId, instance) {
  assertArity(arguments.length, 2, 'Instructions.reclaimDeal', 'dealId, instance');
  return encodeDealInstance(IDX.ReclaimDeal, dealId, instance);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Computes the terms commitment that `AcceptDeal.expectedTermsHash` carries:
 * `SHA-256(utf8(terms))`, the 32 raw bytes whose hex encoding the node
 * compares with `deal_terms_hash(&deal.terms)` (`contracts.rs:281-284`;
 * compared at `contracts.rs:5381-5382` after `hex::encode` at
 * `ledger.rs:7795`). The input must be the exact `terms` string stored by
 * `CreateDeal`; read it back from `GET /contract/xeris_deals`
 * (`contract.state.Deals.deals[dealId].terms`) rather than retyping it. A
 * lone UTF-16 surrogate is rejected because it has no UTF-8 encoding and could
 * never match the stored bytes.
 * @param {string} terms the deal terms exactly as stored on the deal
 * @returns {Buffer} 32-byte digest
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError} `terms` is not a string
 * @throws {RangeError} `terms` contains a lone surrogate
 * @see contracts.rs:281-284
 */
function dealTermsHash(terms) {
  assertArity(arguments.length, 1, 'dealTermsHash', 'terms');
  const text = assertString(terms, 'terms');
  return Buffer.from(sha256(Buffer.from(text, 'utf8')));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * The seven builders for variants 54-60, keyed by camelCase builder name.
 * Aggregated into `Instructions` by `src/instructions/index.js`.
 * @type {Readonly<Record<string, Function>>}
 */
const deals = Object.freeze({
  createDeal,
  acceptDeal,
  confirmDeal,
  cancelDeal,
  disputeDeal,
  settleDeal,
  reclaimDeal,
});

/**
 * Raw encoders for variants whose public builder throws `FeatureDisabledError`.
 * Every deal variant is live on the node (`ledger.rs:7781-7914`), so this
 * module has none; the object exists so every instructions module has the
 * same shape.
 * @type {Readonly<{}>}
 */
const _raw = Object.freeze({});

module.exports = { deals, _raw, dealTermsHash };
