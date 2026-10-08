'use strict';

/**
 * Wire-format tests for `src/instructions/*` through the aggregation module
 * `src/instructions/index.js`.
 *
 * Arbiter: `test/vectors.json`, a byte-for-byte copy of
 * `scratchpad/tools/vectors.json` (91 vectors produced by the reference
 * encoder and verified byte-identical against the `bincode` 1.3.3 crate with
 * the enum text of `token.rs`). Every builder must reproduce every vector for
 * its variant exactly; nothing is defaulted, clamped or reordered.
 *
 * Field order and types below are transcribed from the `XerisInstruction`
 * enum (`token.rs:30-808`, `#[derive(Serialize, Deserialize)]` at
 * `token.rs:29`). The wire layout is `u32le(index)` followed by the fields in
 * declaration order (bincode 1 fixint, little-endian).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const ix = require('../src/instructions/index.js');
const { Instructions, Variant, VARIANT_NAMES, BUILDER_NAMES, _raw, isDisabledVariant, fromPlan,
  encodeSwapCall, dealTermsHash, buildPqRotationMessage, channelStateMessage, channelCloseMessage } = ix;
const { readVariant } = require('../src/encoding');
const { EncodingError, FeatureDisabledError, DISABLED_FEATURES } = require('../src/errors');
const C = require('../src/constants');
const bs58 = require('bs58');

const VECTORS = JSON.parse(fs.readFileSync(path.join(__dirname, 'vectors.json'), 'utf8'));
const hex = (b) => Buffer.from(b).toString('hex');
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n), 0); return b; };

/**
 * Field schema of every variant: `[rustFieldName, type]` in declaration order,
 * plus the camelCase builder name. Type codes: S string, u8, u32, u64, b bool,
 * B Vec<u8>, B32 [u8; 32], S[] Vec<String>, ?T Option<T>.
 * Line numbers are the variant's opening line in `token.rs`.
 */
const SCHEMA = [
  /* 0  token.rs:32  */ ['TokenMint', 'tokenMint', [['token_id', 'S'], ['to', 'S'], ['amount', 'u64']]],
  /* 1  token.rs:38  */ ['TokenTransfer', 'tokenTransfer', [['token_id', 'S'], ['from', 'S'], ['to', 'S'], ['amount', 'u64']]],
  /* 2  token.rs:45  */ ['TokenBurn', 'tokenBurn', [['token_id', 'S'], ['from', 'S'], ['amount', 'u64']]],
  /* 3  token.rs:51  */ ['TokenCreate', 'tokenCreate', [['token_id', 'S'], ['name', 'S'], ['symbol', 'S'], ['decimals', 'u8'], ['max_supply', 'u64'], ['mint_authority', 'S']]],
  /* 4  token.rs:60  */ ['ContractCall', 'contractCall', [['contract_id', 'S'], ['method', 'S'], ['args', 'B']]],
  /* 5  token.rs:66  */ ['ContractDeploy', 'contractDeploy', [['contract_id', 'S'], ['contract_type_str', 'S'], ['params_json', 'S']]],
  /* 6  token.rs:83  */ ['TokenCreateRWA', 'tokenCreateRWA', [['token_id', 'S'], ['name', 'S'], ['symbol', 'S'], ['decimals', 'u8'], ['max_supply', 'u64'], ['mint_authority', 'S'], ['asset_type', 'S'], ['legal_doc_hash', 'S'], ['legal_doc_uri', 'S'], ['jurisdiction', 'S'], ['transfer_restricted', 'b'], ['accredited_only', 'b'], ['valuation', 'u64']]],
  /* 7  token.rs:108 */ ['RWAUpdateStatus', 'rwaUpdateStatus', [['token_id', 'S'], ['new_status', 'S'], ['new_valuation', '?u64'], ['new_legal_doc_hash', '?S'], ['new_legal_doc_uri', '?S']]],
  /* 8  token.rs:118 */ ['RWATransfer', 'rwaTransfer', [['token_id', 'S'], ['from', 'S'], ['to', 'S'], ['amount', 'u64']]],
  /* 9  token.rs:132 */ ['Stake', 'stake', [['pubkey', 'S'], ['amount', 'u64']]],
  /* 10 token.rs:139 */ ['Unstake', 'unstake', [['pubkey', 'S'], ['amount', 'u64']]],
  /* 11 token.rs:152 */ ['NativeTransfer', 'nativeTransfer', [['from', 'S'], ['to', 'S'], ['amount', 'u64']]],
  /* 12 token.rs:166 */ ['ValidatorAttestation', 'validatorAttestation', [['validator', 'S'], ['block_slot', 'u64'], ['block_hash_prefix', 'B']]],
  /* 13 token.rs:184 */ ['WrapXrs', 'wrapXrs', [['amount', 'u64']]],
  /* 14 token.rs:191 */ ['UnwrapXrs', 'unwrapXrs', [['amount', 'u64']]],
  /* 15 token.rs:204 */ ['RegisterAgent', 'registerAgent', [['agent_name', 'S'], ['agent_pubkey', 'S'], ['max_per_tx', 'u64'], ['max_daily', 'u64'], ['allowed_contracts', 'S[]'], ['allowed_operations', 'S[]'], ['expires_at_slot', 'u64']]],
  /* 16 token.rs:225 */ ['UpdateAgent', 'updateAgent', [['agent_pubkey', 'S'], ['new_max_per_tx', '?u64'], ['new_max_daily', '?u64'], ['new_allowed_contracts', '?S[]'], ['new_allowed_operations', '?S[]'], ['new_expires_at_slot', '?u64'], ['revoked', 'b']]],
  /* 17 token.rs:246 */ ['AgentExecute', 'agentExecute', [['owner_pubkey', 'S'], ['inner_instruction', 'B']]],
  /* 18 token.rs:268 */ ['CreateIdentity', 'createIdentity', [['identity_pubkey', 'S'], ['display_name', 'S'], ['identity_type', 'S'], ['parent_identity', 'S'], ['metadata_json', 'S']]],
  /* 19 token.rs:282 */ ['UpdateIdentity', 'updateIdentity', [['identity_pubkey', 'S'], ['new_display_name', '?S'], ['new_metadata', '?S'], ['deactivated', 'b']]],
  /* 20 token.rs:290 */ ['AttestReputation', 'attestReputation', [['subject_pubkey', 'S'], ['score', 'u8'], ['category', 'S'], ['evidence', 'S']]],
  /* 21 token.rs:300 */ ['AgentMessage', 'agentMessage', [['to_identity', 'S'], ['message_type', 'S'], ['payload_json', 'S'], ['reply_to', 'S'], ['expires_at_slot', 'u64']]],
  /* 22 token.rs:311 */ ['SubDelegate', 'subDelegate', [['sub_agent_pubkey', 'S'], ['sub_agent_name', 'S'], ['max_per_tx', 'u64'], ['max_daily', 'u64'], ['allowed_contracts', 'S[]'], ['allowed_operations', 'S[]'], ['expires_at_slot', 'u64'], ['max_depth', 'u8']]],
  /* 23 token.rs:325 */ ['ConditionalOrder', 'conditionalOrder', [['order_id', 'S'], ['condition_type', 'S'], ['condition_source', 'S'], ['condition_threshold', 'u64'], ['inner_instruction', 'B'], ['expires_at_slot', 'u64'], ['locked_amount', 'u64']]],
  /* 24 token.rs:336 */ ['CancelConditionalOrder', 'cancelConditionalOrder', [['order_id', 'S']]],
  /* 25 token.rs:343 */ ['RegisterOracle', 'registerOracle', [['oracle_id', 'S'], ['description', 'S'], ['feed_type', 'S'], ['update_interval_slots', 'u64'], ['stake_amount', 'u64']]],
  /* 26 token.rs:352 */ ['OracleSubmit', 'oracleSubmit', [['oracle_id', 'S'], ['value', 'u64'], ['metadata', 'S']]],
  /* 27 token.rs:361 */ ['HardwareAttest', 'hardwareAttest', [['device_pubkey', 'S'], ['device_type', 'S'], ['manufacturer', 'S'], ['model', 'S'], ['firmware_version', 'S'], ['attestation_proof', 'B'], ['bound_identity', 'S']]],
  /* 28 token.rs:375 */ ['RegisterCapability', 'registerCapability', [['provider_identity', 'S'], ['category', 'S'], ['tags', 'S[]'], ['region', 'S'], ['description', 'S'], ['price_per_unit', 'u64'], ['max_concurrent', 'u32'], ['metadata_json', 'S']]],
  /* 29 token.rs:396 */ ['UpdateCapability', 'updateCapability', [['provider_identity', 'S'], ['category', 'S'], ['new_tags', '?S[]'], ['new_description', '?S'], ['new_price_per_unit', '?u64'], ['new_max_concurrent', '?u32'], ['new_metadata', '?S'], ['removed', 'b']]],
  /* 30 token.rs:414 */ ['QueryCapabilities', 'queryCapabilities', [['category', 'S'], ['tags', 'S[]'], ['region', 'S'], ['min_reputation', 'u8'], ['max_price', 'u64']]],
  /* 31 token.rs:427 */ ['PostTask', 'postTask', [['task_id', 'S'], ['title', 'S'], ['description', 'S'], ['required_category', 'S'], ['required_tags', 'S[]'], ['min_reputation', 'u8'], ['reward', 'u64'], ['expires_at_slot', 'u64'], ['max_claimants', 'u32'], ['verification', 'S'], ['verification_oracle', 'S'], ['verification_threshold', 'u64']]],
  /* 32 token.rs:456 */ ['ClaimTask', 'claimTask', [['task_id', 'S'], ['claimant_identity', 'S']]],
  /* 33 token.rs:463 */ ['ResolveTask', 'resolveTask', [['task_id', 'S'], ['resolution', 'S'], ['proof', 'S']]],
  /* 34 token.rs:477 */ ['RegisterModel', 'registerModel', [['identity_pubkey', 'S'], ['model_name', 'S'], ['model_hash', 'S'], ['model_version', 'S'], ['framework', 'S'], ['capabilities_json', 'S'], ['model_size_bytes', 'u64'], ['execution_environment', 'S']]],
  /* 35 token.rs:489 */ ['UpdateModel', 'updateModel', [['identity_pubkey', 'S'], ['model_hash', 'S'], ['new_version', '?S'], ['new_capabilities', '?S'], ['new_environment', '?S'], ['retired', 'b']]],
  /* 36 token.rs:499 */ ['OpenDispute', 'openDispute', [['dispute_id', 'S'], ['dispute_type', 'S'], ['subject_id', 'S'], ['defendant', 'S'], ['reason', 'S'], ['evidence', 'S'], ['bond', 'u64']]],
  /* 37 token.rs:517 */ ['ResolveDispute', 'resolveDispute', [['dispute_id', 'S'], ['action', 'S'], ['data', 'S']]],
  /* 38 token.rs:524 */ ['SlashReport', 'slashReport', [['agent_pubkey', 'S'], ['owner_pubkey', 'S'], ['violation_type', 'S'], ['evidence', 'S'], ['violation_slot', 'u64']]],
  /* 39 token.rs:533 */ ['CreateProposal', 'createProposal', [['proposal_id', 'S'], ['title', 'S'], ['description', 'S'], ['proposal_type', 'S'], ['parameter_json', 'S'], ['voting_period_slots', 'u64'], ['quorum', 'u64']]],
  /* 40 token.rs:544 */ ['CastVote', 'castVote', [['proposal_id', 'S'], ['vote', 'S']]],
  /* 41 token.rs:550 */ ['ExecuteProposal', 'executeProposal', [['proposal_id', 'S']]],
  /* 42 token.rs:555 */ ['OpenChannel', 'openChannel', [['channel_id', 'S'], ['counterparty', 'S'], ['deposit', 'u64'], ['channel_type', 'S'], ['expires_at_slot', 'u64']]],
  /* 43 token.rs:564 */ ['CloseChannel', 'closeChannel', [['channel_id', 'S'], ['final_balance_a', 'u64'], ['final_balance_b', 'u64'], ['message_count', 'u64'], ['counterparty_signature', 'B']]],
  /* 44 token.rs:581 */ ['ForceCloseChannel', 'forceCloseChannel', [['channel_id', 'S'], ['claimed_balance_self', 'u64'], ['claimed_balance_other', 'u64'], ['state_sequence', 'u64'], ['counterparty_signature', 'B']]],
  /* 45 token.rs:590 */ ['AgentHeartbeat', 'agentHeartbeat', [['identity_pubkey', 'S'], ['current_model_hash', 'S'], ['active_tasks', 'u32'], ['available_capacity', 'u32'], ['status_message', 'S']]],
  /* 46 token.rs:607 */ ['ZkProofSubmit', 'zkProofSubmit', [['proof_id', 'S'], ['proof_system', 'S'], ['proof_data', 'B'], ['public_inputs', 'B'], ['verification_key_hash', 'S'], ['proof_type', 'S'], ['metadata_json', 'S']]],
  /* 47 token.rs:626 */ ['ZkProofVerify', 'zkProofVerify', [['proof_id', 'S']]],
  /* 48 token.rs:634 */ ['ZkPrivateTransfer', 'zkPrivateTransfer', [['token_id', 'S'], ['from', 'S'], ['to', 'S'], ['amount_commitment', 'B'], ['range_proof', 'B'], ['balance_proof', 'B'], ['nullifier', 'B']]],
  /* 49 token.rs:654 */ ['ZkIdentityProof', 'zkIdentityProof', [['identity_pubkey', 'S'], ['claim_type', 'S'], ['claim_value', 'u64'], ['proof_data', 'B'], ['public_inputs', 'B']]],
  /* 50 token.rs:680 */ ['PqKeyRegister', 'pqKeyRegister', [['ed25519_pubkey', 'S'], ['pq_public_key', 'B'], ['pq_algorithm', 'S'], ['security_level', 'u8']]],
  /* 51 token.rs:694 */ ['PqKeyRotate', 'pqKeyRotate', [['ed25519_pubkey', 'S'], ['new_pq_public_key', 'B'], ['new_pq_algorithm', 'S'], ['rotation_proof', 'B']]],
  /* 52 token.rs:709 */ ['PqSignedTransfer', 'pqSignedTransfer', [['from', 'S'], ['to', 'S'], ['amount', 'u64'], ['pq_signature', 'B'], ['pq_algorithm', 'S']]],
  /* 53 token.rs:722 */ ['PqAttest', 'pqAttest', [['attestation_type', 'S'], ['reference_id', 'S'], ['pq_algorithm', 'S'], ['verified', 'b']]],
  /* 54 token.rs:743 */ ['CreateDeal', 'createDeal', [['deal_id', 'S'], ['counterparty', 'S'], ['amount', 'u64'], ['terms', 'S']]],
  /* 55 token.rs:753 */ ['AcceptDeal', 'acceptDeal', [['deal_id', 'S'], ['instance', 'u64'], ['expected_party_a', 'S'], ['expected_amount', 'u64'], ['expected_terms_hash', 'B32']]],
  /* 56 token.rs:762 */ ['ConfirmDeal', 'confirmDeal', [['deal_id', 'S'], ['instance', 'u64']]],
  /* 57 token.rs:765 */ ['CancelDeal', 'cancelDeal', [['deal_id', 'S'], ['instance', 'u64']]],
  /* 58 token.rs:768 */ ['DisputeDeal', 'disputeDeal', [['deal_id', 'S'], ['instance', 'u64'], ['reason', 'S'], ['bond', 'u64']]],
  /* 59 token.rs:777 */ ['SettleDeal', 'settleDeal', [['deal_id', 'S'], ['instance', 'u64']]],
  /* 60 token.rs:781 */ ['ReclaimDeal', 'reclaimDeal', [['deal_id', 'S'], ['instance', 'u64']]],
  /* 61 token.rs:795 */ ['ZkVkRegister', 'zkVkRegister', [['vk_id', 'S'], ['vk_base64', 'S'], ['claim_type', 'S'], ['description', 'S']]],
];

