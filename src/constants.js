'use strict';

/**
 * Node-derived constants for xeris-sdk.
 *
 * Every value below is copied from the XerisCoin node source
 * (`/home/user/xeriscointestnet/src/`, crate `xrs-node`); the citation in each
 * JSDoc block is `file:line` relative to that directory. Objects and arrays are
 * frozen. Nothing in this module reads the environment or performs I/O.
 *
 * @module xeris-sdk/constants
 */

/** SDK version string (package.json). */
const VERSION = '5.0.0';

// ---------------------------------------------------------------------------
// Units and fees
// ---------------------------------------------------------------------------

/**
 * Decimal places of the native token: `xrs_native` is registered with
 * `decimals: 9` (`token.rs:901`); the reference wallet multiplies XRS by
 * 1_000_000_000 (`bin/wallet.rs:113`).
 */
const XRS_DECIMALS = 9;

/** Base units (lamports) per 1 XRS. `token.rs:901`, `bin/wallet.rs:113`. */
const LAMPORTS_PER_XRS = 1_000_000_000;

/** Flat per-transaction fee in lamports. `ledger.rs:58` (`BASE_TX_FEE`). */
const BASE_TX_FEE = 1_000_000;

/** `BASE_TX_FEE` expressed in XRS (derived: 1_000_000 / 1_000_000_000). */
const BASE_TX_FEE_XRS = 0.001;

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/** Default HTTP RPC port. `main.rs:831` (clap default), `main.rs:839` (fallback). */
const DEFAULT_RPC_PORT = 56001;

/** Default explorer / JSON-RPC port. `main.rs:832`, `main.rs:840`. */
const DEFAULT_EXPLORER_PORT = 50008;

/** Default P2P listener port. `main.rs:830`, `main.rs:838`. */
const DEFAULT_P2P_PORT = 4000;

/**
 * Published testnet validator host. The node lists it in `FALLBACK_SEEDS` at
 * `network.rs:298`, currently commented out with the note "RESTORE BEFORE
 * DEPLOYMENT"; the SDK keeps it as the testnet default (`XerisClient.testnet()`).
 */
const TESTNET_SEED = '138.197.116.81';

/**
 * Environment variable consulted by `XerisClient.mainnet()` /
 * `XerisAgent.mainnet()` when no host argument is given. SDK convention: the
 * node source has no mainnet host (`network.rs:282-300`; `main.rs:821, 841`
 * only define the `--mainnet` flag).
 */
const MAINNET_HOST_ENV = 'XERIS_MAINNET_HOST';

/** Chain id bytes used in signing domains on testnet. `ledger.rs:287`. */
const CHAIN_ID_TESTNET = 'xeris-testnet-v1';

/** Chain id bytes used in signing domains on mainnet. `ledger.rs:286`. */
const CHAIN_ID_MAINNET = 'xeris-mainnet-v1';

/** Slot duration in milliseconds. `main.rs:33` (`SLOT_DURATION_MS`). */
const SLOT_MS = 4000;

/**
 * A `recent_blockhash` is accepted while it is among the last this many block
 * hashes. `ledger.rs:239` (`BLOCKHASH_EXPIRY_WINDOW`).
 */
const BLOCKHASH_EXPIRY_WINDOW = 150;

// ---------------------------------------------------------------------------
// Transaction structure limits
// ---------------------------------------------------------------------------

/** Maximum `instruction.data` length in bytes (8 KiB). `ledger.rs:93`. */
const MAX_IX_DATA_SIZE = 8192;

/**
 * Maximum `instruction.data` length for `SlashReport` (variant 38), the largest
 * short_vec-encodable instruction. `ledger.rs:119`.
 */
const MAX_SLASH_IX_DATA_SIZE = 65535;

/** Maximum instructions per transaction. `ledger.rs:94`. */
const MAX_IX_PER_TX = 16;

/** Maximum account keys per transaction. `ledger.rs:95`. */
const MAX_ACCOUNTS_PER_TX = 64;

