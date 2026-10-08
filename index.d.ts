/// <reference types="node" />

/**
 * Type declarations for xeris-sdk 5.0.0.
 *
 * Every declaration mirrors `index.js` and the blueprint
 * (`scratchpad/specs/sdk-blueprint.md`). Node citations are `file:line`
 * relative to `/home/user/xeriscointestnet/src/`. Where a runtime module and
 * this file disagree the runtime module wins; report the difference.
 *
 * Numeric conventions:
 *  - `U64Input` (`number | bigint`): a `number` must be a safe integer; values
 *    above `2^53-1` must be passed as `bigint`. Negative, non-integer and
 *    out-of-range values throw `RangeError`; wrong types throw `TypeError`.
 *  - Node JSON responses carry `u64` fields as JSON numbers; they are typed
 *    `number` here because `JSON.parse` yields numbers (values above `2^53-1`
 *    lose precision in transit regardless of this file).
 *  - `XrsInput` (`number | string`): an XRS amount with at most 9 fractional
 *    digits, converted exactly by `xrsToLamports`; pass a decimal string for
 *    amounts a `number` cannot represent exactly.
 */

import type { Keypair, PublicKey, Transaction } from '@solana/web3.js';

// ---------------------------------------------------------------------------
// Scalar and enumeration types
// ---------------------------------------------------------------------------

/** Unsigned 64-bit field input: a safe-integer `number` or a `bigint` in `0..=2^64-1`. */
export type U64Input = number | bigint;

/** Byte field input. `number[]` and strings are rejected by the runtime (`TypeError`). */
export type BytesInput = Buffer | Uint8Array;

/** XRS amount input: non-negative finite `number` or decimal string with at most 9 fractional digits. */
export type XrsInput = number | string;

/** The four live write routes of the RPC port (`network.rs:4336, 4440, 4571, 4664`). */
export type WriteRoute = '/submit' | '/stake' | '/unstake' | '/pq-register';

/**
 * Transaction status reported by the explorer: `confirmed` / `failed` /
 * `partial` from the receipt store (`tx_store.rs:116-120`), `included` when
 * the node has no receipt store (`explorer.rs:680-690`).
 */
export type TxStatus = 'confirmed' | 'failed' | 'partial' | 'included';

/** `CastVote.vote` values (`contracts.rs:5584-5588`). */
export type Vote = 'yes' | 'no' | 'abstain';

/** `ResolveTask.resolution` values (`ledger.rs:7603-7612`). */
export type TaskResolution = 'complete' | 'verify' | 'reject' | 'cancel';

/**
 * `operation_type` strings the ledger derives from an `AgentExecute` inner
 * instruction; `RegisterAgent.allowed_operations` entries are compared to
 * these by exact equality (`ledger.rs:6425-6477`; `contracts.rs:3471-3477`).
 */
export type AgentOperation =
  | 'NativeTransfer' | 'TokenTransfer' | 'ContractCall' | 'WrapXrs' | 'UnwrapXrs'
  | 'Stake' | 'Unstake' | 'TokenMint' | 'TokenBurn';

/** `CreateIdentity.identity_type` values (`ledger.rs:6696`). */
export type IdentityType = 'agent' | 'device' | 'service' | 'human';

/** `AttestReputation.category` values (`ledger.rs:6820`). */
export type ReputationCategory = 'reliability' | 'accuracy' | 'speed' | 'honesty' | 'safety' | 'general';

/** `AgentMessage.message_type` values (`ledger.rs:6846`). */
export type MessageType = 'proposal' | 'counteroffer' | 'accept' | 'reject' | 'info' | 'request';

/** `ConditionalOrder.condition_type` values (`ledger.rs:6918`). */
export type ConditionType = 'price_above' | 'price_below' | 'balance_above' | 'balance_below' | 'slot_reached' | 'oracle_value';

/** `RegisterOracle.feed_type` values (`ledger.rs:7164`). */
export type FeedType = 'price' | 'event' | 'sensor' | 'weather' | 'custom';

/** `HardwareAttest.device_type` values (`ledger.rs:7232`). */
export type DeviceType = 'humanoid' | 'terminal' | 'iot' | 'mobile' | 'secure_element';

/** `PostTask.verification` values; `automatic` is rejected (`contracts.rs:4751-4786`). */
export type TaskVerificationMode = 'poster_confirm' | 'oracle';

/** `ResolveDispute.action` values (`ledger.rs:7739-7756`). */
export type DisputeAction = 'evidence' | 'defendant_evidence' | 'vote_disputer' | 'vote_defendant' | 'vote_dismiss' | 'expire';

/** `TokenCreateRWA.asset_type` values (`token.rs:1217`). */
export type RwaAssetType = 'real_estate' | 'equity' | 'debt' | 'commodity' | 'ip' | 'collectible' | 'fund' | 'bond';

/** `RWAUpdateStatus.new_status` values (`token.rs:1272`). */
export type RwaStatus = 'active' | 'frozen' | 'redeemed' | 'disputed' | 'revoked';

/** The two binary-args AMM methods (`contracts.rs:2419-2441`). */
export type SwapMethod = 'swap_a_to_b' | 'swap_b_to_a';

/** `ContractType` enum names as serialized by the node (`contracts.rs:335-381`). */
export type ContractTypeName =
  | 'TimeLock' | 'Escrow' | 'Swap' | 'Vesting' | 'MultiSig' | 'RealWorldAsset' | 'Launchpad'
  | 'AgentRegistry' | 'IdentityRegistry' | 'ConditionalOrderBook' | 'LimitOrder' | 'DcaOrder'
  | 'OracleRegistry' | 'DeviceRegistry' | 'CapabilityRegistry' | 'TaskBoard' | 'ModelRegistry'
  | 'DisputeRegistry' | 'Governance' | 'StateChannelRegistry' | 'ZkVerifierRegistry'
  | 'PqKeyRegistry' | 'DealRegistry';

/** Lower-case `ContractDeploy.contract_type_str` aliases accepted by `ContractType::from_str` (`contracts.rs:385-411`). */
export type ContractTypeAlias =
  | 'timelock' | 'time_lock' | 'escrow' | 'swap' | 'vesting' | 'multisig' | 'multi_sig'
  | 'rwa' | 'real_world_asset' | 'realworldasset' | 'launchpad' | 'launch_pad'
  | 'agent_registry' | 'agent' | 'agents' | 'identity' | 'identity_registry'
  | 'conditional' | 'conditional_orders' | 'orders' | 'limit' | 'limit_order' | 'limit_orders'
  | 'dca' | 'dca_order' | 'dollar_cost_averaging' | 'oracle' | 'oracle_registry' | 'oracles'
  | 'device' | 'device_registry' | 'hardware' | 'capability' | 'capabilities' | 'cap_registry'
  | 'task' | 'tasks' | 'task_board' | 'bounty' | 'model' | 'model_registry' | 'models'
  | 'dispute' | 'disputes' | 'arbitration' | 'governance' | 'gov' | 'dao'
  | 'channel' | 'channels' | 'state_channel' | 'zk' | 'zk_verifier' | 'zero_knowledge'
  | 'pq' | 'pq_keys' | 'post_quantum' | 'quantum' | 'deal' | 'deals' | 'escrow_deal';

/** `POST /agent/plan` action names the node answers (`network.rs:5395-5567`). */
export type PlanAction = 'transfer' | 'swap' | 'buy_launchpad' | 'stake' | 'wrap' | 'unwrap';

/** PascalCase `XerisInstruction` variant names in declaration order (`token.rs:30-808`). */
export type VariantName =
  | 'TokenMint' | 'TokenTransfer' | 'TokenBurn' | 'TokenCreate' | 'ContractCall' | 'ContractDeploy'
  | 'TokenCreateRWA' | 'RWAUpdateStatus' | 'RWATransfer' | 'Stake' | 'Unstake' | 'NativeTransfer'
  | 'ValidatorAttestation' | 'WrapXrs' | 'UnwrapXrs' | 'RegisterAgent' | 'UpdateAgent' | 'AgentExecute'
  | 'CreateIdentity' | 'UpdateIdentity' | 'AttestReputation' | 'AgentMessage' | 'SubDelegate'
  | 'ConditionalOrder' | 'CancelConditionalOrder' | 'RegisterOracle' | 'OracleSubmit' | 'HardwareAttest'
  | 'RegisterCapability' | 'UpdateCapability' | 'QueryCapabilities' | 'PostTask' | 'ClaimTask'
  | 'ResolveTask' | 'RegisterModel' | 'UpdateModel' | 'OpenDispute' | 'ResolveDispute' | 'SlashReport'
  | 'CreateProposal' | 'CastVote' | 'ExecuteProposal' | 'OpenChannel' | 'CloseChannel'
  | 'ForceCloseChannel' | 'AgentHeartbeat' | 'ZkProofSubmit' | 'ZkProofVerify' | 'ZkPrivateTransfer'
  | 'ZkIdentityProof' | 'PqKeyRegister' | 'PqKeyRotate' | 'PqSignedTransfer' | 'PqAttest'
  | 'CreateDeal' | 'AcceptDeal' | 'ConfirmDeal' | 'CancelDeal' | 'DisputeDeal' | 'SettleDeal'
  | 'ReclaimDeal' | 'ZkVkRegister';

/** camelCase builder names of `Instructions`, index-aligned with `VariantName`. */
export type BuilderName =
  | 'tokenMint' | 'tokenTransfer' | 'tokenBurn' | 'tokenCreate' | 'contractCall' | 'contractDeploy'
  | 'tokenCreateRWA' | 'rwaUpdateStatus' | 'rwaTransfer' | 'stake' | 'unstake' | 'nativeTransfer'
  | 'validatorAttestation' | 'wrapXrs' | 'unwrapXrs' | 'registerAgent' | 'updateAgent' | 'agentExecute'
  | 'createIdentity' | 'updateIdentity' | 'attestReputation' | 'agentMessage' | 'subDelegate'
  | 'conditionalOrder' | 'cancelConditionalOrder' | 'registerOracle' | 'oracleSubmit' | 'hardwareAttest'
  | 'registerCapability' | 'updateCapability' | 'queryCapabilities' | 'postTask' | 'claimTask'
  | 'resolveTask' | 'registerModel' | 'updateModel' | 'openDispute' | 'resolveDispute' | 'slashReport'
  | 'createProposal' | 'castVote' | 'executeProposal' | 'openChannel' | 'closeChannel'
  | 'forceCloseChannel' | 'agentHeartbeat' | 'zkProofSubmit' | 'zkProofVerify' | 'zkPrivateTransfer'
  | 'zkIdentityProof' | 'pqKeyRegister' | 'pqKeyRotate' | 'pqSignedTransfer' | 'pqAttest'
  | 'createDeal' | 'acceptDeal' | 'confirmDeal' | 'cancelDeal' | 'disputeDeal' | 'settleDeal'
  | 'reclaimDeal' | 'zkVkRegister';

/** `.code` strings carried by every SDK error. */
export type ErrorCode =
  | 'xeris' | 'encoding' | 'arity' | 'feature_disabled' | 'rpc' | 'rpc_http'
  | 'rpc_transport' | 'rpc_json' | 'timeout' | 'config' | 'provider';

/** Keys of `DISABLED_FEATURES`. */
export type DisabledFeatureKey =
  | 'SubDelegate' | 'ZkPrivateTransfer' | 'ZkIdentityProof' | 'PqSignedTransfer'
  | 'airdrop' | 'stakeClaim' | 'governanceRpcWrite' | 'governanceLock'
  | 'agentSwap' | 'agentLaunchpad' | 'agentRwa' | 'agentStake' | 'agentDelegatedMethod';

/**
 * Minimal `fetch` shape the client needs. The default is `globalThis.fetch`
 * (Node >= 18); any implementation with this signature can be injected via
 * `ClientOptions.fetch`.
 */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

// ---------------------------------------------------------------------------
// Errors (src/errors.js)
// ---------------------------------------------------------------------------

/** Options accepted by every SDK error constructor. */
export interface XerisErrorOptions {
  /** Defaults to the class's own code. */
  code?: string;
  /** Free-form structured context; stored as given or `null`. */
  details?: object | null;
  /** Attached as `error.cause` when provided. */
  cause?: unknown;
}

/**
 * Base class of every SDK-specific error (misconfiguration, timeouts,
 * unsupported wallet provider). Native `TypeError` / `RangeError` are thrown
 * for wrong-type and out-of-domain field values and are not subclasses of this.
 */
export class XerisError extends Error {
  constructor(message: string, opts?: XerisErrorOptions);
  /** `'xeris'` by default; see `ErrorCode`. */
  code: string;
  /** Structured context or `null`. */
  details: object | null;
  /** Present when a `cause` was supplied. */
  cause?: unknown;
}

/**
 * Structural encoding failure: wrong argument count (`code: 'arity'`),
 * unknown variant index, oversize instruction data, malformed hex,
 * unreadable instruction bytes.
 */
export class EncodingError extends XerisError {
  constructor(message: string, opts?: XerisErrorOptions & { field?: string | null });
  /** Name of the offending field or parameter, or `null`. */
  field: string | null;
}

/**
 * Thrown synchronously, before any network call, when the requested operation
 * is one the node refuses at ingress, skips in its dispatcher, or serves with
 * HTTP 501. `message` is exactly `DISABLED_FEATURES[feature].message`.
 */
export class FeatureDisabledError extends XerisError {
  constructor(
    message: string,
    opts: XerisErrorOptions & { feature: string; replacement?: string | null; citation: string },
  );
  /** `code` is always `'feature_disabled'`. */
  code: 'feature_disabled';
  /** The `DISABLED_FEATURES` key. */
  feature: string;
  /** The live SDK path to use instead, or `null` when none exists. */
  replacement: string | null;
  /** Node `file:line` range that disables the feature. */
  citation: string;
}

/**
 * A failure reported by the node or by the HTTP transport. Every node error
 * body becomes an `RpcError`, including HTTP 200 bodies with an `"error"` key
 * (every `network.rs` handler except the five 501 stubs at
 * `network.rs:5735, 5798, 5815, 5848, 5865`) and JSON-RPC results of the form
 * `{"error": "..."}` (`explorer.rs:1455, 1481, 1499, 1517, 1536, 1554, 1565`).
 */
export class RpcError extends XerisError {
  constructor(
    message: string,
    opts?: XerisErrorOptions & {
      route?: string | null;
      httpStatus?: number | null;
      body?: unknown;
      nodeStatus?: string | null;
      hint?: string | null;
    },
  );
  /** `'rpc'`, or `'rpc_http'` / `'rpc_transport'` / `'rpc_json'` from the transport layer. */
  code: string;
  /** e.g. `'POST /submit'` or `'JSON-RPC getBalance'`, or `null`. */
  route: string | null;
  /** HTTP status of the response, or `null` when none was received. */
  httpStatus: number | null;
  /** Parsed JSON body, raw text, or `null`. */
  body: unknown;
  /** `body.status` when it is a string (e.g. `rejected_mempool_full`, `network.rs:4825-4843`), else `null`. */
  nodeStatus: string | null;
  /** `body.hint` when it is a string, else `null`. */
  hint: string | null;
}

/** One entry of `DISABLED_FEATURES`. */
export interface DisabledFeature {
  /** Exact message of the `FeatureDisabledError` thrown for this key. */
  readonly message: string;
  /** Live SDK path to use instead, or `null`. */
  readonly replacement: string | null;
  /** Node `file:line` range that disables the feature. */
  readonly citation: string;
}

/**
 * Operations the node refuses, keyed by the name the SDK uses for them
 * (`ledger.rs:1445-1450, 8669-8685, 8687-8697, 8809-8828`;
 * `network.rs:4314-4327, 5705-5740, 5788-5867`; `ledger.rs:2138-2175, 6436-6475, 6554-6561`).
 */
export const DISABLED_FEATURES: Readonly<Record<DisabledFeatureKey, DisabledFeature>>;

// ---------------------------------------------------------------------------
// Constants (src/constants.js)
// ---------------------------------------------------------------------------

