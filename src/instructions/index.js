'use strict';

/**
 * @file Aggregates the four instruction modules into the public
 * `Instructions` namespace and publishes the variant tables of the node's
 * `enum XerisInstruction` (`token.rs:30-808`, 62 variants):
 *
 * - `src/instructions/core.js`  variants 0-17
 * - `src/instructions/ari.js`   variants 18-45
 * - `src/instructions/zkpq.js`  variants 46-53 and 61
 * - `src/instructions/deals.js` variants 54-60
 *
 * `Variant` maps each PascalCase Rust variant name to its index (the
 * declaration position, which bincode writes as `u32le` before the fields;
 * serde derive at `token.rs:29`), `VARIANT_NAMES[index]` gives the name back
 * and `BUILDER_NAMES[index]` names the camelCase builder in `Instructions`.
 * The three tables are derived from one list below, and the module verifies
 * at load time that the sibling modules supplied exactly the 62 expected
 * builders, so a missing, renamed or duplicated builder fails on `require`
 * rather than on the first call.
 *
 * Four variants are refused or skipped by the node: SubDelegate (22,
 * `ledger.rs:1445-1450, 6911-6914`), ZkPrivateTransfer (48,
 * `ledger.rs:8669-8685`), ZkIdentityProof (49, `ledger.rs:8687-8697`) and
 * PqSignedTransfer (52, `ledger.rs:8809-8828`). Their public builders throw
 * `FeatureDisabledError`; the wire encoders are collected here as `_raw` for
 * the wire-format tests only and are not re-exported from the package root.
 * `isDisabledVariant` lets `src/transaction.js` and the clients refuse those
 * indices again before anything is signed.
 */

const { Buffer } = require('buffer');
const { core, encodeSwapCall, _raw: coreRaw } = require('./core');
const {
  ari, channelStateMessage, channelCloseMessage, hardwareAttestChallenge, _raw: ariRaw,
} = require('./ari');
const { zkpq, buildPqRotationMessage, _raw: zkpqRaw } = require('./zkpq');
const { deals, dealTermsHash, _raw: dealsRaw } = require('./deals');
const { INSTRUCTION_COUNT, DISABLED_VARIANTS } = require('../constants');
const { XerisError } = require('../errors');
const { normalizeU64 } = require('../encoding');

// ---------------------------------------------------------------------------
// Variant tables
// ---------------------------------------------------------------------------

/**
 * One row per variant, in declaration order of `enum XerisInstruction`:
 * `[Rust variant name, camelCase builder name]`. The row's position is the
 * variant index; the comment gives the declaring line in `token.rs`.
 * @type {ReadonlyArray<readonly [string, string]>}
 */
const VARIANT_TABLE = Object.freeze([
  ['TokenMint', 'tokenMint'], // 0  token.rs:32
  ['TokenTransfer', 'tokenTransfer'], // 1  token.rs:38
  ['TokenBurn', 'tokenBurn'], // 2  token.rs:45
  ['TokenCreate', 'tokenCreate'], // 3  token.rs:51
  ['ContractCall', 'contractCall'], // 4  token.rs:60
  ['ContractDeploy', 'contractDeploy'], // 5  token.rs:66
  ['TokenCreateRWA', 'tokenCreateRWA'], // 6  token.rs:83
  ['RWAUpdateStatus', 'rwaUpdateStatus'], // 7  token.rs:108
  ['RWATransfer', 'rwaTransfer'], // 8  token.rs:118
  ['Stake', 'stake'], // 9  token.rs:132
  ['Unstake', 'unstake'], // 10 token.rs:139
  ['NativeTransfer', 'nativeTransfer'], // 11 token.rs:152
  ['ValidatorAttestation', 'validatorAttestation'], // 12 token.rs:166
  ['WrapXrs', 'wrapXrs'], // 13 token.rs:184
  ['UnwrapXrs', 'unwrapXrs'], // 14 token.rs:191
  ['RegisterAgent', 'registerAgent'], // 15 token.rs:204
  ['UpdateAgent', 'updateAgent'], // 16 token.rs:225
  ['AgentExecute', 'agentExecute'], // 17 token.rs:246
  ['CreateIdentity', 'createIdentity'], // 18 token.rs:268
  ['UpdateIdentity', 'updateIdentity'], // 19 token.rs:282
  ['AttestReputation', 'attestReputation'], // 20 token.rs:290
  ['AgentMessage', 'agentMessage'], // 21 token.rs:300
  ['SubDelegate', 'subDelegate'], // 22 token.rs:311 (disabled, ledger.rs:1445-1450)
  ['ConditionalOrder', 'conditionalOrder'], // 23 token.rs:325
  ['CancelConditionalOrder', 'cancelConditionalOrder'], // 24 token.rs:336
  ['RegisterOracle', 'registerOracle'], // 25 token.rs:343
  ['OracleSubmit', 'oracleSubmit'], // 26 token.rs:352
  ['HardwareAttest', 'hardwareAttest'], // 27 token.rs:361
  ['RegisterCapability', 'registerCapability'], // 28 token.rs:375
  ['UpdateCapability', 'updateCapability'], // 29 token.rs:396
  ['QueryCapabilities', 'queryCapabilities'], // 30 token.rs:414 (no-op in blocks, ledger.rs:7460-7464)
  ['PostTask', 'postTask'], // 31 token.rs:427
  ['ClaimTask', 'claimTask'], // 32 token.rs:456
  ['ResolveTask', 'resolveTask'], // 33 token.rs:463
  ['RegisterModel', 'registerModel'], // 34 token.rs:477
  ['UpdateModel', 'updateModel'], // 35 token.rs:489
  ['OpenDispute', 'openDispute'], // 36 token.rs:499
  ['ResolveDispute', 'resolveDispute'], // 37 token.rs:517
  ['SlashReport', 'slashReport'], // 38 token.rs:524
  ['CreateProposal', 'createProposal'], // 39 token.rs:533
  ['CastVote', 'castVote'], // 40 token.rs:544
  ['ExecuteProposal', 'executeProposal'], // 41 token.rs:550
  ['OpenChannel', 'openChannel'], // 42 token.rs:555
  ['CloseChannel', 'closeChannel'], // 43 token.rs:564
  ['ForceCloseChannel', 'forceCloseChannel'], // 44 token.rs:581
  ['AgentHeartbeat', 'agentHeartbeat'], // 45 token.rs:590
  ['ZkProofSubmit', 'zkProofSubmit'], // 46 token.rs:607
  ['ZkProofVerify', 'zkProofVerify'], // 47 token.rs:626
  ['ZkPrivateTransfer', 'zkPrivateTransfer'], // 48 token.rs:634 (disabled, ledger.rs:8669-8685)
  ['ZkIdentityProof', 'zkIdentityProof'], // 49 token.rs:654 (disabled, ledger.rs:8687-8697)
  ['PqKeyRegister', 'pqKeyRegister'], // 50 token.rs:680
  ['PqKeyRotate', 'pqKeyRotate'], // 51 token.rs:694
  ['PqSignedTransfer', 'pqSignedTransfer'], // 52 token.rs:709 (disabled, ledger.rs:8809-8828)
  ['PqAttest', 'pqAttest'], // 53 token.rs:722
  ['CreateDeal', 'createDeal'], // 54 token.rs:743
  ['AcceptDeal', 'acceptDeal'], // 55 token.rs:753
  ['ConfirmDeal', 'confirmDeal'], // 56 token.rs:762
  ['CancelDeal', 'cancelDeal'], // 57 token.rs:765
  ['DisputeDeal', 'disputeDeal'], // 58 token.rs:768
  ['SettleDeal', 'settleDeal'], // 59 token.rs:777
  ['ReclaimDeal', 'reclaimDeal'], // 60 token.rs:781
  ['ZkVkRegister', 'zkVkRegister'], // 61 token.rs:795
]);