/** Maximum serialized transaction size in bytes (128 KiB). `tx_pool.rs:183`. */
const MAX_TX_BYTES = 131072;

/**
 * HTTP body limit on the four write routes `/stake`, `/unstake`,
 * `/pq-register`, `/submit` (256 KiB). `network.rs:4336, 4440, 4571, 4664`.
 */
const WRITE_BODY_LIMIT_BYTES = 262144;

/**
 * Per-IP write rate limit shared by the write routes:
 * `PerIpRateLimiter::new(30, 60)`. `network.rs:4308`.
 * @type {Readonly<{max: number, windowSec: number}>}
 */
const WRITE_RPC_LIMIT = Object.freeze({ max: 30, windowSec: 60 });

// ---------------------------------------------------------------------------
// Staking and rewards
// ---------------------------------------------------------------------------

/** Minimum stake to validate (1,000 XRS). `ledger.rs:232` (`MIN_STAKE_TO_MINE`). */
const MIN_STAKE_LAMPORTS = 1_000_000_000_000;

/** Minimum stake to submit attestations (100 XRS). `ledger.rs:1285` (`MIN_ATTESTOR_STAKE`). */
const MIN_ATTESTOR_STAKE_LAMPORTS = 100_000_000_000;

/** Minimum unstake amount (1 XRS). `ledger.rs:210` (`MIN_UNSTAKE_AMOUNT`). */
const MIN_UNSTAKE_LAMPORTS = 1_000_000_000;

/** Unbonding period in slots. `ledger.rs:201` (`UNBONDING_PERIOD_SLOTS`). */
const UNBONDING_PERIOD_SLOTS = 151_200;

/** Reward per accepted attestation in lamports (0.01 XRS). `ledger.rs:214`. */
const ATTESTATION_REWARD_LAMPORTS = 10_000_000;

/** An attestation must name a block within this many slots. `ledger.rs:218`. */
const ATTESTATION_SLOT_WINDOW = 200;

/** Staking rewards are paid every this many blocks. `ledger.rs:5138` (`STAKING_REWARD_INTERVAL`). */
const STAKING_REWARD_INTERVAL_BLOCKS = 900;

/** Staking APY in percent: numerator 7 / denominator 100. `ledger.rs:5144-5145`. */
const STAKING_APY_PCT = 7;

/** Initial block reward in lamports (10 XRS). `ledger.rs:70` (`BASE_BLOCK_REWARD`). */
const BASE_BLOCK_REWARD_LAMPORTS = 10_000_000_000;

/** Blocks between reward halvings. `ledger.rs:75` (`HALVING_INTERVAL`). */
const HALVING_INTERVAL_BLOCKS = 25_000_000;

/**
 * Emission cap in lamports: `500_000_000 * 1_000_000_000` (`ledger.rs:65`,
 * `MAX_EMISSION_SUPPLY`). A BigInt because the value exceeds 2^53-1.
 * @type {bigint}
 */
const MAX_EMISSION_SUPPLY_LAMPORTS = 500_000_000_000_000_000n;

/** Blocks kept in memory; transaction lookups search only these. `ledger.rs:36`. */
const MAX_RECENT_BLOCKS = 1000;

// ---------------------------------------------------------------------------
// Instruction set
// ---------------------------------------------------------------------------

/** Number of `XerisInstruction` variants (indices 0..61). `token.rs:30-808`. */
const INSTRUCTION_COUNT = 62;

/**
 * Variant indices the node refuses or skips:
 * 22 SubDelegate (rejected at ingress, `ledger.rs:1445-1450`; skipped in blocks, `6911-6914`),
 * 48 ZkPrivateTransfer (`ledger.rs:8669-8685`),
 * 49 ZkIdentityProof (`ledger.rs:8687-8697`),
 * 52 PqSignedTransfer (`ledger.rs:8809-8828`).
 * The dispatcher `continue`s for 48/49/52 after the fee has been charged.
 * @type {ReadonlyArray<number>}
 */