/** SDK version string (package.json). */
export const VERSION: '5.0.0';
/** Decimal places of the native token (`token.rs:901`; `bin/wallet.rs:113`). */
export const XRS_DECIMALS: 9;
/** Base units (lamports) per 1 XRS (`token.rs:901`). */
export const LAMPORTS_PER_XRS: 1000000000;
/** Flat per-transaction fee in lamports (`ledger.rs:58`). */
export const BASE_TX_FEE: 1000000;
/** `BASE_TX_FEE` in XRS (derived). */
export const BASE_TX_FEE_XRS: 0.001;
/** Default HTTP RPC port (`main.rs:831, 839`). */
export const DEFAULT_RPC_PORT: 56001;
/** Default explorer / JSON-RPC port (`main.rs:832, 840`). */
export const DEFAULT_EXPLORER_PORT: 50008;
/** Default P2P port (`main.rs:830, 838`). */
export const DEFAULT_P2P_PORT: 4000;
/** Published testnet validator host (`network.rs:298`). */
export const TESTNET_SEED: '138.197.116.81';
/** Environment variable read by `XerisClient.mainnet()` / `XerisAgent.mainnet()` when no host is passed. */
export const MAINNET_HOST_ENV: 'XERIS_MAINNET_HOST';
/** Testnet chain id used in signing domains (`ledger.rs:287`). */
export const CHAIN_ID_TESTNET: 'xeris-testnet-v1';
/** Mainnet chain id used in signing domains (`ledger.rs:286`). */
export const CHAIN_ID_MAINNET: 'xeris-mainnet-v1';
/** Slot duration in milliseconds (`main.rs:33`). */
export const SLOT_MS: 4000;
/** A `recent_blockhash` is valid while among the last this many block hashes (`ledger.rs:239`). */
export const BLOCKHASH_EXPIRY_WINDOW: 150;
/** Maximum `instruction.data` length in bytes (`ledger.rs:93`). */
export const MAX_IX_DATA_SIZE: 8192;
/** Maximum `instruction.data` length for `SlashReport` (variant 38) (`ledger.rs:119`). */
export const MAX_SLASH_IX_DATA_SIZE: 65535;
/** Maximum instructions per transaction (`ledger.rs:94`). */
export const MAX_IX_PER_TX: 16;
/** Maximum account keys per transaction (`ledger.rs:95`). */
export const MAX_ACCOUNTS_PER_TX: 64;
/** Maximum serialized transaction size in bytes (`tx_pool.rs:183`). */
export const MAX_TX_BYTES: 131072;
/** HTTP body limit on the four write routes (`network.rs:4336, 4440, 4571, 4664`). */
export const WRITE_BODY_LIMIT_BYTES: 262144;
/** Per-IP write rate limit shared by the write routes (`network.rs:4308`). */
export const WRITE_RPC_LIMIT: { readonly max: 30; readonly windowSec: 60 };
/** Minimum stake to validate, 1,000 XRS (`ledger.rs:232`). */
export const MIN_STAKE_LAMPORTS: 1000000000000;
/** Minimum stake to submit attestations, 100 XRS (`ledger.rs:1285`). */
export const MIN_ATTESTOR_STAKE_LAMPORTS: 100000000000;
/** Minimum partial unstake, 1 XRS (`ledger.rs:210`). */
export const MIN_UNSTAKE_LAMPORTS: 1000000000;
/** Unbonding period in slots (`ledger.rs:201`). */
export const UNBONDING_PERIOD_SLOTS: 151200;
/** Reward per accepted attestation in lamports (`ledger.rs:214`). */
export const ATTESTATION_REWARD_LAMPORTS: 10000000;
/** An attestation must name a block within this many slots (`ledger.rs:218`). */
export const ATTESTATION_SLOT_WINDOW: 200;
/** Staking rewards are paid every this many blocks (`ledger.rs:5138`). */
export const STAKING_REWARD_INTERVAL_BLOCKS: 900;
/** Staking APY in percent (`ledger.rs:5144-5145`). */
export const STAKING_APY_PCT: 7;
/** Initial block reward in lamports (`ledger.rs:70`). */
export const BASE_BLOCK_REWARD_LAMPORTS: 10000000000;
/** Blocks between reward halvings (`ledger.rs:75`). */
export const HALVING_INTERVAL_BLOCKS: 25000000;
/** Emission cap in lamports; a `bigint` because it exceeds `2^53-1` (`ledger.rs:65`). */
export const MAX_EMISSION_SUPPLY_LAMPORTS: 500000000000000000n;
/** Blocks kept in memory; signature lookups search only these (`ledger.rs:36`). */
export const MAX_RECENT_BLOCKS: 1000;
/** Number of `XerisInstruction` variants (`token.rs:30-808`). */
export const INSTRUCTION_COUNT: 62;
/** Variant indices the node refuses or skips (`ledger.rs:1445-1450, 8669-8685, 8687-8697, 8809-8828`). */
export const DISABLED_VARIANTS: readonly [22, 48, 49, 52];
/** The only PQ algorithm string the node accepts (`crypto.rs:924`). */
export const SUPPORTED_PQ_ALGORITHM: 'dilithium3';
/** ML-DSA-65 public key length in bytes (`crypto.rs:1162-1186`). */
export const PQ_PUBLIC_KEY_LEN: 1952;
/** ML-DSA-65 secret key length in bytes (`crypto.rs:1164`). */
export const PQ_SECRET_KEY_LEN: 4032;
/** ML-DSA-65 detached signature length in bytes (`crypto.rs:1162-1186`). */
export const PQ_SIGNATURE_LEN: 3309;
/** Security level the PQ registry requires (`contracts.rs:6168-6215`). */
export const PQ_SECURITY_LEVEL: 3;
/** Substrings that mark a ZK descriptive field as a PQ claim; such fields are rejected (`ledger.rs:5362-5374`). */
export const PQ_CLAIM_TOKENS: readonly ['pq', 'post-quantum', 'post_quantum', 'postquantum', 'post quantum', 'dilithium', 'mldsa', 'ml-dsa', 'ml_dsa'];
/** Domain tag of the PQ key-rotation message (`crypto.rs:864`). */
export const PQ_ROTATE_TAG: 'xrs_pq_rotate_v5';
/** Domain tag of the channel state message (`contracts.rs:69`). */
export const CHANNEL_STATE_TAG: 'XRS_CH_STATE_V3';
/** Domain tag of the channel close message (`contracts.rs:98`). */
export const CHANNEL_CLOSE_TAG: 'XRS_CLOSE_CH_V4';
/** Challenge period of `xeris_channels` in slots (`ledger.rs:8308`). */
export const CHANNEL_CHALLENGE_PERIOD_SLOTS: 1000;
/** Maximum Groth16 proof size in bytes (`crypto.rs:1041`). */
export const MAX_GROTH16_PROOF_BYTES: 512;
/** Maximum Groth16 verification key size in bytes (`crypto.rs:1042`). */
export const MAX_GROTH16_VK_BYTES: 16384;
/** Maximum Groth16 public inputs, 32 bytes each (`crypto.rs:1043`). */
export const MAX_GROTH16_PUBLIC_INPUTS: 64;
/** Allowed `allowed_operations` strings, in the order of `AGENT_INNER_VARIANTS` (`ledger.rs:6425-6477`). */
export const AGENT_OPERATIONS: readonly ['NativeTransfer', 'TokenTransfer', 'ContractCall', 'WrapXrs', 'UnwrapXrs', 'Stake', 'Unstake', 'TokenMint', 'TokenBurn'];
/** Variant indices accepted as an `AgentExecute` inner instruction, same order as `AGENT_OPERATIONS`. */
export const AGENT_INNER_VARIANTS: readonly [11, 1, 4, 13, 14, 9, 10, 0, 2];
/** `ContractCall` methods whose delegated spend the ledger can bound (`ledger.rs:2138-2175`). */
export const DELEGATED_CALL_METHODS: readonly ['buy_tokens', 'sell_tokens', 'swap', 'add_liquidity', 'remove_liquidity', 'create_dca_order', 'distribute', 'post', 'open', 'create', 'place_order', 'cancel', 'reclaim', 'claim_rewards', 'redeem', 'amend', 'list', 'status', 'get_stats', 'get_key'];
/** Agent daily-spend window in slots (`contracts.rs:3439`). */
export const AGENT_DAILY_WINDOW_SLOTS: 21600;
/** Maximum agents per owner registry (`contracts.rs:3334`). */
export const MAX_AGENTS_PER_REGISTRY: 50;
/** `CreateIdentity.identity_type` values (`ledger.rs:6696`). */
export const IDENTITY_TYPES: readonly ['agent', 'device', 'service', 'human'];
/** `AttestReputation.category` values (`ledger.rs:6820`). */
export const REPUTATION_CATEGORIES: readonly ['reliability', 'accuracy', 'speed', 'honesty', 'safety', 'general'];
/** `AgentMessage.message_type` values (`ledger.rs:6846`). */
export const MESSAGE_TYPES: readonly ['proposal', 'counteroffer', 'accept', 'reject', 'info', 'request'];
/** `ConditionalOrder.condition_type` values (`ledger.rs:6918`). */
export const CONDITION_TYPES: readonly ['price_above', 'price_below', 'balance_above', 'balance_below', 'slot_reached', 'oracle_value'];
/** `RegisterOracle.feed_type` values (`ledger.rs:7164`). */
export const FEED_TYPES: readonly ['price', 'event', 'sensor', 'weather', 'custom'];
/** `HardwareAttest.device_type` values (`ledger.rs:7232`). */
export const DEVICE_TYPES: readonly ['humanoid', 'terminal', 'iot', 'mobile', 'secure_element'];
/** `PostTask.verification` values (`contracts.rs:4751-4786`). */
export const TASK_VERIFICATION_MODES: readonly ['poster_confirm', 'oracle'];
/** `ResolveTask.resolution` values (`ledger.rs:7603-7612`). */
export const TASK_RESOLUTIONS: readonly ['complete', 'verify', 'reject', 'cancel'];
/** `ResolveDispute.action` values (`ledger.rs:7739-7756`). */
export const DISPUTE_ACTIONS: readonly ['evidence', 'defendant_evidence', 'vote_disputer', 'vote_defendant', 'vote_dismiss', 'expire'];
/** `CastVote.vote` values (`contracts.rs:5584-5588`). */
export const VOTES: readonly ['yes', 'no', 'abstain'];
/** `TokenCreateRWA.asset_type` values (`token.rs:1217`). */
export const RWA_ASSET_TYPES: readonly ['real_estate', 'equity', 'debt', 'commodity', 'ip', 'collectible', 'fund', 'bond'];
/** `RWAUpdateStatus.new_status` values (`token.rs:1272`). */
export const RWA_STATUSES: readonly ['active', 'frozen', 'redeemed', 'disputed', 'revoked'];
/** Lower-case deploy aliases mapped to `ContractType` enum names (`contracts.rs:385-411`). */
export const CONTRACT_TYPE_ALIASES: Readonly<Record<ContractTypeAlias, ContractTypeName>>;
/** Enum names a user `ContractDeploy` is refused for (`ledger.rs:2344-2349`). */
export const PROTOCOL_MANAGED_CONTRACT_TYPES: readonly ['DeviceRegistry', 'ZkVerifierRegistry', 'PqKeyRegistry', 'ConditionalOrderBook', 'DisputeRegistry', 'DealRegistry', 'TaskBoard', 'StateChannelRegistry'];
/** Reserved contract id prefixes (`ledger.rs:1524-1530`). */
export const RESERVED_CONTRACT_ID_PREFIXES: readonly ['xeris_', 'identity_', 'agent_registry_', '__'];
/** Reserved contract id suffixes (`ledger.rs:1529`). */
export const RESERVED_CONTRACT_ID_SUFFIXES: readonly ['_xrs_pool'];
/** Contract id shape the SDK accepts, a strict subset of `contracts.rs:1316-1320`. */
export const CONTRACT_ID_PATTERN: RegExp;
/** Fixed ids of the protocol-created registries (`ledger.rs:2184-2320`). */
export const PROTOCOL_CONTRACT_IDS: {
  readonly oracles: 'xeris_oracles';
  readonly devices: 'xeris_devices';
  readonly capabilities: 'xeris_capabilities';
  readonly tasks: 'xeris_tasks';
  readonly models: 'xeris_models';
  readonly disputes: 'xeris_disputes';
  readonly deals: 'xeris_deals';
  readonly governance: 'xeris_governance';
  readonly channels: 'xeris_channels';
  readonly zkVerifier: 'xeris_zk_verifier';
  readonly pqKeys: 'xeris_pq_keys';
  readonly heartbeats: 'xeris_heartbeats';
};
/** Minimum `DisputeDeal.bond` in lamports (`contracts.rs:1008`). */
export const MIN_DEAL_DISPUTE_BOND: 1000000000;
/** Slots after which an active deal can be reclaimed (`contracts.rs:1079`). */
export const DEAL_TIMEOUT_SLOTS: 648000;
/** Dispute challenge period in slots (`contracts.rs:995`). */
export const DISPUTE_CHALLENGE_PERIOD_SLOTS: 21600;
/** Maximum dispute lifetime in slots (`contracts.rs:1000`). */
export const DISPUTE_MAX_LIFETIME_SLOTS: 648000;
/** Maximum task lifetime in slots (`contracts.rs:916`). */
export const MAX_TASK_LIFETIME_SLOTS: 648000;
/** Storage bond locked per conditional order in lamports (`ledger.rs:1290`). */
export const ORDER_STORAGE_BOND: 10000000;
/** Maximum conditional order lifetime in slots (`ledger.rs:1295`). */
export const MAX_ORDER_LIFETIME_SLOTS: 650000;
/** Maximum `ConditionalOrder.inner_instruction` length in bytes (`ledger.rs:6942`). */
export const MAX_CONDITIONAL_INNER_BYTES: 2048;
/** Minimum `RegisterOracle.stake_amount` in lamports (`ledger.rs:7170`). */
export const MIN_ORACLE_STAKE_LAMPORTS: 1000000000;
/** Minimum `CreateProposal.voting_period_slots` (`ledger.rs:8267-8272`). */
export const MIN_VOTING_PERIOD_SLOTS: 21600;
/** Maximum `CreateProposal.voting_period_slots` (`contracts.rs:5527-5530`). */
export const MAX_VOTING_PERIOD_SLOTS: 1296000;
/** Quorum used when `CreateProposal.quorum == 0` (`contracts.rs:163`). */
export const DEFAULT_PROPOSAL_QUORUM: 5000000000000;
/** Default minimum staked balance to propose (`contracts.rs:1826-1827`). */
export const MIN_PROPOSAL_STAKE_LAMPORTS: 100000000000;
/** Protocol fee on launchpad trades in basis points (`contracts.rs:308`). */
export const LAUNCHPAD_XERIS_FEE_BPS: 77;
/** Items per page on cursor-paged registry routes; `limit` is clamped to 1..32 by the node (`explorer.rs:126`). */
export const REGISTRY_PAGE_ITEMS: 32;
/** Maximum `page_size` on `/v2/account/{addr}/transactions` (`tx_store.rs:57`). */
export const ACCOUNT_HISTORY_MAX_PAGE_SIZE: 200;
/** Maximum numbered `page` on `/v2/account/{addr}/transactions` (`explorer.rs:1305-1306`). */
export const ACCOUNT_HISTORY_MAX_PAGE: 50;
/** Maximum `page_size` on numbered list routes (`explorer.rs:276-299`). */
export const LIST_MAX_PAGE_SIZE: 100;
/** Transaction status vocabulary (`explorer.rs:680-690`; `tx_store.rs:116-120`). */
export const TX_STATUSES: readonly ['confirmed', 'failed', 'partial', 'included'];
/** Maximum UTF-8 byte lengths of string fields enforced by the node. */
export const STRING_LIMITS: {
  /** `ledger.rs:6706` */ readonly identityDisplayName: 128;
  /** `ledger.rs:6702` */ readonly identityMetadata: 4096;
  /** `ledger.rs:6826` */ readonly reputationEvidence: 512;
  /** `ledger.rs:6852` */ readonly messagePayload: 8192;
  /** `ledger.rs:7175` */ readonly oracleDescription: 512;
  /** `ledger.rs:7211` */ readonly oracleMetadata: 1024;
  /** `contracts.rs:4723` */ readonly taskTitle: 256;
  /** `contracts.rs:4726` */ readonly taskDescription: 4096;
  /** `contracts.rs:4975-4979` */ readonly taskRejectReason: 512;
  /** `contracts.rs:5637` */ readonly channelId: 128;
  /** `contracts.rs:5652` */ readonly channelType: 64;
};

// ---------------------------------------------------------------------------
// Encoding primitives and unit conversion (src/encoding.js)
// ---------------------------------------------------------------------------

/** Unsigned 32-bit field input: integer `number` or `bigint` in `0..=4294967295`. */
export type U32Input = number | bigint;

/** Unsigned 8-bit field input: integer `number` or `bigint` in `0..=255`. */
export type U8Input = number | bigint;

/** A Rust `Option<T>` field: `null` or `undefined` encode `None`; every other value (including `0`, `''`, `[]`, `false`) encodes `Some`. */
export type Optional<T> = T | null | undefined;

/**
 * Validates a `u64` field value and returns it as a `bigint`.
 * @param value Safe-integer `number` or `bigint`, `0..=2^64-1`.
 * @param field Field name used in error messages (default `'u64'`).
 * @throws {TypeError} Anything other than a `number` or `bigint` (booleans and numeric strings included).
 * @throws {RangeError} Negative, non-integer, `NaN`/`Infinity`, a `number` above `2^53-1` (`"<field>: numbers above 2^53-1 lose precision; pass a BigInt"`), or a `bigint` above `2^64-1`.
 */
export function normalizeU64(value: U64Input, field?: string): bigint;

/**
 * Validates a `u32` field value and returns it as a `number`.
 * @param value Integer `0..=4294967295`.
 * @param field Field name used in error messages (default `'u32'`).
 * @throws {TypeError|RangeError} As `normalizeU64`, with the `u32` bound.
 */
export function normalizeU32(value: U32Input, field?: string): number;

/**
 * Validates a `u8` field value and returns it as a `number`.
 * @param value Integer `0..=255`.
 * @param field Field name used in error messages (default `'u8'`).
 * @throws {TypeError|RangeError} As `normalizeU64`, with the `u8` bound.
 */
export function normalizeU8(value: U8Input, field?: string): number;

/**
 * Encodes a `u8` as 1 byte.
 * @throws {TypeError|RangeError} See `normalizeU8`.
 */
export function encodeU8(value: U8Input, field?: string): Buffer;

/**
 * Encodes a `u32` as 4 bytes little-endian (bincode 1 fixint).
 * @throws {TypeError|RangeError} See `normalizeU32`.
 */
export function encodeU32(value: U32Input, field?: string): Buffer;

/**
 * Encodes a `u64` as 8 bytes little-endian (bincode 1 fixint).
 * @throws {TypeError|RangeError} See `normalizeU64`.
 */
export function encodeU64(value: U64Input, field?: string): Buffer;

/**
 * Encodes a `bool` as `0x00` / `0x01`.
 * @throws {TypeError} When `value` is not a boolean (`1` is not `true`).
 */
export function encodeBool(value: boolean, field?: string): Buffer;

/**
 * Encodes a Rust `String`: `u64le(byteLength) ‖ utf8`.
 * @throws {TypeError} When `value` is not a string.
 * @throws {RangeError} When `value` contains a lone UTF-16 surrogate (no UTF-8 encoding exists).
 */
export function encodeString(value: string, field?: string): Buffer;

/**
 * Encodes a `Vec<u8>`: `u64le(length) ‖ bytes`.
 * @throws {TypeError} When `value` is not a `Buffer`/`Uint8Array` (`number[]` and strings are refused).
 */
export function encodeBytes(value: BytesInput, field?: string): Buffer;

/**
 * Encodes a `[u8; n]`: the `n` raw bytes, no length prefix.
 * @param n Required length.
 * @throws {TypeError} When `value` is not a `Buffer`/`Uint8Array`.
 * @throws {RangeError} When `value.length !== n`.
 */
export function encodeFixedBytes(value: BytesInput, n: number, field?: string): Buffer;

/**
 * Encodes a `Vec<String>`: `u64le(count) ‖ encodeString(each)`.
 * @throws {TypeError} When `values` is not an array or an element is not a string.
 * @throws {RangeError} When an element contains a lone surrogate.
 */
export function encodeStringVec(values: readonly string[], field?: string): Buffer;

/**
 * Encodes an `Option<T>`: `0x00` for `null`/`undefined`, else `0x01 ‖ encoder(value, field)`.
 * `0`, `''`, `[]` and `false` are `Some`.
 * @param encoder Encoder for `T`, e.g. `encodeU64`.
 * @param field Forwarded to `encoder`; when omitted the encoder's own default applies.
 * @throws {TypeError} When `value` is `Some` and `encoder` is not a function, or whatever `encoder` throws.
 */
export function encodeOption<T>(
  value: Optional<T>,
  encoder: (value: T, field?: string) => Buffer,
  field?: string,
): Buffer;

/**
 * Encodes the `XerisInstruction` discriminant as `u32le(index)` (`token.rs:29-30`).
 * @throws {EncodingError} When `index` is not an integer in `0..INSTRUCTION_COUNT-1` (`.field === 'variant'`).
 */
export function encodeVariant(index: number): Buffer;

/**
 * Reads the variant index from encoded instruction data (`readUInt32LE(0)`).
 * @throws {TypeError} When `data` is not a `Buffer`/`Uint8Array`.
 * @throws {EncodingError} When `data` is shorter than 4 bytes.
 */
export function readVariant(data: BytesInput): number;

/**
 * Converts an XRS amount to lamports exactly (9 decimals, `token.rs:901`):
 * `0.29` → `290000000n`, `'1234567.123456789'` → `1234567123456789n`.
 * A `number` is converted via `String(n)`, so values that render in exponent
 * form (`1e-7`) are refused; pass those as decimal strings.
 * @throws {TypeError} When `xrs` is not a number or string.
 * @throws {RangeError} Negative, `NaN`/`Infinity`, more than 9 fractional digits, exponent form, or above `2^64-1` lamports.
 */
export function xrsToLamports(xrs: XrsInput, field?: string): bigint;

/**
 * Converts lamports to an exact XRS decimal string with trailing zeros removed
 * (`290000000` → `'0.29'`, `5000000000n` → `'5'`).
 * @throws {TypeError|RangeError} See `normalizeU64`.
 */
export function lamportsToXrs(lamports: U64Input, field?: string): string;

/**
 * Converts a decimal amount of a token with `decimals` fractional digits to
 * integer base units exactly; `xrsToLamports(x) === toBaseUnits(x, 9)`.
 * @param decimals Integer `0..=38`.
 * @throws {TypeError} When `amount` is not a number or string, or `decimals` is not a number.
 * @throws {RangeError} As `xrsToLamports`, with `decimals` as the fractional-digit bound; `decimals` outside `0..=38`.
 */
export function toBaseUnits(amount: XrsInput, decimals: number, field?: string): bigint;

/**
 * Converts integer base units to an exact decimal string with trailing zeros
 * removed (`fromBaseUnits(1500000n, 6) === '1.5'`).
 * @param decimals Integer `0..=38`.
 * @throws {TypeError|RangeError} See `normalizeU64`; `decimals` outside `0..=38`.
 */
export function fromBaseUnits(units: U64Input, decimals: number, field?: string): string;

/** 4.x name; the same function object as `encodeString`. */
export const encodeBincodeString: typeof encodeString;
/** 4.x name; the same function object as `encodeBytes`. */
export const encodeBincodeVec: typeof encodeBytes;
/** 4.x name; the same function object as `encodeStringVec`. */
export const encodeBincodeStringVec: typeof encodeStringVec;

// ---------------------------------------------------------------------------
// Instruction builders (src/instructions/*.js)
// ---------------------------------------------------------------------------

/**
 * `ContractCall.args` input. `Buffer`/`Uint8Array` is sent verbatim (the only
 * way to send the 16-byte AMM swap payload, see `encodeSwapCall`); a plain
 * object is `JSON.stringify`-ed (`bigint` values are not serialisable and throw
 * `TypeError`); a string must already be JSON text that parses as an object,
 * because the node refuses every other JSON value (`ledger.rs:2359-2371`).
 */
export type ContractCallArgs = BytesInput | Record<string, unknown> | string;

/**
 * A builder for one of the four variants the node refuses. Calling it throws
 * `FeatureDisabledError` synchronously without reading its arguments
 * (`ledger.rs:1445-1450, 8669-8685, 8687-8697, 8809-8828`).
 */
export type DisabledBuilder = (...args: unknown[]) => never;

/**
 * The 62 `XerisInstruction` encoders (`token.rs:30-808`), one per variant,
 * in declaration order. Each takes its Rust fields as positional parameters
 * in Rust order with strict arity (`EncodingError`, `code: 'arity'`, on a
 * wrong argument count), applies only bincode-level validation (type, range,
 * UTF-8 well-formedness, fixed-array length) and never substitutes a default
 * or applies a node business rule. Returns `u32le(index) ‖ fields`.
 *
 * Common throws: `EncodingError` (arity), `TypeError` (wrong JavaScript type),
 * `RangeError` (right type, out of the field's domain).
 */