/** Variants the node refuses (ledger.rs:1445-1450, 8669-8685, 8687-8697, 8809-8828). */
const DISABLED = { 22: 'SubDelegate', 48: 'ZkPrivateTransfer', 49: 'ZkIdentityProof', 52: 'PqSignedTransfer' };

/** Converts one vectors.json field value to the builder argument for its type. */
function toArg(type, value, name) {
  if (type.startsWith('?')) {
    return value === null ? null : toArg(type.slice(1), value, name);
  }
  switch (type) {
    case 'S': assert.equal(typeof value, 'string', name); return value;
    case 'u8': case 'u32': assert.equal(typeof value, 'number', name); return value;
    case 'u64':
      // vectors.json carries u64 values above 2^53-1 as decimal strings.
      if (typeof value === 'string') return BigInt(value);
      assert.equal(typeof value, 'number', name);
      return value;
    case 'b': assert.equal(typeof value, 'boolean', name); return value;
    case 'B': assert.equal(typeof value, 'string', name); return Buffer.from(value, 'hex');
    case 'B32': {
      const buf = Buffer.from(value, 'hex');
      assert.equal(buf.length, 32, name);
      return buf;
    }
    case 'S[]': assert.ok(Array.isArray(value), name); return value;
    default: throw new Error(`unknown schema type ${type}`);
  }
}

/** A plausible argument of the given type, for arity and error tests. */
function sampleArg(type) {
  if (type.startsWith('?')) return null;
  switch (type) {
    case 'S': return 'x';
    case 'u8': case 'u32': case 'u64': return 1;
    case 'b': return true;
    case 'B': return Buffer.alloc(0);
    case 'B32': return Buffer.alloc(32);
    case 'S[]': return [];
    default: throw new Error(`unknown schema type ${type}`);
  }
}