const DISABLED_VARIANTS = Object.freeze([22, 48, 49, 52]);

// ---------------------------------------------------------------------------
// Post-quantum key registry
// ---------------------------------------------------------------------------

/** The only PQ algorithm string the node accepts (case-sensitive). `crypto.rs:924`. */
const SUPPORTED_PQ_ALGORITHM = 'dilithium3';

/** ML-DSA-65 (Dilithium3) public key length in bytes. `crypto.rs:1162-1186`, `crypto.rs:948`. */
const PQ_PUBLIC_KEY_LEN = 1952;

/** ML-DSA-65 secret key length in bytes (FIPS 204 final). `crypto.rs:1164, 1190, 1200`. */
const PQ_SECRET_KEY_LEN = 4032;

/**
 * ML-DSA-65 detached signature length in bytes. `crypto.rs:1162-1186`
 * (`dilithium3_signature_len`, "Currently 3309"); the node builds against
 * `pqcrypto-mldsa 0.1.2` (FIPS 204 final), not the round-3 draft's 3293.
 */
const PQ_SIGNATURE_LEN = 3309;

/** Security level the PQ registry requires for `dilithium3`. `contracts.rs:6168-6215` (line 6205). */
const PQ_SECURITY_LEVEL = 3;

/**
 * Lower-cased substrings that mark a string as a post-quantum claim; the node
 * rejects ZK verification keys / proofs whose descriptive fields contain any
 * of them. `ledger.rs:5362-5374` (`asserts_pq_claim`).
 * @type {ReadonlyArray<string>}
 */
const PQ_CLAIM_TOKENS = Object.freeze([
  'pq',
  'post-quantum', 'post_quantum', 'postquantum', 'post quantum',
  'dilithium',
  'mldsa', 'ml-dsa', 'ml_dsa',
]);

/** Domain tag prefixed to the PQ key-rotation message. `crypto.rs:864`. */
const PQ_ROTATE_TAG = 'xrs_pq_rotate_v5';

// ---------------------------------------------------------------------------
// State channels
// ---------------------------------------------------------------------------

/** Domain tag of the channel state message. `contracts.rs:69`. */
const CHANNEL_STATE_TAG = 'XRS_CH_STATE_V3';

/** Domain tag of the channel close message. `contracts.rs:98`. */
const CHANNEL_CLOSE_TAG = 'XRS_CLOSE_CH_V4';

/**
 * Challenge period of the protocol channel registry, fixed when the ledger
 * creates `xeris_channels`. `ledger.rs:8308` (`challenge_period_slots: 1000`).
 */
const CHANNEL_CHALLENGE_PERIOD_SLOTS = 1000;

// ---------------------------------------------------------------------------
// ZK verifier
// ---------------------------------------------------------------------------

/** Maximum Groth16 proof size in bytes. `crypto.rs:1041`. */
const MAX_GROTH16_PROOF_BYTES = 512;

/** Maximum Groth16 verification key size in bytes (16 KiB). `crypto.rs:1042`. */
const MAX_GROTH16_VK_BYTES = 16384;

/** Maximum Groth16 public inputs (field elements of 32 bytes each). `crypto.rs:1043`. */
const MAX_GROTH16_PUBLIC_INPUTS = 64;

// ---------------------------------------------------------------------------
// Agent delegation
// ---------------------------------------------------------------------------

/**
 * `operation_type` strings the ledger derives from an `AgentExecute` inner
 * instruction; `RegisterAgent.allowed_operations` is matched against these by
 * exact string equality. `ledger.rs:6425-6477`; matcher `contracts.rs:3471-3477`.
 * @type {ReadonlyArray<string>}
 */
const AGENT_OPERATIONS = Object.freeze([
  'NativeTransfer', 'TokenTransfer', 'ContractCall', 'WrapXrs', 'UnwrapXrs',
  'Stake', 'Unstake', 'TokenMint', 'TokenBurn',
]);