export interface InstructionBuilders {
  /** Variant 0 (`token.rs:32-36`). Signer must be the token's `mint_authority` (`token.rs:1080`); `amount > 0` (`token.rs:1057`). */
  tokenMint(tokenId: string, to: string, amount: U64Input): Buffer;
  /** Variant 1 (`token.rs:38-43`). Signer == `from`, `from != to`, `amount > 0` (`token.rs:1104-1114`). */
  tokenTransfer(tokenId: string, from: string, to: string, amount: U64Input): Buffer;
  /** Variant 2 (`token.rs:45-49`; handler `token.rs:1147-1175`). */
  tokenBurn(tokenId: string, from: string, amount: U64Input): Buffer;
  /** Variant 3 (`token.rs:51-58`). Signer must equal `mintAuthority` (`token.rs:1036`). `maxSupply` in base units. */
  tokenCreate(tokenId: string, name: string, symbol: string, decimals: U8Input, maxSupply: U64Input, mintAuthority: string): Buffer;
  /** Variant 4 (`token.rs:60-64`; dispatcher `ledger.rs:5829-6153`). See `ContractCallArgs` for the payload rules. */
  contractCall(contractId: string, method: string, args: ContractCallArgs): Buffer;
  /** Variant 5 (`token.rs:66-70`; dispatcher `ledger.rs:6155-6239`). `contractTypeStr` is a `ContractTypeAlias`; `paramsJson` is JSON text. */
  contractDeploy(contractId: string, contractTypeStr: string, paramsJson: string): Buffer;
  /** Variant 6 (`token.rs:72-86`; handler `token.rs:1206-1256`). `valuation` in USD cents. */
  tokenCreateRWA(
    tokenId: string, name: string, symbol: string, decimals: U8Input, maxSupply: U64Input, mintAuthority: string,
    assetType: string, legalDocHash: string, legalDocUri: string, jurisdiction: string,
    transferRestricted: boolean, accreditedOnly: boolean, valuation: U64Input,
  ): Buffer;
  /** Variant 7 (`token.rs:88-94`; handler `token.rs:1258-1294`). The three `new*` fields are `Option<T>`. */
  rwaUpdateStatus(tokenId: string, newStatus: string, newValuation: Optional<U64Input>, newLegalDocHash: Optional<string>, newLegalDocUri: Optional<string>): Buffer;
  /** Variant 8 (`token.rs:96-101`; handler `token.rs:1296-1330`). */
  rwaTransfer(tokenId: string, from: string, to: string, amount: U64Input): Buffer;
  /** Variant 9 (`token.rs:103-106`). Federation-gated on the node (`network.rs:2407-2417`); resulting stake must be >= `MIN_STAKE_LAMPORTS` (`ledger.rs:5713-5718`). */
  stake(pubkey: string, amount: U64Input): Buffer;
  /** Variant 10 (`token.rs:108-111`; handler `ledger.rs:5737-5827`). */
  unstake(pubkey: string, amount: U64Input): Buffer;
  /** Variant 11 (`token.rs:113-117`). Signer == `from` (`ledger.rs:5594`); `to` canonical and not `__*` (`ledger.rs:1569-1577`); `amount > 0`. */
  nativeTransfer(from: string, to: string, amount: U64Input): Buffer;
  /** Variant 12 (`token.rs:119-123`). The node requires `blockHashPrefix` to be exactly 32 bytes at ingress (`ledger.rs:1400`); this encoder accepts any length. */
  validatorAttestation(validator: string, blockSlot: U64Input, blockHashPrefix: BytesInput): Buffer;
  /** Variant 13 (`token.rs:125-127`; handler `ledger.rs:5631-5657`). `amount` in lamports. */
  wrapXrs(amount: U64Input): Buffer;
  /** Variant 14 (`token.rs:129-131`; handler `ledger.rs:5658-5684`). `amount` in lamports. */
  unwrapXrs(amount: U64Input): Buffer;
  /** Variant 15 (`token.rs:133-141`; handler `ledger.rs:6318-6363`). `allowedOperations` entries are matched exactly against `AGENT_OPERATIONS`; empty lists allow all. */
  registerAgent(
    agentName: string, agentPubkey: string, maxPerTx: U64Input, maxDaily: U64Input,
    allowedContracts: readonly string[], allowedOperations: readonly string[], expiresAtSlot: U64Input,
  ): Buffer;
  /** Variant 16 (`token.rs:143-151`; handler `ledger.rs:6365-6392`). Five `Option<T>` fields then `revoked`. */
  updateAgent(
    agentPubkey: string, newMaxPerTx: Optional<U64Input>, newMaxDaily: Optional<U64Input>,
    newAllowedContracts: Optional<readonly string[]>, newAllowedOperations: Optional<readonly string[]>,
    newExpiresAtSlot: Optional<U64Input>, revoked: boolean,
  ): Buffer;
  /** Variant 17 (`token.rs:153-156`; handler `ledger.rs:6425-6485`). `innerInstruction` is encoded instruction bytes, not inspected here; see `checks.agentInner`. */
  agentExecute(ownerPubkey: string, innerInstruction: BytesInput): Buffer;
  /** Variant 18 (`token.rs:158-164`; handler `ledger.rs:6687-6793`). A non-empty `parentIdentity` requires a co-signed transaction (`ledger.rs:6717-6727`). */
  createIdentity(identityPubkey: string, displayName: string, identityType: string, parentIdentity: string, metadataJson: string): Buffer;
  /** Variant 19 (`token.rs:166-171`; handler `ledger.rs:6795-6807`). */
  updateIdentity(identityPubkey: string, newDisplayName: Optional<string>, newMetadata: Optional<string>, deactivated: boolean): Buffer;
  /** Variant 20 (`token.rs:173-178`; handler `ledger.rs:6809-6842`). The node clamps `score` to 100 (`contracts.rs:3568`); `XerisClient.attestReputation` refuses > 100 instead. */
  attestReputation(subjectPubkey: string, score: U8Input, category: string, evidence: string): Buffer;
  /** Variant 21 (`token.rs:180-186`; handler `ledger.rs:6844-6871`). Writes no state. */
  agentMessage(toIdentity: string, messageType: string, payloadJson: string, replyTo: string, expiresAtSlot: U64Input): Buffer;
  /** Variant 22. Always throws `FeatureDisabledError` (`feature: 'SubDelegate'`): rejected at ingress (`ledger.rs:1445-1450`) and skipped in blocks (`ledger.rs:6911-6914`). Use `registerAgent`. */
  subDelegate: DisabledBuilder;
  /** Variant 23 (`token.rs:201-209`; handler `ledger.rs:6916-7122`). `innerInstruction` is encoded instruction bytes (<= `MAX_CONDITIONAL_INNER_BYTES` on the node). */
  conditionalOrder(
    orderId: string, conditionType: string, conditionSource: string, conditionThreshold: U64Input,
    innerInstruction: BytesInput, expiresAtSlot: U64Input, lockedAmount: U64Input,
  ): Buffer;
  /** Variant 24 (`token.rs:211-213`; handler `ledger.rs:7124-7160`). */
  cancelConditionalOrder(orderId: string): Buffer;
  /** Variant 25 (`token.rs:215-221`; handler `ledger.rs:7162-7207`). `stakeAmount` in lamports. */
  registerOracle(oracleId: string, description: string, feedType: string, updateIntervalSlots: U64Input, stakeAmount: U64Input): Buffer;
  /** Variant 26 (`token.rs:223-227`; handler `ledger.rs:7209-7228`). */
  oracleSubmit(oracleId: string, value: U64Input, metadata: string): Buffer;
  /** Variant 27 (`token.rs:229-237`; handler `ledger.rs:7311-7332`). `attestationProof` is a 64-byte Ed25519 signature over the `XRS_HW_ATTEST_V2` challenge (`ledger.rs:5299-5319`). */
  hardwareAttest(
    devicePubkey: string, deviceType: string, manufacturer: string, model: string, firmwareVersion: string,
    attestationProof: BytesInput, boundIdentity: string,
  ): Buffer;
  /** Variant 28 (`token.rs:239-248`; handler `ledger.rs:7389-7433`). `pricePerUnit` in lamports. */
  registerCapability(
    providerIdentity: string, category: string, tags: readonly string[], region: string, description: string,
    pricePerUnit: U64Input, maxConcurrent: U32Input, metadataJson: string,
  ): Buffer;
  /** Variant 29 (`token.rs:250-259`; handler `ledger.rs:7435-7458`). Five `Option<T>` fields then `removed`. */
  updateCapability(
    providerIdentity: string, category: string, newTags: Optional<readonly string[]>, newDescription: Optional<string>,
    newPricePerUnit: Optional<U64Input>, newMaxConcurrent: Optional<U32Input>, newMetadata: Optional<string>, removed: boolean,
  ): Buffer;
  /**
   * Variant 30 (`token.rs:261-267`). Encodes, but the dispatcher is a no-op
   * (`ledger.rs:7460-7464`): the fee is charged and nothing is written or
   * returned.
   * @deprecated Use `XerisClient.searchCapabilities` (`GET /capabilities/search`).
   */
  queryCapabilities(category: string, tags: readonly string[], region: string, minReputation: U8Input, maxPrice: U64Input): Buffer;
  /** Variant 31 (`token.rs:269-282`; handler `ledger.rs:7466-7505`). Twelve fields; `reward` and `verificationThreshold` in lamports. */
  postTask(
    taskId: string, title: string, description: string, requiredCategory: string, requiredTags: readonly string[],
    minReputation: U8Input, reward: U64Input, expiresAtSlot: U64Input, maxClaimants: U32Input,
    verification: string, verificationOracle: string, verificationThreshold: U64Input,
  ): Buffer;
  /** Variant 32 (`token.rs:284-287`; handler `ledger.rs:7507-7588`). */
  claimTask(taskId: string, claimantIdentity: string): Buffer;
  /** Variant 33 (`token.rs:289-293`; handler `ledger.rs:7590-7629`). */
  resolveTask(taskId: string, resolution: string, proof: string): Buffer;
  /** Variant 34 (`token.rs:295-304`; handler `ledger.rs:7633-7663`). */
  registerModel(
    identityPubkey: string, modelName: string, modelHash: string, modelVersion: string, framework: string,
    capabilitiesJson: string, modelSizeBytes: U64Input, executionEnvironment: string,
  ): Buffer;
  /** Variant 35 (`token.rs:306-313`; handler `ledger.rs:7665-7680`). The dispatcher ignores `identityPubkey` and uses the signer (`ledger.rs:7671`). */
  updateModel(identityPubkey: string, modelHash: string, newVersion: Optional<string>, newCapabilities: Optional<string>, newEnvironment: Optional<string>, retired: boolean): Buffer;
  /** Variant 36 (`token.rs:499-509`; handler `ledger.rs:7682-7708`). Seven fields; `bond` in lamports. */
  openDispute(disputeId: string, disputeType: string, subjectId: string, defendant: string, reason: string, evidence: string, bond: U64Input): Buffer;
  /** Variant 37 (`token.rs:511-515`; handler `ledger.rs:7710-7778`). */
  resolveDispute(disputeId: string, action: string, data: string): Buffer;
  /** Variant 38 (`token.rs:517-523`). Instruction data may be up to `MAX_SLASH_IX_DATA_SIZE` bytes (`ledger.rs:119`). */
  slashReport(agentPubkey: string, ownerPubkey: string, violationType: string, evidence: string, violationSlot: U64Input): Buffer;
  /** Variant 39 (`token.rs:525-533`; handler `ledger.rs:8265-8290`). `quorum = 0` selects `DEFAULT_PROPOSAL_QUORUM` (`ledger.rs:8284-8288`). */
  createProposal(proposalId: string, title: string, description: string, proposalType: string, parameterJson: string, votingPeriodSlots: U64Input, quorum: U64Input): Buffer;
  /** Variant 40 (`token.rs:535-538`; handler `ledger.rs:8292-8297`). */
  castVote(proposalId: string, vote: string): Buffer;
  /** Variant 41 (`token.rs:540-542`; handler `ledger.rs:8299-8303`). */
  executeProposal(proposalId: string): Buffer;
  /** Variant 42 (`token.rs:544-550`; handler `ledger.rs:8305-8312`). `deposit` in lamports. */
  openChannel(channelId: string, counterparty: string, deposit: U64Input, channelType: string, expiresAtSlot: U64Input): Buffer;
  /** Variant 43 (`token.rs:552-558`; handler `ledger.rs:8314-8400`). `counterpartySignature` is 64-byte Ed25519 over `channelCloseMessage(...)`. */
  closeChannel(channelId: string, finalBalanceA: U64Input, finalBalanceB: U64Input, messageCount: U64Input, counterpartySignature: BytesInput): Buffer;
  /** Variant 44 (`token.rs:581-587`). Five fields; `counterpartySignature` is empty for `stateSequence == 0`, else 64-byte Ed25519 over `channelStateMessage(...)` (`contracts.rs:5787-5812`). */
  forceCloseChannel(channelId: string, claimedBalanceSelf: U64Input, claimedBalanceOther: U64Input, stateSequence: U64Input, counterpartySignature: BytesInput): Buffer;
  /** Variant 45 (`token.rs:589-595`; handler `ledger.rs:8420-8452`). */
  agentHeartbeat(identityPubkey: string, currentModelHash: string, activeTasks: U32Input, availableCapacity: U32Input, statusMessage: string): Buffer;
  /** Variant 46 (`token.rs:597-605`; handler `ledger.rs:8529-8661`). The node requires `proofSystem === 'groth16'` and a `verificationKeyHash` registered with `zkVkRegister`. */
  zkProofSubmit(proofId: string, proofSystem: string, proofData: BytesInput, publicInputs: BytesInput, verificationKeyHash: string, proofType: string, metadataJson: string): Buffer;
  /** Variant 47 (`token.rs:607-609`; handler `ledger.rs:8663-8667`, read-only). */
  zkProofVerify(proofId: string): Buffer;
  /** Variant 48. Always throws `FeatureDisabledError` (`feature: 'ZkPrivateTransfer'`): skipped by the dispatcher after the fee is charged (`ledger.rs:8669-8685`). */
  zkPrivateTransfer: DisabledBuilder;
  /** Variant 49. Always throws `FeatureDisabledError` (`feature: 'ZkIdentityProof'`): skipped by the dispatcher (`ledger.rs:8687-8697`). */
  zkIdentityProof: DisabledBuilder;
  /** Variant 50 (`token.rs:639-644`; handler `ledger.rs:8701-8736`). The node requires `'dilithium3'`, a 1952-byte key and level 3 (`crypto.rs:924-976`; `contracts.rs:6168-6215`). */
  pqKeyRegister(ed25519Pubkey: string, pqPublicKey: BytesInput, pqAlgorithm: string, securityLevel: U8Input): Buffer;
  /** Variant 51 (`token.rs:646-651`; handler `ledger.rs:8738-8807`). `rotationProof` signs `buildPqRotationMessage(...)` with the currently registered key. */
  pqKeyRotate(ed25519Pubkey: string, newPqPublicKey: BytesInput, newPqAlgorithm: string, rotationProof: BytesInput): Buffer;
  /** Variant 52. Always throws `FeatureDisabledError` (`feature: 'PqSignedTransfer'`): skipped by the dispatcher (`ledger.rs:8809-8828`). */
  pqSignedTransfer: DisabledBuilder;
  /** Variant 53 (`token.rs:660-665`; handler `ledger.rs:8830-8871`). Self-asserted marker; the node stores `verified = false` regardless. */
  pqAttest(attestationType: string, referenceId: string, pqAlgorithm: string, verified: boolean): Buffer;
  /** Variant 54 (`token.rs:738-743`; handler `ledger.rs:7781-7788`). `amount` in lamports. */
  createDeal(dealId: string, counterparty: string, amount: U64Input, terms: string): Buffer;
  /** Variant 55 (`token.rs:753-759`; handler `ledger.rs:7789-7798`). `expectedTermsHash` is exactly 32 raw bytes (`[u8; 32]`, no length prefix); see `dealTermsHash`. */
  acceptDeal(dealId: string, instance: U64Input, expectedPartyA: string, expectedAmount: U64Input, expectedTermsHash: BytesInput): Buffer;
  /** Variant 56 (`token.rs:761-764`; handler `ledger.rs:7799-7802`). */
  confirmDeal(dealId: string, instance: U64Input): Buffer;
  /** Variant 57 (`token.rs:766-769`; handler `ledger.rs:7803-7806`). */
  cancelDeal(dealId: string, instance: U64Input): Buffer;
  /** Variant 58 (`token.rs:771-776`; handler `ledger.rs:7807-7861`). `bond >= MIN_DEAL_DISPUTE_BOND` on the node (`ledger.rs:7814`). */
  disputeDeal(dealId: string, instance: U64Input, reason: string, bond: U64Input): Buffer;
  /** Variant 59 (`token.rs:778-781`; handler `ledger.rs:7862-7905`, permissionless). */
  settleDeal(dealId: string, instance: U64Input): Buffer;
  /** Variant 60 (`token.rs:783-786`; handler `ledger.rs:7906-7914`); allowed after `DEAL_TIMEOUT_SLOTS` (`contracts.rs:1079`). */
  reclaimDeal(dealId: string, instance: U64Input): Buffer;
  /** Variant 61 (`token.rs:795-800`; handler `ledger.rs:8480-8491`). Signer needs >= 1,000 XRS staked; `vkBase64` decodes to 1..`MAX_GROTH16_VK_BYTES` bytes. */
  zkVkRegister(vkId: string, vkBase64: string, claimType: string, description: string): Buffer;
}

/** The frozen builder table; see `InstructionBuilders`. */
export const Instructions: Readonly<InstructionBuilders>;

/** PascalCase variant name → index, in `token.rs:30-808` declaration order. */
export interface VariantIndex {
  readonly TokenMint: 0; readonly TokenTransfer: 1; readonly TokenBurn: 2; readonly TokenCreate: 3;
  readonly ContractCall: 4; readonly ContractDeploy: 5; readonly TokenCreateRWA: 6; readonly RWAUpdateStatus: 7;
  readonly RWATransfer: 8; readonly Stake: 9; readonly Unstake: 10; readonly NativeTransfer: 11;
  readonly ValidatorAttestation: 12; readonly WrapXrs: 13; readonly UnwrapXrs: 14; readonly RegisterAgent: 15;
  readonly UpdateAgent: 16; readonly AgentExecute: 17; readonly CreateIdentity: 18; readonly UpdateIdentity: 19;
  readonly AttestReputation: 20; readonly AgentMessage: 21; readonly SubDelegate: 22; readonly ConditionalOrder: 23;
  readonly CancelConditionalOrder: 24; readonly RegisterOracle: 25; readonly OracleSubmit: 26; readonly HardwareAttest: 27;
  readonly RegisterCapability: 28; readonly UpdateCapability: 29; readonly QueryCapabilities: 30; readonly PostTask: 31;
  readonly ClaimTask: 32; readonly ResolveTask: 33; readonly RegisterModel: 34; readonly UpdateModel: 35;
  readonly OpenDispute: 36; readonly ResolveDispute: 37; readonly SlashReport: 38; readonly CreateProposal: 39;
  readonly CastVote: 40; readonly ExecuteProposal: 41; readonly OpenChannel: 42; readonly CloseChannel: 43;
  readonly ForceCloseChannel: 44; readonly AgentHeartbeat: 45; readonly ZkProofSubmit: 46; readonly ZkProofVerify: 47;
  readonly ZkPrivateTransfer: 48; readonly ZkIdentityProof: 49; readonly PqKeyRegister: 50; readonly PqKeyRotate: 51;
  readonly PqSignedTransfer: 52; readonly PqAttest: 53; readonly CreateDeal: 54; readonly AcceptDeal: 55;
  readonly ConfirmDeal: 56; readonly CancelDeal: 57; readonly DisputeDeal: 58; readonly SettleDeal: 59;
  readonly ReclaimDeal: 60; readonly ZkVkRegister: 61;
}

/** Frozen variant-name → index table (62 entries). `Variant.ZkVkRegister === 61`. */
export const Variant: VariantIndex;

/** Index → PascalCase variant name (62 entries). */
export const VARIANT_NAMES: readonly VariantName[];

/** Index → camelCase builder name (62 entries), aligned with `VARIANT_NAMES`. */
export const BUILDER_NAMES: readonly BuilderName[];

/** `true` for the variant indices in `DISABLED_VARIANTS` (22, 48, 49, 52). */
export function isDisabledVariant(index: number): boolean;

/**
 * Converts a `POST /agent/plan` response (`network.rs:5386-5577`) into encoded
 * instruction bytes by calling the builder the plan names: 11 → `nativeTransfer`,
 * 4 with a byte-array `args` → `contractCall` (swap, 16 bytes), 4 with an object
 * `args` → `contractCall` (buy_launchpad), 9 → `stake`, 13 → `wrapXrs`,
 * 14 → `unwrapXrs`. `params.amount` is the node's `(amount_xrs * 1e9) as u64`
 * truncation (`network.rs:5399, 5537, 5549, 5560`); compare with
 * `xrsToLamports` before signing when exactness matters.
 * @throws {TypeError} `plan`/`plan.params` not an object, unsupported `variant_index`, `variant_name` mismatch, or a wrong-typed parameter.
 * @throws {RangeError} A numeric parameter that is not a safe integer, or a byte outside `0..=255`.
 */
export function fromPlan(plan: AgentPlan): Buffer;

/**
 * `contractCall(contractId, method, u64le(inputAmount) ‖ u64le(minOutput))`:
 * the 16-byte payload the Swap contract reads (`contracts.rs:2419-2441`,
 * `2484-2499`). Amounts in base units of the respective tokens.
 * @throws {RangeError} When `method` is not `'swap_a_to_b'` / `'swap_b_to_a'`, or an amount is out of range.
 * @throws {TypeError|EncodingError} Wrong types or argument count.
 */
export function encodeSwapCall(contractId: string, method: SwapMethod, inputAmount: U64Input, minOutput: U64Input): Buffer;

/**
 * `SHA-256(utf8(terms))`: the 32 bytes `acceptDeal.expectedTermsHash` must
 * carry (`contracts.rs:281-284`, compared at `contracts.rs:5381-5382`). Pass
 * the exact `terms` string stored by `CreateDeal`.
 * @throws {TypeError} When `terms` is not a string.
 * @throws {RangeError} When `terms` contains a lone surrogate.
 */
export function dealTermsHash(terms: string): Buffer;

/**
 * The message `pqKeyRotate.rotationProof` must sign (`crypto.rs:851-870`):
 * `ascii('xrs_pq_rotate_v5') ‖ chainId ‖ oldPk ‖ newPk ‖ u64le(rotationCount)`,
 * no length framing. `chainId` is `CHAIN_ID_TESTNET` / `CHAIN_ID_MAINNET`
 * (a string is used as its ASCII bytes); `rotationCount` is the address's
 * current `rotation_count` from `GET /pq/keys/{address}` (`ledger.rs:8785-8792`).
 * Sign the result with the currently registered ML-DSA-65 secret key; this
 * SDK does not implement ML-DSA.
 * @throws {TypeError} Wrong types.
 * @throws {RangeError} Empty `chainId`, a key not exactly `PQ_PUBLIC_KEY_LEN` bytes, or `rotationCount` out of range.
 */
export function buildPqRotationMessage(chainId: string | BytesInput, oldPk: BytesInput, newPk: BytesInput, rotationCount: U64Input): Buffer;

/**
 * Canonical channel state message (`contracts.rs:57-85`):
 * `'XRS_CH_STATE_V3' ‖ lp(networkDomain) ‖ lp(utf8(channelId)) ‖ u64le(generation) ‖
 * u64le(createdSlot) ‖ identity(partyA) ‖ identity(partyB) ‖ u64le(balanceA) ‖
 * u64le(balanceB) ‖ u64le(stateSequence)`, where `lp(b) = u32le(len) ‖ b`
 * (`contracts.rs:12-15`) and `identity(s)` is `0x01 ‖ 32-byte key` for a
 * canonical base58 key, else `0x00 ‖ lp(utf8(s))` (`contracts.rs:21-30`).
 * `networkDomain` is the chain id (`CHAIN_ID_TESTNET` / `CHAIN_ID_MAINNET`) as
 * a string or its raw bytes (`contracts.rs:5646-5648`). `generation` and
 * `createdSlot` come from the channel record in `GET /contract/xeris_channels`.
 * The counterparty signs this with `XerisKeypair.sign` for `forceCloseChannel`
 * (`stateSequence >= 1`) and `challenge_update`.
 * @throws {TypeError|RangeError|EncodingError}
 */