/**
 * PascalCase Rust variant name for each index, `VARIANT_NAMES[index]`.
 * @type {ReadonlyArray<string>}
 */
const VARIANT_NAMES = Object.freeze(VARIANT_TABLE.map((row) => row[0]));

/**
 * camelCase builder name in `Instructions` for each index,
 * `BUILDER_NAMES[index]`.
 * @type {ReadonlyArray<string>}
 */
const BUILDER_NAMES = Object.freeze(VARIANT_TABLE.map((row) => row[1]));

/**
 * Variant index by PascalCase Rust name, e.g. `Variant.NativeTransfer === 11`,
 * `Variant.ZkVkRegister === 61`. 62 entries in declaration order of
 * `enum XerisInstruction` (`token.rs:30-808`).
 * @type {Readonly<Record<string, number>>}
 */
const Variant = Object.freeze(
  Object.fromEntries(VARIANT_NAMES.map((name, index) => [name, index])),
);

// ---------------------------------------------------------------------------
// Builder namespace
// ---------------------------------------------------------------------------

/**
 * Every instruction builder, keyed by camelCase name: `Instructions.<name>(...)`
 * returns the encoded instruction as a `Buffer`. Parameters are positional,
 * named after the Rust fields in declaration order, with strict arity (an
 * `EncodingError` with `code: 'arity'` otherwise). `Option<T>` fields take
 * `null`/`undefined` for `None`. u64 fields take a safe-integer `number` or a
 * `bigint`. `subDelegate`, `zkPrivateTransfer`, `zkIdentityProof` and
 * `pqSignedTransfer` throw `FeatureDisabledError` without reading their
 * arguments; `queryCapabilities` encodes but is a no-op in blocks
 * (`ledger.rs:7460-7464`).
 * @type {Readonly<Record<string, Function>>}
 */
const Instructions = Object.freeze({ ...core, ...ari, ...zkpq, ...deals });

/**
 * Wire encoders for the four variants whose public builder throws
 * `FeatureDisabledError`: `subDelegate` (22), `zkPrivateTransfer` (48),
 * `zkIdentityProof` (49), `pqSignedTransfer` (52). They exist so the
 * reference vectors can be asserted; `src/transaction.js` and
 * `XerisClient.sendInstruction` refuse the indices, so the bytes cannot be
 * submitted through this SDK. Not re-exported from the package root.
 * @type {Readonly<{subDelegate: Function, zkPrivateTransfer: Function, zkIdentityProof: Function, pqSignedTransfer: Function}>}
 */
const _raw = Object.freeze({
  subDelegate: ariRaw.subDelegate,
  zkPrivateTransfer: zkpqRaw.zkPrivateTransfer,
  zkIdentityProof: zkpqRaw.zkIdentityProof,
  pqSignedTransfer: zkpqRaw.pqSignedTransfer,
});

// ---------------------------------------------------------------------------
// Load-time consistency check
// ---------------------------------------------------------------------------

/**
 * Verifies that the tables above and the builders the sibling modules
 * exported describe the same 62 variants. Runs once on `require`.
 * @returns {void}
 * @throws {XerisError} a table or a sibling module is inconsistent
 */