/**
 * Variant indices accepted as an `AgentExecute` inner instruction, in the same
 * order as `AGENT_OPERATIONS`. `ledger.rs:6425-6477`. Note that inner Stake (9)
 * and Unstake (10) reach `token::process_token_instruction`, which returns
 * `Ok(())` without touching stakes (`token.rs:1183-1200`), so they execute as
 * budget-consuming no-ops.
 * @type {ReadonlyArray<number>}
 */
const AGENT_INNER_VARIANTS = Object.freeze([11, 1, 4, 13, 14, 9, 10, 0, 2]);

/**
 * `ContractCall` methods whose spend the ledger can bound for a delegated call
 * (`delegated_call_spend` returns `Some`). Any other method, including
 * `confirm` and `verify`, fails closed. `ledger.rs:2138-2175`.
 * @type {ReadonlyArray<string>}
 */
const DELEGATED_CALL_METHODS = Object.freeze([
  'buy_tokens', 'sell_tokens', 'swap', 'add_liquidity', 'remove_liquidity',
  'create_dca_order', 'distribute', 'post', 'open', 'create', 'place_order',
  'cancel', 'reclaim', 'claim_rewards', 'redeem', 'amend',
  'list', 'status', 'get_stats', 'get_key',
]);

/** Agent daily-spend window in slots. `contracts.rs:3439` (`DAILY_SLOTS`). */
const AGENT_DAILY_WINDOW_SLOTS = 21_600;

/** Maximum agents per owner registry. `contracts.rs:3334`. */
const MAX_AGENTS_PER_REGISTRY = 50;

// ---------------------------------------------------------------------------
// Enumerated string fields validated by the node
// ---------------------------------------------------------------------------

/** `CreateIdentity.identity_type` values. `ledger.rs:6696`. @type {ReadonlyArray<string>} */
const IDENTITY_TYPES = Object.freeze(['agent', 'device', 'service', 'human']);

/** `AttestReputation.category` values. `ledger.rs:6820`. @type {ReadonlyArray<string>} */
const REPUTATION_CATEGORIES = Object.freeze(['reliability', 'accuracy', 'speed', 'honesty', 'safety', 'general']);

/** `AgentMessage.message_type` values. `ledger.rs:6846`. @type {ReadonlyArray<string>} */
const MESSAGE_TYPES = Object.freeze(['proposal', 'counteroffer', 'accept', 'reject', 'info', 'request']);

/** `ConditionalOrder.condition_type` values. `ledger.rs:6918`. @type {ReadonlyArray<string>} */
const CONDITION_TYPES = Object.freeze(['price_above', 'price_below', 'balance_above', 'balance_below', 'slot_reached', 'oracle_value']);

/** `RegisterOracle.feed_type` values. `ledger.rs:7164`. @type {ReadonlyArray<string>} */
const FEED_TYPES = Object.freeze(['price', 'event', 'sensor', 'weather', 'custom']);

/** `HardwareAttest.device_type` values. `ledger.rs:7232`. @type {ReadonlyArray<string>} */
const DEVICE_TYPES = Object.freeze(['humanoid', 'terminal', 'iot', 'mobile', 'secure_element']);

/**
 * `PostTask.verification` values. `contracts.rs:4751-4786`; `automatic` is
 * rejected (XWC-74) and `oracle` requires a non-empty `verification_oracle`.
 * @type {ReadonlyArray<string>}
 */
const TASK_VERIFICATION_MODES = Object.freeze(['poster_confirm', 'oracle']);

/** `ResolveTask.resolution` values. `ledger.rs:7603-7612`. @type {ReadonlyArray<string>} */
const TASK_RESOLUTIONS = Object.freeze(['complete', 'verify', 'reject', 'cancel']);

/** `ResolveDispute.action` values. `ledger.rs:7739-7756`. @type {ReadonlyArray<string>} */
const DISPUTE_ACTIONS = Object.freeze(['evidence', 'defendant_evidence', 'vote_disputer', 'vote_defendant', 'vote_dismiss', 'expire']);