export function channelStateMessage(
  networkDomain: string | BytesInput, channelId: string, generation: U64Input, createdSlot: U64Input,
  partyA: string, partyB: string, balanceA: U64Input, balanceB: U64Input, stateSequence: U64Input,
): Buffer;

/**
 * Canonical cooperative-close message (`contracts.rs:86-109`): as
 * `channelStateMessage` with the tag `'XRS_CLOSE_CH_V4'` and the trailing
 * fields `finalBalanceA`, `finalBalanceB`, `messageCount`. The counterparty
 * signs this with `XerisKeypair.sign` for `closeChannel` (`ledger.rs:8332-8388`).
 * @throws {TypeError|RangeError|EncodingError}
 */
export function channelCloseMessage(
  networkDomain: string | BytesInput, channelId: string, generation: U64Input, createdSlot: U64Input,
  partyA: string, partyB: string, finalBalanceA: U64Input, finalBalanceB: U64Input, messageCount: U64Input,
): Buffer;

// ---------------------------------------------------------------------------
// Keypair (src/keypair.js)
// ---------------------------------------------------------------------------

/**
 * An Ed25519 keypair in the node's `Keypair` layout (64-byte secret key =
 * 32-byte seed ‖ 32-byte public key; address = base58 public key). Wraps a
 * `@solana/web3.js` `Keypair` for transaction signing and signs raw messages
 * through `node:crypto`. `toJSON()` and `util.inspect` never expose secret bytes.
 */
export class XerisKeypair {
  /**
   * Wraps an existing web3 `Keypair`.
   * @throws {TypeError} When `solanaKeypair` is not a web3 `Keypair`.
   */
  constructor(solanaKeypair: Keypair);
  /** A new random keypair (`Keypair.generate()`). */
  static generate(): XerisKeypair;
  /**
   * From a 64-byte secret key (`Keypair::to_bytes()` layout). `number[]` is
   * accepted here only, each element validated as an integer `0..=255`.
   * @throws {TypeError} Wrong container type or a non-number element.
   * @throws {RangeError} Length other than 64, an element outside `0..=255`, or a public-key half that does not match the seed.
   * @see bin/wallet.rs:103-105
   */
  static fromSecretKey(secretKey: Uint8Array | Buffer | readonly number[]): XerisKeypair;
  /**
   * From a 32-byte Ed25519 seed.
   * @throws {TypeError} Not a `Buffer`/`Uint8Array`.
   * @throws {RangeError} Length other than 32.
   */
  static fromSeed(seed: Uint8Array | Buffer): XerisKeypair;
  /**
   * From a JSON file holding an array of 64 integers, the format written by
   * `xrs-wallet keygen` and `keypair_gen` (`bin/wallet.rs:96-105`, `bin/keypair_gen.rs:14-16`).
   * @throws {TypeError} When `path` is not a string.
   * @throws {EncodingError} Not JSON, not exactly 64 integers `0..=255`, or a mismatched public-key half (`.field === 'keypairFile'`). File-system errors propagate unchanged.
   */
  static fromJsonFile(path: string): XerisKeypair;
  /** The address: base58 public key. */
  readonly publicKey: string;
  /** A 32-byte copy of the raw public key. */
  readonly publicKeyBytes: Buffer;
  /** The wrapped `@solana/web3.js` `Keypair`. */
  readonly solanaKeypair: Keypair;
  /** A 64-byte copy of the secret key (seed ‖ public key). */
  readonly secretKey: Uint8Array;
  /** The secret key as the JSON file shape: 64 integers `0..=255`. */
  toJsonBytes(): number[];
  /**
   * Writes the keypair as a JSON array of 64 integers. `mode` applies when the
   * file is created (default `0o600`, as `bin/keypair_gen.rs:24-32`); an
   * existing file keeps its permissions.
   * @throws {TypeError} When `path` is not a string or `mode` is not an integer.
   * @throws {RangeError} When `mode` is outside `0..=0o7777`.
   */
  saveToFile(path: string, opts?: { mode?: number }): void;
  /**
   * Detached Ed25519 signature (64 bytes) over the raw `message`, byte-identical
   * to web3.js signing; what the node verifies for channel co-signatures
   * (`contracts.rs:57-109`) and `HardwareAttest` proofs (`ledger.rs:5299-5319`).
   * @throws {TypeError} When `message` is not a `Buffer`/`Uint8Array`.
   */
  sign(message: BytesInput): Buffer;
  /**
   * Verifies a detached Ed25519 signature.
   * @param publicKey Canonical base58 address or 32 raw bytes.
   * @throws {TypeError} Wrong types.
   * @throws {EncodingError} When a string `publicKey` is not canonical base58.
   * @throws {RangeError} When a byte `publicKey` is not 32 bytes or `signature` is not 64 bytes.
   */
  static verify(publicKey: string | Uint8Array | Buffer, message: BytesInput, signature: BytesInput): boolean;
  /** JSON form without secret material. */
  toJSON(): { publicKey: string };
}

/**
 * `true` only when `s` is base58 decoding to exactly 32 bytes whose
 * re-encoding equals `s` (the node's round-trip rule, `ledger.rs:1569-1577`).
 * Does not check the `__` reserved prefix; see `checks.transferTarget`.
 */
export function isCanonicalPubkey(s: string): boolean;

/**
 * The 32 raw bytes of a canonical base58 public key.
 * @throws {EncodingError} When `!isCanonicalPubkey(s)` (`.field === 'pubkey'`).
 */
export function pubkeyBytes(s: string): Buffer;

// ---------------------------------------------------------------------------
// Transaction assembly (src/transaction.js)
// ---------------------------------------------------------------------------

/** Result of `assembleSignedTransaction`. */
export interface SignedTransactionBytes {
  /** Serialized signed transaction (`bincode::serialize(&Transaction)` layout). */
  txBytes: Buffer;
  /** `txBytes` as standard base64 with padding: the `tx_base64` body value. */
  txBase64: string;
  /** base58 first signature: the node's transaction id. */
  signature: string;
}

/**
 * Success body of a write route (`status` means mempool admission, not
 * confirmation; poll `XerisClient.waitForConfirmation`):
 * - `POST /submit`: `{status:'ok', signature}`; a `ValidatorAttestation` adds
 *   `attestation_accepted: true, reward: 10000000, reward_xrs: 0.01` (`network.rs:4847-4856`).
 * - `POST /stake`: `{status:'queued', message, staked, pubkey, signature}` (`network.rs:4424-4430`).
 * - `POST /unstake`: `{status:'queued', message, unstaked, unbonding_period_slots: 151200, pubkey, signature}` (`network.rs:4543-4551`).
 * - `POST /pq-register`: `{status:'queued', message, ed25519_pubkey, signature}` (`network.rs:4650-4654`).
 */
export interface SubmitResult {
  status: 'ok' | 'queued';
  /** base58 first signature. */
  signature: string;
  message?: string;
  attestation_accepted?: true;
  /** lamports */
  reward?: number;
  reward_xrs?: number;
  /** lamports */
  staked?: number;
  /** lamports */
  unstaked?: number;
  unbonding_period_slots?: number;
  pubkey?: string;
  ed25519_pubkey?: string;
}

/**
 * Decodes the node's 64-character hex block hash (JSON-RPC `getLatestBlockhash`,
 * `explorer.rs:1489-1500`) to the 32 raw bytes a transaction carries.
 * @throws {TypeError} When `hex` is not a string.
 * @throws {EncodingError} `'blockhash: expected 64 hex characters'`.
 */
export function blockhashFromHex(hex: string): Buffer;

/**
 * Checks encoded instruction data against the node's stateless ingress rules
 * and returns its variant index: a readable `u32le` variant `< INSTRUCTION_COUNT`
 * (`network.rs:183-187`), not a disabled variant, and at most `MAX_IX_DATA_SIZE`
 * bytes (`MAX_SLASH_IX_DATA_SIZE` for variant 38; `network.rs:168-179`,
 * `ledger.rs:93, 119`).
 * @param index Position in the transaction, used only in error messages.
 * @throws {TypeError} When `data` is not a `Buffer`/`Uint8Array`, or `index` is not a non-negative integer.
 * @throws {EncodingError} When `data` is shorter than 4 bytes or the variant is `>= INSTRUCTION_COUNT`.
 * @throws {FeatureDisabledError} For variants 22, 48, 49 and 52.
 * @throws {RangeError} When `data` exceeds the size cap for its variant.
 */
export function assertInstructionSubmittable(data: BytesInput, index?: number): number;

/**
 * Builds an unsigned legacy `Transaction`: one `TransactionInstruction` per
 * instruction with `keys = [{pubkey: payer, isSigner: true, isWritable: true}]`
 * and a zero `programId` (never read by the node, `ledger.rs:8922-8924`;
 * `bin/wallet.rs:181, 519`), `feePayer = payer`, `recentBlockhash = bs58(bytes)`.
 * Instructions execute in order without atomicity (`ledger.rs:5557-5570`).
 * @param instructions One encoded instruction or 1..`MAX_IX_PER_TX`; each passes `assertInstructionSubmittable`.
 * @param recentBlockhash 32 raw bytes (from `blockhashFromHex`).
 * @throws {TypeError} Wrong types.
 * @throws {RangeError} Non-canonical payer, 0 or more than 16 instructions, blockhash not 32 bytes, oversize instruction.
 * @throws {EncodingError|FeatureDisabledError} From `assertInstructionSubmittable`.
 */
export function buildTransaction(payerPubkey: string, instructions: BytesInput | readonly BytesInput[], recentBlockhash: BytesInput): Transaction;

/**
 * Signs `tx` in place with `keypair.solanaKeypair` and returns it.
 * @throws {TypeError} When `tx` is not a legacy `Transaction` or `keypair` is not a `XerisKeypair`.
 */
export function signTransaction(tx: Transaction, keypair: XerisKeypair): Transaction;

/**
 * `tx.serialize()`: the bytes the node decodes with `bincode` (`network.rs:4668-4675`).
 * @throws {TypeError} When `tx` is not a legacy `Transaction`.
 * @throws {RangeError} When the result exceeds `MAX_TX_BYTES` (`tx_pool.rs:183`).
 */
export function serializeTransaction(tx: Transaction): Buffer;

/**
 * base58 of `txBytes[1..65]`, the first (only) signature.
 * @throws {TypeError} When `txBytes` is not a `Buffer`/`Uint8Array`.
 * @throws {EncodingError} When `txBytes[0] !== 1` or the buffer is shorter than 65 bytes.
 */
export function signatureOf(txBytes: BytesInput): string;

/**
 * `buildTransaction` → `signTransaction` → `serializeTransaction` → `signatureOf`.
 * @throws {TypeError|RangeError|EncodingError|FeatureDisabledError} As the four steps.
 */
export function assembleSignedTransaction(keypair: XerisKeypair, instructions: BytesInput | readonly BytesInput[], recentBlockhash: BytesInput): SignedTransactionBytes;

/**
 * Turns a write-route JSON body into a `SubmitResult`, or throws `RpcError`
 * when it carries a string `error` (every handler replies HTTP 200 on failure,
 * `network.rs:4336-4432, 4440-4552, 4571-4655, 4664-4858`). `RpcError.nodeStatus`
 * carries `body.status` (`rejected_underfunded_quota`, `rejected_mempool_full`,
 * `rejected_not_admitted`) and `.hint` carries `body.hint`.
 * @param route Recorded on the error, e.g. `'POST /submit'`.
 * @throws {TypeError} When `route` is not a string or `httpStatus` is not an integer (when given).
 * @throws {RpcError} With `.message = body.error`; also when `body` is not a JSON object.
 */
export function parseSubmitResponse(body: unknown, route?: string | null, httpStatus?: number | null): SubmitResult;

// ---------------------------------------------------------------------------
// Node response shapes
// ---------------------------------------------------------------------------
// Field names are the node's JSON keys verbatim. `u64` values arrive as JSON
// numbers and are typed `number`; values above 2^53-1 lose precision in
// `JSON.parse` regardless of this file.

/** JSON-RPC `getLatestBlockhash` (`explorer.rs:1489-1500`), as returned by `XerisClient.getLatestBlockhashInfo`. */
export interface BlockhashInfo {
  slot: number;
  /** 64 lowercase hex characters; decode with `blockhashFromHex`. */
  blockhash: string;
  /** `slot + BLOCKHASH_EXPIRY_WINDOW`. */
  lastValidBlockHeight: number;
}

/** `{success: true, data}` envelope of the explorer's single-object routes. */
export interface ApiResponse<T> {
  success: true;
  data: T;
}