function builderFor(index) {
  const name = BUILDER_NAMES[index];
  return DISABLED[index] ? _raw[name] : Instructions[name];
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

test('Variant / VARIANT_NAMES / BUILDER_NAMES cover all 62 variants in token.rs order', () => {
  assert.equal(SCHEMA.length, 62);
  assert.equal(Object.keys(Instructions).length, 62);
  assert.equal(Object.keys(Variant).length, 62);
  assert.equal(VARIANT_NAMES.length, 62);
  assert.equal(BUILDER_NAMES.length, 62);
  assert.equal(Variant.TokenMint, 0);
  assert.equal(Variant.NativeTransfer, 11);
  assert.equal(Variant.OpenDispute, 36);
  assert.equal(Variant.ForceCloseChannel, 44);
  assert.equal(Variant.CreateDeal, 54);
  assert.equal(Variant.ZkVkRegister, 61);
  assert.equal(VARIANT_NAMES[36], 'OpenDispute');
  assert.equal(VARIANT_NAMES[61], 'ZkVkRegister');
  for (let i = 0; i < 62; i++) {
    const [rustName, builderName] = SCHEMA[i];
    assert.equal(Variant[rustName], i, `Variant.${rustName}`);
    assert.equal(VARIANT_NAMES[i], rustName, `VARIANT_NAMES[${i}]`);
    assert.equal(BUILDER_NAMES[i], builderName, `BUILDER_NAMES[${i}]`);
    assert.equal(typeof Instructions[builderName], 'function', `Instructions.${builderName}`);
  }
  assert.ok(Object.isFrozen(Instructions));
  assert.ok(Object.isFrozen(Variant));
  assert.ok(Object.isFrozen(VARIANT_NAMES));
  assert.ok(Object.isFrozen(BUILDER_NAMES));
  assert.ok(Object.isFrozen(_raw));
  assert.deepEqual(Object.keys(_raw).sort(), ['pqSignedTransfer', 'subDelegate', 'zkIdentityProof', 'zkPrivateTransfer']);
  for (const name of Object.keys(_raw)) assert.equal(typeof _raw[name], 'function');
});

test('isDisabledVariant mirrors DISABLED_VARIANTS', () => {
  for (let i = 0; i < 62; i++) {
    assert.equal(isDisabledVariant(i), Boolean(DISABLED[i]), `variant ${i}`);
  }
  assert.deepEqual(C.DISABLED_VARIANTS, Object.keys(DISABLED).map(Number));
  assert.equal(isDisabledVariant(62), false);
});

test('vectors.json is the unmodified 91-vector arbiter', () => {
  assert.equal(VECTORS.length, 91);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'vectors.json'))).digest('hex');
  assert.equal(sha, '8dc0a7ac557150d5d89936947445deb5a238cb0cf54c8511d9d3224669113486');
  const covered = new Set(VECTORS.map((v) => v.index));
  assert.equal(covered.size, 62, 'every variant has at least one vector');
  for (const v of VECTORS) {
    assert.equal(v.variant, SCHEMA[v.index][0], `vector ${v.index}/${v.label} variant name`);
    assert.deepEqual(Object.keys(v.fields), SCHEMA[v.index][2].map((f) => f[0]), `vector ${v.index}/${v.label} field order`);
    assert.equal(v.hex.length, v.length * 2);
    assert.equal(v.hex.slice(0, 8), hex(u32le(v.index)), 'discriminant');
  }
});

// ---------------------------------------------------------------------------
// Every vector, every builder
// ---------------------------------------------------------------------------

for (const vector of VECTORS) {
  const [, builderName, fields] = SCHEMA[vector.index];
  const label = `vector ${vector.index} ${vector.variant} [${vector.label}]`;
  test(`${label} via ${DISABLED[vector.index] ? '_raw' : 'Instructions'}.${builderName} is byte-exact`, () => {
    const args = fields.map(([name, type]) => toArg(type, vector.fields[name], name));
    assert.equal(args.length, fields.length);
    const out = builderFor(vector.index)(...args);
    assert.ok(Buffer.isBuffer(out), 'builders return Buffer');
    assert.equal(out.length, vector.length, `${label} length`);
    assert.equal(hex(out), vector.hex, `${label} bytes`);
    assert.equal(readVariant(out), vector.index);
  });
}

test('zero-values vectors: empty strings and zeros are encoded verbatim (no silent defaults)', () => {
  // 4.x substituted 'agent', '{}', 'global', 'poster_confirm', 100, 1, 3, 151200, 'payment',
  // 'groth16', 'custom', '0.0.0', 'local', 'text' for falsy inputs (encoders-vs-reference.md).
  const zero = VECTORS.filter((v) => v.label === 'zero-values');
  assert.equal(zero.length, 11);
  assert.deepEqual(zero.map((v) => v.index), [18, 20, 25, 28, 29, 31, 34, 39, 42, 46, 50]);
  for (const v of zero) {
    const [, builderName, fields] = SCHEMA[v.index];
    const out = Instructions[builderName](...fields.map(([n, t]) => toArg(t, v.fields[n], n)));
    assert.equal(hex(out), v.hex, `${v.variant} zero-values`);
  }
  // AttestReputation u8-max: score 255 must not be clamped to 100 (node clamps at contracts.rs:3568; the SDK does not).
  const u8max = VECTORS.find((v) => v.index === 20 && v.label === 'u8-max');
  assert.equal(hex(Instructions.attestReputation(u8max.fields.subject_pubkey, 255, 'x', '')), u8max.hex);
});

test('undefined and null both encode Option::None; 0, "" and [] encode Some', () => {
  const none = VECTORS.find((v) => v.index === 16 && v.label === 'options-none');
  const pk = none.fields.agent_pubkey;
  // The options-none vector sets revoked = true (scratchpad vectors.json, index 16).
  assert.equal(none.fields.revoked, true);
  assert.equal(hex(Instructions.updateAgent(pk, null, null, null, null, null, true)), none.hex);
  assert.equal(hex(Instructions.updateAgent(pk, undefined, undefined, undefined, undefined, undefined, true)), none.hex);
  const some = Instructions.updateAgent(pk, 0, 0, [], [], 0, false);
  assert.equal(hex(some.subarray(4 + 8 + pk.length)), '01' + '00'.repeat(8) + '01' + '00'.repeat(8) + '01' + '00'.repeat(8) + '01' + '00'.repeat(8) + '01' + '00'.repeat(8) + '00');
  const rwa = Instructions.rwaUpdateStatus('t', 'active', 0, '', '');
  assert.equal(hex(rwa), hex(Buffer.concat([
    u32le(7), u64le(1), Buffer.from('t'), u64le(6), Buffer.from('active'),
    Buffer.from([1]), u64le(0), Buffer.from([1]), u64le(0), Buffer.from([1]), u64le(0),
  ])));
  // tail: Option<u32> Some(0) ‖ Option<String> None ‖ bool false
  assert.equal(hex(Instructions.updateCapability('p', 'c', null, null, null, 0, null, false)).slice(-14), '01' + '00000000' + '00' + '00');
});

// ---------------------------------------------------------------------------
// Disabled variants (D3)
// ---------------------------------------------------------------------------

for (const [index, key] of Object.entries(DISABLED)) {
  const builderName = SCHEMA[index][1];
  test(`Instructions.${builderName} (variant ${index}) throws FeatureDisabledError synchronously`, () => {
    const fields = SCHEMA[index][2];
    const args = fields.map(([, t]) => sampleArg(t));
    for (const callArgs of [args, [], [1, 2, 3]]) {
      assert.throws(() => Instructions[builderName](...callArgs), (err) => {
        assert.ok(err instanceof FeatureDisabledError, `${builderName}: expected FeatureDisabledError, got ${err && err.name}`);
        assert.equal(err.name, 'FeatureDisabledError');
        assert.equal(err.code, 'feature_disabled');
        assert.equal(err.feature, key);
        assert.equal(err.message, DISABLED_FEATURES[key].message);
        assert.equal(err.replacement, DISABLED_FEATURES[key].replacement);
        assert.equal(err.citation, DISABLED_FEATURES[key].citation);
        assert.equal(typeof err.citation, 'string');
        assert.ok(err.citation.length > 0);
        return true;
      });
    }
    // The raw encoder still exists for wire-format tests and is not the public builder.
    assert.equal(typeof _raw[builderName], 'function');
    assert.notEqual(_raw[builderName], Instructions[builderName]);
    assert.ok(Buffer.isBuffer(_raw[builderName](...args)));
  });
}

