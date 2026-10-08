'use strict';

/**
 * @file xeris-sdk public entry point. Re-exports only; every symbol is
 * implemented and documented in its `src/` module:
 *
 *   src/constants.js           node-derived constants (`file:line` cited per value)
 *   src/errors.js              XerisError, EncodingError, FeatureDisabledError, RpcError
 *   src/encoding.js            bincode 1.x primitives, exact XRS/base-unit conversion, strict JSON
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
 * `serializedFromWalletResult`, `concat`, `toBytes`, `assertString`,
 * `isPlainJsonObject`, `assertJsonObjectText`.
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

// One assignment per export (not an object literal of member expressions), so
// Node's CommonJS export detection (cjs-module-lexer) sees every name and
// `import { Instructions } from 'xeris-sdk'` works from ES modules.

// -- Classes ---------------------------------------------------------------
exports.XerisClient = client.XerisClient;
exports.XerisDApp = dapp.XerisDApp;
exports.XerisAgent = agent.XerisAgent;
exports.XerisKeypair = keypair.XerisKeypair;

// -- Instruction layer -----------------------------------------------------
exports.Instructions = instructions.Instructions;
exports.Variant = instructions.Variant;
exports.VARIANT_NAMES = instructions.VARIANT_NAMES;
exports.BUILDER_NAMES = instructions.BUILDER_NAMES;
exports.fromPlan = instructions.fromPlan;
exports.isDisabledVariant = instructions.isDisabledVariant;
exports.encodeSwapCall = instructions.encodeSwapCall;
exports.dealTermsHash = instructions.dealTermsHash;
exports.buildPqRotationMessage = instructions.buildPqRotationMessage;
exports.channelStateMessage = instructions.channelStateMessage;
exports.channelCloseMessage = instructions.channelCloseMessage;
exports.hardwareAttestChallenge = instructions.hardwareAttestChallenge;

// -- Encoding primitives and unit conversion -------------------------------
exports.encodeU8 = encoding.encodeU8;
exports.encodeU32 = encoding.encodeU32;
exports.encodeU64 = encoding.encodeU64;
exports.encodeBool = encoding.encodeBool;
exports.encodeString = encoding.encodeString;
exports.encodeBytes = encoding.encodeBytes;
exports.encodeFixedBytes = encoding.encodeFixedBytes;
exports.encodeStringVec = encoding.encodeStringVec;
exports.encodeOption = encoding.encodeOption;
exports.encodeVariant = encoding.encodeVariant;
exports.readVariant = encoding.readVariant;
exports.normalizeU64 = encoding.normalizeU64;
exports.normalizeU32 = encoding.normalizeU32;
exports.normalizeU8 = encoding.normalizeU8;
exports.xrsToLamports = encoding.xrsToLamports;
exports.lamportsToXrs = encoding.lamportsToXrs;
exports.toBaseUnits = encoding.toBaseUnits;
exports.fromBaseUnits = encoding.fromBaseUnits;
exports.stringifyJson = encoding.stringifyJson;
exports.parseJson = encoding.parseJson;
// 4.x names, same function objects as encodeString / encodeBytes / encodeStringVec
exports.encodeBincodeString = encoding.encodeBincodeString;
exports.encodeBincodeVec = encoding.encodeBincodeVec;
exports.encodeBincodeStringVec = encoding.encodeBincodeStringVec;

// -- Transaction assembly --------------------------------------------------
exports.blockhashFromHex = transaction.blockhashFromHex;
exports.buildTransaction = transaction.buildTransaction;
exports.signTransaction = transaction.signTransaction;
exports.serializeTransaction = transaction.serializeTransaction;
exports.assembleSignedTransaction = transaction.assembleSignedTransaction;
exports.assertInstructionSubmittable = transaction.assertInstructionSubmittable;
exports.parseSubmitResponse = transaction.parseSubmitResponse;
exports.signatureOf = transaction.signatureOf;
exports.isCanonicalPubkey = keypair.isCanonicalPubkey;
exports.pubkeyBytes = keypair.pubkeyBytes;

// -- Errors ----------------------------------------------------------------
exports.XerisError = errors.XerisError;
exports.EncodingError = errors.EncodingError;
exports.FeatureDisabledError = errors.FeatureDisabledError;
exports.RpcError = errors.RpcError;
exports.DISABLED_FEATURES = errors.DISABLED_FEATURES;

// -- Node business rules (pure functions used by the three classes) --------
exports.checks = client.checks;

// -- Reference vectors -----------------------------------------------------
exports.TestVectors = vectors.TestVectors;

// -- Constants (src/constants.js, blueprint §5) ----------------------------
exports.VERSION = constants.VERSION;
exports.XRS_DECIMALS = constants.XRS_DECIMALS;
exports.LAMPORTS_PER_XRS = constants.LAMPORTS_PER_XRS;
exports.BASE_TX_FEE = constants.BASE_TX_FEE;
exports.BASE_TX_FEE_XRS = constants.BASE_TX_FEE_XRS;
exports.DEFAULT_RPC_PORT = constants.DEFAULT_RPC_PORT;
exports.DEFAULT_EXPLORER_PORT = constants.DEFAULT_EXPLORER_PORT;
exports.DEFAULT_P2P_PORT = constants.DEFAULT_P2P_PORT;
exports.TESTNET_SEED = constants.TESTNET_SEED;
exports.MAINNET_HOST_ENV = constants.MAINNET_HOST_ENV;
exports.CHAIN_ID_TESTNET = constants.CHAIN_ID_TESTNET;
exports.CHAIN_ID_MAINNET = constants.CHAIN_ID_MAINNET;
exports.SLOT_MS = constants.SLOT_MS;
exports.BLOCKHASH_EXPIRY_WINDOW = constants.BLOCKHASH_EXPIRY_WINDOW;
exports.MAX_IX_DATA_SIZE = constants.MAX_IX_DATA_SIZE;
exports.MAX_SLASH_IX_DATA_SIZE = constants.MAX_SLASH_IX_DATA_SIZE;
exports.MAX_IX_PER_TX = constants.MAX_IX_PER_TX;
exports.MAX_ACCOUNTS_PER_TX = constants.MAX_ACCOUNTS_PER_TX;
exports.MAX_TX_BYTES = constants.MAX_TX_BYTES;
exports.WRITE_BODY_LIMIT_BYTES = constants.WRITE_BODY_LIMIT_BYTES;
exports.WRITE_RPC_LIMIT = constants.WRITE_RPC_LIMIT;
exports.MIN_STAKE_LAMPORTS = constants.MIN_STAKE_LAMPORTS;
exports.MIN_ATTESTOR_STAKE_LAMPORTS = constants.MIN_ATTESTOR_STAKE_LAMPORTS;
exports.MIN_UNSTAKE_LAMPORTS = constants.MIN_UNSTAKE_LAMPORTS;
exports.UNBONDING_PERIOD_SLOTS = constants.UNBONDING_PERIOD_SLOTS;
exports.ATTESTATION_REWARD_LAMPORTS = constants.ATTESTATION_REWARD_LAMPORTS;
exports.ATTESTATION_SLOT_WINDOW = constants.ATTESTATION_SLOT_WINDOW;
exports.STAKING_REWARD_INTERVAL_BLOCKS = constants.STAKING_REWARD_INTERVAL_BLOCKS;
exports.STAKING_APY_PCT = constants.STAKING_APY_PCT;
exports.BASE_BLOCK_REWARD_LAMPORTS = constants.BASE_BLOCK_REWARD_LAMPORTS;
exports.HALVING_INTERVAL_BLOCKS = constants.HALVING_INTERVAL_BLOCKS;
exports.MAX_EMISSION_SUPPLY_LAMPORTS = constants.MAX_EMISSION_SUPPLY_LAMPORTS;
exports.MAX_RECENT_BLOCKS = constants.MAX_RECENT_BLOCKS;
exports.INSTRUCTION_COUNT = constants.INSTRUCTION_COUNT;
exports.DISABLED_VARIANTS = constants.DISABLED_VARIANTS;
exports.SUPPORTED_PQ_ALGORITHM = constants.SUPPORTED_PQ_ALGORITHM;
exports.PQ_PUBLIC_KEY_LEN = constants.PQ_PUBLIC_KEY_LEN;
exports.PQ_SECRET_KEY_LEN = constants.PQ_SECRET_KEY_LEN;
exports.PQ_SIGNATURE_LEN = constants.PQ_SIGNATURE_LEN;
exports.PQ_SECURITY_LEVEL = constants.PQ_SECURITY_LEVEL;
exports.PQ_CLAIM_TOKENS = constants.PQ_CLAIM_TOKENS;
exports.PQ_ROTATE_TAG = constants.PQ_ROTATE_TAG;
exports.CHANNEL_STATE_TAG = constants.CHANNEL_STATE_TAG;
exports.CHANNEL_CLOSE_TAG = constants.CHANNEL_CLOSE_TAG;
exports.CHANNEL_CHALLENGE_PERIOD_SLOTS = constants.CHANNEL_CHALLENGE_PERIOD_SLOTS;
exports.MAX_GROTH16_PROOF_BYTES = constants.MAX_GROTH16_PROOF_BYTES;
exports.MAX_GROTH16_VK_BYTES = constants.MAX_GROTH16_VK_BYTES;
exports.MAX_GROTH16_PUBLIC_INPUTS = constants.MAX_GROTH16_PUBLIC_INPUTS;
exports.AGENT_OPERATIONS = constants.AGENT_OPERATIONS;
exports.AGENT_INNER_VARIANTS = constants.AGENT_INNER_VARIANTS;
exports.DELEGATED_CALL_METHODS = constants.DELEGATED_CALL_METHODS;
exports.AGENT_DAILY_WINDOW_SLOTS = constants.AGENT_DAILY_WINDOW_SLOTS;
exports.MAX_AGENTS_PER_REGISTRY = constants.MAX_AGENTS_PER_REGISTRY;
exports.IDENTITY_TYPES = constants.IDENTITY_TYPES;
exports.REPUTATION_CATEGORIES = constants.REPUTATION_CATEGORIES;
exports.MESSAGE_TYPES = constants.MESSAGE_TYPES;
exports.CONDITION_TYPES = constants.CONDITION_TYPES;
exports.FEED_TYPES = constants.FEED_TYPES;
exports.DEVICE_TYPES = constants.DEVICE_TYPES;
exports.TASK_VERIFICATION_MODES = constants.TASK_VERIFICATION_MODES;
exports.TASK_RESOLUTIONS = constants.TASK_RESOLUTIONS;
exports.DISPUTE_ACTIONS = constants.DISPUTE_ACTIONS;
exports.VOTES = constants.VOTES;
exports.RWA_ASSET_TYPES = constants.RWA_ASSET_TYPES;
exports.RWA_STATUSES = constants.RWA_STATUSES;
exports.CONTRACT_TYPE_ALIASES = constants.CONTRACT_TYPE_ALIASES;
exports.PROTOCOL_MANAGED_CONTRACT_TYPES = constants.PROTOCOL_MANAGED_CONTRACT_TYPES;
exports.RESERVED_CONTRACT_ID_PREFIXES = constants.RESERVED_CONTRACT_ID_PREFIXES;
exports.RESERVED_CONTRACT_ID_SUFFIXES = constants.RESERVED_CONTRACT_ID_SUFFIXES;
exports.CONTRACT_ID_PATTERN = constants.CONTRACT_ID_PATTERN;
exports.PROTOCOL_CONTRACT_IDS = constants.PROTOCOL_CONTRACT_IDS;
exports.MIN_DEAL_DISPUTE_BOND = constants.MIN_DEAL_DISPUTE_BOND;
exports.DEAL_TIMEOUT_SLOTS = constants.DEAL_TIMEOUT_SLOTS;
exports.DISPUTE_CHALLENGE_PERIOD_SLOTS = constants.DISPUTE_CHALLENGE_PERIOD_SLOTS;
exports.DISPUTE_MAX_LIFETIME_SLOTS = constants.DISPUTE_MAX_LIFETIME_SLOTS;
exports.MAX_TASK_LIFETIME_SLOTS = constants.MAX_TASK_LIFETIME_SLOTS;
exports.ORDER_STORAGE_BOND = constants.ORDER_STORAGE_BOND;
exports.MAX_ORDER_LIFETIME_SLOTS = constants.MAX_ORDER_LIFETIME_SLOTS;
exports.MAX_CONDITIONAL_INNER_BYTES = constants.MAX_CONDITIONAL_INNER_BYTES;
exports.MIN_ORACLE_STAKE_LAMPORTS = constants.MIN_ORACLE_STAKE_LAMPORTS;
exports.MIN_VOTING_PERIOD_SLOTS = constants.MIN_VOTING_PERIOD_SLOTS;
exports.MAX_VOTING_PERIOD_SLOTS = constants.MAX_VOTING_PERIOD_SLOTS;
exports.DEFAULT_PROPOSAL_QUORUM = constants.DEFAULT_PROPOSAL_QUORUM;
exports.MIN_PROPOSAL_STAKE_LAMPORTS = constants.MIN_PROPOSAL_STAKE_LAMPORTS;
exports.LAUNCHPAD_XERIS_FEE_BPS = constants.LAUNCHPAD_XERIS_FEE_BPS;
exports.REGISTRY_PAGE_ITEMS = constants.REGISTRY_PAGE_ITEMS;
exports.ACCOUNT_HISTORY_MAX_PAGE_SIZE = constants.ACCOUNT_HISTORY_MAX_PAGE_SIZE;
exports.ACCOUNT_HISTORY_MAX_PAGE = constants.ACCOUNT_HISTORY_MAX_PAGE;
exports.LIST_MAX_PAGE_SIZE = constants.LIST_MAX_PAGE_SIZE;
exports.SIGNATURES_MAX_LIMIT = constants.SIGNATURES_MAX_LIMIT;
exports.PRICE_HISTORY_MAX_LIMIT = constants.PRICE_HISTORY_MAX_LIMIT;
exports.TX_STATUSES = constants.TX_STATUSES;
exports.STRING_LIMITS = constants.STRING_LIMITS;

// A re-export that resolved to `undefined` means a `src/` module no longer
// exports the name under its contracted spelling. Fail at load time rather
// than let callers discover it as "x is not a function" or as a silently
// missing constant.
for (const name of Object.keys(exports)) {
  if (exports[name] === undefined) {
    throw new errors.XerisError(`xeris-sdk: export "${name}" resolved to undefined; a src/ module does not export it`);
  }
}