function assertTablesConsistent() {
  const fail = (what) => {
    throw new XerisError(`src/instructions/index.js: ${what}`, {
      details: { expected: INSTRUCTION_COUNT },
    });
  };
  if (VARIANT_TABLE.length !== INSTRUCTION_COUNT) {
    fail(`variant table has ${VARIANT_TABLE.length} rows, expected ${INSTRUCTION_COUNT}`);
  }
  if (new Set(VARIANT_NAMES).size !== INSTRUCTION_COUNT) fail('duplicate variant name in the table');
  if (new Set(BUILDER_NAMES).size !== INSTRUCTION_COUNT) fail('duplicate builder name in the table');
  const supplied = [core, ari, zkpq, deals].reduce((n, mod) => n + Object.keys(mod).length, 0);
  if (supplied !== INSTRUCTION_COUNT) {
    fail(`sibling modules supplied ${supplied} builders, expected ${INSTRUCTION_COUNT}`);
  }
  const keys = Object.keys(Instructions);
  if (keys.length !== INSTRUCTION_COUNT) {
    fail(`Instructions has ${keys.length} keys after merging, expected ${INSTRUCTION_COUNT} (a builder name is shared by two modules)`);
  }
  for (let index = 0; index < INSTRUCTION_COUNT; index += 1) {
    const name = BUILDER_NAMES[index];
    if (typeof Instructions[name] !== 'function') {
      fail(`no builder named '${name}' for variant ${index} (${VARIANT_NAMES[index]})`);
    }
  }
  for (const index of DISABLED_VARIANTS) {
    const name = BUILDER_NAMES[index];
    if (typeof _raw[name] !== 'function') {
      fail(`no raw encoder '_raw.${name}' for disabled variant ${index}`);
    }
  }
  const rawCount = [coreRaw, ariRaw, zkpqRaw, dealsRaw].reduce((n, mod) => n + Object.keys(mod).length, 0);
  if (rawCount !== DISABLED_VARIANTS.length) {
    fail(`sibling modules supplied ${rawCount} raw encoders, expected ${DISABLED_VARIANTS.length}`);
  }
}

assertTablesConsistent();

// ---------------------------------------------------------------------------
// Strict decoder
// ---------------------------------------------------------------------------

/**
 * Field layout of every variant, `VARIANT_FIELDS[index]` = `[[rustFieldName,
 * type], ...]` in declaration order (`token.rs:30-808`). Type codes: `S`
 * String, `u8`, `u32`, `u64`, `b` bool, `B` Vec<u8>, `B32` [u8; 32], `S[]`
 * Vec<String>, `?T` Option<T>. `test/instructions.test.js` checks it against
 * an independent transcription and against the reference vectors.
 * @type {ReadonlyArray<ReadonlyArray<readonly [string, string]>>}
 */