/** Numbered-page metadata (`explorer.rs:39-45`). */
export interface Pagination {
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

/** Numbered page (`explorer.rs:33-37`); `page_size` is clamped to `1..=LIST_MAX_PAGE_SIZE` by the node. */
export interface Paginated<T> {
  success: true;
  data: T[];
  pagination: Pagination;
}

/** `after`/`limit` query of the cursor-paged registry routes (`explorer.rs:120-124`). */
export interface CursorOptions {
  /** Key of the last row of the previous page (`next_after`). */
  after?: string;
  /** Rows per page; the node clamps to `1..=REGISTRY_PAGE_ITEMS`. */
  limit?: number;
}

/**
 * Cursor page (`explorer.rs:1646-1840, 1970-2120`): `count` is the total before
 * paging, `next_after` is `null` on the last page, and the rows sit under
 * the key `K` the route uses (`data`, `tokens`, `contracts`, `pools`).
 */
export type CursorPage<T, K extends string> = { success: true; count: number; next_after: string | null } & { [P in K]: T[] };

/**
 * One registry view of `GET /v2/contract/{id}` (`explorer.rs:1849-1958`):
 * numbered page of at most 32 rows under the key `K` (`models`, `listings`,
 * `devices`, `heartbeats`).
 */
export type RegistryPage<T, K extends string> = { success: true; contract_id: string; page: number; page_size: number } & { [P in K]: T[] };

/** `GET /v2/stats` (`explorer.rs:47-56, 965-1011`). */
export interface NetworkStats {
  block_height: number;
  current_slot: number;
  total_transactions: number;
  total_accounts: number;
  /** lamports */
  total_staked: number;
  validator_count: number;
  tps_estimate: number;
}

/** Row of `GET /v2/blocks` (`explorer.rs:58-65`). */
export interface BlockSummary {
  slot: number;
  /** hex */
  hash: string;
  proposer: string;
  tx_count: number;
  /** milliseconds */
  poh_timestamp: number;
}

/** `GET /v2/block/slot/{slot}` and `/v2/block/hash/{hash}` (`explorer.rs:67-77`). Transactions carry `status: 'included'` (block membership only). */
export interface BlockDetail {
  slot: number;
  /** hex */
  hash: string;
  nonce: number;
  proposer: string;
  /** milliseconds */
  poh_timestamp: number;
  /** hex */
  merkle_root: string;
  transaction_count: number;
  transactions: TransactionSummary[];
}

/** Row of `GET /v2/transactions`, `/v2/block/*` and `/v2/account/{addr}/transactions` (`explorer.rs:79-92`). */
export interface TransactionSummary {
  signature: string;
  block_slot: number;
  from: string;
  to: string;
  /** lamports or token base units, per `tx_type` */
  amount: number;
  amount_xrs: number;
  status: TxStatus;
  /** Instruction kind; account history prefixes it with `sent:` / `received:`. */
  tx_type: string;
  /** Decoded extra fields (`token_id`, `contract_id`, `method`, ...); absent for plain transfers. */
  details?: Record<string, unknown> | null;
}

/** Per-instruction outcome in `TxDetail.instructions` (`explorer.rs:1215-1219`). */
export interface InstructionOutcome {
  index: number;
  status: 'confirmed' | 'failed';
}

/** `GET /v2/tx/{signature}` (`explorer.rs:1221-1238`); what `waitForConfirmation` resolves with. */
export interface TxDetail {
  signature: string;
  block_slot: number;
  /** hex */
  block_hash: string;
  /** milliseconds */
  poh_timestamp: number;
  from: string;
  to: string;
  amount: number;
  amount_xrs: number;
  tx_type: string;
  details: Record<string, unknown> | null;
  /** `confirmed` only when every instruction committed; `partial` for a mixed outcome (`explorer.rs:680-690`). */
  status: TxStatus;
  /** Empty when the node has no receipt for the transaction. */
  instructions: InstructionOutcome[];
  /** `current_slot - block_slot` */
  confirmations: number;
}

/** `GET /v2/account/{address}` (`explorer.rs:94-102`); never 404s, unknown addresses read as zero. */
export interface AccountInfo {
  address: string;
  /** lamports */
  balance: number;
  balance_xrs: number;
  /** lamports */
  stake: number;
  is_validator: boolean;
  blocks_proposed: number;
}

/** `GET /v2/account/{address}/transactions` (`explorer.rs:1287-1375`). Pass `cursor` back as `before` for the next page. */
export interface AccountTransactions extends Paginated<TransactionSummary> {
  cursor: number | null;
}

/** Query of `XerisClient.getAccountTransactions`; `page` is capped at `ACCOUNT_HISTORY_MAX_PAGE`, `pageSize` at `ACCOUNT_HISTORY_MAX_PAGE_SIZE`. */
export interface AccountTransactionsOptions {
  page?: number;
  pageSize?: number;
  /** `cursor` of the previous response. */
  before?: number;
}

/** Row of `GET /v2/validators` (`explorer.rs:104-109`). */
export interface ValidatorInfo {
  address: string;
  /** lamports */
  stake: number;
  stake_percentage: number;
  blocks_proposed: number;
}

/** `GET /v2/validators` (`explorer.rs:1377-1410`). */
export interface ValidatorsResponse {
  success: true;
  data: ValidatorInfo[];
  /** lamports */
  total_staked: number;
  total_staked_xrs: number;
  validator_count: number;
}

/** `GET /v2/search?q=` (`explorer.rs:763-832`); `Not found` is raised as `RpcError`. */
export type SearchResult =
  | { success: true; result_type: 'block'; data: { slot: number; hash: string } }
  | { success: true; result_type: 'transaction'; data: { signature: string; block_slot: number } }
  | { success: true; result_type: 'account' | 'validator'; data: { address: string } };

/** `MintPolicy` (`token.rs:825-833`): `LaunchpadManaged` tokens reject ordinary `TokenMint`. */
export type MintPolicy = 'Standard' | 'LaunchpadManaged';

/** `RWAMetadata` (`token.rs:855-880`). */
export interface RwaMetadata {
  asset_type: string;
  legal_doc_hash: string;
  legal_doc_uri: string;
  jurisdiction: string;
  status: string;
  transfer_restricted: boolean;
  accredited_only: boolean;
  /** USD cents */
  valuation: number;
  approved_holders: string[];
  /** `[slot, old_status, new_status]`; `GET /v2/tokens` truncates to 256 entries and adds `status_history_total`. */
  status_history: Array<[number, string, string]>;
  status_history_total?: number;
}

/** `TokenInfo` (`token.rs:835-852`). */
export interface TokenInfo {
  token_id: string;
  name: string;
  symbol: string;
  decimals: number;
  /** base units */
  max_supply: number;
  /** base units */
  current_supply: number;
  mint_authority: string;
  created_slot: number;
  rwa_metadata: RwaMetadata | null;
  mint_policy: MintPolicy;
}

/** `GET /token/balance/{address}/{tokenId}` (`network.rs:4903-4913`). */
export interface TokenBalance {
  address: string;
  token_id: string;
  /** base units */
  balance: number;
  token_info: TokenInfo | null;
}

/** Row of `TokenAccounts.token_accounts` (`network.rs:5197-5203`). */
export interface TokenAccount {
  token_id: string;
  symbol: string;
  /** base units */
  balance: number;
  balance_display: number;
  decimals: number;
}

/** `GET /token/accounts/{address}` (`network.rs:5186-5211`). */
export interface TokenAccounts {
  address: string;
  /** lamports, despite the name */
  native_xrs: number;
  token_accounts: TokenAccount[];
}

/** Row of `GET /v2/token/{id}/holders` and `GET /v2/rwa/{id}` (`explorer.rs:197`). */
export interface HolderRow {
  address: string;
  /** base units */
  balance: number;
}

/** `GET /v2/token/{id}/holders` (`explorer.rs:1681-1712`). */
export interface TokenHolders {
  success: true;
  token_id: string;
  holder_count: number;
  holders: HolderRow[];
  next_after: string | null;
}

/** Row of `GET /v2/rwa` (`explorer.rs:216-222`). */
export interface RwaListRow {
  token_id: string;
  name: string;
  symbol: string;
  decimals: number;
  max_supply: number;
  current_supply: number;
  /** the token's `mint_authority` */
  issuer: string;
  created_slot: number;
  asset_type: string;
  jurisdiction: string;
  status: string;
  transfer_restricted: boolean;
  accredited_only: boolean;
  valuation_usd_cents: number;
  legal_doc_hash: string;
  legal_doc_uri: string;
  approved_holder_count: number;
}

/** `GET /v2/rwa/{id}` (`explorer.rs:1743-1805`). */
export interface RwaDetail {
  success: true;
  token: Pick<RwaListRow, 'token_id' | 'name' | 'symbol' | 'decimals' | 'max_supply' | 'current_supply' | 'issuer' | 'created_slot'>;
  rwa: Pick<RwaListRow, 'asset_type' | 'jurisdiction' | 'status' | 'legal_doc_hash' | 'legal_doc_uri' | 'transfer_restricted' | 'accredited_only' | 'valuation_usd_cents'> & {
    approved_holders: string[];
    /** newest-last, at most 256 entries */
    status_history: Array<[number, string, string]>;
    status_history_total: number;
  };
  /** The `RealWorldAsset` contract bound to the token, when one exists. */
  contract: { contract_id: string; is_active: boolean; created_slot: number } | null;
  holders: HolderRow[];
  holder_count: number;
  next_after: string | null;
}

/** Row of `GET /contracts` (`network.rs:5033-5039`) and `GET /v2/contracts` (`explorer.rs:199-206`). */
export interface ContractListRow {
  contract_id: string;
  /** `ContractType` enum name */
  type: ContractTypeName;
  owner: string;
  is_active: boolean;
  created_slot: number;
}

/** `GET /contracts` (`network.rs:5029-5045`). */
export interface ContractsResponse {
  success: true;
  count: number;
  contracts: ContractListRow[];
}

/** `ContractState::Swap` fields read by the SDK (`contracts.rs:414-460`; `explorer.rs:2000-2016`). Other fields pass through. */
export interface SwapPoolState {
  token_a: string;
  token_b: string;
  /** base units */
  reserve_a: number;
  /** base units */
  reserve_b: number;
  fee_bps: number;
  total_shares: number;
  lp_shares: Record<string, number>;
  [field: string]: unknown;
}

/**
 * `ContractState` as serde serialises it: a single-key object whose key is the
 * variant name (`TimeLock`, `Escrow`, `Swap`, `Vesting`, `MultiSig`,
 * `RealWorldAsset`, `Launchpad`, `AgentRegistry`, `Identity`,
 * `ConditionalOrders`, `LimitOrder`, `DcaOrder`, `Oracles`, `Devices`,
 * `Capabilities`, `Tasks`, `Models`, `Disputes`, `Deals`, `GovernanceState`,
 * `Channels`, `Heartbeats`, `ZkVerifier`, `PqKeys`; `contracts.rs:412-706`).
 */
export interface ContractStateMap {
  Swap?: SwapPoolState;
  [variant: string]: Record<string, unknown> | undefined;
}

/** `Contract` (`contracts.rs:805-812`), the `contract` of `GET /contract/{id}` and `GET /v2/contract/{id}`. */
export interface ContractDetail {
  contract_id: string;
  contract_type: ContractTypeName;
  owner: string;
  created_slot: number;
  state: ContractStateMap;
  is_active: boolean;
}

/** `GET /contract/{id}` (`network.rs:5018-5026`); not found → `RpcError('Contract not found')`. */
export interface ContractResponse {
  success: true;
  contract: ContractDetail;
}

/** `get_swap_quote` (`contracts.rs`, via `GET /contract/{id}/quote`, `network.rs:5048-5066`). */
export interface SwapQuote {
  input_token: string;
  /** base units */
  input_amount: number;
  output_token: string;
  /** base units */
  output_amount: number;
  /** base units of the input token */
  fee: number;
  fee_bps: number;
  /** formatted with two decimals */
  price_impact_pct: string;
  effective_price: number;
}

/** `GET /contract/{id}/quote` (`network.rs:5048-5066`). */
export interface SwapQuoteResponse {
  success: true;
  quote: SwapQuote;
}

/**
 * `GET /contract/{id}/vesting/{wallet}` (`network.rs:5070-5109`; `contracts.rs:3215-3300`).
 * Every deployable launchpad answers `{enabled: false}` because
 * `vesting_enabled: true` is refused at deploy (`contracts.rs:1666-1668`).
 */
export interface VestingStatus {
  success: true;
  vesting:
    | { enabled: false }
    | {
        enabled: true;
        cliff_ends_at?: number;
        cliff_remaining_seconds?: number;
        total_purchased: number;
        total_unlocked?: number;
        total_sold?: number;
        available_to_sell: number;
        max_per_tx?: number;
        daily_unlock_pct?: number;
        max_sell_pct?: number;
        fully_vested_at?: number;
      };
}

/** Row of `GET /launchpads` (`network.rs:5236-5260`). */
export interface LaunchpadInfo {
  contract_id: string;
  token_id: string;
  name: string;
  symbol: string;
  image_url: string;
  description: string;
  creator: string;
  total_supply: number;
  tokens_sold: number;
  tokens_remaining: number;
  /** lamports */
  xrs_collected: number;
  /** lamports */
  target_liquidity_xrs: number;
  current_price_lamports: number;
  market_cap_xrs_lamports: number;
  progress_pct: number;
  creator_reward_bps: number;
  xeris_fee_bps: 77;
  total_fee_bps: number;
  creator_rewards_accrued: number;
  xeris_fees_accrued: number;
  finalized: boolean;
  dex_pool_id: string;
  created_slot: number;
  trade_count: number;
}

/** `GET /launchpads` (`network.rs:5215-5271`), newest first. */
export interface LaunchpadsResponse {
  launchpads: LaunchpadInfo[];
}

/** `GET /launchpad/{id}/quote?xrs_amount=` (`network.rs:5274-5327`). */
export interface LaunchpadQuote {
  /** lamports */
  xrs_amount: number;
  /** base units */
  tokens_out: number;
  /** lamports */
  creator_fee: number;
  /** lamports */
  xeris_fee: number;
  /** lamports */
  total_fees: number;
  effective_price: number;
  price_after: number;
  price_impact_pct: number;
}

/** `AgentEntry` (`contracts.rs:1267-1298`). */
export interface AgentEntry {
  agent_pubkey: string;
  agent_name: string;
  owner: string;
  /** lamports */
  max_per_tx: number;
  /** lamports per `AGENT_DAILY_WINDOW_SLOTS` */
  max_daily: number;
  /** empty = all */
  allowed_contracts: string[];
  /** empty = all; entries are `AgentOperation` strings */
  allowed_operations: string[];
  /** 0 = never */
  expires_at_slot: number;
  revoked: boolean;
  created_slot: number;
  daily_spent: number;
  daily_window_start: number;
  total_txs: number;
  total_spent: number;
}

/** `GET /agent/registry/{owner}` (`network.rs:5332-5355`); an owner without a registry gets `agent_count: 0`. */
export interface AgentRegistry {
  owner: string;
  registry_id: string;
  agent_count: number;
  agents: AgentEntry[];
}

/** `GET /agent/validate/{agent}/{owner}` (`network.rs:5358-5383`); an unknown agent is raised as `RpcError('Agent not found in registry')`. */
export interface AgentValidation {
  authorized: boolean;
  revoked: boolean;
  expired: boolean;
  agent: AgentEntry;
}

/** Request bodies of `POST /agent/plan` (`network.rs:5386-5577`). `amount_xrs` is parsed as `f64` and truncated to lamports. */
export type AgentPlanRequest =
  | { action: 'transfer' | 'send'; from: string; to: string; amount_xrs: number }
  | { action: 'swap'; pool_id: string; token_in: string; amount_in: number; slippage_pct?: number }
  | { action: 'buy_launchpad' | 'buy'; launchpad_id: string; xrs_amount: number; slippage_pct?: number }
  | { action: 'stake'; pubkey: string; amount_xrs: number }
  | { action: 'wrap' | 'unwrap'; amount_xrs: number };

/** `POST /agent/plan` for `transfer` (`network.rs:5396-5416`). */
export interface TransferPlan {
  action: 'transfer';
  variant_index: 11;
  variant_name: 'NativeTransfer';
  params: { from: string; to: string; amount: number };
  amount_xrs: number;
  fee: number;
  fee_xrs: number;
  sender_balance: number;
  sufficient_balance: boolean;
}

/** `POST /agent/plan` for `swap` (`network.rs:5417-5497`); `params.args` is the 16-byte swap payload as a byte array. */
export interface SwapPlan {
  action: 'swap';
  variant_index: 4;
  variant_name: 'ContractCall';
  params: { contract_id: string; method: SwapMethod; args: number[] };
  quote: { amount_out: number; min_amount_out: number; fee: number; slippage_pct: number; price_impact_pct: number };
  pool: { token_a: string; token_b: string; reserve_a: number; reserve_b: number };
}

/** `POST /agent/plan` for `buy_launchpad` (`network.rs:5498-5534`). */
export interface BuyLaunchpadPlan {
  action: 'buy_launchpad';
  variant_index: 4;
  variant_name: 'ContractCall';
  params: { contract_id: string; method: 'buy_tokens'; args: { xrs_amount: number; min_tokens_out: number } };
  quote: { tokens_out: number; min_tokens_out: number; creator_fee: number; xeris_fee: number; slippage_pct: number };
}

/** `POST /agent/plan` for `stake` (`network.rs:5535-5545`). */
export interface StakePlan {
  action: 'stake';
  variant_index: 9;
  variant_name: 'Stake';
  params: { pubkey: string; amount: number };
  amount_xrs: number;
  min_stake_xrs: number;
}

/** `POST /agent/plan` for `wrap` (`network.rs:5546-5556`). */
export interface WrapPlan {
  action: 'wrap';
  variant_index: 13;
  variant_name: 'WrapXrs';
  params: { amount: number };
  amount_xrs: number;
}

/** `POST /agent/plan` for `unwrap` (`network.rs:5557-5567`). */
export interface UnwrapPlan {
  action: 'unwrap';
  variant_index: 14;
  variant_name: 'UnwrapXrs';
  params: { amount: number };
  amount_xrs: number;
}

/** A `POST /agent/plan` success body; convert with `fromPlan`. Unknown actions and lookup failures are raised as `RpcError`. */
export type AgentPlan = TransferPlan | SwapPlan | BuyLaunchpadPlan | StakePlan | WrapPlan | UnwrapPlan;

/** `CapabilityListing` (`contracts.rs:805-818`). */
export interface CapabilityListing {
  provider_identity: string;
  category: string;
  tags: string[];
  region: string;
  description: string;
  /** lamports */
  price_per_unit: number;
  max_concurrent: number;
  current_tasks: number;
  metadata_json: string;
  created_slot: number;
  active: boolean;
  reputation_snapshot: number;
}

/** Query of `GET /capabilities/search` (`network.rs:5583-5615`); `tags` are joined with `,`. */
export interface CapabilitySearchParams {
  category?: string;
  tags?: readonly string[];
  /** listings with `region === 'global'` always match */
  region?: string;
  minRep?: number;
  /** lamports; listings priced `0` always match */
  maxPrice?: U64Input;
  /** node default 50 */
  limit?: number;
}

/** `GET /capabilities/search` (`network.rs:5583-5615`). */
export interface CapabilitySearchResponse {
  success: true;
  data: CapabilityListing[];
}

/** `GET /capabilities` (`network.rs:5619-5632`). */
export interface CapabilitiesResponse {
  success: true;
  count: number;
  data: CapabilityListing[];
}

/** `TaskEntry.status` values (`contracts.rs:890-891`). */
export type TaskStatus = 'open' | 'claimed' | 'completed' | 'verified' | 'rejected' | 'disputed' | 'cancelled' | 'expired';

/** `TaskEntry` (`contracts.rs:864-907`). */
export interface TaskEntry {
  task_id: string;
  poster: string;
  title: string;
  description: string;
  required_category: string;
  required_tags: string[];
  min_reputation: number;
  /** lamports, immutable display value */
  reward: number;
  /** lamports still escrowed */
  escrow_remaining: number;
  expires_at_slot: number;
  max_claimants: number;
  verification: string;
  verification_oracle: string;
  verification_threshold: number;
  created_slot: number;
  claimants: string[];
  status: TaskStatus;
  completion_proof: string;
  completed_by: string;
  rejection_reason: string;
  rejections: number;
}

/** `GET /tasks` (`network.rs:5640-5659`): tasks with status `open` or `claimed`. The totals are absent when the task board is not deployed. */
export interface TasksResponse {
  success: true;
  open_tasks: number;
  total_posted?: number;
  total_completed?: number;
  total_rewards_paid_xrs?: number;
  data: TaskEntry[];
}

/** `ZkProofRecord` (`contracts.rs:1175-1189`). */
export interface ZkProofRecord {
  proof_id: string;
  submitter: string;
  proof_system: string;
  proof_data_hash: string;
  public_inputs_hash: string;
  verification_key_hash: string;
  proof_type: string;
  metadata_json: string;
  submitted_slot: number;
  verified: boolean;
  verification_slot: number;
  proof_size: number;
}

/** `GET /zk/proofs/{identity}` (`network.rs:5912-5923`). */
export interface ZkProofsResponse {
  success: true;
  count: number;
  proofs: ZkProofRecord[];
}

/** `GET /zk/stats` (`network.rs:5942-5954`); the two optional fields are absent when the verifier registry is not deployed. */
export interface ZkStats {
  total_proofs: number;
  total_verified: number;
  verification_keys?: number;
  nullifiers_used?: number;
}

/** `GET /pq/keys/{address}` (`network.rs:5958-5974`). */
export interface PqKeyInfo {
  success: true;
  has_pq_key: boolean;
  algorithm?: string;
  security_level?: number;
  /** hex SHA-256 of the registered public key */
  key_hash?: string;
  registered_slot?: number;
  rotation_count?: number;
  active?: boolean;
}

/** `GET /pq/status` (`network.rs:5978-6001`); optional fields are absent when the registry is not deployed. */
export interface PqStatus {
  total_registered: number;
  total_rotations?: number;
  total_pq_transactions?: number;
  algorithms?: Record<string, number>;
  quantum_ready_pct: number;
}

/** Row of `GET /governance/proposals` (`network.rs:5745-5783`). */
export interface GovernanceProposal {
  id: string;
  title: string;
  description: string;
  discussion_url: null;
  proposer: string;
  status: 'Active' | 'Passed' | 'Failed' | 'Executed';
  /** lamports of voting weight */
  votes_for: number;
  votes_against: number;
  quorum: number;
  /** `voting_end_slot * 4000` */
  expiry_timestamp: number;
  action: { type: string; params: Record<string, never> };
  /** `created_slot * 4000` */
  created_at: number;
}

/** `GET /governance/proposals` (`network.rs:5745-5783`). */
export interface GovernanceProposals {
  proposals: GovernanceProposal[];
  total_proposals: number;
  total_executed: number;
}

/** `GET /governance/lock/{address}` (`network.rs:5821-5833`). No instruction writes these values. */
export interface GovernanceLock {
  address: string;
  /** lamports */
  locked_amount: number;
  locked_xrs: number;
  delegate: string | null;
}

/** One `price_history_{pool}.json` entry (`GET /price-history`, `network.rs:6026-6075`). */
export interface PriceSnapshot {
  slot: number;
  timestamp_ms: number;
  price: number;
  tvl: number;
  token_a: string;
  token_b: string;
  total_fees_lamports: number;
}

/** `GET /price-history?pool_id=&limit=` (`network.rs:6026-6075`). */
export interface PriceHistory {
  /** `token_a/token_b` of the first entry */
  pair: string;
  count: number;
  history: PriceSnapshot[];
}

/** `GET /pools/price-history` (`network.rs:6079-6106`): the last 100 entries per pool. */
export interface AllPoolPriceHistory {
  pools: Record<string, { history: PriceSnapshot[]; count: number }>;
}

/** Row of `GET /v2/pools` (`explorer.rs:2094-2109`). */
export interface PoolRow {
  pool_id: string;
  token_a: string;
  token_b: string;
  reserve_a: number;
  reserve_b: number;
  fee_bps: number;
  total_lp_shares: number;
  lp_holder_count: number;
  /** formatted with eight decimals */
  price_a_in_b: string;
  /** formatted with eight decimals */
  price_b_in_a: string;
  is_active: boolean;
  total_value_locked: number;
  volume_24h: number;
  apr: number;
}

/** `GET /stake/{address}` (`network.rs:4866-4899`). */
export interface StakeInfo {
  address: string;
  /** lamports */
  stake: number;
  stake_xrs: number;
  isValidator: boolean;
  blocksProposed: number;
  staking_apy_pct: number;
  earns_staking_rewards: boolean;
  estimated_hourly_reward_lamports: number;
  estimated_hourly_reward_xrs: number;
  estimated_annual_reward_xrs: number;
  min_stake_for_rewards_xrs: number;
}

/** Row of `UnstakingInfo.sessions` (`network.rs:5689-5696`); `*_time` are `slot * 4`, not epoch seconds. */
export interface UnstakingSession {
  id: string;
  /** lamports */
  amount: number;
  start_time: number;
  end_time: number;
  start_slot: number;
  unlock_time: number;
}

/** `GET /account/{address}/unstaking` (`network.rs:5683-5703`). */
export interface UnstakingInfo {
  address: string;
  count: number;
  sessions: UnstakingSession[];
}

/** `GET /network/economics` (`network.rs:5147-5183`). */
export interface NetworkEconomics {
  total_mined_lamports: number;
  total_mined_xrs: number;
  emission_cap_xrs: number;
  remaining_emission_xrs: number;
  emission_pct_complete: number;
  current_block_reward_xrs: number;
  halving_epoch: number;
  next_halving_slot: number;
  fee_activation_slot: number;
  fees_active: boolean;
  base_tx_fee_lamports: number;
  base_tx_fee_xrs: number;
  total_fees_collected_lamports: number;
  total_fees_collected_xrs: number;
  chain_height: number;
  staking_apy_pct: number;
  staking_reward_interval_blocks: number;
  total_staked_lamports: number;
  total_staked_xrs: number;
  num_eligible_stakers: number;
  min_stake_for_rewards_xrs: number;
}

/** Raw `Block` of `GET /blocks` (`ledger.rs:294-331`): hashes are JSON byte arrays, not hex. */
export interface LedgerBlock {
  slot: number;
  hash: number[];
  nonce: number;
  /** serde form of `solana_sdk::transaction::Transaction` */
  transactions: unknown[];
  merkle_root: number[];
  proposer: string;
  /** milliseconds */
  poh_timestamp: number;
  previous_hash: number[];
  poh_hash: number[];
  proposer_sig: number[];
  hybrid_proposer_sig: unknown | null;
  proposer_dilithium3_pk: number[];
}

/** `ModelEntry` (`contracts.rs`), rows of the `ModelRegistry` view of `GET /v2/contract/xeris_models`. */
export interface ModelEntry {
  identity_pubkey: string;
  model_name: string;
  model_hash: string;
  model_version: string;
  framework: string;
  capabilities_json: string;
  model_size_bytes: number;
  execution_environment: string;
  registered_slot: number;
  retired: boolean;
  attestation_count: number;
}

/** `DeviceEntry` (`contracts.rs`), rows of the `DeviceRegistry` view of `GET /v2/contract/xeris_devices`. */
export interface DeviceEntry {
  device_pubkey: string;
  device_type: string;
  manufacturer: string;
  model: string;
  firmware_version: string;
  bound_identity: string;
  registered_slot: number;
  last_attestation_slot: number;
  attestation_count: number;
  active: boolean;
}

/** `HeartbeatRecord` (`contracts.rs`), rows of the `HeartbeatRegistry` view of `GET /v2/contract/xeris_heartbeats`. */
export interface HeartbeatRecord {
  identity_pubkey: string;
  last_heartbeat_slot: number;
  current_model_hash: string;
  active_tasks: number;
  available_capacity: number;
  status_message: string;
  total_heartbeats: number;
}

/** `GET /v2/contract/{id}` for `xeris_models` (`explorer.rs:1849-1884`). */
export type ModelRegistryPage = RegistryPage<ModelEntry, 'models'> & { type: 'ModelRegistry'; model_count: number };
/** `GET /v2/contract/{id}` for `xeris_capabilities` (`explorer.rs:1885-1913`). */
export type CapabilityRegistryPage = RegistryPage<CapabilityListing, 'listings'> & { type: 'CapabilityRegistry'; active_listing_count: number };
/** `GET /v2/contract/{id}` for `xeris_devices` (`explorer.rs:1914-1936`). */
export type DeviceRegistryPage = RegistryPage<DeviceEntry, 'devices'> & { type: 'DeviceRegistry'; active_device_count: number };
/** `GET /v2/contract/{id}` for `xeris_heartbeats` (`explorer.rs:1937-1958`). */
export type HeartbeatRegistryPage = RegistryPage<HeartbeatRecord, 'heartbeats'> & { type: 'HeartbeatRegistry'; alive_count: number };

/** `GET /v2/contract/{id}` (`explorer.rs:1843-1967`): a registry page for the four paged registries, else `{success, contract}`. */
export type ContractV2Response = ModelRegistryPage | CapabilityRegistryPage | DeviceRegistryPage | HeartbeatRegistryPage | ContractResponse;

/** Query of `XerisClient.getContractV2`; `pageSize` is clamped to `1..=REGISTRY_PAGE_ITEMS` by the node. */
export interface RegistryPageOptions {
  page?: number;
  pageSize?: number;
}

/** JSON-RPC `getAccountInfo` (`explorer.rs:1460-1481`). */
export interface RpcAccountInfo {
  context: { slot: number };
  value: {
    lamports: number;
    owner: 'system';
    executable: false;
    stake: number;
    isValidator: boolean;
  };
}

/** JSON-RPC `getBlock` (`explorer.rs:1502-1517`). */
export interface RpcBlock {
  /** hex */
  blockhash: string;
  parentSlot: number;
  /** seconds */
  blockTime: number;
  blockHeight: number;
  /** a count, not a list */
  transactions: number;
}

/** JSON-RPC `meta.err` / `SignatureInfo.err` (`explorer.rs:694-717`): `null` only when every instruction committed. */
export type RpcTxError = null | 'ExecutionFailed' | 'OutcomeUnknown' | { InstructionError: [number, 'ExecutionFailed'] };

/** JSON-RPC `getTransaction` (`explorer.rs:1519-1536, 1572-1600`). */
export interface RpcTransaction {
  slot: number;
  /** seconds */
  blockTime: number;
  meta: {
    err: RpcTxError;
    /** `BASE_TX_FEE` */
    fee: number;
    /** `null` when no receipt store is available */
    instructionOutcomes: Array<{ index: number; ok: boolean }> | null;
  };
  transaction: {
    signatures: string[];
    from: string;
    to: string;
    amount: number;
    amount_xrs: number;
    tx_type: string;
    details: Record<string, unknown> | null;
  };
}

/** Row of JSON-RPC `getSignaturesForAddress` (`explorer.rs:1604-1628`). */
export interface SignatureInfo {
  signature: string;
  slot: number;
  /** seconds */
  blockTime: number;
  err: RpcTxError;
  from: string;
  to: string;
  amount: number;
  amount_xrs: number;
  tx_type: string;
  type: 'sent' | 'received';
}

/** JSON-RPC `getVersion` (`explorer.rs:1560-1563`): hard-coded literals. */
export interface VersionInfo {
  'solana-core': '1.0.0';
  xeriscoin: '1.0.0';
}

/** `ContractCall` `add_liquidity` arguments (`contracts.rs:2214-2231`); all five required and `> 0`. */
export interface LiquidityArgs {
  amount_a: U64Input;
  amount_b: U64Input;
  min_lp_shares: U64Input;
  min_amount_a: U64Input;
  min_amount_b: U64Input;
}

// ---------------------------------------------------------------------------
// Client options and node business rules (src/client.js)
// ---------------------------------------------------------------------------

/** Options of `XerisClient` (and the client inside `XerisDApp` / `XerisAgent`). */
export interface ClientOptions {
  /** RPC port appended to `host` (default `DEFAULT_RPC_PORT`). */
  rpcPort?: number;
  /** Explorer port appended to `host` (default `DEFAULT_EXPLORER_PORT`). */
  explorerPort?: number;
  /** Full RPC base URL, no trailing slash; overrides `host` + `rpcPort`. */
  rpcUrl?: string;
  /** Full explorer base URL, no trailing slash; overrides `host` + `explorerPort`. */
  explorerUrl?: string;
  /** `fetch` implementation (default `globalThis.fetch`; `XerisError` `code 'config'` when absent). */
  fetch?: FetchLike;
  /** Per-request timeout in milliseconds (default 30000); expiry throws `XerisError` `code 'timeout'`. */
  timeoutMs?: number;
}

/** Options of `XerisAgent`: the `XerisClient` options. */
export type AgentOptions = ClientOptions;

/** Options of `XerisDApp`. */
export interface DAppOptions extends ClientOptions {
  /** Wallet provider to use instead of detecting `window.xeris`. */
  provider?: XerisWalletProvider;
  /** Node base URL with scheme, e.g. `'http://138.197.116.81'`. */
  host?: string;
  /**
   * Fixed SDK default `'testnet'`: when no host can be resolved, testnet falls
   * back to `http://TESTNET_SEED`; `'mainnet'` has no built-in host
   * (`network.rs:282-300`) and needs `host`/`rpcUrl` or `provider.getRpcUrl()`.
   */
  network?: 'testnet' | 'mainnet';
}

/** `opts` of `XerisClient.sendInstruction` and the wrappers that default to a dedicated route. */
export interface SendOptions {
  /** Write route (default `'/submit'`; `stakeXrs` → `'/stake'`, `unstakeXrs` → `'/unstake'`, `pqKeyRegister` → `'/pq-register'`). */
  route?: WriteRoute;
}

/** `opts` of `waitForConfirmation`. */
export interface ConfirmationOptions {
  /** Default `BLOCKHASH_EXPIRY_WINDOW * SLOT_MS` (600000). */
  timeoutMs?: number;
  /** Default `SLOT_MS`. */
  intervalMs?: number;
}

/**
 * Node business rules as pure functions (no I/O). Each returns `undefined`
 * or throws `RangeError` (right type, refused value), `TypeError` (wrong
 * type), `XerisError` or `FeatureDisabledError` as noted. Applied by every
 * `XerisClient` / `XerisDApp` / `XerisAgent` wrapper before any network call.
 */
export interface Checks {
  /** `isCanonicalPubkey(s)` (`ledger.rs:1569-1577`). */
  pubkey(s: string, field?: string): void;
  /** `pubkey(to)` and `to` does not start with `__` (`ledger.rs:1562-1564, 5602`). */
  transferTarget(to: string): void;
  /** `normalizeU64(amount) > 0n`. */
  positive(amount: U64Input, field?: string): void;
  /** `blockHash.length === 32` and `validator === signer` (`ledger.rs:1398-1413`). */
  attestation(blockHash: BytesInput, validator: string, signer: string): void;
  /** `value === signer`. */
  signerIs(value: string, signer: string, field?: string): void;
  /** `list.includes(value)`; the message lists the allowed values. */
  oneOf(value: string, list: readonly string[], field?: string): void;
  /** `Buffer.byteLength(s, 'utf8') <= n` (`STRING_LIMITS`). */
  maxBytes(s: string, n: number, field?: string): void;
  /** Matches `CONTRACT_ID_PATTERN` with no reserved prefix/suffix (`contracts.rs:1316-1320`; `ledger.rs:1524-1530`). */
  contractId(id: string): void;
  /** `CONTRACT_TYPE_ALIASES[s.toLowerCase()]` exists and is not in `PROTOCOL_MANAGED_CONTRACT_TYPES` (`contracts.rs:385-411`; `ledger.rs:2344-2349`). */
  contractType(s: string): void;
  /** `'swap_a_to_b' | 'swap_b_to_a'` (`contracts.rs:2419-2441`). */
  swapMethod(m: string): void;
  /** The five `add_liquidity` fields present and each `> 0` (`contracts.rs:2214-2231`). */
  liquidityArgs(a: LiquidityArgs): void;
  /** Lower-cased `s` contains none of `PQ_CLAIM_TOKENS` (`ledger.rs:5362-5374`). */
  noPqClaim(s: string, field?: string): void;
  /** Key length `PQ_PUBLIC_KEY_LEN`, algorithm `SUPPORTED_PQ_ALGORITHM`, level `PQ_SECURITY_LEVEL` (`crypto.rs:924-976`; `contracts.rs:6168-6215`). */
  pqRegister(pqPublicKey: BytesInput, pqAlgorithm: string, securityLevel: U8Input): void;
  /** New key 1952 bytes, algorithm `'dilithium3'`, proof `PQ_SIGNATURE_LEN` bytes (`ledger.rs:8738-8807`). */
  pqRotate(newPk: BytesInput, algorithm: string, proof: BytesInput): void;
  /** `proofSystem === 'groth16'`, proof <= 512 bytes, inputs a multiple of 32 bytes up to 64 × 32, `noPqClaim` on the strings (`ledger.rs:8566-8573`; `crypto.rs:1041-1098`). */
  groth16(proofSystem: string, proofData: BytesInput, publicInputs: BytesInput, proofType: string, metadataJson: string): void;
  /** Base64 decoding to 1..`MAX_GROTH16_VK_BYTES` bytes (`crypto.rs:1143-1152`). */
  vkBase64(s: string): void;
  /** `bond >= MIN_DEAL_DISPUTE_BOND` (`ledger.rs:7814`). */
  dealBond(bond: U64Input): void;
  /** `!id.startsWith('deal_')` (`ledger.rs:7690`). */
  disputeId(id: string): void;
  /** `MIN_VOTING_PERIOD_SLOTS <= slots <= MAX_VOTING_PERIOD_SLOTS` (`ledger.rs:8267-8272`; `contracts.rs:5527-5530`). */
  votingPeriod(slots: U64Input): void;
  /** `sig.length === 0` when `stateSequence === 0`, else `64` (`contracts.rs:5787-5812`). */
  channelSignature(stateSequence: U64Input, sig: BytesInput): void;
  /** `sig.length === 64` (`ledger.rs:8332-8388, 7244`). */
  ed25519Signature(sig: BytesInput, field?: string): void;
  /** `minReputation === 0`, verification in `TASK_VERIFICATION_MODES` (`'oracle'` needs a non-empty oracle), title <= 256 B, description <= 4096 B, `reward > 0` (`contracts.rs:4698-4700, 4723-4760`). */
  taskPost(minReputation: U8Input, verification: string, verificationOracle: string, title: string, description: string, reward: U64Input): void;
  /**
   * `AgentExecute` inner-instruction allow-list (`ledger.rs:6425-6485, 2138-2175`):
   * variant in `AGENT_INNER_VARIANTS` (else `RangeError`); 9/10 throw
   * `FeatureDisabledError` (`agentStake`); a `ContractCall` needs JSON-object
   * args (a swap payload → `agentSwap`), a method in `DELEGATED_CALL_METHODS`
   * (else `agentDelegatedMethod`) and a `contractId` not starting with `agent_registry_`.
   */
  agentInner(innerData: BytesInput): void;
  /** Every entry in `AGENT_OPERATIONS` (`contracts.rs:3471-3477`). */
  agentOperations(list: readonly string[]): void;
}

/** The node business rules; see `Checks`. */
export const checks: Checks;

// ---------------------------------------------------------------------------
// XerisClient (src/client.js)
// ---------------------------------------------------------------------------

/**
 * Holds no state beyond its URLs; every write method takes the signing
 * `XerisKeypair`, applies the relevant `checks.*` before any I/O, builds and
 * signs the transaction locally and POSTs `{tx_base64}` to the node. Every
 * node error body is thrown as `RpcError` (D6); write results report mempool
 * admission only.
 */
export class XerisClient {
  /**
   * @param host Base URL with scheme, e.g. `'http://138.197.116.81'` (trailing slash stripped); may be `null` when both `opts.rpcUrl` and `opts.explorerUrl` are given.
   * @throws {TypeError|XerisError} `code 'config'` for a malformed host, URL or option.
   */
  constructor(host: string | null, opts?: ClientOptions);
  /** Client for the published testnet validator (`http://TESTNET_SEED`, `network.rs:298`). */
  static testnet(opts?: ClientOptions): XerisClient;
  /**
   * Client for mainnet. The node has no built-in mainnet host (`network.rs:282-300`;
   * `main.rs:821, 841`), so `host` or `process.env.XERIS_MAINNET_HOST` is required.
   * @throws {XerisError} `code 'config'`: `mainnet host not configured: pass a host or set XERIS_MAINNET_HOST`.
   */
  static mainnet(host?: string | null, opts?: ClientOptions): XerisClient;
  /** `err instanceof RpcError && err.message === 'Rate limited. Max 30 write RPCs per minute per IP.'` (`network.rs:4665-4667`). */
  static isRateLimited(err: unknown): boolean;
  /** Re-export of `buildPqRotationMessage`. */
  static buildPqRotationMessage(chainId: string | BytesInput, oldPk: BytesInput, newPk: BytesInput, rotationCount: U64Input): Buffer;