test('DISABLED_FEATURES messages name the replacement path (blueprint §4)', () => {
  assert.equal(DISABLED_FEATURES.SubDelegate.message, 'SubDelegate (variant 22) is rejected by the node at ingress with "SubDelegate is disabled (XWC-82)" and skipped in blocks. Register each agent directly with RegisterAgent (variant 15).');
  assert.equal(DISABLED_FEATURES.SubDelegate.replacement, 'Instructions.registerAgent / XerisClient.registerAgent');
  assert.equal(DISABLED_FEATURES.SubDelegate.citation, 'ledger.rs:1445-1450, 6911-6914');
  assert.equal(DISABLED_FEATURES.ZkPrivateTransfer.message, 'ZkPrivateTransfer (variant 48) is skipped by the node dispatcher (NEW-CRIT-3): the fee is charged and no balance changes. There is no private-transfer path; use NativeTransfer (variant 11) or TokenTransfer (variant 1).');
  assert.equal(DISABLED_FEATURES.ZkPrivateTransfer.citation, 'ledger.rs:8669-8685');
  assert.equal(DISABLED_FEATURES.ZkIdentityProof.message, 'ZkIdentityProof (variant 49) is skipped by the node dispatcher (NEW-CRIT-1). The only live proof path is ZkProofSubmit (variant 46) against a VK registered with ZkVkRegister (variant 61).');
  assert.equal(DISABLED_FEATURES.ZkIdentityProof.citation, 'ledger.rs:8687-8697');
  assert.equal(DISABLED_FEATURES.PqSignedTransfer.message, 'PqSignedTransfer (variant 52) is skipped by the node dispatcher (NEW-CRIT-4). Transfers are Ed25519-signed NativeTransfer (variant 11); PqKeyRegister (50) and PqKeyRotate (51) remain live.');
  assert.equal(DISABLED_FEATURES.PqSignedTransfer.citation, 'ledger.rs:8809-8828');
  assert.equal(DISABLED_FEATURES.airdrop.message, 'GET /airdrop/{address}/{amount} is disabled on the node (HTTP 200 body {"status":501}, NEW-HIGH-7). Fund an account with a NativeTransfer from a funded key.');
  assert.equal(DISABLED_FEATURES.stakeClaim.message, 'POST /stake/claim returns HTTP 501 (NEW-CRIT-6). Staking rewards are paid automatically every 900 blocks to the liquid balance; there is nothing to claim.');
  assert.equal(DISABLED_FEATURES.stakeClaim.replacement, null);
  assert.equal(DISABLED_FEATURES.governanceRpcWrite.message, 'POST /governance/vote and /governance/propose return HTTP 501 (NEW-CRIT-6). Use the on-chain instructions CreateProposal (39), CastVote (40), ExecuteProposal (41) via POST /submit.');
  assert.equal(DISABLED_FEATURES.governanceLock.message, 'POST /governance/lock and /governance/delegate return HTTP 501 (NEW-CRIT-6). No on-chain lock or delegation instruction exists; GET /governance/lock/{address} remains readable.');
  assert.equal(DISABLED_FEATURES.governanceLock.replacement, null);
  assert.equal(DISABLED_FEATURES.QueryCapabilities.replacement, 'XerisClient.searchCapabilities');
  assert.equal(DISABLED_FEATURES.QueryCapabilities.citation, 'ledger.rs:7460-7464');
  assert.deepEqual(Object.keys(DISABLED_FEATURES).sort(), ['SubDelegate', 'QueryCapabilities', 'ZkIdentityProof', 'ZkPrivateTransfer', 'PqSignedTransfer', 'agentDelegatedMethod', 'agentLaunchpad', 'agentRwa', 'agentStake', 'agentSwap', 'airdrop', 'governanceLock', 'governanceRpcWrite', 'stakeClaim'].sort());
  assert.ok(Object.isFrozen(DISABLED_FEATURES));
});

// ---------------------------------------------------------------------------
// Arity (D4) and field-level errors
// ---------------------------------------------------------------------------

test('every live builder throws EncodingError(code arity) on one argument too few or too many', () => {
  for (let i = 0; i < 62; i++) {
    if (DISABLED[i]) continue;
    const [, builderName, fields] = SCHEMA[i];
    const fn = Instructions[builderName];
    const args = fields.map(([, t]) => sampleArg(t));
    assert.ok(Buffer.isBuffer(fn(...args)), `${builderName} with ${args.length} args`);
    for (const bad of [args.slice(0, -1), [...args, 0]]) {
      assert.throws(() => fn(...bad), (err) => {
        assert.ok(err instanceof EncodingError, `${builderName}(${bad.length} args): expected EncodingError, got ${err && err.name}: ${err && err.message}`);
        assert.equal(err.code, 'arity', builderName);
        assert.equal(err.message, `Instructions.${builderName} expects exactly ${fields.length} arguments (${fieldList(fields)}), got ${bad.length}`);
        return true;
      });
    }
    // Trailing `undefined` still counts as an argument: no optional parameters anywhere.
    if (fields.length > 1) {
      assert.throws(() => fn(...args, undefined), (err) => err instanceof EncodingError && err.code === 'arity');
    }
  }
  function fieldList(fields) {
    return fields.map(([name]) => name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())).join(', ');
  }
});

test('raw encoders of disabled variants keep strict arity too', () => {
  for (const [index] of Object.entries(DISABLED)) {
    const [, builderName, fields] = SCHEMA[index];
    const args = fields.map(([, t]) => sampleArg(t));
    assert.throws(() => _raw[builderName](...args.slice(0, -1)), (err) => err instanceof EncodingError && err.code === 'arity');
    assert.throws(() => _raw[builderName](...args, 0), (err) => err instanceof EncodingError && err.code === 'arity');
  }
});

test('field-level TypeError/RangeError name the parameter', () => {
  const ok = (fn) => assert.ok(Buffer.isBuffer(fn()));
  const rejects = (fn, cls, param) => assert.throws(fn, (err) => {
    assert.ok(err instanceof cls, `expected ${cls.name}, got ${err && err.name}: ${err && err.message}`);
    assert.ok(err.message.includes(param), `message should name '${param}': ${err.message}`);
    return true;
  });
  rejects(() => Instructions.openDispute('d1', 'task', 't1', 'Bob', 'late', '', -1), RangeError, 'bond');
  rejects(() => Instructions.openDispute('d1', 'task', 't1', 'Bob', 'late', '', '1'), TypeError, 'bond');
  rejects(() => Instructions.openDispute('d1', 'task', 't1', 'Bob', 'late', '', 2n ** 64n), RangeError, 'bond');
  rejects(() => Instructions.openDispute('d1', 'task', 't1', 5, 'late', '', 1), TypeError, 'defendant');
  rejects(() => Instructions.acceptDeal('deal-1', 1, 'Alice', 1, Buffer.alloc(31)), RangeError, 'expectedTermsHash');
  rejects(() => Instructions.acceptDeal('deal-1', 1, 'Alice', 1, Buffer.alloc(33)), RangeError, 'expectedTermsHash');
  rejects(() => Instructions.acceptDeal('deal-1', 1, 'Alice', 1, 'ab'.repeat(32)), TypeError, 'expectedTermsHash');
  rejects(() => Instructions.acceptDeal('deal-1', 1, 'Alice', 1, new Array(32).fill(0)), TypeError, 'expectedTermsHash');
  ok(() => Instructions.acceptDeal('deal-1', 1, 'Alice', 1, new Uint8Array(32)));
  rejects(() => Instructions.postTask('t', 'T', '', '', [], 256, 1, 0, 1, 'poster_confirm', '', 0), RangeError, 'minReputation');
  rejects(() => Instructions.postTask('t', 'T', '', '', [], 0, 1, 0, 2 ** 32, 'poster_confirm', '', 0), RangeError, 'maxClaimants');
  rejects(() => Instructions.postTask('t', 'T', '', '', 'tag', 0, 1, 0, 1, 'poster_confirm', '', 0), TypeError, 'requiredTags');
  rejects(() => Instructions.registerAgent('a', 'p', 1, 1, 'x', [], 0), TypeError, 'allowedContracts');
  rejects(() => Instructions.registerAgent('a', 'p', 1, 1, [], [1], 0), TypeError, 'allowedOperations');
  rejects(() => Instructions.registerAgent('a', 'p', 9007199254740993, 1, [], [], 0), RangeError, 'maxPerTx');
  ok(() => Instructions.registerAgent('a', 'p', 9007199254740993n, 1, [], [], 0));
  rejects(() => Instructions.tokenCreate('t', 'n', 's', 256, 1, 'm'), RangeError, 'decimals');
  rejects(() => Instructions.tokenCreate('t', 'n', 's', '9', 1, 'm'), TypeError, 'decimals');
  rejects(() => Instructions.tokenCreateRWA('t', 'n', 's', 0, 1, 'm', 'equity', 'h', 'u', 'US', 1, false, 0), TypeError, 'transferRestricted');
  rejects(() => Instructions.tokenCreateRWA('t', 'n', 's', 0, 1, 'm', 'equity', 'h', 'u', 'US', false, 'no', 0), TypeError, 'accreditedOnly');
  rejects(() => Instructions.nativeTransfer('a', 'b', 1.5), RangeError, 'amount');
  rejects(() => Instructions.nativeTransfer('a', 'b', true), TypeError, 'amount');
  rejects(() => Instructions.nativeTransfer('a', 'b', -1n), RangeError, 'amount');
  rejects(() => Instructions.nativeTransfer('a', '\ud800', 1), RangeError, 'to');
  rejects(() => Instructions.nativeTransfer(null, 'b', 1), TypeError, 'from');
  rejects(() => Instructions.createIdentity('p', '\udc00', 'agent', '', ''), RangeError, 'displayName');
  rejects(() => Instructions.updateAgent('p', -1, null, null, null, null, false), RangeError, 'newMaxPerTx');
  rejects(() => Instructions.updateAgent('p', null, null, 'x', null, null, false), TypeError, 'newAllowedContracts');
  rejects(() => Instructions.updateAgent('p', null, null, null, null, null, 1), TypeError, 'revoked');
  rejects(() => Instructions.updateCapability('p', 'c', null, null, null, 2 ** 32, null, false), RangeError, 'newMaxConcurrent');
  rejects(() => Instructions.agentHeartbeat('p', 'h', -1, 0, ''), RangeError, 'activeTasks');
  rejects(() => Instructions.agentHeartbeat('p', 'h', 0, 2 ** 32, ''), RangeError, 'availableCapacity');
  rejects(() => Instructions.validatorAttestation('v', 1, [1, 2, 3]), TypeError, 'blockHashPrefix');
  rejects(() => Instructions.validatorAttestation('v', 1, 'abcd'), TypeError, 'blockHashPrefix');
  rejects(() => Instructions.agentExecute('o', [11, 0, 0, 0]), TypeError, 'innerInstruction');
  rejects(() => Instructions.closeChannel('c', 1, 1, 1, 'sig'), TypeError, 'counterpartySignature');
  rejects(() => Instructions.forceCloseChannel('c', 1, 1, 1, null), TypeError, 'counterpartySignature');
  rejects(() => Instructions.pqKeyRegister('e', Buffer.alloc(1952), 'dilithium3', 256), RangeError, 'securityLevel');
  rejects(() => Instructions.pqKeyRegister('e', 'key', 'dilithium3', 3), TypeError, 'pqPublicKey');
  rejects(() => Instructions.pqAttest('tx', 'r', 'dilithium3', 'true'), TypeError, 'verified');
  rejects(() => Instructions.disputeDeal('d', 1, 'r', 0.5), RangeError, 'bond');
  rejects(() => Instructions.createDeal('d', 'c', 1, 5), TypeError, 'terms');
  rejects(() => Instructions.confirmDeal('d', '1'), TypeError, 'instance');
  rejects(() => Instructions.zkVkRegister('vk', 'AAAA', 'transfer', undefined), TypeError, 'description');
  rejects(() => Instructions.zkProofSubmit('p', 'groth16', 'proof', Buffer.alloc(0), 'vk', 't', '{}'), TypeError, 'proofData');
  rejects(() => Instructions.contractDeploy('c', 'swap', { token_a: 'x' }), TypeError, 'paramsJson');
});

