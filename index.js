'use strict';

/**
 * @file xeris-sdk public entry point. Re-exports only; every symbol is
 * implemented and documented in its `src/` module:
 *
 *   src/constants.js           node-derived constants (`file:line` cited per value)
 *   src/errors.js              XerisError, EncodingError, FeatureDisabledError, RpcError
 *   src/encoding.js            bincode 1.x primitives, exact XRS/base-unit conversion
 *   src/instructions/index.js  Instructions (62 builders), Variant, fromPlan, message helpers
 *   src/keypair.js             XerisKeypair, isCanonicalPubkey, pubkeyBytes
 *   src/transaction.js         transaction assembly, signing, serialisation, /submit parsing
 *   src/client.js              XerisClient (holds a keypair, signs, talks to the node) + checks
 *   src/dapp.js                XerisDApp (browser; the wallet provider signs)
 *   src/agent.js               XerisAgent (AgentExecute delegation)
 *   src/vectors.js             TestVectors
 *
 * Not exported on purpose: `_raw` (wire encoders for the four variants the
 * node refuses: SubDelegate 22 `ledger.rs:1445-1450`, ZkPrivateTransfer 48
 * `ledger.rs:8669-8685`, ZkIdentityProof 49 `ledger.rs:8687-8697`,
 * PqSignedTransfer 52 `ledger.rs:8809-8828`), `disabledFeature`, `submitBody`,
 * `serializedFromWalletResult`, `concat`, `toBytes`, `assertString`.
 *
 * The export list is fixed; `test/exports.test.js` asserts it and nothing more.
 */

const constants = require('./src/constants.js');
const errors = require('./src/errors.js');
const encoding = require('./src/encoding.js');
const instructions = require('./src/instructions/index.js');
const keypair = require('./src/keypair.js');
const transaction = require('./src/transaction.js');
const client = require('./src/client.js');
const dapp = require('./src/dapp.js');
const agent = require('./src/agent.js');
const vectors = require('./src/vectors.js');