  /** Base URL passed to the constructor, or `null`. */
  readonly host: string | null;
  /** RPC base URL, e.g. `http://138.197.116.81:56001`. */
  readonly rpcUrl: string;
  /** Explorer / JSON-RPC base URL, e.g. `http://138.197.116.81:50008`. */
  readonly explorerUrl: string;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs: number;

  // -- Core transaction methods (blueprint §10.4) ---------------------------

  /** JSON-RPC `getLatestBlockhash` (`explorer.rs:1489-1500`). */
  getLatestBlockhashInfo(): Promise<BlockhashInfo>;
  /** `blockhashFromHex((await getLatestBlockhashInfo()).blockhash)`: 32 raw bytes. */
  getLatestBlockhash(): Promise<Buffer>;
  /**
   * `assertInstructionSubmittable` each → `getLatestBlockhash` → `assembleSignedTransaction` → `POST {route}` → `parseSubmitResponse`.
   * @param instructionData One encoded instruction or 1..`MAX_IX_PER_TX`.
   * @throws {TypeError} When `keypair` is not a `XerisKeypair`.
   * @throws {RangeError} For a route outside `WriteRoute` or a bad instruction count.
   * @throws {EncodingError|FeatureDisabledError} From `assertInstructionSubmittable`.
   * @throws {RpcError|XerisError} Node error bodies, transport failures, timeouts.
   */
  sendInstruction(keypair: XerisKeypair, instructionData: BytesInput | readonly BytesInput[], opts?: SendOptions): Promise<SubmitResult>;
  /** POSTs pre-signed transaction bytes (`{tx_base64}`) to `route` (default `'/submit'`) and parses the body. */
  submitSignedTransaction(txBase64: string, route?: WriteRoute): Promise<SubmitResult>;
  /**
   * Polls `getTransaction(signature)` every `intervalMs` until the explorer
   * returns it (`status` in `TX_STATUSES`; `included` is terminal too) or
   * `timeoutMs` elapses. `RpcError('Transaction not found')` keeps polling;
   * any other error propagates.
   * @throws {XerisError} `code 'timeout'`: the node only searches its last `MAX_RECENT_BLOCKS` in-memory blocks.
   * @throws {RpcError}
   */
  waitForConfirmation(signature: string, opts?: ConfirmationOptions): Promise<TxDetail>;

  // -- Write wrappers (blueprint §10.5); signer = keypair.publicKey ---------