test('builders are pure encoders: node business rules are not applied (D1)', () => {
  // Each of these is refused by the node but must encode (the client wrappers enforce the rules).
  assert.ok(Buffer.isBuffer(Instructions.nativeTransfer('a', '__escrow', 0)));          // ledger.rs:1569-1577
  assert.ok(Buffer.isBuffer(Instructions.pqKeyRegister('e', Buffer.alloc(10), 'rsa', 1)));  // crypto.rs:924-976
  assert.ok(Buffer.isBuffer(Instructions.disputeDeal('d', 1, 'r', 1)));                  // contracts.rs:1008
  assert.ok(Buffer.isBuffer(Instructions.attestReputation('s', 255, 'nope', '')));       // contracts.rs:3568
  assert.ok(Buffer.isBuffer(Instructions.validatorAttestation('v', 1, Buffer.alloc(5)))); // ledger.rs:1400
  assert.ok(Buffer.isBuffer(Instructions.createProposal('p', 't', '', '', '', 1, 0)));     // ledger.rs:8267
  assert.ok(Buffer.isBuffer(Instructions.zkProofSubmit('p', 'plonk', Buffer.alloc(0), Buffer.alloc(0), '', 'pq', '')));
  assert.ok(Buffer.isBuffer(Instructions.queryCapabilities('c', [], '', 0, 0)));         // no-op in blocks, ledger.rs:7460-7464
});

// ---------------------------------------------------------------------------
// contractCall argument forms and encodeSwapCall (§7.1)
// ---------------------------------------------------------------------------

test('contractCall: plain object is JSON-encoded, Buffer/Uint8Array are raw, anything else is a TypeError', () => {
  const jsonVec = VECTORS.find((v) => v.index === 4 && v.label === 'json-args');
  assert.equal(hex(Instructions.contractCall('lp_moon_token', 'buy_tokens', { xrs_amount: 5000000000 })), jsonVec.hex);
  const expectedJson = Buffer.from('{"a":1}', 'utf8');
  assert.equal(hex(Instructions.contractCall('c', 'm', { a: 1 })), hex(Buffer.concat([u32le(4), u64le(1), Buffer.from('c'), u64le(1), Buffer.from('m'), u64le(expectedJson.length), expectedJson])));
  assert.equal(hex(Instructions.contractCall('c', 'm', {})), hex(Buffer.concat([u32le(4), u64le(1), Buffer.from('c'), u64le(1), Buffer.from('m'), u64le(2), Buffer.from('{}')])));
  // probes.md: 4.x JSON-encoded a Buffer as {"type":"Buffer","data":[...]}.
  const raw = Instructions.contractCall('c', 'm', Buffer.alloc(16, 1));
  assert.equal(hex(raw), hex(Buffer.concat([u32le(4), u64le(1), Buffer.from('c'), u64le(1), Buffer.from('m'), u64le(16), Buffer.alloc(16, 1)])));
  assert.equal(hex(Instructions.contractCall('c', 'm', new Uint8Array(16).fill(1))), hex(raw));
  const binVec = VECTORS.find((v) => v.index === 4 && v.label === 'binary-swap-args');
  assert.equal(hex(Instructions.contractCall('pool_xusdc_xrs', 'swap_a_to_b', Buffer.from(binVec.fields.args, 'hex'))), binVec.hex);
  // (A JSON-text string is not asserted either way: blueprint §7.1 rejects every string,
  // core.js accepts JSON text of an object; both refuse a non-JSON string.)
  for (const bad of [[1, 2, 3], 5, null, undefined, true, [], 'abcd', '"s"', '[1]', new Date(), new Map()]) {
    assert.throws(() => Instructions.contractCall('c', 'm', bad), TypeError, `args ${String(bad)}`);
  }
  // bigint is written as exact JSON digits (the node reads u64 with as_u64, exact to 2^64-1).
  const big = Instructions.contractCall('lp', 'buy_tokens', { xrs_amount: 50_000_000_000n, min_tokens_out: 15488583466903808n });
  assert.ok(big.toString('utf8').endsWith('{"xrs_amount":50000000000,"min_tokens_out":15488583466903808}'));
  assert.ok(Instructions.contractCall('c', 'm', { a: 18446744073709551615n }).toString('utf8').endsWith('{"a":18446744073709551615}'));
  // Values JSON.stringify would silently change are refused (review: slippage floor removed on the node).
  for (const [args, E] of [
    [{ xrs_amount: 1000, min_tokens_out: NaN }, RangeError],
    [{ xrs_amount: 1000, min_tokens_out: Infinity }, RangeError],
    [{ xrs_amount: 1000, min_tokens_out: undefined }, TypeError],
    [{ xrs_amount: 9007199254740993 }, RangeError],
    [{ xrs_amount: 2 ** 64 }, RangeError],
    [{ a: 2n ** 64n }, RangeError],
    [{ f: () => 1 }, TypeError],
    [{ note: '\uD800' }, RangeError],
    [{ ['\uDC00']: 1 }, RangeError],
    [{ b: Buffer.alloc(2) }, TypeError],
    [{ d: new Date(0) }, TypeError],
  ]) {
    assert.throws(() => Instructions.contractCall('lp', 'buy_tokens', args), E, JSON.stringify(Object.keys(args)));
  }
  // The string path is checked the way serde_json reads it.
  assert.throws(() => Instructions.contractCall('c', 'm', '{"note":"\\ud800"}'), RangeError);
  assert.throws(() => Instructions.contractCall('c', 'm', '{"a":1e400}'), RangeError);
  assert.throws(() => Instructions.contractCall('c', 'm', '{"a":18446744073709551616}'), RangeError);
  assert.ok(Instructions.contractCall('c', 'm', '{"a":18446744073709551615}').toString('utf8').endsWith('{"a":18446744073709551615}'));
});

test('encodeSwapCall: ContractCall with 16 raw LE bytes (input_amount ‖ min_output)', () => {
  // contracts.rs:2419-2441, 2484-2499
  assert.equal(hex(encodeSwapCall('pool1', 'swap_a_to_b', 10_000_000, 1)), '040000000500000000000000706f6f6c310b00000000000000737761705f615f746f5f62100000000000000080969800000000000100000000000000');
  assert.equal(hex(encodeSwapCall('pool1', 'swap_a_to_b', 10_000_000n, 1n)), hex(encodeSwapCall('pool1', 'swap_a_to_b', 10_000_000, 1)));
  const binVec = VECTORS.find((v) => v.index === 4 && v.label === 'binary-swap-args');
  assert.equal(hex(encodeSwapCall('pool_xusdc_xrs', 'swap_a_to_b', 1_000_000_000_000n, 995_000_000_000n)), binVec.hex);
  assert.equal(hex(encodeSwapCall('p', 'swap_b_to_a', 1, 0)), hex(Instructions.contractCall('p', 'swap_b_to_a', Buffer.concat([u64le(1), u64le(0)]))));
  assert.equal(ix.encodeSwapCall, encodeSwapCall);
  assert.throws(() => encodeSwapCall('p', 'swap', 1, 1), RangeError);
  assert.throws(() => encodeSwapCall('p', 'SWAP_A_TO_B', 1, 1), RangeError);
  assert.throws(() => encodeSwapCall('p', 'swap_a_to_b', -1, 1), RangeError);
  assert.throws(() => encodeSwapCall('p', 'swap_a_to_b', 1, 2n ** 64n), RangeError);
  assert.throws(() => encodeSwapCall('p', 'swap_a_to_b', '1', 1), TypeError);
  assert.throws(() => encodeSwapCall('p', 'swap_a_to_b', 1), EncodingError);
  assert.throws(() => encodeSwapCall('p', 'swap_a_to_b', 1, 1, 1), EncodingError);
});