/** `CastVote.vote` values. `contracts.rs:5584-5588`. @type {ReadonlyArray<string>} */
const VOTES = Object.freeze(['yes', 'no', 'abstain']);

/** `TokenCreateRWA.asset_type` values. `token.rs:1217`. @type {ReadonlyArray<string>} */
const RWA_ASSET_TYPES = Object.freeze(['real_estate', 'equity', 'debt', 'commodity', 'ip', 'collectible', 'fund', 'bond']);

/** `RWAUpdateStatus.new_status` values. `token.rs:1272`. @type {ReadonlyArray<string>} */
const RWA_STATUSES = Object.freeze(['active', 'frozen', 'redeemed', 'disputed', 'revoked']);

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/**
 * Lower-case `ContractDeploy.contract_type_str` aliases mapped to the
 * `ContractType` enum name, copied from `ContractType::from_str`
 * (`contracts.rs:385-411`; the node lower-cases the input before matching).
 * 61 aliases over 23 enum names (blueprint §5 said 24; `contracts.rs:335-381`
 * declares 23).
 * @type {Readonly<Record<string, string>>}
 */
const CONTRACT_TYPE_ALIASES = Object.freeze({
  timelock: 'TimeLock', time_lock: 'TimeLock',
  escrow: 'Escrow',
  swap: 'Swap',
  vesting: 'Vesting',
  multisig: 'MultiSig', multi_sig: 'MultiSig',
  rwa: 'RealWorldAsset', real_world_asset: 'RealWorldAsset', realworldasset: 'RealWorldAsset',
  launchpad: 'Launchpad', launch_pad: 'Launchpad',
  agent_registry: 'AgentRegistry', agent: 'AgentRegistry', agents: 'AgentRegistry',
  identity: 'IdentityRegistry', identity_registry: 'IdentityRegistry',
  conditional: 'ConditionalOrderBook', conditional_orders: 'ConditionalOrderBook', orders: 'ConditionalOrderBook',
  limit: 'LimitOrder', limit_order: 'LimitOrder', limit_orders: 'LimitOrder',
  dca: 'DcaOrder', dca_order: 'DcaOrder', dollar_cost_averaging: 'DcaOrder',
  oracle: 'OracleRegistry', oracle_registry: 'OracleRegistry', oracles: 'OracleRegistry',
  device: 'DeviceRegistry', device_registry: 'DeviceRegistry', hardware: 'DeviceRegistry',
  capability: 'CapabilityRegistry', capabilities: 'CapabilityRegistry', cap_registry: 'CapabilityRegistry',
  task: 'TaskBoard', tasks: 'TaskBoard', task_board: 'TaskBoard', bounty: 'TaskBoard',
  model: 'ModelRegistry', model_registry: 'ModelRegistry', models: 'ModelRegistry',
  dispute: 'DisputeRegistry', disputes: 'DisputeRegistry', arbitration: 'DisputeRegistry',
  governance: 'Governance', gov: 'Governance', dao: 'Governance',
  channel: 'StateChannelRegistry', channels: 'StateChannelRegistry', state_channel: 'StateChannelRegistry',
  zk: 'ZkVerifierRegistry', zk_verifier: 'ZkVerifierRegistry', zero_knowledge: 'ZkVerifierRegistry',
  pq: 'PqKeyRegistry', pq_keys: 'PqKeyRegistry', post_quantum: 'PqKeyRegistry', quantum: 'PqKeyRegistry',
  deal: 'DealRegistry', deals: 'DealRegistry', escrow_deal: 'DealRegistry',
});

/**
 * `ContractType` enum names a user `ContractDeploy` is refused for; the ledger
 * creates these registries itself. `ledger.rs:2344-2349`
 * (`is_protocol_managed_registry_type`).
 * @type {ReadonlyArray<string>}
 */