  /** NativeTransfer of `amountXrs` XRS (converted exactly). Preflight: `transferTarget(to)`, `positive`. */
  transferXrs(keypair: XerisKeypair, to: string, amountXrs: XrsInput): Promise<SubmitResult>;
  /** NativeTransfer of `lamports` base units. Preflight: `transferTarget(to)`, `positive`. */
  transferLamports(keypair: XerisKeypair, to: string, lamports: U64Input): Promise<SubmitResult>;
  /**
   * Stake via `POST /stake` by default. Federation-gated on the node
   * (`network.rs:2407-2417`); the resulting stake must be >= `MIN_STAKE_LAMPORTS`
   * (`ledger.rs:5713-5718`). Returns `{status:'queued', ...}`.
   */
  stakeXrs(keypair: XerisKeypair, amountXrs: XrsInput, opts?: SendOptions): Promise<SubmitResult>;
  /**
   * Unstake via `POST /unstake` by default. Partial unstakes must leave >= 1 XRS
   * and be >= `MIN_UNSTAKE_LAMPORTS` (`network.rs:4499-4505`; `ledger.rs:5759, 5772-5776`);
   * funds unlock after `UNBONDING_PERIOD_SLOTS`.
   */
  unstakeXrs(keypair: XerisKeypair, amountXrs: XrsInput, opts?: SendOptions): Promise<SubmitResult>;
  /** WrapXrs: native lamports → `xrs_native` token balance (`ledger.rs:5631-5657`). */
  wrapXrs(keypair: XerisKeypair, amountXrs: XrsInput): Promise<SubmitResult>;
  /** UnwrapXrs (`ledger.rs:5658-5684`). */
  unwrapXrs(keypair: XerisKeypair, amountXrs: XrsInput): Promise<SubmitResult>;
  /**
   * ValidatorAttestation for `blockSlot` / `blockHash` (32 raw bytes, e.g.
   * `Buffer.from(getBlocks(1,1).data[0].hash, 'hex')`). Needs >= 100 XRS staked,
   * a slot within `ATTESTATION_SLOT_WINDOW`, one reward per 10 slots
   * (`network.rs:4694-4768`). Preflight: `attestation`.
   */
  submitAttestation(keypair: XerisKeypair, blockSlot: U64Input, blockHash: BytesInput): Promise<SubmitResult>;
  /** TokenCreate with `mintAuthority = signer`; `maxSupply` in base units. */
  createToken(keypair: XerisKeypair, tokenId: string, name: string, symbol: string, decimals: U8Input, maxSupply: U64Input): Promise<SubmitResult>;
  /** TokenMint; `amount` in base units. Preflight: `positive`. */
  mintTokens(keypair: XerisKeypair, tokenId: string, to: string, amount: U64Input): Promise<SubmitResult>;
  /** TokenTransfer from the signer; `amount` in base units. Preflight: `positive`, `to !== signer` (`token.rs:1111`). */
  transferToken(keypair: XerisKeypair, tokenId: string, to: string, amount: U64Input): Promise<SubmitResult>;
  /** TokenBurn from the signer; `amount` in base units. Preflight: `positive`. */
  burnTokens(keypair: XerisKeypair, tokenId: string, amount: U64Input): Promise<SubmitResult>;
  /** TokenCreateRWA with `mintAuthority = signer`. Preflight: `oneOf(assetType, RWA_ASSET_TYPES)`, `legalDocHash !== ''` (`token.rs:1214-1217`). */
  createRwaToken(
    keypair: XerisKeypair, tokenId: string, name: string, symbol: string, decimals: U8Input, maxSupply: U64Input,
    assetType: RwaAssetType, legalDocHash: string, legalDocUri: string, jurisdiction: string,
    transferRestricted: boolean, accreditedOnly: boolean, valuation: U64Input,
  ): Promise<SubmitResult>;
  /** RWAUpdateStatus. Preflight: `oneOf(newStatus, RWA_STATUSES)`. */
  rwaUpdateStatus(keypair: XerisKeypair, tokenId: string, newStatus: RwaStatus, newValuation: Optional<U64Input>, newLegalDocHash: Optional<string>, newLegalDocUri: Optional<string>): Promise<SubmitResult>;
  /** RWATransfer from the signer. Preflight: `positive`, `to !== signer`. */
  rwaTransfer(keypair: XerisKeypair, tokenId: string, to: string, amount: U64Input): Promise<SubmitResult>;
  /** ContractDeploy with `JSON.stringify(params)`. Preflight: `contractId`, `contractType` (a `ContractTypeAlias`, case-insensitive). */
  deployContract(keypair: XerisKeypair, contractId: string, contractType: string, params: Record<string, unknown>): Promise<SubmitResult>;
  /** ContractCall. `args` is a plain object, or exactly 16 raw bytes for the two swap methods. */
  callContract(keypair: XerisKeypair, contractId: string, method: string, args: Record<string, unknown> | BytesInput): Promise<SubmitResult>;
  /** AMM swap via `encodeSwapCall`. Preflight: `swapMethod`, `positive(inputAmount)`, `positive(minOutput)` (`contracts.rs:2419-2432`). */
  swap(keypair: XerisKeypair, poolId: string, method: SwapMethod, inputAmount: U64Input, minOutput: U64Input): Promise<SubmitResult>;
  /**
   * `swap` with the direction resolved from `getContract(poolId).contract.state.Swap`:
   * `token_b === tokenIn` → `swap_b_to_a`, `token_a === tokenIn` → `swap_a_to_b`.
   * @throws {RangeError} When `tokenIn` is in neither side of the pool.
   */
  swapByToken(keypair: XerisKeypair, poolId: string, tokenIn: string, inputAmount: U64Input, minOutput: U64Input): Promise<SubmitResult>;
  /** `add_liquidity` with `{amount_a, amount_b, min_lp_shares, min_amount_a, min_amount_b}` (`contracts.rs:2214-2231`). Preflight: `liquidityArgs`. */
  addLiquidity(keypair: XerisKeypair, poolId: string, amountA: U64Input, amountB: U64Input, minLpShares: U64Input, minAmountA: U64Input, minAmountB: U64Input): Promise<SubmitResult>;
  /** `remove_liquidity` with `{shares, min_amount_a, min_amount_b}` (`contracts.rs:2378-2384`). Preflight: `positive(shares)`. */
  removeLiquidity(keypair: XerisKeypair, poolId: string, shares: U64Input, minAmountA: U64Input, minAmountB: U64Input): Promise<SubmitResult>;
  /** Launchpad `buy_tokens` with `{xrs_amount, min_tokens_out}` (lamports; spends the wrapped `xrs_native` balance, `contracts.rs:2842-2857`). */
  buyOnLaunchpad(keypair: XerisKeypair, launchpadId: string, xrsAmount: U64Input, minTokensOut: U64Input): Promise<SubmitResult>;
  /** Launchpad `sell_tokens` with `{token_amount, min_xrs_out}` (`contracts.rs:2939-2947`). */
  sellOnLaunchpad(keypair: XerisKeypair, launchpadId: string, tokenAmount: U64Input, minXrsOut: U64Input): Promise<SubmitResult>;
  /** RegisterAgent. Preflight: `pubkey(agentPubkey)`, `agentOperations(allowedOperations)`. */
  registerAgent(
    keypair: XerisKeypair, agentName: string, agentPubkey: string, maxPerTx: U64Input, maxDaily: U64Input,
    allowedContracts: readonly string[], allowedOperations: readonly AgentOperation[], expiresAtSlot: U64Input,
  ): Promise<SubmitResult>;
  /** UpdateAgent. Preflight: `agentOperations` when `newAllowedOperations` is not `null`. */
  updateAgent(
    keypair: XerisKeypair, agentPubkey: string, newMaxPerTx: Optional<U64Input>, newMaxDaily: Optional<U64Input>,
    newAllowedContracts: Optional<readonly string[]>, newAllowedOperations: Optional<readonly AgentOperation[]>,
    newExpiresAtSlot: Optional<U64Input>, revoked: boolean,
  ): Promise<SubmitResult>;
  /**
   * CreateIdentity for the signer with `parentIdentity = ''` (a parent needs a
   * co-signed transaction, `ledger.rs:6717-6727`, which `sendInstruction` does not build).
   * Preflight: `oneOf(identityType, IDENTITY_TYPES)`, `maxBytes(displayName, 128)`, `maxBytes(metadataJson, 4096)`.
   */
  createIdentity(keypair: XerisKeypair, displayName: string, identityType: IdentityType, metadataJson: string): Promise<SubmitResult>;
  /** UpdateIdentity for the signer. */
  updateIdentity(keypair: XerisKeypair, newDisplayName: Optional<string>, newMetadata: Optional<string>, deactivated: boolean): Promise<SubmitResult>;
  /** AttestReputation. Preflight: `score <= 100` (`RangeError`; the node would clamp, `contracts.rs:3568`), `oneOf(category, REPUTATION_CATEGORIES)`, `maxBytes(evidence, 512)`, `subjectPubkey !== signer` (`contracts.rs:3572`). */
  attestReputation(keypair: XerisKeypair, subjectPubkey: string, score: U8Input, category: ReputationCategory, evidence: string): Promise<SubmitResult>;
  /** AgentMessage. Preflight: `oneOf(messageType, MESSAGE_TYPES)`, `maxBytes(payloadJson, 8192)`. */
  sendAgentMessage(keypair: XerisKeypair, toIdentity: string, messageType: MessageType, payloadJson: string, replyTo: string, expiresAtSlot: U64Input): Promise<SubmitResult>;
  /**
   * ConditionalOrder. Preflight: `oneOf(conditionType, CONDITION_TYPES)`,
   * `innerInstruction.length <= MAX_CONDITIONAL_INNER_BYTES`, `lockedAmount >= ORDER_STORAGE_BOND`,
   * `assertInstructionSubmittable(inner)` and inner variant not 17/23 (`ledger.rs:1439`).
   */
  conditionalOrder(
    keypair: XerisKeypair, orderId: string, conditionType: ConditionType, conditionSource: string, conditionThreshold: U64Input,
    innerInstruction: BytesInput, expiresAtSlot: U64Input, lockedAmount: U64Input,
  ): Promise<SubmitResult>;
  /** CancelConditionalOrder. */
  cancelConditionalOrder(keypair: XerisKeypair, orderId: string): Promise<SubmitResult>;
  /** RegisterOracle. Preflight: `oneOf(feedType, FEED_TYPES)`, `stakeAmount >= MIN_ORACLE_STAKE_LAMPORTS`, `maxBytes(description, 512)`. */
  registerOracle(keypair: XerisKeypair, oracleId: string, description: string, feedType: FeedType, updateIntervalSlots: U64Input, stakeAmount: U64Input): Promise<SubmitResult>;
  /** OracleSubmit. Preflight: `maxBytes(metadata, 1024)`. */
  oracleSubmit(keypair: XerisKeypair, oracleId: string, value: U64Input, metadata: string): Promise<SubmitResult>;
  /** HardwareAttest. Preflight: `oneOf(deviceType, DEVICE_TYPES)`, `ed25519Signature(attestationProof)`. */
  hardwareAttest(
    keypair: XerisKeypair, devicePubkey: string, deviceType: DeviceType, manufacturer: string, model: string,
    firmwareVersion: string, attestationProof: BytesInput, boundIdentity: string,
  ): Promise<SubmitResult>;
  /** RegisterCapability with `providerIdentity = signer`. */
  registerCapability(
    keypair: XerisKeypair, category: string, tags: readonly string[], region: string, description: string,
    pricePerUnit: U64Input, maxConcurrent: U32Input, metadataJson: string,
  ): Promise<SubmitResult>;
  /** UpdateCapability with `providerIdentity = signer`. */
  updateCapability(
    keypair: XerisKeypair, category: string, newTags: Optional<readonly string[]>, newDescription: Optional<string>,
    newPricePerUnit: Optional<U64Input>, newMaxConcurrent: Optional<U32Input>, newMetadata: Optional<string>, removed: boolean,
  ): Promise<SubmitResult>;
  /** PostTask (all 12 fields pass through). Preflight: `taskPost`. */
  postTask(
    keypair: XerisKeypair, taskId: string, title: string, description: string, requiredCategory: string, requiredTags: readonly string[],
    minReputation: U8Input, reward: U64Input, expiresAtSlot: U64Input, maxClaimants: U32Input,
    verification: TaskVerificationMode, verificationOracle: string, verificationThreshold: U64Input,
  ): Promise<SubmitResult>;
  /** ClaimTask with `claimantIdentity = signer`. */
  claimTask(keypair: XerisKeypair, taskId: string): Promise<SubmitResult>;
  /** ResolveTask. Preflight: `oneOf(resolution, TASK_RESOLUTIONS)`. */
  resolveTask(keypair: XerisKeypair, taskId: string, resolution: TaskResolution, proof: string): Promise<SubmitResult>;
  /** RegisterModel with `identityPubkey = signer`. */
  registerModel(
    keypair: XerisKeypair, modelName: string, modelHash: string, modelVersion: string, framework: string,
    capabilitiesJson: string, modelSizeBytes: U64Input, executionEnvironment: string,
  ): Promise<SubmitResult>;
  /** UpdateModel with `identityPubkey = signer`. */
  updateModel(keypair: XerisKeypair, modelHash: string, newVersion: Optional<string>, newCapabilities: Optional<string>, newEnvironment: Optional<string>, retired: boolean): Promise<SubmitResult>;
  /** OpenDispute (7 fields). Preflight: `disputeId`. */
  openDispute(keypair: XerisKeypair, disputeId: string, disputeType: string, subjectId: string, defendant: string, reason: string, evidence: string, bond: U64Input): Promise<SubmitResult>;
  /** ResolveDispute. Preflight: `oneOf(action, DISPUTE_ACTIONS)`. */
  resolveDispute(keypair: XerisKeypair, disputeId: string, action: DisputeAction, data: string): Promise<SubmitResult>;
  /** SlashReport (instruction data may be up to `MAX_SLASH_IX_DATA_SIZE`). Preflight: `ownerPubkey !== signer` (`ledger.rs:7959-7970`). */
  slashReport(keypair: XerisKeypair, agentPubkey: string, ownerPubkey: string, violationType: string, evidence: string, violationSlot: U64Input): Promise<SubmitResult>;
  /** CreateProposal. Proposer needs >= 100 XRS staked; `quorum = 0` selects `DEFAULT_PROPOSAL_QUORUM` (`ledger.rs:8284-8288`). Preflight: `votingPeriod`. */
  createProposal(keypair: XerisKeypair, proposalId: string, title: string, description: string, proposalType: string, parameterJson: string, votingPeriodSlots: U64Input, quorum: U64Input): Promise<SubmitResult>;
  /** CastVote. Preflight: `oneOf(vote, VOTES)`. */
  castVote(keypair: XerisKeypair, proposalId: string, vote: Vote): Promise<SubmitResult>;
  /** ExecuteProposal. */
  executeProposal(keypair: XerisKeypair, proposalId: string): Promise<SubmitResult>;
  /** OpenChannel. Preflight: non-empty `channelId` <= 128 B, non-empty `channelType` <= 64 B, `positive(deposit)`, `counterparty !== signer`. */
  openChannel(keypair: XerisKeypair, channelId: string, counterparty: string, deposit: U64Input, channelType: string, expiresAtSlot: U64Input): Promise<SubmitResult>;
  /** CloseChannel. Preflight: `ed25519Signature(counterpartySignature)` (over `channelCloseMessage`). */
  closeChannel(keypair: XerisKeypair, channelId: string, finalBalanceA: U64Input, finalBalanceB: U64Input, messageCount: U64Input, counterpartySignature: BytesInput): Promise<SubmitResult>;
  /** ForceCloseChannel (5 fields). Preflight: `channelSignature(stateSequence, counterpartySignature)`. */
  forceCloseChannel(keypair: XerisKeypair, channelId: string, claimedBalanceSelf: U64Input, claimedBalanceOther: U64Input, stateSequence: U64Input, counterpartySignature: BytesInput): Promise<SubmitResult>;
  /** AgentHeartbeat with `identityPubkey = signer`. */
  agentHeartbeat(keypair: XerisKeypair, currentModelHash: string, activeTasks: U32Input, availableCapacity: U32Input, statusMessage: string): Promise<SubmitResult>;
  /** ZkVkRegister. Preflight: `noPqClaim` on `vkId`/`claimType`/`description`, `vkBase64`. */
  zkVkRegister(keypair: XerisKeypair, vkId: string, vkBase64: string, claimType: string, description: string): Promise<SubmitResult>;
  /** ZkProofSubmit. Preflight: `groth16(...)`. */
  zkProofSubmit(keypair: XerisKeypair, proofId: string, proofSystem: string, proofData: BytesInput, publicInputs: BytesInput, verificationKeyHash: string, proofType: string, metadataJson: string): Promise<SubmitResult>;
  /** ZkProofVerify (read-only on the node). */
  zkProofVerify(keypair: XerisKeypair, proofId: string): Promise<SubmitResult>;
  /** PqKeyRegister for the signer via `POST /pq-register` by default. Preflight: `pqRegister`. */
  pqKeyRegister(keypair: XerisKeypair, pqPublicKey: BytesInput, pqAlgorithm: string, securityLevel: U8Input, opts?: SendOptions): Promise<SubmitResult>;
  /** PqKeyRotate for the signer. Preflight: `pqRotate`. */
  pqKeyRotate(keypair: XerisKeypair, newPqPublicKey: BytesInput, newPqAlgorithm: string, rotationProof: BytesInput): Promise<SubmitResult>;
  /** PqAttest: stored as self-asserted, `verified` forced to `false` by the node (`ledger.rs:8830-8871`). */
  pqAttest(keypair: XerisKeypair, attestationType: string, referenceId: string, pqAlgorithm: string, verified: boolean): Promise<SubmitResult>;
  /** CreateDeal. Preflight: `pubkey(counterparty)`, `counterparty !== signer`, `positive(amount)`. */
  createDeal(keypair: XerisKeypair, dealId: string, counterparty: string, amount: U64Input, terms: string): Promise<SubmitResult>;
  /** AcceptDeal. `expectedTermsHash` is a 32-byte digest, or the terms string (then `dealTermsHash(terms)` is applied); the two are told apart by type. */
  acceptDeal(keypair: XerisKeypair, dealId: string, instance: U64Input, expectedPartyA: string, expectedAmount: U64Input, expectedTermsHash: BytesInput | string): Promise<SubmitResult>;
  /** ConfirmDeal. */
  confirmDeal(keypair: XerisKeypair, dealId: string, instance: U64Input): Promise<SubmitResult>;
  /** CancelDeal. */
  cancelDeal(keypair: XerisKeypair, dealId: string, instance: U64Input): Promise<SubmitResult>;
  /** SettleDeal (permissionless). */
  settleDeal(keypair: XerisKeypair, dealId: string, instance: U64Input): Promise<SubmitResult>;
  /** ReclaimDeal, allowed after `DEAL_TIMEOUT_SLOTS`. */
  reclaimDeal(keypair: XerisKeypair, dealId: string, instance: U64Input): Promise<SubmitResult>;
  /** DisputeDeal. Preflight: `dealBond`. */
  disputeDeal(keypair: XerisKeypair, dealId: string, instance: U64Input, reason: string, bond: U64Input): Promise<SubmitResult>;

  // -- Operations the node refuses (throw synchronously, no I/O) -----------

  /** Throws `FeatureDisabledError` (`SubDelegate`, `ledger.rs:1445-1450`). Use `registerAgent`. */
  subDelegate(...args: unknown[]): never;
  /** Throws `FeatureDisabledError` (`ZkPrivateTransfer`, `ledger.rs:8669-8685`). Use `transferXrs` / `transferToken`. */
  zkPrivateTransfer(...args: unknown[]): never;
  /** Throws `FeatureDisabledError` (`ZkIdentityProof`, `ledger.rs:8687-8697`). Use `zkProofSubmit`. */
  zkIdentityProof(...args: unknown[]): never;
  /** Throws `FeatureDisabledError` (`PqSignedTransfer`, `ledger.rs:8809-8828`). Use `transferXrs`. */
  pqSignedTransfer(...args: unknown[]): never;
  /** Throws `FeatureDisabledError` (`ZkPrivateTransfer`). */
  sendZkPrivateTransfer(...args: unknown[]): never;
  /** Throws `FeatureDisabledError` (`PqSignedTransfer`). */
  sendPqTransfer(...args: unknown[]): never;
  /** Throws `FeatureDisabledError` (`airdrop`, `network.rs:4314-4327`). Fund accounts with `transferXrs`. */
  airdrop(...args: unknown[]): never;
  /** Throws `FeatureDisabledError` (`stakeClaim`, `network.rs:5705-5740`): rewards are paid automatically every 900 blocks. */
  claimStakingReward(...args: unknown[]): never;
  /** Throws `FeatureDisabledError` (`governanceLock`, `network.rs:5838-5867`). */
  governanceLock(...args: unknown[]): never;
  /** Throws `FeatureDisabledError` (`governanceLock`, `network.rs:5838-5867`). */
  governanceDelegate(...args: unknown[]): never;

  // -- Read methods, RPC port (blueprint §10.6) ----------------------------

  /** `GET /health` (`network.rs:4860-4862`). */
  getHealth(): Promise<{ status: 'ok' }>;
  /** `GET /blocks` (`network.rs:4555-4559`): up to 50 raw blocks, newest first. */
  getRecentBlocks(): Promise<LedgerBlock[]>;
  /** `GET /stake/{address}` (`network.rs:4866-4899`). */
  getStakeInfo(address: string): Promise<StakeInfo>;
  /** `GET /account/{address}/unstaking` (`network.rs:5683-5703`). */
  getUnstaking(address: string): Promise<UnstakingInfo>;
  /** `GET /network/economics` (`network.rs:5147-5183`). */
  getNetworkEconomics(): Promise<NetworkEconomics>;
  /** `GET /tokens` (`network.rs:4915-4922`). */
  getTokenList(): Promise<{ tokens: TokenInfo[] }>;
  /** `GET /token/balance/{address}/{tokenId}` (`network.rs:4903-4913`). */
  getTokenBalance(address: string, tokenId: string): Promise<TokenBalance>;
  /** `GET /token/accounts/{address}` (`network.rs:5186-5211`). */
  getTokenAccounts(address: string): Promise<TokenAccounts>;
  /** `GET /contracts` (`network.rs:5029-5045`). */
  getContracts(): Promise<ContractsResponse>;
  /** `GET /contract/{id}` (`network.rs:5018-5026`); not found → `RpcError('Contract not found')`. */
  getContract(contractId: string): Promise<ContractResponse>;
  /** `GET /contract/{id}/quote?input_token=&amount=` (`network.rs:5048-5066`); `amount` in base units. */
  getContractQuote(contractId: string, inputToken: string, amount: U64Input): Promise<SwapQuoteResponse>;
  /** `GET /contract/{id}/vesting/{wallet}` (`network.rs:5070-5109`), Launchpad only. */
  getVestingStatus(contractId: string, wallet: string): Promise<VestingStatus>;
  /** `GET /launchpads` (`network.rs:5215-5271`). */
  getLaunchpads(): Promise<LaunchpadsResponse>;
  /** `GET /launchpad/{id}/quote?xrs_amount=` (`network.rs:5274-5327`); `xrsAmountLamports` in lamports. */
  getLaunchpadQuote(contractId: string, xrsAmountLamports: U64Input): Promise<LaunchpadQuote>;
  /** `GET /agent/registry/{owner}` (`network.rs:5332-5355`). */
  getAgentRegistry(owner: string): Promise<AgentRegistry>;
  /** `GET /agent/validate/{agent}/{owner}` (`network.rs:5358-5383`); unknown agent → `RpcError('Agent not found in registry')`. */
  validateAgent(agentPubkey: string, owner: string): Promise<AgentValidation>;
  /** `POST /agent/plan` (`network.rs:5386-5577`; 16 KiB body, not rate limited). Unknown actions → `RpcError`. */
  agentPlan(body: AgentPlanRequest): Promise<AgentPlan>;
  /** `agentPlan({action:'transfer', from, to, amount_xrs})`. `amountXrs` is a JSON number parsed as `f64` and truncated to lamports (`network.rs:5398-5399`). */
  planTransfer(from: string, to: string, amountXrs: number): Promise<TransferPlan>;
  /** `agentPlan({action:'swap', pool_id, token_in, amount_in, slippage_pct})`; `amountIn` in base units, `slippagePct` in `0..=100`. */
  planSwap(poolId: string, tokenIn: string, amountIn: U64Input, slippagePct: number): Promise<SwapPlan>;
  /** `agentPlan({action:'buy_launchpad', launchpad_id, xrs_amount, slippage_pct})`; `xrsAmount` in lamports. */
  planBuyLaunchpad(launchpadId: string, xrsAmount: U64Input, slippagePct: number): Promise<BuyLaunchpadPlan>;
  /** `agentPlan({action:'stake', pubkey, amount_xrs})`; `amountXrs` as `planTransfer`. */
  planStake(pubkey: string, amountXrs: number): Promise<StakePlan>;
  /** `agentPlan({action:'wrap', amount_xrs})`; `amountXrs` as `planTransfer`. */
  planWrap(amountXrs: number): Promise<WrapPlan>;
  /** `agentPlan({action:'unwrap', amount_xrs})`; `amountXrs` as `planTransfer`. */
  planUnwrap(amountXrs: number): Promise<UnwrapPlan>;
  /** `GET /capabilities/search` (`network.rs:5583-5615`); only supplied parameters are sent. */
  searchCapabilities(params?: CapabilitySearchParams): Promise<CapabilitySearchResponse>;
  /** `GET /capabilities` (`network.rs:5619-5632`). */
  getCapabilities(): Promise<CapabilitiesResponse>;
  /** `GET /tasks` (`network.rs:5640-5659`). */
  getTasks(): Promise<TasksResponse>;
  /** `GET /tasks/{id}` (`network.rs:5663-5675`); not found → `RpcError('Task not found')`. */
  getTask(taskId: string): Promise<ApiResponse<TaskEntry>>;
  /** `GET /zk/proofs/{identity}` (`network.rs:5912-5923`). */
  getZkProofs(identity: string): Promise<ZkProofsResponse>;
  /** `GET /zk/verify/{id}` (`network.rs:5927-5938`); not found → `RpcError('Proof not found')`. */
  getZkProofStatus(proofId: string): Promise<ApiResponse<ZkProofRecord>>;
  /** `GET /zk/stats` (`network.rs:5942-5954`). */
  getZkStats(): Promise<ZkStats>;
  /** `GET /pq/keys/{address}` (`network.rs:5958-5974`). */
  getPqKey(address: string): Promise<PqKeyInfo>;
  /** `GET /pq/status` (`network.rs:5978-6001`). */
  getPqStatus(): Promise<PqStatus>;
  /** `GET /governance/proposals` (`network.rs:5745-5783`). */
  getGovernanceProposals(): Promise<GovernanceProposals>;
  /** `GET /governance/lock/{address}` (`network.rs:5821-5833`). */
  getGovernanceLock(address: string): Promise<GovernanceLock>;
  /** `GET /price-history?pool_id=&limit=` (`network.rs:6026-6075`); `limit` defaults to the node's own 500 and is capped at 10080 by the node. */
  getPriceHistory(poolId: string, limit?: number): Promise<PriceHistory>;
  /** `GET /pools/price-history` (`network.rs:6079-6106`). */
  getAllPoolPriceHistory(): Promise<AllPoolPriceHistory>;

  // -- Read methods, explorer port (blueprint §10.7) -----------------------

  /** `GET /v2/stats` (`explorer.rs:965-1011`). */
  getStats(): Promise<ApiResponse<NetworkStats>>;
  /** `GET /v2/blocks?page=&page_size=` (`explorer.rs:1014-1034`); defaults 1 / 20, `page_size` capped at 100 by the node. */
  getBlocks(page?: number, pageSize?: number): Promise<Paginated<BlockSummary>>;
  /** `GET /v2/block/slot/{slot}` (`explorer.rs:1037-1081`); reaches disk for old slots. */
  getBlockBySlot(slot: U64Input): Promise<ApiResponse<BlockDetail>>;
  /** `GET /v2/block/hash/{hash}` (`explorer.rs:1084-1106`); in-memory blocks only. */
  getBlockByHash(hashHex: string): Promise<ApiResponse<BlockDetail>>;
  /** `GET /v2/transactions?page=&page_size=` (`explorer.rs:1109-1180`). */
  getTransactions(page?: number, pageSize?: number): Promise<Paginated<TransactionSummary>>;
  /** `GET /v2/tx/{signature}` (`explorer.rs:1183-1249`); not found → `RpcError('Transaction not found')`. */
  getTransaction(signature: string): Promise<ApiResponse<TxDetail>>;
  /** `GET /v2/account/{address}` (`explorer.rs:1251-1284`). */
  getAccountInfo(address: string): Promise<ApiResponse<AccountInfo>>;
  /** `GET /v2/account/{address}/transactions?page=&page_size=&before=` (`explorer.rs:1287-1375`). */
  getAccountTransactions(address: string, opts?: AccountTransactionsOptions): Promise<AccountTransactions>;
  /** `GET /v2/validators` (`explorer.rs:1377-1410`). */
  getValidators(): Promise<ValidatorsResponse>;
  /** `GET /v2/search?q=` (`explorer.rs:763-832`); `Not found` → `RpcError`. */
  search(q: string): Promise<SearchResult>;
  /** `GET /v2/tokens?after=&limit=` (`explorer.rs:1646-1679`). */
  getTokens(opts?: CursorOptions): Promise<CursorPage<TokenInfo, 'data'>>;
  /** `GET /v2/token/{id}/holders?after=&limit=` (`explorer.rs:1681-1712`). */
  getTokenHolders(tokenId: string, opts?: CursorOptions): Promise<TokenHolders>;
  /** `GET /v2/rwa?after=&limit=` (`explorer.rs:1719-1740`). */
  getRwaTokens(opts?: CursorOptions): Promise<CursorPage<RwaListRow, 'tokens'>>;
  /** `GET /v2/rwa/{id}?after=&limit=` (`explorer.rs:1743-1805`); the cursor pages the holders. */
  getRwa(tokenId: string, opts?: CursorOptions): Promise<RwaDetail>;
  /** `GET /v2/contracts?after=&limit=` (`explorer.rs:1815-1840`). */
  getContractsV2(opts?: CursorOptions): Promise<CursorPage<ContractListRow, 'contracts'>>;
  /** `GET /v2/contract/{id}?page=&page_size=` (`explorer.rs:1843-1967`). */
  getContractV2(id: string, opts?: RegistryPageOptions): Promise<ContractV2Response>;
  /** `GET /v2/pools?after=&limit=` (`explorer.rs:1970-2120`). */
  getPools(opts?: CursorOptions): Promise<CursorPage<PoolRow, 'pools'>>;

  // -- JSON-RPC methods, explorer port `POST /` (blueprint §10.8) ----------