test('agentExecute / conditionalOrder wrap inner bytes without inspecting them', () => {
  const inner = Instructions.nativeTransfer('Alice', 'Bob', 5_000_000_000);
  assert.equal(hex(Instructions.agentExecute('Alice', inner)), '110000000500000000000000416c69636524000000000000000b0000000500000000000000416c6963650300000000000000426f6200f2052a01000000');
  const ae = VECTORS.find((v) => v.index === 17);
  const innerVec = Buffer.from(ae.fields.inner_instruction, 'hex');
  assert.equal(readVariant(innerVec), 11);
  assert.equal(hex(Instructions.agentExecute(ae.fields.owner_pubkey, innerVec)), ae.hex);
  const co = VECTORS.find((v) => v.index === 23);
  assert.equal(hex(Instructions.conditionalOrder(co.fields.order_id, co.fields.condition_type, co.fields.condition_source, co.fields.condition_threshold, Buffer.from(co.fields.inner_instruction, 'hex'), co.fields.expires_at_slot, co.fields.locked_amount)), co.hex);
  // Purity: an inner buffer that is not a valid instruction still encodes (the client rejects it).
  assert.ok(Buffer.isBuffer(Instructions.agentExecute('o', Buffer.from([0xff]))));
  assert.ok(Buffer.isBuffer(Instructions.agentExecute('o', Buffer.alloc(0))));
});

test('readVariant on builder output', () => {
  assert.equal(readVariant(Instructions.openDispute('d1', 'task', 't1', 'Bob', 'late', '', 1_000_000_000)), 36);
  assert.equal(readVariant(Instructions.forceCloseChannel('ch1', 100, 200, 0, Buffer.alloc(0))), 44);
  assert.equal(readVariant(_raw.subDelegate('s', 'n', 1, 1, [], [], 0, 1)), 22);
  assert.equal(readVariant(Instructions.zkVkRegister('vk1', 'AAAA', 'transfer', 'test')), 61);
});

test('7-field OpenDispute and 5-field ForceCloseChannel (the 4.x undecodable layouts are gone)', () => {
  assert.equal(hex(Instructions.openDispute('d1', 'task', 't1', 'Bob', 'late', '', 1_000_000_000)), '240000000200000000000000643104000000000000007461736b020000000000000074310300000000000000426f6204000000000000006c617465000000000000000000ca9a3b00000000');
  assert.equal(hex(Instructions.forceCloseChannel('ch1', 100, 200, 0, Buffer.alloc(0))), '2c00000003000000000000006368316400000000000000c80000000000000000000000000000000000000000000000');
  assert.throws(() => Instructions.openDispute('d1', 'task', 't1', 'late', '', 1_000_000_000), (e) => e instanceof EncodingError && e.code === 'arity');
  assert.throws(() => Instructions.forceCloseChannel('ch1', 100, 200, 0), (e) => e instanceof EncodingError && e.code === 'arity');
});

// ---------------------------------------------------------------------------
// Blueprint §13 reference entries (the TestVectors table)
// ---------------------------------------------------------------------------

test('blueprint §13 reference hex strings', () => {
  const cases = [
    [() => Instructions.nativeTransfer('Alice', 'Bob', 5_000_000_000), '0b0000000500000000000000416c6963650300000000000000426f6200f2052a01000000'],
    [() => Instructions.stake('TestVal', 1_000_000_000_000), '0900000007000000000000005465737456616c0010a5d4e8000000'],
    [() => Instructions.tokenMint('xUSDC', 'Bob', 1_000_000_000), '00000000050000000000000078555344430300000000000000426f6200ca9a3b00000000'],
    [() => Instructions.tokenTransfer('xUSDC', 'Alice', 'Bob', 500_000_000), '01000000050000000000000078555344430500000000000000416c6963650300000000000000426f620065cd1d00000000'],
    [() => Instructions.wrapXrs(10_000_000_000), '0d00000000e40b5402000000'],
    [() => Instructions.createDeal('deal-1', 'Bob', 2_000_000_000, 'ship 1 widget'), '3600000006000000000000006465616c2d310300000000000000426f6200943577000000000d0000000000000073686970203120776964676574'],
    [() => Instructions.acceptDeal('deal-1', 1, 'Alice', 2_000_000_000, dealTermsHash('ship 1 widget')), '3700000006000000000000006465616c2d3101000000000000000500000000000000416c6963650094357700000000734c5fd1cd9fd0bb047abb8c90edf73dd1cc4584be43973dd64c92a8402fa65d'],
    [() => Instructions.confirmDeal('deal-1', 1), '3800000006000000000000006465616c2d310100000000000000'],
    [() => Instructions.disputeDeal('deal-1', 1, 'late', 1_000_000_000), '3a00000006000000000000006465616c2d31010000000000000004000000000000006c61746500ca9a3b00000000'],
    [() => Instructions.zkVkRegister('vk1', 'AAAA', 'transfer', 'test'), '3d0000000300000000000000766b3104000000000000004141414108000000000000007472616e73666572040000000000000074657374'],
    [() => Instructions.updateAgent('AgentKey', null, 7, null, ['NativeTransfer', 'WrapXrs'], null, true), '1000000008000000000000004167656e744b657900010700000000000000000102000000000000000e000000000000004e61746976655472616e736665720700000000000000577261705872730001'],
    [() => Instructions.registerAgent('TestAgent', 'pubkey123', 1000, 2000, ['pool_a'], ['ContractCall'], 0), '0f0000000900000000000000546573744167656e7409000000000000007075626b6579313233e803000000000000d00700000000000001000000000000000600000000000000706f6f6c5f6101000000000000000c00000000000000436f6e747261637443616c6c0000000000000000'],
    [() => Instructions.rwaUpdateStatus('t', 'active', 5, null, null), '0700000001000000000000007406000000000000006163746976650105000000000000000000'],
    [() => Instructions.agentHeartbeat('Alice', '', 1, 9, 'ok'), '2d0000000500000000000000416c6963650000000000000000010000000900000002000000000000006f6b'],
    [() => Instructions.postTask('t1', 'T', '', '', [], 0, 1_000_000_000, 0, 1, 'poster_confirm', '', 0), '1f000000020000000000000074310100000000000000540000000000000000000000000000000000000000000000000000ca9a3b000000000000000000000000010000000e00000000000000706f737465725f636f6e6669726d00000000000000000000000000000000'],
    [() => Instructions.validatorAttestation('Alice', 42, Buffer.from(Array.from({ length: 32 }, (_, i) => i))), '0c0000000500000000000000416c6963652a000000000000002000000000000000000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'],
  ];
  for (const [fn, expected] of cases) assert.equal(hex(fn()), expected);
  const pq = Instructions.pqKeyRegister('Alice', Buffer.alloc(1952, 0xab), 'dilithium3', 3);
  assert.equal(pq.length, 1996);
  assert.equal(hex(pq.subarray(0, 40)), '320000000500000000000000416c696365a007000000000000ababababababababababababababab');
  assert.equal(hex(pq.subarray(-20)), 'ab0a0000000000000064696c69746869756d3303');
});

// ---------------------------------------------------------------------------
// Helpers: dealTermsHash, buildPqRotationMessage, channel messages
// ---------------------------------------------------------------------------

test('dealTermsHash = sha256(utf8(terms)), 32 raw bytes (contracts.rs:281-284)', () => {
  const h = dealTermsHash('ship 1 widget');
  assert.ok(Buffer.isBuffer(h));
  assert.equal(h.length, 32);
  assert.equal(hex(h), '734c5fd1cd9fd0bb047abb8c90edf73dd1cc4584be43973dd64c92a8402fa65d');
  assert.equal(hex(dealTermsHash('')), crypto.createHash('sha256').update('').digest('hex'));
  assert.equal(hex(dealTermsHash('é')), crypto.createHash('sha256').update(Buffer.from('é', 'utf8')).digest('hex'));
  // The AcceptDeal vector's expected_terms_hash is an arbitrary 32-byte value, not
  // derived from the CreateDeal vector's terms, so it is not a hash fixture here.
  const create = VECTORS.find((v) => v.index === 54);
  assert.equal(hex(dealTermsHash(create.fields.terms)), crypto.createHash('sha256').update(Buffer.from(create.fields.terms, 'utf8')).digest('hex'));
  assert.throws(() => dealTermsHash(5), TypeError);
  assert.throws(() => dealTermsHash(Buffer.from('x')), TypeError);
  assert.throws(() => dealTermsHash('\ud800'), RangeError);
});