const PROTOCOL_MANAGED_CONTRACT_TYPES = Object.freeze([
  'DeviceRegistry', 'ZkVerifierRegistry', 'PqKeyRegistry', 'ConditionalOrderBook',
  'DisputeRegistry', 'DealRegistry', 'TaskBoard', 'StateChannelRegistry',
]);

/**
 * Contract id prefixes reserved by the node; `ContractDeploy` with such an id
 * is rejected. `ledger.rs:1524-1530` (`is_reserved_contract_id`), applied at `ledger.rs:6171`.
 * @type {ReadonlyArray<string>}
 */
const RESERVED_CONTRACT_ID_PREFIXES = Object.freeze(['xeris_', 'identity_', 'agent_registry_', '__']);

/** Contract id suffixes reserved by the node. `ledger.rs:1529`. @type {ReadonlyArray<string>} */
const RESERVED_CONTRACT_ID_SUFFIXES = Object.freeze(['_xrs_pool']);

/**
 * Contract id shape accepted by the SDK: 1..128 ASCII letters, digits, `_` or
 * `-`. The node check at `contracts.rs:1316-1320` uses `char::is_alphanumeric`
 * (which also admits non-ASCII letters and digits) and a byte-length limit of
 * 128; this pattern is a strict subset of what the node accepts, so an id that
 * matches it is always accepted by the node.
 * @type {RegExp}
 */
const CONTRACT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Fixed ids of the protocol-created registries. `ledger.rs:2184-2320`
 * (`is_protected_contract_call` deny table) and the ledger's registry creation
 * sites (`xeris_oracles` at `ledger.rs:13762`, `xeris_tasks` at `13832`).
 * @type {Readonly<Record<string, string>>}
 */
const PROTOCOL_CONTRACT_IDS = Object.freeze({
  oracles: 'xeris_oracles',
  devices: 'xeris_devices',
  capabilities: 'xeris_capabilities',
  tasks: 'xeris_tasks',
  models: 'xeris_models',
  disputes: 'xeris_disputes',
  deals: 'xeris_deals',
  governance: 'xeris_governance',
  channels: 'xeris_channels',
  zkVerifier: 'xeris_zk_verifier',
  pqKeys: 'xeris_pq_keys',
  heartbeats: 'xeris_heartbeats',
});

// ---------------------------------------------------------------------------
// Deals, disputes, tasks, orders, oracles, governance, launchpad
// ---------------------------------------------------------------------------

/** Minimum `DisputeDeal.bond` in lamports (1 XRS). `contracts.rs:1008` (`MIN_DEAL_DISPUTE_BOND`). */
const MIN_DEAL_DISPUTE_BOND = 1_000_000_000;

/** Slots after which an unaccepted/unsettled deal can be reclaimed. `contracts.rs:1079`. */
const DEAL_TIMEOUT_SLOTS = 648_000;

/** Dispute challenge period in slots. `contracts.rs:995`. */
const DISPUTE_CHALLENGE_PERIOD_SLOTS = 21_600;

/** Maximum dispute lifetime in slots. `contracts.rs:1000`. */
const DISPUTE_MAX_LIFETIME_SLOTS = 648_000;

/** Maximum task lifetime in slots. `contracts.rs:916`. */
const MAX_TASK_LIFETIME_SLOTS = 648_000;

/** Storage bond locked per conditional order in lamports. `ledger.rs:1290` (`ORDER_STORAGE_BOND`). */
const ORDER_STORAGE_BOND = 10_000_000;

/** Maximum conditional order lifetime in slots. `ledger.rs:1295`. */
const MAX_ORDER_LIFETIME_SLOTS = 650_000;

/** Maximum `ConditionalOrder.inner_instruction` length in bytes. `ledger.rs:6942`. */
const MAX_CONDITIONAL_INNER_BYTES = 2048;

/** Minimum `RegisterOracle.stake_amount` in lamports (1 XRS). `ledger.rs:7170`; `contracts.rs:4307`. */
const MIN_ORACLE_STAKE_LAMPORTS = 1_000_000_000;