const VARIANT_FIELDS = Object.freeze([
  /* 0  TokenMint, token.rs:32 */ [['token_id', 'S'], ['to', 'S'], ['amount', 'u64']],
  /* 1  TokenTransfer, token.rs:38 */ [['token_id', 'S'], ['from', 'S'], ['to', 'S'], ['amount', 'u64']],
  /* 2  TokenBurn, token.rs:45 */ [['token_id', 'S'], ['from', 'S'], ['amount', 'u64']],
  /* 3  TokenCreate, token.rs:51 */ [['token_id', 'S'], ['name', 'S'], ['symbol', 'S'], ['decimals', 'u8'], ['max_supply', 'u64'], ['mint_authority', 'S']],
  /* 4  ContractCall, token.rs:60 */ [['contract_id', 'S'], ['method', 'S'], ['args', 'B']],
  /* 5  ContractDeploy, token.rs:66 */ [['contract_id', 'S'], ['contract_type_str', 'S'], ['params_json', 'S']],
  /* 6  TokenCreateRWA, token.rs:83 */ [['token_id', 'S'], ['name', 'S'], ['symbol', 'S'], ['decimals', 'u8'], ['max_supply', 'u64'], ['mint_authority', 'S'], ['asset_type', 'S'], ['legal_doc_hash', 'S'], ['legal_doc_uri', 'S'], ['jurisdiction', 'S'], ['transfer_restricted', 'b'], ['accredited_only', 'b'], ['valuation', 'u64']],
  /* 7  RWAUpdateStatus, token.rs:108 */ [['token_id', 'S'], ['new_status', 'S'], ['new_valuation', '?u64'], ['new_legal_doc_hash', '?S'], ['new_legal_doc_uri', '?S']],
  /* 8  RWATransfer, token.rs:118 */ [['token_id', 'S'], ['from', 'S'], ['to', 'S'], ['amount', 'u64']],
  /* 9  Stake, token.rs:132 */ [['pubkey', 'S'], ['amount', 'u64']],
  /* 10 Unstake, token.rs:139 */ [['pubkey', 'S'], ['amount', 'u64']],
  /* 11 NativeTransfer, token.rs:152 */ [['from', 'S'], ['to', 'S'], ['amount', 'u64']],
  /* 12 ValidatorAttestation, token.rs:166 */ [['validator', 'S'], ['block_slot', 'u64'], ['block_hash_prefix', 'B']],
  /* 13 WrapXrs, token.rs:184 */ [['amount', 'u64']],
  /* 14 UnwrapXrs, token.rs:191 */ [['amount', 'u64']],
  /* 15 RegisterAgent, token.rs:204 */ [['agent_name', 'S'], ['agent_pubkey', 'S'], ['max_per_tx', 'u64'], ['max_daily', 'u64'], ['allowed_contracts', 'S[]'], ['allowed_operations', 'S[]'], ['expires_at_slot', 'u64']],
  /* 16 UpdateAgent, token.rs:225 */ [['agent_pubkey', 'S'], ['new_max_per_tx', '?u64'], ['new_max_daily', '?u64'], ['new_allowed_contracts', '?S[]'], ['new_allowed_operations', '?S[]'], ['new_expires_at_slot', '?u64'], ['revoked', 'b']],
  /* 17 AgentExecute, token.rs:246 */ [['owner_pubkey', 'S'], ['inner_instruction', 'B']],
  /* 18 CreateIdentity, token.rs:268 */ [['identity_pubkey', 'S'], ['display_name', 'S'], ['identity_type', 'S'], ['parent_identity', 'S'], ['metadata_json', 'S']],
  /* 19 UpdateIdentity, token.rs:282 */ [['identity_pubkey', 'S'], ['new_display_name', '?S'], ['new_metadata', '?S'], ['deactivated', 'b']],
  /* 20 AttestReputation, token.rs:290 */ [['subject_pubkey', 'S'], ['score', 'u8'], ['category', 'S'], ['evidence', 'S']],
  /* 21 AgentMessage, token.rs:300 */ [['to_identity', 'S'], ['message_type', 'S'], ['payload_json', 'S'], ['reply_to', 'S'], ['expires_at_slot', 'u64']],
  /* 22 SubDelegate, token.rs:311 */ [['sub_agent_pubkey', 'S'], ['sub_agent_name', 'S'], ['max_per_tx', 'u64'], ['max_daily', 'u64'], ['allowed_contracts', 'S[]'], ['allowed_operations', 'S[]'], ['expires_at_slot', 'u64'], ['max_depth', 'u8']],
  /* 23 ConditionalOrder, token.rs:325 */ [['order_id', 'S'], ['condition_type', 'S'], ['condition_source', 'S'], ['condition_threshold', 'u64'], ['inner_instruction', 'B'], ['expires_at_slot', 'u64'], ['locked_amount', 'u64']],
  /* 24 CancelConditionalOrder, token.rs:336 */ [['order_id', 'S']],
  /* 25 RegisterOracle, token.rs:343 */ [['oracle_id', 'S'], ['description', 'S'], ['feed_type', 'S'], ['update_interval_slots', 'u64'], ['stake_amount', 'u64']],
  /* 26 OracleSubmit, token.rs:352 */ [['oracle_id', 'S'], ['value', 'u64'], ['metadata', 'S']],
  /* 27 HardwareAttest, token.rs:361 */ [['device_pubkey', 'S'], ['device_type', 'S'], ['manufacturer', 'S'], ['model', 'S'], ['firmware_version', 'S'], ['attestation_proof', 'B'], ['bound_identity', 'S']],
  /* 28 RegisterCapability, token.rs:375 */ [['provider_identity', 'S'], ['category', 'S'], ['tags', 'S[]'], ['region', 'S'], ['description', 'S'], ['price_per_unit', 'u64'], ['max_concurrent', 'u32'], ['metadata_json', 'S']],
  /* 29 UpdateCapability, token.rs:396 */ [['provider_identity', 'S'], ['category', 'S'], ['new_tags', '?S[]'], ['new_description', '?S'], ['new_price_per_unit', '?u64'], ['new_max_concurrent', '?u32'], ['new_metadata', '?S'], ['removed', 'b']],
  /* 30 QueryCapabilities, token.rs:414 */ [['category', 'S'], ['tags', 'S[]'], ['region', 'S'], ['min_reputation', 'u8'], ['max_price', 'u64']],
  /* 31 PostTask, token.rs:427 */ [['task_id', 'S'], ['title', 'S'], ['description', 'S'], ['required_category', 'S'], ['required_tags', 'S[]'], ['min_reputation', 'u8'], ['reward', 'u64'], ['expires_at_slot', 'u64'], ['max_claimants', 'u32'], ['verification', 'S'], ['verification_oracle', 'S'], ['verification_threshold', 'u64']],
  /* 32 ClaimTask, token.rs:456 */ [['task_id', 'S'], ['claimant_identity', 'S']],
  /* 33 ResolveTask, token.rs:463 */ [['task_id', 'S'], ['resolution', 'S'], ['proof', 'S']],
  /* 34 RegisterModel, token.rs:477 */ [['identity_pubkey', 'S'], ['model_name', 'S'], ['model_hash', 'S'], ['model_version', 'S'], ['framework', 'S'], ['capabilities_json', 'S'], ['model_size_bytes', 'u64'], ['execution_environment', 'S']],
  /* 35 UpdateModel, token.rs:489 */ [['identity_pubkey', 'S'], ['model_hash', 'S'], ['new_version', '?S'], ['new_capabilities', '?S'], ['new_environment', '?S'], ['retired', 'b']],
  /* 36 OpenDispute, token.rs:499 */ [['dispute_id', 'S'], ['dispute_type', 'S'], ['subject_id', 'S'], ['defendant', 'S'], ['reason', 'S'], ['evidence', 'S'], ['bond', 'u64']],
  /* 37 ResolveDispute, token.rs:517 */ [['dispute_id', 'S'], ['action', 'S'], ['data', 'S']],
  /* 38 SlashReport, token.rs:524 */ [['agent_pubkey', 'S'], ['owner_pubkey', 'S'], ['violation_type', 'S'], ['evidence', 'S'], ['violation_slot', 'u64']],
  /* 39 CreateProposal, token.rs:533 */ [['proposal_id', 'S'], ['title', 'S'], ['description', 'S'], ['proposal_type', 'S'], ['parameter_json', 'S'], ['voting_period_slots', 'u64'], ['quorum', 'u64']],
  /* 40 CastVote, token.rs:544 */ [['proposal_id', 'S'], ['vote', 'S']],
  /* 41 ExecuteProposal, token.rs:550 */ [['proposal_id', 'S']],
  /* 42 OpenChannel, token.rs:555 */ [['channel_id', 'S'], ['counterparty', 'S'], ['deposit', 'u64'], ['channel_type', 'S'], ['expires_at_slot', 'u64']],
  /* 43 CloseChannel, token.rs:564 */ [['channel_id', 'S'], ['final_balance_a', 'u64'], ['final_balance_b', 'u64'], ['message_count', 'u64'], ['counterparty_signature', 'B']],
  /* 44 ForceCloseChannel, token.rs:581 */ [['channel_id', 'S'], ['claimed_balance_self', 'u64'], ['claimed_balance_other', 'u64'], ['state_sequence', 'u64'], ['counterparty_signature', 'B']],
  /* 45 AgentHeartbeat, token.rs:590 */ [['identity_pubkey', 'S'], ['current_model_hash', 'S'], ['active_tasks', 'u32'], ['available_capacity', 'u32'], ['status_message', 'S']],
  /* 46 ZkProofSubmit, token.rs:607 */ [['proof_id', 'S'], ['proof_system', 'S'], ['proof_data', 'B'], ['public_inputs', 'B'], ['verification_key_hash', 'S'], ['proof_type', 'S'], ['metadata_json', 'S']],
  /* 47 ZkProofVerify, token.rs:626 */ [['proof_id', 'S']],
  /* 48 ZkPrivateTransfer, token.rs:634 */ [['token_id', 'S'], ['from', 'S'], ['to', 'S'], ['amount_commitment', 'B'], ['range_proof', 'B'], ['balance_proof', 'B'], ['nullifier', 'B']],
  /* 49 ZkIdentityProof, token.rs:654 */ [['identity_pubkey', 'S'], ['claim_type', 'S'], ['claim_value', 'u64'], ['proof_data', 'B'], ['public_inputs', 'B']],
  /* 50 PqKeyRegister, token.rs:680 */ [['ed25519_pubkey', 'S'], ['pq_public_key', 'B'], ['pq_algorithm', 'S'], ['security_level', 'u8']],
  /* 51 PqKeyRotate, token.rs:694 */ [['ed25519_pubkey', 'S'], ['new_pq_public_key', 'B'], ['new_pq_algorithm', 'S'], ['rotation_proof', 'B']],
  /* 52 PqSignedTransfer, token.rs:709 */ [['from', 'S'], ['to', 'S'], ['amount', 'u64'], ['pq_signature', 'B'], ['pq_algorithm', 'S']],
  /* 53 PqAttest, token.rs:722 */ [['attestation_type', 'S'], ['reference_id', 'S'], ['pq_algorithm', 'S'], ['verified', 'b']],
  /* 54 CreateDeal, token.rs:743 */ [['deal_id', 'S'], ['counterparty', 'S'], ['amount', 'u64'], ['terms', 'S']],
  /* 55 AcceptDeal, token.rs:753 */ [['deal_id', 'S'], ['instance', 'u64'], ['expected_party_a', 'S'], ['expected_amount', 'u64'], ['expected_terms_hash', 'B32']],
  /* 56 ConfirmDeal, token.rs:762 */ [['deal_id', 'S'], ['instance', 'u64']],
  /* 57 CancelDeal, token.rs:765 */ [['deal_id', 'S'], ['instance', 'u64']],
  /* 58 DisputeDeal, token.rs:768 */ [['deal_id', 'S'], ['instance', 'u64'], ['reason', 'S'], ['bond', 'u64']],
  /* 59 SettleDeal, token.rs:777 */ [['deal_id', 'S'], ['instance', 'u64']],
  /* 60 ReclaimDeal, token.rs:781 */ [['deal_id', 'S'], ['instance', 'u64']],
  /* 61 ZkVkRegister, token.rs:795 */ [['vk_id', 'S'], ['vk_base64', 'S'], ['claim_type', 'S'], ['description', 'S']],
].map((fields) => Object.freeze(fields.map((f) => Object.freeze(f)))));