  /** JSON-RPC `getBalance` → `result.value` lamports; unknown addresses read 0 (`explorer.rs:1448-1458`). */
  getBalance(address: string): Promise<number>;
  /** JSON-RPC `getAccountInfo` (`explorer.rs:1460-1481`). */
  getAccountInfoRpc(address: string): Promise<RpcAccountInfo>;
  /** JSON-RPC `getSlot` (`explorer.rs:1483`). */
  getSlot(): Promise<number>;
  /** JSON-RPC `getBlockHeight` (`explorer.rs:1485`). */
  getBlockHeight(): Promise<number>;
  /** JSON-RPC `getBlock` (`explorer.rs:1502-1517`); `null` when the slot is not in memory. */
  getBlockRpc(slot: U64Input): Promise<RpcBlock | null>;
  /** JSON-RPC `getTransaction` (`explorer.rs:1519-1536, 1572-1600`); `null` when not found. */
  getTransactionRpc(signature: string): Promise<RpcTransaction | null>;
  /** JSON-RPC `getSignaturesForAddress` (`explorer.rs:1538-1556, 1604-1630`); `limit` defaults to the node's 20 and is capped at 200 by the node. */
  getSignaturesForAddress(address: string, limit?: number): Promise<SignatureInfo[]>;
  /** JSON-RPC `getHealth` (`explorer.rs:1558`). */
  getHealthRpc(): Promise<'ok'>;
  /** JSON-RPC `getVersion` (`explorer.rs:1560-1563`). */
  getVersion(): Promise<VersionInfo>;
}

// ---------------------------------------------------------------------------
// XerisDApp (src/dapp.js)
// ---------------------------------------------------------------------------

/**
 * What an injected wallet (`window.xeris`) must implement. Required: `connect`
 * and at least one of `signTransaction` / `signAndSendTransaction`. The SDK
 * prefers `signTransaction` and submits to `POST /submit` itself; with only
 * `signAndSendTransaction` the wallet submits and the result is normalised to
 * `{status:'ok', signature}`.
 */
export interface XerisWalletProvider {
  isXeris?: boolean;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PublicKey | string } | string>;
  /** Accepted results: a signed `Transaction`, the serialized signed bytes, `{signature}` (64 bytes, base58 or base64) or `{signedTransaction}`. */
  signTransaction?(tx: Transaction): Promise<Transaction | Uint8Array | { signature: Uint8Array | number[] | string } | { signedTransaction: string | Uint8Array }>;
  /** Used only when `signTransaction` is absent; the wallet must POST `{tx_base64}` to `/submit`. */
  signAndSendTransaction?(tx: Transaction): Promise<{ signature: string }>;
  signMessage?(message: Uint8Array): Promise<{ signature: Uint8Array }>;
  disconnect?(): Promise<void>;
  /** Node RPC URL; `:56001` is stripped to derive the host. */
  getRpcUrl?(): Promise<string>;
  on?(event: 'disconnect' | 'accountChanged', handler: (arg: unknown) => void): void;
  off?(event: string, handler: (...args: unknown[]) => void): void;
}

/** Events emitted by `XerisDApp.on`: `'connect'` → `{publicKey}`, `'disconnect'` → `undefined`, `'accountChanged'` → new base58 key or `null`. */
export type DAppEvent = 'connect' | 'disconnect' | 'accountChanged';

/**
 * Browser adapter: the injected wallet signs, the SDK encodes, submits and
 * reads through an internal `XerisClient` created on `connect`. Write methods
 * return the node's `/submit` body (mempool admission); poll
 * `waitForConfirmation` for inclusion. Stake and unstake go through `/submit`
 * here (the dedicated routes add nothing on the wallet-signed path).
 */
export class XerisDApp {
  /** @throws {TypeError|RangeError|XerisError} On malformed options. */
  constructor(opts?: DAppOptions);
  /** `window.xeris`, else `window.solana` when it has `isXeris`, else `window.solana`, else `null`. */
  static detectProvider(): XerisWalletProvider | null;
  /**
   * Polls `detectProvider()` every 100 ms until a provider appears or `timeoutMs`
   * (default 3000) elapses; `null` immediately outside a browser.
   * @throws {TypeError|RangeError} For a non-finite or negative timeout.
   */
  static waitForProvider(timeoutMs?: number): Promise<XerisWalletProvider | null>;
  /** Connected wallet public key (base58), or `null`. */
  readonly publicKey: string | null;
  readonly connected: boolean;
  /** The provider in use, or `null` before `connect`. */
  readonly provider: XerisWalletProvider | null;
  /** The internal `XerisClient`; `null` until a host is known (constructor `host`/URLs, or `connect`). */
  readonly client: XerisClient | null;
  /**
   * Resolves the provider (`opts.provider` → `detectProvider()` → `waitForProvider(2000)`),
   * connects, validates the public key, resolves the node base URL
   * (`opts.rpcUrl`/`explorerUrl` → `opts.host` → `provider.getRpcUrl()` → testnet seed)
   * and creates the internal client.
   * @throws {XerisError} `code 'provider'` (no provider, `connect` missing/rejected, no usable key); `code 'config'` for mainnet without a host.
   * @throws {RangeError} When the wallet's key is not canonical.
   */
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: string }>;
  /** Calls `provider.disconnect()` when present, clears the key and emits `'disconnect'`. */
  disconnect(): Promise<void>;
  /** Registers a listener. @throws {RangeError|TypeError} */
  on(event: DAppEvent, callback: (arg: unknown) => void): void;
  /** Removes a listener registered with `on`. @throws {RangeError|TypeError} */
  off(event: DAppEvent, callback: (arg: unknown) => void): void;
  /**
   * Builds a transaction from encoded instruction bytes, has the wallet sign it
   * and submits it (`serializedFromWalletResult` + `POST /submit`, or
   * `signAndSendTransaction`).
   * @throws {XerisError} `code 'provider'` when not connected, no signing method, rejected, or an unusable result.
   * @throws {FeatureDisabledError|RangeError|EncodingError} From `assertInstructionSubmittable`.
   * @throws {RpcError}
   */
  sendInstruction(instructionData: BytesInput | readonly BytesInput[]): Promise<SubmitResult>;
  /** `provider.signMessage` → 64-byte signature. A string is signed as its UTF-8 bytes. @throws {XerisError} `code 'provider'` when unsupported. */
  signMessage(message: Uint8Array | Buffer | string): Promise<Buffer>;
  /** `client.waitForConfirmation`. @throws {XerisError} `code 'config'` before a client exists. */
  waitForConfirmation(signature: string, opts?: ConfirmationOptions): Promise<TxDetail>;

  // -- Write wrappers; signer = this.publicKey; preflight as XerisClient ----

  /** NativeTransfer of `amountXrs` XRS. */
  transferXrs(to: string, amountXrs: XrsInput): Promise<SubmitResult>;
  /** NativeTransfer of `lamports`. */
  transferLamports(to: string, lamports: U64Input): Promise<SubmitResult>;
  /** Stake via `/submit` (federation-gated, `network.rs:2407-2417`; min `MIN_STAKE_LAMPORTS`). */
  stakeXrs(amountXrs: XrsInput): Promise<SubmitResult>;
  /** Unstake via `/submit`. */
  unstakeXrs(amountXrs: XrsInput): Promise<SubmitResult>;
  /** WrapXrs. */
  wrapXrs(amountXrs: XrsInput): Promise<SubmitResult>;
  /** UnwrapXrs. */
  unwrapXrs(amountXrs: XrsInput): Promise<SubmitResult>;
  /** TokenTransfer; `amount` in base units. */
  transferToken(tokenId: string, to: string, amount: U64Input): Promise<SubmitResult>;
  /** AMM swap with the direction resolved from the pool state (as `XerisClient.swapByToken`); amounts in base units. */
  swapTokens(poolId: string, tokenIn: string, amountIn: U64Input, minAmountOut: U64Input): Promise<SubmitResult>;
  /** AMM swap with an explicit method (`encodeSwapCall`). */
  swap(poolId: string, method: SwapMethod, inputAmount: U64Input, minOutput: U64Input): Promise<SubmitResult>;
  /** Launchpad `buy_tokens`; `xrsAmount` in lamports (spends wrapped XRS). */
  buyOnLaunchpad(launchpadId: string, xrsAmount: U64Input, minTokensOut: U64Input): Promise<SubmitResult>;
  /** Launchpad `sell_tokens`. */
  sellOnLaunchpad(launchpadId: string, tokenAmount: U64Input, minXrsOut: U64Input): Promise<SubmitResult>;
  /** `add_liquidity` (all five fields required, `> 0`). */
  addLiquidity(poolId: string, amountA: U64Input, amountB: U64Input, minLpShares: U64Input, minAmountA: U64Input, minAmountB: U64Input): Promise<SubmitResult>;
  /** `remove_liquidity` with `{shares, min_amount_a, min_amount_b}`. */
  removeLiquidity(poolId: string, shares: U64Input, minAmountA: U64Input, minAmountB: U64Input): Promise<SubmitResult>;
  /** ContractCall; `args` is a plain object, or 16 raw bytes for the swap methods. */
  callContract(contractId: string, method: string, args: Record<string, unknown> | BytesInput): Promise<SubmitResult>;
  /** ContractDeploy with `JSON.stringify(params)`. */
  deployContract(contractId: string, contractType: string, params: Record<string, unknown>): Promise<SubmitResult>;

  // -- Read wrappers delegating to this.client ------------------------------

  /** JSON-RPC `getBalance` in lamports; defaults to the connected key. */
  getBalance(address?: string): Promise<number>;
  /** `GET /token/accounts/{address}`; defaults to the connected key. */
  getTokenAccounts(address?: string): Promise<TokenAccounts>;
  /** `GET /v2/account/{address}`; defaults to the connected key. */
  getAccountInfo(address?: string): Promise<ApiResponse<AccountInfo>>;
  /** `GET /launchpads`. */
  getLaunchpads(): Promise<LaunchpadsResponse>;
  /** `GET /launchpad/{id}/quote?xrs_amount=` (lamports). */
  getLaunchpadQuote(launchpadId: string, xrsAmountLamports: U64Input): Promise<LaunchpadQuote>;
  /** `GET /contracts`. */
  getContracts(): Promise<ContractsResponse>;
  /** `GET /contract/{id}`. */
  getContract(contractId: string): Promise<ContractResponse>;
  /** `GET /contract/{id}/quote` (`XerisClient.getContractQuote`); `amount` in base units. */
  getSwapQuote(poolId: string, inputToken: string, amount: U64Input): Promise<SwapQuoteResponse>;
  /** `GET /v2/pools`. */
  getPools(opts?: CursorOptions): Promise<CursorPage<PoolRow, 'pools'>>;
  /** `GET /tokens`. */
  getTokenList(): Promise<{ tokens: TokenInfo[] }>;
  /** `GET /v2/stats`. */
  getStats(): Promise<ApiResponse<NetworkStats>>;
  /** `GET /v2/tx/{signature}`. */
  getTransaction(signature: string): Promise<ApiResponse<TxDetail>>;

  // -- Operations the node refuses (throw synchronously, no I/O) -----------

  /** Throws `FeatureDisabledError` (`airdrop`, `network.rs:4314-4327`). */
  airdrop(...args: unknown[]): never;
  /** Throws `FeatureDisabledError` (`ZkPrivateTransfer`, `ledger.rs:8669-8685`). */
  sendZkPrivateTransfer(...args: unknown[]): never;
}

// ---------------------------------------------------------------------------
// XerisAgent (src/agent.js)
// ---------------------------------------------------------------------------

/** Client-side filters of `XerisAgent.findTasks` (exact matches). */
export interface TaskFilters {
  /** `required_category === category` */
  category?: string;
  /** `status === status` */
  status?: TaskStatus;
  /** `required_tags.includes(tag)` */
  tag?: string;
}

/**
 * Agent-side client: direct agent-signed instructions, plus delegated
 * execution as the owner through `AgentExecute` (`ledger.rs:6425-6485`).
 * Delegated spend is bounded by the owner's `RegisterAgent` limits; a
 * delegated instruction the node rejects is recorded as a failed transaction,
 * not as a submission error.
 */
export class XerisAgent {
  /**
   * @param keypair The agent's key: signer and fee payer of every transaction.
   * @param ownerPubkey Canonical public key of the owner who registered this agent.
   * @param host Node base URL with scheme (required).
   * @throws {TypeError} Non-keypair, non-string owner, or missing host.
   * @throws {RangeError} Non-canonical owner key.
   * @throws {XerisError} `code 'config'` for a malformed host.
   */
  constructor(keypair: XerisKeypair, ownerPubkey: string, host: string, opts?: AgentOptions);
  /** Agent on the published testnet validator (`TESTNET_SEED`). */
  static testnet(keypair: XerisKeypair, ownerPubkey: string, opts?: AgentOptions): XerisAgent;
  /**
   * Agent on mainnet; `host` or `process.env.XERIS_MAINNET_HOST` is required (`network.rs:282-300`).
   * @throws {XerisError} `code 'config'` when neither is set.
   */
  static mainnet(keypair: XerisKeypair, ownerPubkey: string, host?: string | null, opts?: AgentOptions): XerisAgent;
  /** The agent's public key (base58). */
  readonly publicKey: string;
  /** The owner's public key (base58). */
  readonly ownerPubkey: string;
  /** The underlying client. */
  readonly client: XerisClient;

  // -- Registry reads ------------------------------------------------------

  /** `client.validateAgent(publicKey, ownerPubkey)`. @throws {RpcError} `'Agent not found in registry'`. */
  getPermissions(): Promise<AgentValidation>;
  /** `client.getAgentRegistry(ownerPubkey)`. */
  getRegistry(): Promise<AgentRegistry>;

  // -- Direct, agent-signed instructions -----------------------------------

  /** `createIdentity(publicKey, displayName, 'agent', '', metadataJson)`; required before `heartbeat`, `claimTask` and messages (`ledger.rs:8441, 7527, 6857-6864`). */
  createIdentity(displayName: string, metadataJson: string): Promise<SubmitResult>;
  /** `agentHeartbeat(publicKey, ...)`; all four arguments required. */
  heartbeat(currentModelHash: string, activeTasks: U32Input, availableCapacity: U32Input, statusMessage: string): Promise<SubmitResult>;
  /** `claimTask(taskId, publicKey)`. */
  claimTask(taskId: string): Promise<SubmitResult>;
  /** `resolveTask`; preflight `oneOf(resolution, TASK_RESOLUTIONS)`. */
  resolveTask(taskId: string, resolution: TaskResolution, proof: string): Promise<SubmitResult>;
  /** `resolveTask(taskId, 'complete', proof)`. */
  completeTask(taskId: string, proof: string): Promise<SubmitResult>;
  /** `agentMessage`; preflight `oneOf(messageType, MESSAGE_TYPES)`, `maxBytes(payloadJson, 8192)`. */
  sendMessage(toIdentity: string, messageType: MessageType, payloadJson: string, replyTo: string, expiresAtSlot: U64Input): Promise<SubmitResult>;
  /** `registerCapability(publicKey, ...)`. */
  registerCapability(category: string, tags: readonly string[], region: string, description: string, pricePerUnit: U64Input, maxConcurrent: U32Input, metadataJson: string): Promise<SubmitResult>;

  // -- Delegated (AgentExecute, executes as the owner) ---------------------

  /** `checks.agentInner(inner)` then `sendInstruction(keypair, agentExecute(ownerPubkey, inner))`. */
  execute(innerInstruction: BytesInput): Promise<SubmitResult>;
  /** Inner `nativeTransfer(ownerPubkey, to, lamports)`. */
  transferXrs(to: string, amountXrs: XrsInput): Promise<SubmitResult>;
  /** Inner `tokenTransfer(tokenId, ownerPubkey, to, amount)`. */
  transferToken(tokenId: string, to: string, amount: U64Input): Promise<SubmitResult>;
  /** Inner `tokenMint(tokenId, to, amount)`. */
  mintTokens(tokenId: string, to: string, amount: U64Input): Promise<SubmitResult>;
  /** Inner `tokenBurn(tokenId, ownerPubkey, amount)`. */
  burnTokens(tokenId: string, amount: U64Input): Promise<SubmitResult>;
  /** Inner `wrapXrs(lamports)`. */
  wrapXrs(amountXrs: XrsInput): Promise<SubmitResult>;
  /** Inner `unwrapXrs(lamports)`. */
  unwrapXrs(amountXrs: XrsInput): Promise<SubmitResult>;
  /** Inner `contractCall` with JSON-object `args` only; `checks.agentInner` enforces `DELEGATED_CALL_METHODS` (`ledger.rs:2138-2175`). */
  callContract(contractId: string, method: string, args: Record<string, unknown>): Promise<SubmitResult>;
  /** Delegated `add_liquidity`, budgeted via `quote_add_liquidity` (`ledger.rs:6448-6459`). */
  addLiquidity(poolId: string, amountA: U64Input, amountB: U64Input, minLpShares: U64Input, minAmountA: U64Input, minAmountB: U64Input): Promise<SubmitResult>;
  /** Delegated `remove_liquidity`. */
  removeLiquidity(poolId: string, shares: U64Input, minAmountA: U64Input, minAmountB: U64Input): Promise<SubmitResult>;

  // -- Planner (read-only) ---------------------------------------------------

  /** `client.planTransfer(ownerPubkey, to, amountXrs)`. */
  planTransfer(to: string, amountXrs: number): Promise<TransferPlan>;
  /** `client.planSwap(...)`. */
  planSwap(poolId: string, tokenIn: string, amountIn: U64Input, slippagePct: number): Promise<SwapPlan>;
  /** `client.planBuyLaunchpad(...)`. */
  planBuy(launchpadId: string, xrsAmount: U64Input, slippagePct: number): Promise<BuyLaunchpadPlan>;
  /** `client.planStake(ownerPubkey, amountXrs)`. */
  planStake(amountXrs: number): Promise<StakePlan>;
  /** `client.planWrap(amountXrs)`. */
  planWrap(amountXrs: number): Promise<WrapPlan>;
  /** `client.planUnwrap(amountXrs)`. */
  planUnwrap(amountXrs: number): Promise<UnwrapPlan>;

  // -- Reads ----------------------------------------------------------------

  /** `client.getTasks().data` filtered client-side by exact match; unknown filter keys throw `RangeError`. */
  findTasks(filters?: TaskFilters): Promise<TaskEntry[]>;
  /** Owner's balance in lamports (JSON-RPC `getBalance`). */
  getBalance(): Promise<number>;
  /** Owner's `GET /token/accounts/{owner}`. */
  getTokenAccounts(): Promise<TokenAccounts>;
  /** `GET /capabilities`. */
  getCapabilities(): Promise<CapabilitiesResponse>;
  /** `GET /capabilities/search`. */
  searchCapabilities(params?: CapabilitySearchParams): Promise<CapabilitySearchResponse>;

  // -- Delegations the node refuses (throw synchronously, no I/O) ----------

  /** Throws `FeatureDisabledError` (`agentSwap`, `ledger.rs:6436-6469, 2138-2175`); the owner signs via `XerisClient.swap` / `XerisDApp.swapTokens`. */
  swapTokens(...args: unknown[]): never;
  /** Throws `FeatureDisabledError` (`agentLaunchpad`, `ledger.rs:6554-6556`). */
  buyOnLaunchpad(...args: unknown[]): never;
  /** Throws `FeatureDisabledError` (`agentLaunchpad`, `ledger.rs:6554-6556`). */
  sellOnLaunchpad(...args: unknown[]): never;
  /** Throws `FeatureDisabledError` (`agentStake`, `ledger.rs:6474-6475`; `token.rs:1183-1200`). */
  stakeXrs(...args: unknown[]): never;
  /** Throws `FeatureDisabledError` (`agentStake`). */
  unstakeXrs(...args: unknown[]): never;
  /** Throws `FeatureDisabledError` (`SubDelegate`, `ledger.rs:1445-1450`). */
  subDelegate(...args: unknown[]): never;
}

// ---------------------------------------------------------------------------
// TestVectors (src/vectors.js)
// ---------------------------------------------------------------------------

/** One reference vector: the installed builder's bytes next to the arbiter's expected hex. */
export interface Vector {
  /** Entry name (the `TestVectors` method that produced it). */
  name: string;
  /** PascalCase variant name. */
  variant: VariantName;
  /** Variant index. */
  index: number;
  /** What the call encodes. */
  description: string;
  /** Arguments passed to the builder, in order. */
  inputs: unknown[];
  /** Bytes the installed builder produced, lowercase hex. */
  hex: string;
  /** The same bytes. */
  bytes: Buffer;
  /** `bytes.length`. */
  length: number;
  /** Reference bytes from the arbiter encoder, lowercase hex. */
  expectedHex: string;
}

/** One failed comparison reported by `TestVectors.verify()`. */
export interface VectorFailure {
  /** Entry name, or the primitive check's label. */
  name: string;
  expectedHex: string;
  /** Bytes produced, or `null` when the builder threw. */
  hex: string | null;
  /** The builder's error message when it threw, or a length/index mismatch note. */
  error?: string;
}

/** The frozen `TestVectors` namespace: twenty entry functions plus `all`, `verify`, `printAll`. */
export interface TestVectorsApi {
  nativeTransfer(): Vector;
  stake(): Vector;
  tokenMint(): Vector;
  tokenTransfer(): Vector;
  wrapXrs(): Vector;
  createDeal(): Vector;
  acceptDeal(): Vector;
  confirmDeal(): Vector;
  disputeDeal(): Vector;
  zkVkRegister(): Vector;
  agentExecuteNativeTransfer(): Vector;
  contractCallSwap(): Vector;
  openDispute(): Vector;
  forceCloseChannel(): Vector;
  updateAgent(): Vector;
  registerAgent(): Vector;
  rwaUpdateStatus(): Vector;
  agentHeartbeat(): Vector;
  postTask(): Vector;
  validatorAttestation(): Vector;
  /** The twenty vectors in table order, computing each builder's bytes now. */
  all(): Vector[];
  /** Compares every entry and every embedded primitive check against its reference bytes; never throws. */
  verify(): { ok: boolean; failures: VectorFailure[] };
  /** Prints every entry and a `verify()` summary to stdout; the only console output in the SDK. The exit code is unchanged. */
  printAll(): void;
}

/** Reference vectors computed with the installed builders; see `TestVectorsApi`. */
export const TestVectors: TestVectorsApi;