test('buildPqRotationMessage = "xrs_pq_rotate_v5" ‖ chainId ‖ oldPk ‖ newPk ‖ u64le(rotationCount), no framing (crypto.rs:851-870)', () => {
  const oldPk = Buffer.alloc(1952, 0x01);
  const newPk = Buffer.alloc(1952, 0x02);
  const msg = buildPqRotationMessage('xeris-testnet-v1', oldPk, newPk, 3);
  assert.ok(Buffer.isBuffer(msg));
  assert.equal(msg.length, 16 + 16 + 1952 + 1952 + 8);
  assert.equal(msg.subarray(0, 16).toString('latin1'), 'xrs_pq_rotate_v5');
  assert.equal(msg.subarray(16, 32).toString('latin1'), 'xeris-testnet-v1');
  assert.equal(hex(msg.subarray(32, 32 + 1952)), hex(oldPk));
  assert.equal(hex(msg.subarray(32 + 1952, 32 + 3904)), hex(newPk));
  assert.equal(hex(msg.subarray(-8)), '0300000000000000');
  assert.equal(hex(buildPqRotationMessage(Buffer.from('xeris-testnet-v1'), oldPk, newPk, 3)), hex(msg));
  assert.equal(hex(buildPqRotationMessage(C.CHAIN_ID_MAINNET, oldPk, newPk, 0n).subarray(16, 32)), hex(Buffer.from('xeris-mainnet-v1')));
  assert.throws(() => buildPqRotationMessage('xeris-testnet-v1', Buffer.alloc(1951), newPk, 3), RangeError);
  assert.throws(() => buildPqRotationMessage('xeris-testnet-v1', oldPk, Buffer.alloc(1953), 3), RangeError);
  assert.throws(() => buildPqRotationMessage('xeris-testnet-v1', oldPk, newPk, -1), RangeError);
  assert.throws(() => buildPqRotationMessage('xeris-testnet-v1', oldPk, newPk, 1.5), RangeError);
  assert.throws(() => buildPqRotationMessage('xeris-testnet-v1', 'old', newPk, 3), TypeError);
  assert.throws(() => buildPqRotationMessage(5, oldPk, newPk, 3), TypeError);
});

test('channelStateMessage / channelCloseMessage layout (contracts.rs:12-30, 57-109)', () => {
  // identity(): 0x01 ‖ 32-byte key when the string parses as a Pubkey, else 0x00 ‖ u32le(len) ‖ bytes.
  const partyA = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
  const partyB = 'Bob';
  const keyA = Buffer.from(bs58.decode(partyA));
  assert.equal(keyA.length, 32);
  const lp = (b) => Buffer.concat([u32le(b.length), b]);
  const domain = Buffer.from('xeris-testnet-v1');
  const expectedState = Buffer.concat([
    Buffer.from('XRS_CH_STATE_V3'), lp(domain), lp(Buffer.from('ch-1')),
    u64le(2), u64le(1000),
    Buffer.from([1]), keyA,
    Buffer.from([0]), lp(Buffer.from('Bob')),
    u64le(30), u64le(20), u64le(41),
  ]);
  const state = channelStateMessage('xeris-testnet-v1', 'ch-1', 2, 1000, partyA, partyB, 30, 20, 41);
  assert.ok(Buffer.isBuffer(state));
  assert.equal(hex(state), hex(expectedState));
  assert.equal(hex(channelStateMessage(domain, 'ch-1', 2n, 1000n, partyA, partyB, 30n, 20n, 41n)), hex(expectedState));
  assert.equal(hex(channelStateMessage(new Uint8Array(domain), 'ch-1', 2, 1000, partyA, partyB, 30, 20, 41)), hex(expectedState));
  const expectedClose = Buffer.concat([
    Buffer.from('XRS_CLOSE_CH_V4'), lp(domain), lp(Buffer.from('ch-1')),
    u64le(2), u64le(1000),
    Buffer.from([1]), keyA,
    Buffer.from([0]), lp(Buffer.from('Bob')),
    u64le(30), u64le(20), u64le(42),
  ]);
  assert.equal(hex(channelCloseMessage('xeris-testnet-v1', 'ch-1', 2, 1000, partyA, partyB, 30, 20, 42)), hex(expectedClose));
  assert.equal(C.CHANNEL_STATE_TAG.length, 15);
  assert.equal(C.CHANNEL_CLOSE_TAG.length, 15);
  // The domain is the raw chain-id bytes, not the hex string the ledger injects
  // (ledger.rs:8310 hex-encodes, contracts.rs:5646-5648 hex-decodes it back).
  assert.equal(hex(state.subarray(15, 15 + 4 + 16)), hex(lp(domain)));
  // A UTF-8 channel id is length-prefixed by byte length.
  const utf8 = channelStateMessage('xeris-testnet-v1', 'é', 0, 0, 'a', 'b', 0, 0, 0);
  assert.equal(hex(utf8.subarray(15 + 20, 15 + 20 + 6)), hex(lp(Buffer.from('é', 'utf8'))));
  // Both parties non-pubkey.
  const both = channelStateMessage('xeris-testnet-v1', 'c', 0, 0, 'a', 'b', 0, 0, 0);
  assert.equal(hex(both.subarray(15 + 20 + 5 + 16)), hex(Buffer.concat([Buffer.from([0]), lp(Buffer.from('a')), Buffer.from([0]), lp(Buffer.from('b')), u64le(0), u64le(0), u64le(0)])));
  assert.throws(() => channelStateMessage('xeris-testnet-v1', 'c', -1, 0, 'a', 'b', 0, 0, 0), RangeError);
  assert.throws(() => channelStateMessage('xeris-testnet-v1', 5, 0, 0, 'a', 'b', 0, 0, 0), TypeError);
  assert.throws(() => channelStateMessage(5, 'c', 0, 0, 'a', 'b', 0, 0, 0), TypeError);
  // A dropped trailing field is either an arity failure or a missing u64, never a shorter message.
  assert.throws(() => channelCloseMessage('xeris-testnet-v1', 'c', 0, 0, 'a', 'b', 0, 0), (e) => e instanceof TypeError || e instanceof EncodingError);
});

// ---------------------------------------------------------------------------
// fromPlan (§7.4): POST /agent/plan responses (network.rs:5386-5577)
// ---------------------------------------------------------------------------

test('fromPlan converts the five planner shapes into instruction bytes', () => {
  const transfer = { action: 'transfer', variant_index: 11, variant_name: 'NativeTransfer', params: { from: 'A', to: 'B', amount: 1500000000 }, amount_xrs: 1.5 };
  assert.equal(hex(fromPlan(transfer)), hex(Instructions.nativeTransfer('A', 'B', 1500000000)));
  // swap: params.args is a 16-element byte array (network.rs:5455-5465)
  const argBytes = Array.from(Buffer.concat([u64le(10_000_000), u64le(1)]));
  const swap = { action: 'swap', variant_index: 4, variant_name: 'ContractCall', params: { contract_id: 'pool1', method: 'swap_a_to_b', args: argBytes } };
  assert.equal(hex(fromPlan(swap)), hex(encodeSwapCall('pool1', 'swap_a_to_b', 10_000_000, 1)));
  // buy_launchpad: params.args is an object (network.rs:5510-5523)
  const buy = { action: 'buy_launchpad', variant_index: 4, variant_name: 'ContractCall', params: { contract_id: 'lp1', method: 'buy_tokens', args: { xrs_amount: 5000000000, min_tokens_out: 990 } } };
  assert.equal(hex(fromPlan(buy)), hex(Instructions.contractCall('lp1', 'buy_tokens', { xrs_amount: 5000000000, min_tokens_out: 990 })));
  const stake = { action: 'stake', variant_index: 9, variant_name: 'Stake', params: { pubkey: 'P', amount: 1000000000000 }, amount_xrs: 1000, min_stake_xrs: 1000 };
  assert.equal(hex(fromPlan(stake)), hex(Instructions.stake('P', 1000000000000)));
  assert.equal(hex(fromPlan({ action: 'wrap', variant_index: 13, variant_name: 'WrapXrs', params: { amount: 5 }, amount_xrs: 0.000000005 })), hex(Instructions.wrapXrs(5)));
  assert.equal(hex(fromPlan({ action: 'unwrap', variant_index: 14, variant_name: 'UnwrapXrs', params: { amount: 5 }, amount_xrs: 0.000000005 })), hex(Instructions.unwrapXrs(5)));
});

test('fromPlan rejects unknown variants, missing params and unsafe numbers', () => {
  assert.throws(() => fromPlan({ variant_index: 1, params: { token_id: 't', from: 'a', to: 'b', amount: 1 } }), TypeError);
  assert.throws(() => fromPlan({ variant_index: 22, params: {} }), TypeError);
  assert.throws(() => fromPlan({ variant_index: 11 }), TypeError);
  assert.throws(() => fromPlan({ variant_index: 11, params: null }), TypeError);
  assert.throws(() => fromPlan(null), TypeError);
  assert.throws(() => fromPlan({ error: 'Unknown action' }), TypeError);
  assert.throws(() => fromPlan({ variant_index: 11, params: { from: 'A', to: 'B', amount: 1.5 } }), RangeError);
  assert.throws(() => fromPlan({ variant_index: 11, params: { from: 'A', to: 'B', amount: 9007199254740993 } }), RangeError);
  assert.throws(() => fromPlan({ variant_index: 11, params: { from: 'A', to: 'B', amount: -1 } }), RangeError);
  assert.throws(() => fromPlan({ variant_index: 13, params: { amount: 1e21 } }), RangeError);
  assert.throws(() => fromPlan({ variant_index: 4, params: { contract_id: 'p', method: 'swap_a_to_b', args: [1, 2, 256] } }), RangeError);
  assert.throws(() => fromPlan({ variant_index: 4, params: { contract_id: 'p', method: 'swap_a_to_b', args: 'abcd' } }), TypeError);
});