if (VARIANT_FIELDS.length !== INSTRUCTION_COUNT) {
  throw new XerisError(`src/instructions/index.js: VARIANT_FIELDS has ${VARIANT_FIELDS.length} rows, expected ${INSTRUCTION_COUNT}`);
}

/** `str::from_utf8` equivalent: invalid UTF-8 (including encoded surrogates) throws; a BOM is kept. */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Internal: thrown by the field readers, caught by `tryDecodeInstruction`. */
class DecodeFailure extends Error {}

/**
 * Reads one field of type `type` at `state.offset` with bincode 1 rules
 * (fixint little-endian, u64 length prefixes, `Option` tag 0/1, `bool` byte
 * 0/1, `String` strict UTF-8).
 * @param {Buffer} bytes
 * @param {{offset: number}} state advanced past the field
 * @param {string} type type code from `VARIANT_FIELDS`
 * @param {string} where `Variant.field` for the failure text
 * @returns {unknown}
 * @throws {DecodeFailure}
 */
function readField(bytes, state, type, where) {
  const remaining = () => bytes.length - state.offset;
  const take = (n, what) => {
    if (n > remaining()) {
      throw new DecodeFailure(`${where}: truncated (${what} needs ${n} bytes, ${remaining()} left at offset ${state.offset})`);
    }
    const out = bytes.subarray(state.offset, state.offset + n);
    state.offset += n;
    return out;
  };
  const length = (what) => {
    const n = take(8, `${what} length`).readBigUInt64LE(0);
    if (n > BigInt(remaining())) {
      throw new DecodeFailure(`${where}: ${what} length ${n} exceeds the ${remaining()} bytes left`);
    }
    return Number(n);
  };
  if (type.startsWith('?')) {
    const tag = take(1, 'Option tag')[0];
    if (tag === 0) return null;
    if (tag === 1) return readField(bytes, state, type.slice(1), where);
    throw new DecodeFailure(`${where}: invalid Option tag 0x${tag.toString(16).padStart(2, '0')} (bincode accepts 0 or 1)`);
  }
  switch (type) {
    case 'u8': return take(1, 'u8')[0];
    case 'u32': return take(4, 'u32').readUInt32LE(0);
    case 'u64': return take(8, 'u64').readBigUInt64LE(0);
    case 'b': {
      const v = take(1, 'bool')[0];
      if (v > 1) throw new DecodeFailure(`${where}: invalid bool byte 0x${v.toString(16).padStart(2, '0')} (bincode accepts 0 or 1)`);
      return v === 1;
    }
    case 'B': return Buffer.from(take(length('Vec<u8>'), 'Vec<u8>'));
    case 'B32': return Buffer.from(take(32, '[u8; 32]'));
    case 'S': {
      const raw = take(length('String'), 'String');
      try {
        return STRICT_UTF8.decode(raw);
      } catch (_) {
        throw new DecodeFailure(`${where}: String is not valid UTF-8`);
      }
    }
    case 'S[]': {
      const count = take(8, 'Vec<String> count').readBigUInt64LE(0);
      // Every String carries an 8-byte length prefix, so a count above
      // remaining/8 cannot decode; refusing it here bounds the loop.
      if (count > BigInt(Math.floor(remaining() / 8))) {
        throw new DecodeFailure(`${where}: Vec<String> count ${count} cannot fit in the ${remaining()} bytes left`);
      }
      const out = [];
      for (let i = 0; i < Number(count); i += 1) out.push(readField(bytes, state, 'S', `${where}[${i}]`));
      return out;
    }
    default:
      throw new XerisError(`src/instructions/index.js: unknown field type '${type}' in VARIANT_FIELDS`);
  }
}