module.exports = {
  // -- Classes ---------------------------------------------------------------
  XerisClient: client.XerisClient,
  XerisDApp: dapp.XerisDApp,
  XerisAgent: agent.XerisAgent,
  XerisKeypair: keypair.XerisKeypair,

  // -- Instruction layer -----------------------------------------------------
  Instructions: instructions.Instructions,
  Variant: instructions.Variant,
  VARIANT_NAMES: instructions.VARIANT_NAMES,
  BUILDER_NAMES: instructions.BUILDER_NAMES,
  fromPlan: instructions.fromPlan,
  isDisabledVariant: instructions.isDisabledVariant,
  encodeSwapCall: instructions.encodeSwapCall,
  dealTermsHash: instructions.dealTermsHash,
  buildPqRotationMessage: instructions.buildPqRotationMessage,
  channelStateMessage: instructions.channelStateMessage,
  channelCloseMessage: instructions.channelCloseMessage,

  // -- Encoding primitives and unit conversion -------------------------------
  encodeU8: encoding.encodeU8,
  encodeU32: encoding.encodeU32,
  encodeU64: encoding.encodeU64,
  encodeBool: encoding.encodeBool,
  encodeString: encoding.encodeString,
  encodeBytes: encoding.encodeBytes,
  encodeFixedBytes: encoding.encodeFixedBytes,
  encodeStringVec: encoding.encodeStringVec,
  encodeOption: encoding.encodeOption,
  encodeVariant: encoding.encodeVariant,
  readVariant: encoding.readVariant,
  normalizeU64: encoding.normalizeU64,
  normalizeU32: encoding.normalizeU32,
  normalizeU8: encoding.normalizeU8,
  xrsToLamports: encoding.xrsToLamports,
  lamportsToXrs: encoding.lamportsToXrs,
  toBaseUnits: encoding.toBaseUnits,
  fromBaseUnits: encoding.fromBaseUnits,
  // 4.x names, same function objects as encodeString / encodeBytes / encodeStringVec
  encodeBincodeString: encoding.encodeBincodeString,
  encodeBincodeVec: encoding.encodeBincodeVec,
  encodeBincodeStringVec: encoding.encodeBincodeStringVec,

  // -- Transaction assembly --------------------------------------------------
  blockhashFromHex: transaction.blockhashFromHex,
  buildTransaction: transaction.buildTransaction,
  signTransaction: transaction.signTransaction,
  serializeTransaction: transaction.serializeTransaction,
  assembleSignedTransaction: transaction.assembleSignedTransaction,
  assertInstructionSubmittable: transaction.assertInstructionSubmittable,
  parseSubmitResponse: transaction.parseSubmitResponse,
  signatureOf: transaction.signatureOf,
  isCanonicalPubkey: keypair.isCanonicalPubkey,
  pubkeyBytes: keypair.pubkeyBytes,

  // -- Errors ----------------------------------------------------------------
  XerisError: errors.XerisError,
  EncodingError: errors.EncodingError,
  FeatureDisabledError: errors.FeatureDisabledError,
  RpcError: errors.RpcError,
  DISABLED_FEATURES: errors.DISABLED_FEATURES,

  // -- Node business rules (pure functions used by the three classes) --------
  checks: client.checks,

  // -- Reference vectors -----------------------------------------------------
  TestVectors: vectors.TestVectors,

  // -- Constants (src/constants.js, blueprint §5) ----------------------------
  VERSION: constants.VERSION,
  XRS_DECIMALS: constants.XRS_DECIMALS,
  LAMPORTS_PER_XRS: constants.LAMPORTS_PER_XRS,
  BASE_TX_FEE: constants.BASE_TX_FEE,
  BASE_TX_FEE_XRS: constants.BASE_TX_FEE_XRS,
  DEFAULT_RPC_PORT: constants.DEFAULT_RPC_PORT,
  DEFAULT_EXPLORER_PORT: constants.DEFAULT_EXPLORER_PORT,
  DEFAULT_P2P_PORT: constants.DEFAULT_P2P_PORT,
  TESTNET_SEED: constants.TESTNET_SEED,
  MAINNET_HOST_ENV: constants.MAINNET_HOST_ENV,
  CHAIN_ID_TESTNET: constants.CHAIN_ID_TESTNET,
  CHAIN_ID_MAINNET: constants.CHAIN_ID_MAINNET,
  SLOT_MS: constants.SLOT_MS,
  BLOCKHASH_EXPIRY_WINDOW: constants.BLOCKHASH_EXPIRY_WINDOW,
  MAX_IX_DATA_SIZE: constants.MAX_IX_DATA_SIZE,
  MAX_SLASH_IX_DATA_SIZE: constants.MAX_SLASH_IX_DATA_SIZE,
  MAX_IX_PER_TX: constants.MAX_IX_PER_TX,
  MAX_ACCOUNTS_PER_TX: constants.MAX_ACCOUNTS_PER_TX,
  MAX_TX_BYTES: constants.MAX_TX_BYTES,
  WRITE_BODY_LIMIT_BYTES: constants.WRITE_BODY_LIMIT_BYTES,
  WRITE_RPC_LIMIT: constants.WRITE_RPC_LIMIT,
  MIN_STAKE_LAMPORTS: constants.MIN_STAKE_LAMPORTS,
  MIN_ATTESTOR_STAKE_LAMPORTS: constants.MIN_ATTESTOR_STAKE_LAMPORTS,
  MIN_UNSTAKE_LAMPORTS: constants.MIN_UNSTAKE_LAMPORTS,
  UNBONDING_PERIOD_SLOTS: constants.UNBONDING_PERIOD_SLOTS,
  ATTESTATION_REWARD_LAMPORTS: constants.ATTESTATION_REWARD_LAMPORTS,
  ATTESTATION_SLOT_WINDOW: constants.ATTESTATION_SLOT_WINDOW,
  STAKING_REWARD_INTERVAL_BLOCKS: constants.STAKING_REWARD_INTERVAL_BLOCKS,
  STAKING_APY_PCT: constants.STAKING_APY_PCT,
  BASE_BLOCK_REWARD_LAMPORTS: constants.BASE_BLOCK_REWARD_LAMPORTS,
  HALVING_INTERVAL_BLOCKS: constants.HALVING_INTERVAL_BLOCKS,
  MAX_EMISSION_SUPPLY_LAMPORTS: constants.MAX_EMISSION_SUPPLY_LAMPORTS,
  MAX_RECENT_BLOCKS: constants.MAX_RECENT_BLOCKS,
  INSTRUCTION_COUNT: constants.INSTRUCTION_COUNT,
  DISABLED_VARIANTS: constants.DISABLED_VARIANTS,
  SUPPORTED_PQ_ALGORITHM: constants.SUPPORTED_PQ_ALGORITHM,
  PQ_PUBLIC_KEY_LEN: constants.PQ_PUBLIC_KEY_LEN,
  PQ_SECRET_KEY_LEN: constants.PQ_SECRET_KEY_LEN,
  PQ_SIGNATURE_LEN: constants.PQ_SIGNATURE_LEN,
  PQ_SECURITY_LEVEL: constants.PQ_SECURITY_LEVEL,
  PQ_CLAIM_TOKENS: constants.PQ_CLAIM_TOKENS,
  PQ_ROTATE_TAG: constants.PQ_ROTATE_TAG,
  CHANNEL_STATE_TAG: constants.CHANNEL_STATE_TAG,
  CHANNEL_CLOSE_TAG: constants.CHANNEL_CLOSE_TAG,
  CHANNEL_CHALLENGE_PERIOD_SLOTS: constants.CHANNEL_CHALLENGE_PERIOD_SLOTS,
  MAX_GROTH16_PROOF_BYTES: constants.MAX_GROTH16_PROOF_BYTES,
  MAX_GROTH16_VK_BYTES: constants.MAX_GROTH16_VK_BYTES,
  MAX_GROTH16_PUBLIC_INPUTS: constants.MAX_GROTH16_PUBLIC_INPUTS,
  AGENT_OPERATIONS: constants.AGENT_OPERATIONS,
  AGENT_INNER_VARIANTS: constants.AGENT_INNER_VARIANTS,
  DELEGATED_CALL_METHODS: constants.DELEGATED_CALL_METHODS,
  AGENT_DAILY_WINDOW_SLOTS: constants.AGENT_DAILY_WINDOW_SLOTS,
  MAX_AGENTS_PER_REGISTRY: constants.MAX_AGENTS_PER_REGISTRY,
  IDENTITY_TYPES: constants.IDENTITY_TYPES,
  REPUTATION_CATEGORIES: constants.REPUTATION_CATEGORIES,
  MESSAGE_TYPES: constants.MESSAGE_TYPES,
  CONDITION_TYPES: constants.CONDITION_TYPES,
  FEED_TYPES: constants.FEED_TYPES,
  DEVICE_TYPES: constants.DEVICE_TYPES,
  TASK_VERIFICATION_MODES: constants.TASK_VERIFICATION_MODES,
  TASK_RESOLUTIONS: constants.TASK_RESOLUTIONS,
  DISPUTE_ACTIONS: constants.DISPUTE_ACTIONS,
  VOTES: constants.VOTES,
  RWA_ASSET_TYPES: constants.RWA_ASSET_TYPES,
  RWA_STATUSES: constants.RWA_STATUSES,
  CONTRACT_TYPE_ALIASES: constants.CONTRACT_TYPE_ALIASES,
  PROTOCOL_MANAGED_CONTRACT_TYPES: constants.PROTOCOL_MANAGED_CONTRACT_TYPES,
  RESERVED_CONTRACT_ID_PREFIXES: constants.RESERVED_CONTRACT_ID_PREFIXES,
  RESERVED_CONTRACT_ID_SUFFIXES: constants.RESERVED_CONTRACT_ID_SUFFIXES,
  CONTRACT_ID_PATTERN: constants.CONTRACT_ID_PATTERN,
  PROTOCOL_CONTRACT_IDS: constants.PROTOCOL_CONTRACT_IDS,
  MIN_DEAL_DISPUTE_BOND: constants.MIN_DEAL_DISPUTE_BOND,
  DEAL_TIMEOUT_SLOTS: constants.DEAL_TIMEOUT_SLOTS,
  DISPUTE_CHALLENGE_PERIOD_SLOTS: constants.DISPUTE_CHALLENGE_PERIOD_SLOTS,
  DISPUTE_MAX_LIFETIME_SLOTS: constants.DISPUTE_MAX_LIFETIME_SLOTS,
  MAX_TASK_LIFETIME_SLOTS: constants.MAX_TASK_LIFETIME_SLOTS,
  ORDER_STORAGE_BOND: constants.ORDER_STORAGE_BOND,
  MAX_ORDER_LIFETIME_SLOTS: constants.MAX_ORDER_LIFETIME_SLOTS,
  MAX_CONDITIONAL_INNER_BYTES: constants.MAX_CONDITIONAL_INNER_BYTES,
  MIN_ORACLE_STAKE_LAMPORTS: constants.MIN_ORACLE_STAKE_LAMPORTS,
  MIN_VOTING_PERIOD_SLOTS: constants.MIN_VOTING_PERIOD_SLOTS,
  MAX_VOTING_PERIOD_SLOTS: constants.MAX_VOTING_PERIOD_SLOTS,
  DEFAULT_PROPOSAL_QUORUM: constants.DEFAULT_PROPOSAL_QUORUM,
  MIN_PROPOSAL_STAKE_LAMPORTS: constants.MIN_PROPOSAL_STAKE_LAMPORTS,
  LAUNCHPAD_XERIS_FEE_BPS: constants.LAUNCHPAD_XERIS_FEE_BPS,
  REGISTRY_PAGE_ITEMS: constants.REGISTRY_PAGE_ITEMS,
  ACCOUNT_HISTORY_MAX_PAGE_SIZE: constants.ACCOUNT_HISTORY_MAX_PAGE_SIZE,
  ACCOUNT_HISTORY_MAX_PAGE: constants.ACCOUNT_HISTORY_MAX_PAGE,
  LIST_MAX_PAGE_SIZE: constants.LIST_MAX_PAGE_SIZE,
  TX_STATUSES: constants.TX_STATUSES,
  STRING_LIMITS: constants.STRING_LIMITS,
};

// A re-export that resolved to `undefined` means a `src/` module no longer
// exports the name under its contracted spelling. Fail at load time rather
// than let callers discover it as "x is not a function" or as a silently
// missing constant.
for (const name of Object.keys(module.exports)) {
  if (module.exports[name] === undefined) {
    throw new errors.XerisError(`xeris-sdk: export "${name}" resolved to undefined; a src/ module does not export it`);
  }
}