test('fromPlan applies the u64 range to buy_tokens args (contracts.rs:2847-2850)', () => {
  const buy = (args) => ({ variant_index: 4, params: { contract_id: 'lp_x', method: 'buy_tokens', args } });
  const negative = (e) => e instanceof RangeError && /expected an unsigned integer >= 0/.test(e.message);
  // A negative min_tokens_out reads as None under as_u64() and becomes 0: no slippage floor.
  assert.throws(() => fromPlan(buy({ xrs_amount: 1000, min_tokens_out: -5 })), (e) => negative(e) && /params\.args\.min_tokens_out/.test(e.message));
  assert.throws(() => fromPlan(buy({ xrs_amount: 1000, min_tokens_out: -5n })), (e) => negative(e) && /params\.args\.min_tokens_out/.test(e.message));
  assert.throws(() => fromPlan(buy({ xrs_amount: -1000, min_tokens_out: 1 })), (e) => negative(e) && /params\.args\.xrs_amount/.test(e.message));
  assert.throws(() => fromPlan(buy({ xrs_amount: -1000n, min_tokens_out: 1 })), (e) => negative(e) && /params\.args\.xrs_amount/.test(e.message));
  assert.throws(() => fromPlan(buy({ xrs_amount: 1, min_tokens_out: 2n ** 64n })), (e) => e instanceof RangeError && /<= 18446744073709551615/.test(e.message));
  assert.throws(() => fromPlan(buy({ xrs_amount: 2n ** 64n, min_tokens_out: 1 })), (e) => e instanceof RangeError && /params\.args\.xrs_amount/.test(e.message));
  assert.throws(() => fromPlan(buy({ xrs_amount: 1.5, min_tokens_out: 1 })), (e) => e instanceof RangeError && !/lost precision/.test(e.message));
  assert.throws(() => fromPlan(buy({ xrs_amount: 2 ** 60, min_tokens_out: 1 })), (e) => e instanceof RangeError && /lost precision/.test(e.message));
  assert.throws(() => fromPlan(buy({ xrs_amount: '1', min_tokens_out: 1 })), TypeError);
  assert.throws(() => fromPlan({ variant_index: 11, params: { from: 'A', to: 'B', amount: -1n } }), RangeError);
  assert.equal(hex(fromPlan(buy({ xrs_amount: 0, min_tokens_out: 2n ** 64n - 1n }))),
    hex(Instructions.contractCall('lp_x', 'buy_tokens', { xrs_amount: 0, min_tokens_out: 2n ** 64n - 1n })));
});

// ---------------------------------------------------------------------------
// Module surface
// ---------------------------------------------------------------------------

test('instructions/index.js exports exactly the names in the cross-module contract', () => {
  assert.deepEqual(Object.keys(ix).sort(), [
    'BUILDER_NAMES', 'Instructions', 'VARIANT_NAMES', 'Variant', '_raw', 'buildPqRotationMessage',
    'channelCloseMessage', 'channelStateMessage', 'dealTermsHash', 'encodeSwapCall', 'fromPlan', 'hardwareAttestChallenge',
    'isDisabledVariant', 'VARIANT_FIELDS', 'decodeInstruction', 'tryDecodeInstruction',
  ].sort());
  assert.equal(typeof dealTermsHash, 'function');
  assert.equal(typeof buildPqRotationMessage, 'function');
  assert.equal(typeof channelStateMessage, 'function');
  assert.equal(typeof channelCloseMessage, 'function');
  assert.equal(typeof fromPlan, 'function');
  assert.equal(typeof isDisabledVariant, 'function');
});

test('builders are plain functions with no `this` dependency', () => {
  const { nativeTransfer, acceptDeal } = Instructions;
  assert.equal(hex(nativeTransfer('Alice', 'Bob', 5_000_000_000)), '0b0000000500000000000000416c6963650300000000000000426f6200f2052a01000000');
  assert.ok(Buffer.isBuffer(acceptDeal('d', 1, 'a', 1, Buffer.alloc(32))));
});

// ---------------------------------------------------------------------------
// hardwareAttestChallenge (ledger.rs:5299-5319) and exact plan amounts
// ---------------------------------------------------------------------------

test('hardwareAttestChallenge mirrors hw_attest_challenge byte for byte', () => {
  const { hardwareAttestChallenge } = ix;
  const lp = (b) => { const n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n, b]); };
  const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
  const device = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
  const deviceKey = Buffer.from(require('bs58').decode(device));
  const expected = Buffer.concat([
    Buffer.from('XRS_HW_ATTEST_V2'),
    Buffer.from([1]), deviceKey,                       // push_identity: parses as a Pubkey
    Buffer.from([0]), lp(Buffer.from('')),             // push_identity: empty bound identity
    lp(Buffer.from('iot')), lp(Buffer.from('Acme')), lp(Buffer.from('M1')), lp(Buffer.from('1.0.0')),
    u64(123456789n),
  ]);
  assert.equal(hex(hardwareAttestChallenge(device, '', 'iot', 'Acme', 'M1', '1.0.0', 123456789n)), hex(expected));
  assert.throws(() => hardwareAttestChallenge(device, '', 'iot', 'Acme', 'M1', '1.0.0'), EncodingError);
  assert.throws(() => hardwareAttestChallenge(device, '', 'iot', 'Acme', 'M1', '1.0.0', -1), RangeError);
});

test('fromPlan encodes bigint launchpad args exactly and refuses rounded or unknown ones', () => {
  const plan = (args, method = 'buy_tokens') => ({ variant_index: 4, variant_name: 'ContractCall', params: { contract_id: 'lp_x', method, args } });
  const out = fromPlan(plan({ xrs_amount: 50000000000, min_tokens_out: 15488583466903809n }));
  assert.ok(out.toString('utf8').endsWith('{"xrs_amount":50000000000,"min_tokens_out":15488583466903809}'));
  assert.throws(() => fromPlan(plan({ xrs_amount: 50000000000, min_tokens_out: 15488583466903808 })), RangeError);
  assert.throws(() => fromPlan(plan({ xrs_amount: 1, min_tokens_out: 1, extra: 1 })), TypeError);
  assert.throws(() => fromPlan(plan({ xrs_amount: 1 })), TypeError);
  assert.throws(() => fromPlan(plan({ xrs_amount: 1, min_tokens_out: 1 }, 'sell_tokens')), TypeError);
  assert.throws(() => fromPlan(plan({ xrs_amount: '1', min_tokens_out: 1 })), TypeError);
});

// ---------------------------------------------------------------------------
// Strict decoder (bincode::deserialize::<XerisInstruction>)
// ---------------------------------------------------------------------------

test('VARIANT_FIELDS equals the independent SCHEMA transcription of token.rs', () => {
  assert.equal(ix.VARIANT_FIELDS.length, 62);
  for (let i = 0; i < 62; i += 1) {
    assert.deepEqual(ix.VARIANT_FIELDS[i].map((f) => [...f]), SCHEMA[i][2], `variant ${i}`);
  }
});

test('decodeInstruction reads every vector back to its fields', () => {
  const asJson = (type, v) => {
    if (v === null) return null;
    const t = type.replace(/^\?/, '');
    if (t === 'u64') return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : String(v);
    if (t === 'B' || t === 'B32') return hex(v);
    return v;
  };
  for (const v of VECTORS) {
    const d = ix.decodeInstruction(Buffer.from(v.hex, 'hex'));
    assert.ok(d !== null, `${v.index}/${v.label}`);
    assert.equal(d.variant, v.index);
    assert.equal(d.name, v.variant);
    assert.equal(d.byteLength, v.length);
    const got = Object.fromEntries(ix.VARIANT_FIELDS[v.index].map(([name, type]) => [name, asJson(type, d.fields[name])]));
    assert.deepEqual(got, v.fields, `${v.index}/${v.label}`);
  }
});

test('decodeInstruction refuses what bincode refuses and ignores trailing bytes', () => {
  const ok = Instructions.updateIdentity('k', null, 'm', true);
  assert.deepEqual(ix.decodeInstruction(Buffer.concat([ok, Buffer.from([9, 9])])).fields, {
    identity_pubkey: 'k', new_display_name: null, new_metadata: 'm', deactivated: true,
  });
  for (let n = 0; n < ok.length; n += 1) assert.equal(ix.decodeInstruction(ok.subarray(0, n)), null, `truncated to ${n}`);
  const flip = (offset, byte) => { const b = Buffer.from(ok); b[offset] = byte; return b; };
  assert.match(ix.tryDecodeInstruction(flip(13, 2)).reason, /new_display_name: invalid Option tag 0x02/);
  assert.match(ix.tryDecodeInstruction(flip(ok.length - 1, 2)).reason, /deactivated: invalid bool byte 0x02/);
  assert.match(ix.tryDecodeInstruction(flip(12, 0xff)).reason, /identity_pubkey: String is not valid UTF-8/);
  assert.match(ix.tryDecodeInstruction(u32le(62)).reason, /variant index 62/);
  assert.match(ix.tryDecodeInstruction(Buffer.alloc(3)).reason, /needs 4/);
  // A UTF-8 BOM is valid UTF-8 and is kept, as str::from_utf8 keeps it.
  assert.equal(ix.decodeInstruction(Instructions.cancelConditionalOrder('﻿x')).fields.order_id, '﻿x');
  assert.throws(() => ix.decodeInstruction('0b000000'), TypeError);
});