/** Minimum `CreateProposal.voting_period_slots`. `ledger.rs:8267-8272`; `contracts.rs:5527`. */
const MIN_VOTING_PERIOD_SLOTS = 21_600;

/** Maximum `CreateProposal.voting_period_slots`. `contracts.rs:5527-5530`. */
const MAX_VOTING_PERIOD_SLOTS = 1_296_000;

/** Quorum used when `CreateProposal.quorum == 0` (5,000 XRS). `contracts.rs:163`. */
const DEFAULT_PROPOSAL_QUORUM = 5_000_000_000_000;

/** Default minimum staked balance to propose (100 XRS). `contracts.rs:1826-1827`. */
const MIN_PROPOSAL_STAKE_LAMPORTS = 100_000_000_000;

/** Protocol fee on launchpad trades in basis points. `contracts.rs:308` (`XERIS_FEE_BPS`). */
const LAUNCHPAD_XERIS_FEE_BPS = 77;

// ---------------------------------------------------------------------------
// Explorer paging
// ---------------------------------------------------------------------------

/** Items per page on cursor-paged registry routes (`limit` clamped to 1..32). `explorer.rs:126`. */
const REGISTRY_PAGE_ITEMS = 32;

/** Maximum `page_size` on `/v2/account/{addr}/transactions`. `tx_store.rs:57` (`MAX_PAGE`). */
const ACCOUNT_HISTORY_MAX_PAGE_SIZE = 200;

/** Maximum numbered `page` on `/v2/account/{addr}/transactions`. `explorer.rs:1305-1306`. */
const ACCOUNT_HISTORY_MAX_PAGE = 50;

/** Maximum `page_size` on numbered list routes (`paginate` clamps to 1..100). `explorer.rs:276-299`. */
const LIST_MAX_PAGE_SIZE = 100;

/**
 * `status` values the explorer reports for a transaction: `confirmed`,
 * `failed`, `partial` from the receipt store (`tx_store.rs:116-120`) and
 * `included` when no store is available (`explorer.rs:680-690`).
 * @type {ReadonlyArray<string>}
 */
const TX_STATUSES = Object.freeze(['confirmed', 'failed', 'partial', 'included']);

// ---------------------------------------------------------------------------
// String byte limits enforced by the node (Rust `str::len`, i.e. UTF-8 bytes)
// ---------------------------------------------------------------------------

/**
 * Maximum UTF-8 byte lengths of string fields:
 * `identityDisplayName` `ledger.rs:6706`, `identityMetadata` `ledger.rs:6702`,
 * `reputationEvidence` `ledger.rs:6826`, `messagePayload` `ledger.rs:6852`,
 * `oracleDescription` `ledger.rs:7175`, `oracleMetadata` `ledger.rs:7211`,
 * `taskTitle` `contracts.rs:4723`, `taskDescription` `contracts.rs:4726`,
 * `taskRejectReason` `contracts.rs:4975-4979`, `channelId` `contracts.rs:5637`,
 * `channelType` `contracts.rs:5652`.
 * @type {Readonly<Record<string, number>>}
 */
const STRING_LIMITS = Object.freeze({
  identityDisplayName: 128,
  identityMetadata: 4096,
  reputationEvidence: 512,
  messagePayload: 8192,
  oracleDescription: 512,
  oracleMetadata: 1024,
  taskTitle: 256,
  taskDescription: 4096,
  taskRejectReason: 512,
  channelId: 128,
  channelType: 64,
});