/**
 * Decodes `data` as `bincode::deserialize::<XerisInstruction>` does
 * (`token.rs:29`, bincode 1.3 legacy options: fixint, little-endian, trailing
 * bytes allowed), reporting why it does not decode.
 * @param {Buffer|Uint8Array} data
 * @returns {{ok: true, value: DecodedInstruction}|{ok: false, reason: string}}
 * @throws {TypeError} `data` is not a `Buffer`/`Uint8Array`.
 */
function tryDecodeInstruction(data) {
  if (!(data instanceof Uint8Array)) {
    throw new TypeError(`decodeInstruction: pass a Buffer or Uint8Array, got ${describe(data)}`);
  }
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.length < 4) {
    return { ok: false, reason: `${bytes.length} bytes; the u32le variant index needs 4` };
  }
  const variant = bytes.readUInt32LE(0);
  if (variant >= INSTRUCTION_COUNT) {
    return { ok: false, reason: `variant index ${variant} is not a XerisInstruction (0..${INSTRUCTION_COUNT - 1})` };
  }
  const name = VARIANT_NAMES[variant];
  const state = { offset: 4 };
  const fields = {};
  try {
    for (const [field, type] of VARIANT_FIELDS[variant]) {
      fields[field] = readField(bytes, state, type, `${name}.${field}`);
    }
  } catch (err) {
    if (err instanceof DecodeFailure) return { ok: false, reason: err.message };
    throw err;
  }
  return { ok: true, value: { variant, name, fields, byteLength: state.offset } };
}

/**
 * @typedef {object} DecodedInstruction
 * @property {number} variant variant index
 * @property {string} name PascalCase Rust variant name
 * @property {Record<string, unknown>} fields keyed by Rust field name: `u8`/`u32` as
 *   `number`, `u64` as `bigint`, `bool` as `boolean`, `String` as `string`,
 *   `Vec<u8>`/`[u8; 32]` as a `Buffer` copy, `Vec<String>` as `string[]`, `None` as `null`
 * @property {number} byteLength bytes consumed; any bytes after it are ignored, as by the node
 */

/**
 * Strict decode of one encoded `XerisInstruction`, the same acceptance as
 * the node's `bincode::deserialize::<XerisInstruction>` (`token.rs:29`;
 * ingress `network.rs:183-187`, inner instructions `ledger.rs:6399-6405,
 * 6923-6927`): a truncated field, a `String` that is not valid UTF-8, an
 * `Option` tag or `bool` byte other than 0/1, or a variant index above 61
 * makes it return `null`. Trailing bytes are ignored, as `bincode::deserialize`
 * ignores them.
 * @param {Buffer|Uint8Array} data
 * @returns {DecodedInstruction|null}
 * @throws {TypeError} `data` is not a `Buffer`/`Uint8Array`.
 */
