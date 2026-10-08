'use strict';

/**
 * The package's public surface is fixed (blueprint §14.1): this file asserts
 * the exact export set, that internals stay private, and that index.d.ts
 * declares every export.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sdk = require('..');

const CLASSES = ['XerisClient', 'XerisDApp', 'XerisAgent', 'XerisKeypair'];
const INSTRUCTION_LAYER = [
  'Instructions', 'Variant', 'VARIANT_NAMES', 'BUILDER_NAMES', 'fromPlan', 'isDisabledVariant', 'encodeSwapCall',
  'dealTermsHash', 'buildPqRotationMessage', 'channelStateMessage', 'channelCloseMessage', 'hardwareAttestChallenge',
];
const ENCODING = [
  'encodeU8', 'encodeU32', 'encodeU64', 'encodeBool', 'encodeString', 'encodeBytes', 'encodeFixedBytes',
  'encodeStringVec', 'encodeOption', 'encodeVariant', 'readVariant', 'normalizeU64', 'normalizeU32', 'normalizeU8',
  'xrsToLamports', 'lamportsToXrs', 'toBaseUnits', 'fromBaseUnits', 'stringifyJson', 'parseJson',
  'encodeBincodeString', 'encodeBincodeVec', 'encodeBincodeStringVec',
];
const TRANSACTION = [
  'blockhashFromHex', 'buildTransaction', 'signTransaction', 'serializeTransaction', 'assembleSignedTransaction',
  'assertInstructionSubmittable', 'parseSubmitResponse', 'signatureOf', 'isCanonicalPubkey', 'pubkeyBytes',
];
const ERRORS = ['XerisError', 'EncodingError', 'FeatureDisabledError', 'RpcError', 'DISABLED_FEATURES'];
const OTHER = ['checks', 'isProtectedContractCall', 'TestVectors'];
const CONSTANTS = [
  'VERSION', 'XRS_DECIMALS', 'LAMPORTS_PER_XRS', 'BASE_TX_FEE', 'BASE_TX_FEE_XRS', 'DEFAULT_RPC_PORT',
  'DEFAULT_EXPLORER_PORT', 'DEFAULT_P2P_PORT', 'TESTNET_SEED', 'MAINNET_HOST_ENV', 'CHAIN_ID_TESTNET',
  'CHAIN_ID_MAINNET', 'SLOT_MS', 'BLOCKHASH_EXPIRY_WINDOW', 'MAX_IX_DATA_SIZE', 'MAX_SLASH_IX_DATA_SIZE',
  'MAX_IX_PER_TX', 'MAX_ACCOUNTS_PER_TX', 'MAX_TX_BYTES', 'WRITE_BODY_LIMIT_BYTES', 'WRITE_RPC_LIMIT',
  'MIN_STAKE_LAMPORTS', 'MIN_ATTESTOR_STAKE_LAMPORTS', 'MIN_UNSTAKE_LAMPORTS', 'UNBONDING_PERIOD_SLOTS',
  'ATTESTATION_REWARD_LAMPORTS', 'ATTESTATION_SLOT_WINDOW', 'STAKING_REWARD_INTERVAL_BLOCKS',
  'STAKING_APY_PCT', 'BASE_BLOCK_REWARD_LAMPORTS', 'HALVING_INTERVAL_BLOCKS', 'MAX_EMISSION_SUPPLY_LAMPORTS',
  'MAX_RECENT_BLOCKS', 'INSTRUCTION_COUNT', 'DISABLED_VARIANTS', 'SUPPORTED_PQ_ALGORITHM',
  'PQ_PUBLIC_KEY_LEN', 'PQ_SECRET_KEY_LEN', 'PQ_SIGNATURE_LEN', 'PQ_SECURITY_LEVEL', 'PQ_CLAIM_TOKENS',
  'PQ_ROTATE_TAG', 'CHANNEL_STATE_TAG', 'CHANNEL_CLOSE_TAG', 'CHANNEL_CHALLENGE_PERIOD_SLOTS',
  'MAX_GROTH16_PROOF_BYTES', 'MAX_GROTH16_VK_BYTES', 'MAX_GROTH16_PUBLIC_INPUTS', 'AGENT_OPERATIONS',
  'AGENT_INNER_VARIANTS', 'DELEGATED_CALL_METHODS', 'AGENT_DAILY_WINDOW_SLOTS', 'MAX_AGENTS_PER_REGISTRY',
  'IDENTITY_TYPES', 'REPUTATION_CATEGORIES', 'MESSAGE_TYPES', 'CONDITION_TYPES', 'FEED_TYPES',
  'DEVICE_TYPES', 'TASK_VERIFICATION_MODES', 'TASK_RESOLUTIONS', 'DISPUTE_ACTIONS', 'VOTES',
  'RWA_ASSET_TYPES', 'RWA_STATUSES', 'CONTRACT_TYPE_ALIASES', 'PROTOCOL_MANAGED_CONTRACT_TYPES',
  'RESERVED_CONTRACT_ID_PREFIXES', 'RESERVED_CONTRACT_ID_SUFFIXES', 'CONTRACT_ID_PATTERN',
  'PROTOCOL_CONTRACT_IDS', 'PROTECTED_CONTRACT_CALLS', 'MIN_DEAL_DISPUTE_BOND', 'DEAL_TIMEOUT_SLOTS', 'DISPUTE_CHALLENGE_PERIOD_SLOTS',
  'DISPUTE_MAX_LIFETIME_SLOTS', 'MAX_TASK_LIFETIME_SLOTS', 'ORDER_STORAGE_BOND', 'MAX_ORDER_LIFETIME_SLOTS',
  'MAX_CONDITIONAL_INNER_BYTES', 'CONDITIONAL_INNER_VARIANTS', 'MIN_ORACLE_STAKE_LAMPORTS', 'MIN_VOTING_PERIOD_SLOTS',
  'MAX_VOTING_PERIOD_SLOTS', 'DEFAULT_PROPOSAL_QUORUM', 'MIN_PROPOSAL_STAKE_LAMPORTS',
  'LAUNCHPAD_XERIS_FEE_BPS', 'REGISTRY_PAGE_ITEMS', 'ACCOUNT_HISTORY_MAX_PAGE_SIZE',
  'ACCOUNT_HISTORY_MAX_PAGE', 'LIST_MAX_PAGE_SIZE', 'SIGNATURES_MAX_LIMIT', 'PRICE_HISTORY_MAX_LIMIT', 'TX_STATUSES', 'STRING_LIMITS',
];
const EXPECTED = [...CLASSES, ...INSTRUCTION_LAYER, ...ENCODING, ...TRANSACTION, ...ERRORS, ...OTHER, ...CONSTANTS];

test('index.js exports exactly the blueprint §14.1 set', () => {
  assert.equal(new Set(EXPECTED).size, EXPECTED.length, 'expected list has no duplicates');
  assert.deepEqual(Object.keys(sdk).sort(), [...EXPECTED].sort());
  for (const name of EXPECTED) assert.notEqual(sdk[name], undefined, name);
});

test('every export is a named export under Node ESM (cjs-module-lexer detection)', () => {
  // index.d.ts declares every export as a named export; an ES-module consumer
  // must be able to import each one by name.
  const entry = path.join(__dirname, '..', 'index.js');
  const script = `import * as ns from ${JSON.stringify(entry)};`
    + "process.stdout.write(JSON.stringify(Object.keys(ns).filter((k) => k !== 'default' && k !== 'module.exports')));";
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout).sort(), [...EXPECTED].sort());
  const named = `import { XerisClient, Instructions, encodeU64, VERSION, STRING_LIMITS, stringifyJson } from ${JSON.stringify(entry)};`
    + "process.stdout.write([typeof XerisClient, typeof Instructions, typeof encodeU64, typeof VERSION, typeof STRING_LIMITS, typeof stringifyJson].join(','));";
  const res2 = spawnSync(process.execPath, ['--input-type=module', '-e', named], { encoding: 'utf8' });
  assert.equal(res2.status, 0, res2.stderr);
  assert.equal(res2.stdout, 'function,object,function,string,object,function');
});

test('internal helpers are not exported', () => {
  for (const name of ['_raw', 'disabledFeature', 'submitBody', 'serializedFromWalletResult', 'concat', 'toBytes', 'assertString', 'isPlainJsonObject', 'assertJsonObjectText', 'protectedCallProblem', 'onlyKeys', 'CLIENT_OPTION_KEYS']) {
    assert.equal(name in sdk, false, name);
  }
});

test('4.x encoding aliases are the same function objects', () => {
  assert.equal(sdk.encodeBincodeString, sdk.encodeString);
  assert.equal(sdk.encodeBincodeVec, sdk.encodeBytes);
  assert.equal(sdk.encodeBincodeStringVec, sdk.encodeStringVec);
});

test('every Instructions key is a function and the namespace is frozen', () => {
  assert.equal(Object.keys(sdk.Instructions).length, 62);
  for (const [name, fn] of Object.entries(sdk.Instructions)) assert.equal(typeof fn, 'function', name);
  assert.ok(Object.isFrozen(sdk.Instructions));
});

test('index.d.ts declares every export and every builder', () => {
  const dts = fs.readFileSync(path.join(__dirname, '..', 'index.d.ts'), 'utf8');
  for (const name of EXPECTED) {
    const re = new RegExp(`export (declare )?(const|function|class|let|namespace) ${name}\\b`);
    assert.match(dts, re, `index.d.ts declares ${name}`);
  }
  for (const name of Object.keys(sdk.Instructions)) {
    assert.match(dts, new RegExp(`\\b${name}\\(`), `index.d.ts declares Instructions.${name}`);
  }
});

test('package.json points main/types/exports at the entry files', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.main, 'index.js');
  assert.equal(pkg.types, 'index.d.ts');
  assert.equal(pkg.exports['.'].require, './index.js');
  assert.equal(pkg.exports['.'].types, './index.d.ts');
  assert.equal(pkg.version, sdk.VERSION);
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@noble/curves', '@noble/hashes', '@solana/web3.js', 'bs58', 'buffer']);
  assert.deepEqual(pkg.browser, { fs: false });
});