module.exports = {
  VERSION,
  XRS_DECIMALS,
  LAMPORTS_PER_XRS,
  BASE_TX_FEE,
  BASE_TX_FEE_XRS,
  DEFAULT_RPC_PORT,
  DEFAULT_EXPLORER_PORT,
  DEFAULT_P2P_PORT,
  TESTNET_SEED,
  MAINNET_HOST_ENV,
  CHAIN_ID_TESTNET,
  CHAIN_ID_MAINNET,
  SLOT_MS,
  BLOCKHASH_EXPIRY_WINDOW,
  MAX_IX_DATA_SIZE,
  MAX_SLASH_IX_DATA_SIZE,
  MAX_IX_PER_TX,
  MAX_ACCOUNTS_PER_TX,
  MAX_TX_BYTES,
  WRITE_BODY_LIMIT_BYTES,
  WRITE_RPC_LIMIT,
  MIN_STAKE_LAMPORTS,
  MIN_ATTESTOR_STAKE_LAMPORTS,
  MIN_UNSTAKE_LAMPORTS,
  UNBONDING_PERIOD_SLOTS,
  ATTESTATION_REWARD_LAMPORTS,
  ATTESTATION_SLOT_WINDOW,
  STAKING_REWARD_INTERVAL_BLOCKS,
  STAKING_APY_PCT,
  BASE_BLOCK_REWARD_LAMPORTS,
  HALVING_INTERVAL_BLOCKS,
  MAX_EMISSION_SUPPLY_LAMPORTS,
  MAX_RECENT_BLOCKS,
  INSTRUCTION_COUNT,
  DISABLED_VARIANTS,
  SUPPORTED_PQ_ALGORITHM,
  PQ_PUBLIC_KEY_LEN,
  PQ_SECRET_KEY_LEN,
  PQ_SIGNATURE_LEN,
  PQ_SECURITY_LEVEL,
  PQ_CLAIM_TOKENS,
  PQ_ROTATE_TAG,
  CHANNEL_STATE_TAG,
  CHANNEL_CLOSE_TAG,
  CHANNEL_CHALLENGE_PERIOD_SLOTS,
  MAX_GROTH16_PROOF_BYTES,
  MAX_GROTH16_VK_BYTES,
  MAX_GROTH16_PUBLIC_INPUTS,
  AGENT_OPERATIONS,
  AGENT_INNER_VARIANTS,
  DELEGATED_CALL_METHODS,
  AGENT_DAILY_WINDOW_SLOTS,
  MAX_AGENTS_PER_REGISTRY,
  IDENTITY_TYPES,
  REPUTATION_CATEGORIES,
  MESSAGE_TYPES,
  CONDITION_TYPES,
  FEED_TYPES,
  DEVICE_TYPES,
  TASK_VERIFICATION_MODES,
  TASK_RESOLUTIONS,
  DISPUTE_ACTIONS,
  VOTES,
  RWA_ASSET_TYPES,
  RWA_STATUSES,
  CONTRACT_TYPE_ALIASES,
  PROTOCOL_MANAGED_CONTRACT_TYPES,
  RESERVED_CONTRACT_ID_PREFIXES,
  RESERVED_CONTRACT_ID_SUFFIXES,
  CONTRACT_ID_PATTERN,
  PROTOCOL_CONTRACT_IDS,
  MIN_DEAL_DISPUTE_BOND,
  DEAL_TIMEOUT_SLOTS,
  DISPUTE_CHALLENGE_PERIOD_SLOTS,
  DISPUTE_MAX_LIFETIME_SLOTS,
  MAX_TASK_LIFETIME_SLOTS,
  ORDER_STORAGE_BOND,
  MAX_ORDER_LIFETIME_SLOTS,
  MAX_CONDITIONAL_INNER_BYTES,
  MIN_ORACLE_STAKE_LAMPORTS,
  MIN_VOTING_PERIOD_SLOTS,
  MAX_VOTING_PERIOD_SLOTS,
  DEFAULT_PROPOSAL_QUORUM,
  MIN_PROPOSAL_STAKE_LAMPORTS,
  LAUNCHPAD_XERIS_FEE_BPS,
  REGISTRY_PAGE_ITEMS,
  ACCOUNT_HISTORY_MAX_PAGE_SIZE,
  ACCOUNT_HISTORY_MAX_PAGE,
  LIST_MAX_PAGE_SIZE,
  TX_STATUSES,
  STRING_LIMITS,
};