function decodeInstruction(data) {
  const r = tryDecodeInstruction(data);
  return r.ok ? r.value : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * True when `index` is one of the variants the node refuses at ingress or
 * skips in blocks (`DISABLED_VARIANTS` = 22, 48, 49, 52), whose builders throw.
 * Variant 30 (QueryCapabilities) is not included: its builder encodes, and
 * `assertInstructionSubmittable` refuses to submit it.
 * @param {number} index variant index, e.g. from `readVariant(data)`
 * @returns {boolean}
 * @throws {TypeError} `index` is not a number (a `bigint` or string index would silently compare unequal)
 * @see ledger.rs:1445-1450
 * @see ledger.rs:8669-8685
 * @see ledger.rs:8687-8697
 * @see ledger.rs:8809-8828
 */
function isDisabledVariant(index) {
  if (typeof index !== 'number') {
    throw new TypeError(`isDisabledVariant: expected a variant index (number), got ${index === null ? 'null' : typeof index}`);
  }
  return DISABLED_VARIANTS.includes(index);
}

/**
 * True for a plain object (`{}`), false for `null`, arrays, typed arrays and
 * primitives.
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

/**
 * Describes a value for an error message without serialising it.
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
  if (value === null) return 'null';
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'undefined') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

/**
 * Reads a string parameter of a plan.
 * @param {object} params `plan.params`
 * @param {string} key parameter name as the node emits it
 * @returns {string}
 * @throws {TypeError} missing or not a string
 */
function planString(params, key) {
  const value = params[key];
  if (typeof value !== 'string') {
    throw new TypeError(`fromPlan: params.${key} must be a string, got ${describe(value)}`);
  }
  return value;
}

/**
 * Reads a u64 parameter of a plan. The node serialises u64 values as JSON
 * integers (`network.rs:5399, 5409, 5512-5520`). `XerisClient` parses
 * responses with `parseJson`, which returns integers above 2^53-1 as `bigint`,
 * so a plan obtained through `XerisClient.agentPlan` / `plan*` carries exact
 * values. A `number` above 2^53-1 has already been rounded by `JSON.parse`
 * and is refused; like every u64 builder argument, the value must be an
 * integer in `0..=2^64-1` (`normalizeU64`).
 * @param {object} params `plan.params` (or `plan.params.args`)
 * @param {string} key parameter name as the node emits it
 * @param {string} [label] path used in messages (default `params.<key>`)
 * @returns {number|bigint}
 * @throws {TypeError} missing or not a number/bigint
 * @throws {RangeError} negative, not an integer, above 2^64-1, or a `number` above 2^53-1
 */
function planU64(params, key, label = `params.${key}`) {
  const value = params[key];
  if (typeof value !== 'number' && typeof value !== 'bigint') {
    throw new TypeError(`fromPlan: ${label} must be a number or bigint, got ${describe(value)}`);
  }
  if (typeof value === 'number' && Number.isInteger(value) && value > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(
      `fromPlan: ${label} = ${value} is not a safe integer; the plan lost precision in JSON.parse. Parse the response with parseJson (as XerisClient does) to keep it exact`,
    );
  }
  // Same u64 rule as every builder: an integer in 0..=2^64-1. A negative
  // min_tokens_out would read as None under as_u64() and become 0, removing the
  // slippage floor (contracts.rs:2849-2850).
  normalizeU64(value, `fromPlan: ${label}`);
  return value;
}

/** Keys of the `buy_tokens` args object the planner emits (`network.rs:5512-5520`). */
const PLAN_BUY_ARGS = Object.freeze(['xrs_amount', 'min_tokens_out']);

/**
 * Converts the JSON byte array the node emits for a swap plan
 * (`serde_json` serialises `Vec<u8>` as an array of numbers;
 * `network.rs:5455-5465`) into a `Buffer`, refusing anything that is not an
 * integer `0..=255` (`Buffer.from([256])` would wrap silently).
 * @param {unknown[]} values `params.args`
 * @returns {Buffer}
 * @throws {TypeError} an element is not a number
 * @throws {RangeError} an element is not an integer in `0..=255`
 */
function planByteArray(values) {
  const bytes = Buffer.alloc(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (typeof v !== 'number') {
      throw new TypeError(`fromPlan: params.args[${i}] must be a number, got ${describe(v)}`);
    }
    if (!Number.isInteger(v) || v < 0 || v > 255) {
      throw new RangeError(`fromPlan: params.args[${i}] must be an integer 0..=255, got ${v}`);
    }
    bytes[i] = v;
  }
  return bytes;
}

/**
 * Converts a `POST /agent/plan` response (`network.rs:5386-5577`;
 * `XerisClient.agentPlan` and the `plan*` helpers) into encoded instruction
 * bytes by calling the builder the plan names:
 *
 * | `variant_index` | action(s)                | builder call |
 * |---|---|---|
 * | 11 | `transfer`, `send`     | `nativeTransfer(params.from, params.to, params.amount)` (`network.rs:5407-5409`) |
 * | 4  | `swap`                 | `contractCall(params.contract_id, params.method, Buffer(params.args))` with `params.args` a 16-element byte array (`network.rs:5455-5465`) |
 * | 4  | `buy_launchpad`, `buy` | `contractCall(params.contract_id, 'buy_tokens', { xrs_amount, min_tokens_out })` from `params.args` (`network.rs:5512-5520`) |
 * | 9  | `stake`                | `stake(params.pubkey, params.amount)` (`network.rs:5540-5542`) |
 * | 13 | `wrap`                 | `wrapXrs(params.amount)` (`network.rs:5552-5554`) |
 * | 14 | `unwrap`               | `unwrapXrs(params.amount)` (`network.rs:5563-5565`) |
 *
 * `params.amount` is the lamport value the node computed from `amount_xrs`
 * with `(amount_xrs * 1e9) as u64` (`network.rs:5399, 5537, 5549, 5560`),
 * so it may differ from an exact decimal conversion of the requested XRS;
 * compare it with `xrsToLamports` before signing when exactness matters.
 * Every u64 in the plan (`params.amount`, `params.args.xrs_amount`,
 * `params.args.min_tokens_out`) must be a safe-integer `number` or a `bigint`:
 * a launchpad `min_tokens_out` is above 2^53-1 for most buys on a 10^18-unit
 * supply (`contracts.rs:1602-1604`), and `JSON.parse` would already have
 * rounded it, moving the slippage floor. Plans from `XerisClient` are parsed
 * with `parseJson` and keep these values exact; a plan parsed elsewhere with
 * `JSON.parse` throws `RangeError` here instead of signing a different value.
 * The `buy_tokens` args object must hold exactly `xrs_amount` and
 * `min_tokens_out`, and `params.method` must be `buy_tokens`. The
 * node's error replies (`{"error": ...}`, no `variant_index`) are raised as
 * `RpcError` by the client before reaching this function. The resulting
 * bytes are not checked against node business rules (for example that a
 * swap byte array is exactly 16 bytes, `contract_call_args`,
 * `ledger.rs:2368-2372`); the client wrappers do that.
 * @param {object} plan the parsed JSON body returned by `POST /agent/plan`
 * @returns {Buffer} encoded instruction
 * @throws {TypeError} `plan` or `plan.params` is not an object, `variant_index` is not one of 11, 4, 9, 13, 14, `variant_name` (when present) does not match it, a parameter has the wrong type, or a `buy_tokens` args object has a missing or unknown key
 * @throws {RangeError} a numeric parameter (including `params.args.*`) is a `number` that is not a safe integer, or a byte is outside `0..=255`
 * @see network.rs:5386-5577
 */
function fromPlan(plan) {
  if (!isPlainObject(plan)) {
    throw new TypeError(`fromPlan: expected the object returned by POST /agent/plan, got ${describe(plan)}`);
  }
  const index = plan.variant_index;
  if (typeof index !== 'number' || !Number.isInteger(index)) {
    throw new TypeError(`fromPlan: plan.variant_index must be an integer, got ${describe(index)}`);
  }
  if (plan.variant_name !== undefined && plan.variant_name !== VARIANT_NAMES[index]) {
    throw new TypeError(
      `fromPlan: plan.variant_name ${describe(plan.variant_name)} does not match variant_index ${index} (${VARIANT_NAMES[index] ?? 'unknown'})`,
    );
  }
  const params = plan.params;
  if (!isPlainObject(params)) {
    throw new TypeError(`fromPlan: plan.params must be an object, got ${describe(params)}`);
  }
  switch (index) {
    case Variant.NativeTransfer:
      return core.nativeTransfer(planString(params, 'from'), planString(params, 'to'), planU64(params, 'amount'));
    case Variant.ContractCall: {
      const contractId = planString(params, 'contract_id');
      const method = planString(params, 'method');
      const args = params.args;
      if (Array.isArray(args)) return core.contractCall(contractId, method, planByteArray(args));
      if (isPlainObject(args)) {
        if (method !== 'buy_tokens') {
          throw new TypeError(`fromPlan: an object params.args belongs to a buy_tokens plan (network.rs:5512-5520), got method ${describe(method)}`);
        }
        for (const key of Object.keys(args)) {
          if (!PLAN_BUY_ARGS.includes(key)) {
            throw new TypeError(`fromPlan: params.args.${key} is not a buy_tokens argument; expected only ${PLAN_BUY_ARGS.join(', ')}`);
          }
        }
        return core.contractCall(contractId, method, {
          xrs_amount: planU64(args, 'xrs_amount', 'params.args.xrs_amount'),
          min_tokens_out: planU64(args, 'min_tokens_out', 'params.args.min_tokens_out'),
        });
      }
      throw new TypeError(
        `fromPlan: params.args must be a byte array (swap) or an object (buy_launchpad), got ${describe(args)}`,
      );
    }
    case Variant.Stake:
      return core.stake(planString(params, 'pubkey'), planU64(params, 'amount'));
    case Variant.WrapXrs:
      return core.wrapXrs(planU64(params, 'amount'));
    case Variant.UnwrapXrs:
      return core.unwrapXrs(planU64(params, 'amount'));
    default:
      throw new TypeError(
        `fromPlan: unsupported plan.variant_index ${index}; POST /agent/plan produces 11 (NativeTransfer), 4 (ContractCall), 9 (Stake), 13 (WrapXrs) or 14 (UnwrapXrs)`,
      );
  }
}

module.exports = {
  Instructions,
  Variant,
  VARIANT_NAMES,
  BUILDER_NAMES,
  _raw,
  isDisabledVariant,
  fromPlan,
  encodeSwapCall,
  dealTermsHash,
  buildPqRotationMessage,
  channelStateMessage,
  channelCloseMessage,
  hardwareAttestChallenge,
  VARIANT_FIELDS,
  decodeInstruction,
  tryDecodeInstruction,
};
