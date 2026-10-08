'use strict';

/**
 * Error classes thrown by xeris-sdk.
 *
 * Mapping used across the SDK (blueprint §2):
 * - `TypeError`            wrong JavaScript type for a field (thrown as native TypeError)
 * - `RangeError`           right type, value outside the field's domain (native RangeError)
 * - `EncodingError`        structural failure: arity, unknown variant, oversize instruction, malformed hex
 * - `FeatureDisabledError` anything the node refuses or skips
 * - `RpcError`             anything the node or the transport returned as a failure
 * - `XerisError`           everything else (misconfiguration, timeouts, unsupported provider)
 *
 * Every instance carries a `.code` string. Codes used by the SDK:
 * `xeris`, `encoding`, `arity`, `feature_disabled`, `rpc`, `rpc_http`,
 * `rpc_transport`, `rpc_json`, `timeout`, `config`, `provider`.
 *
 * @module xeris-sdk/errors
 */

/**
 * Base class of every SDK-specific error.
 */
class XerisError extends Error {
  /**
   * @param {string} message Human-readable description.
   * @param {{code?: string, details?: object|null, cause?: unknown}} [opts]
   *   `code` defaults to `'xeris'`; `details` is stored as given (or `null`);
   *   `cause` is attached as `this.cause` when provided.
   */
  constructor(message, opts = {}) {
    super(message);
    const o = opts === null || typeof opts !== 'object' ? {} : opts;
    this.name = 'XerisError';
    /** @type {string} */
    this.code = typeof o.code === 'string' && o.code.length > 0 ? o.code : 'xeris';
    /** @type {object|null} */
    this.details = o.details === undefined ? null : o.details;
    if (o.cause !== undefined) {
      /** @type {unknown} */
      this.cause = o.cause;
    }
  }
}

/**
 * Structural encoding failure: wrong argument count, unknown variant index,
 * oversize instruction data, malformed hex, unreadable instruction bytes.
 */
class EncodingError extends XerisError {
  /**
   * @param {string} message
   * @param {{code?: string, field?: string|null, details?: object|null, cause?: unknown}} [opts]
   *   `code` defaults to `'encoding'` (`'arity'` is used by the instruction
   *   builders); `field` names the offending field or parameter, or is `null`.
   */
  constructor(message, opts = {}) {
    const o = opts === null || typeof opts !== 'object' ? {} : opts;
    super(message, { code: typeof o.code === 'string' && o.code.length > 0 ? o.code : 'encoding', details: o.details, cause: o.cause });
    this.name = 'EncodingError';
    /** @type {string|null} */
    this.field = typeof o.field === 'string' ? o.field : null;
  }
}

/**
 * Thrown before any network call when the requested operation is one the node
 * refuses at ingress, skips in the dispatcher, or serves with HTTP 501.
 */
class FeatureDisabledError extends XerisError {
  /**
   * @param {string} message Exact text from `DISABLED_FEATURES[feature].message`.
   * @param {{feature: string, replacement?: string|null, citation: string, details?: object|null, cause?: unknown}} opts
   *   `feature` is the `DISABLED_FEATURES` key; `replacement` names the live
   *   SDK path to use instead, or is `null` when none exists; `citation` is
   *   the node `file:line` range that disables the feature.
   */
  constructor(message, opts = {}) {
    const o = opts === null || typeof opts !== 'object' ? {} : opts;
    super(message, { code: 'feature_disabled', details: o.details, cause: o.cause });
    this.name = 'FeatureDisabledError';
    /** @type {string} */
    this.feature = typeof o.feature === 'string' ? o.feature : '';
    /** @type {string|null} */
    this.replacement = typeof o.replacement === 'string' ? o.replacement : null;
    /** @type {string} */
    this.citation = typeof o.citation === 'string' ? o.citation : '';
  }
}

/**
 * A failure reported by the node or by the HTTP transport. Covers HTTP 200
 * bodies carrying an `"error"` key (every `network.rs` handler except the five
 * 501 stubs replies that way), JSON-RPC results of the form `{"error": "..."}`
 * (`explorer.rs:1455, 1481, 1499, 1517, 1536, 1554, 1565`), non-2xx statuses,
 * unparsable bodies and transport exceptions.
 */
class RpcError extends XerisError {
  /**
   * @param {string} message The node's `error` string, or a transport description.
   * @param {{code?: string, route?: string|null, httpStatus?: number|null, body?: unknown,
   *          nodeStatus?: string|null, hint?: string|null, details?: object|null, cause?: unknown}} [opts]
   *   `code` defaults to `'rpc'` (the transport uses `'rpc_http'`,
   *   `'rpc_transport'`, `'rpc_json'`); `route` is e.g. `'POST /submit'` or
   *   `'JSON-RPC getBalance'`; `httpStatus` is the HTTP status or `null`;
   *   `body` is the parsed JSON body or raw text. `nodeStatus` and `hint`
   *   default to `body.status` / `body.hint` when those are strings on an
   *   object body (e.g. `rejected_mempool_full`, `network.rs:4825-4843`).
   */
  constructor(message, opts = {}) {
    const o = opts === null || typeof opts !== 'object' ? {} : opts;
    super(message, { code: typeof o.code === 'string' && o.code.length > 0 ? o.code : 'rpc', details: o.details, cause: o.cause });
    this.name = 'RpcError';
    /** @type {string|null} */
    this.route = typeof o.route === 'string' ? o.route : null;
    /** @type {number|null} */
    this.httpStatus = typeof o.httpStatus === 'number' && Number.isInteger(o.httpStatus) ? o.httpStatus : null;
    /** @type {unknown} */
    this.body = o.body === undefined ? null : o.body;
    const bodyObj = this.body !== null && typeof this.body === 'object' && !Array.isArray(this.body) ? this.body : null;
    /** @type {string|null} */
    this.nodeStatus = typeof o.nodeStatus === 'string'
      ? o.nodeStatus
      : (bodyObj && typeof bodyObj.status === 'string' ? bodyObj.status : null);
    /** @type {string|null} */
    this.hint = typeof o.hint === 'string'
      ? o.hint
      : (bodyObj && typeof bodyObj.hint === 'string' ? bodyObj.hint : null);
  }
}

/**
 * Operations the node refuses, keyed by the name the SDK uses for them.
 * Messages are exact (tests assert them). Each entry: `{ message, replacement, citation }`
 * where `replacement` is the live SDK path or `null`, and `citation` is the
 * node `file:line` that disables the operation.
 * @type {Readonly<Record<string, Readonly<{message: string, replacement: string|null, citation: string}>>>}
 */
const DISABLED_FEATURES = Object.freeze({
  // Variant 22: `return Err("SubDelegate is disabled (XWC-82)")` at ingress (ledger.rs:1445-1450);
  // `continue` in the block dispatcher (ledger.rs:6911-6914).
  SubDelegate: Object.freeze({
    message: 'SubDelegate (variant 22) is rejected by the node at ingress with "SubDelegate is disabled (XWC-82)" and skipped in blocks. Register each agent directly with RegisterAgent (variant 15).',
    replacement: 'Instructions.registerAgent / XerisClient.registerAgent',
    citation: 'ledger.rs:1445-1450, 6911-6914',
  }),
  // Variant 48: dispatcher `continue` after the fee is charged (ledger.rs:8669-8685, NEW-CRIT-3).
  ZkPrivateTransfer: Object.freeze({
    message: 'ZkPrivateTransfer (variant 48) is skipped by the node dispatcher (NEW-CRIT-3): the fee is charged and no balance changes. There is no private-transfer path; use NativeTransfer (variant 11) or TokenTransfer (variant 1).',
    replacement: 'Instructions.nativeTransfer / Instructions.tokenTransfer',
    citation: 'ledger.rs:8669-8685',
  }),
  // Variant 49: dispatcher `continue` (ledger.rs:8687-8697, NEW-CRIT-1).
  ZkIdentityProof: Object.freeze({
    message: 'ZkIdentityProof (variant 49) is skipped by the node dispatcher (NEW-CRIT-1). The only live proof path is ZkProofSubmit (variant 46) against a VK registered with ZkVkRegister (variant 61).',
    replacement: 'Instructions.zkProofSubmit',
    citation: 'ledger.rs:8687-8697',
  }),
  // Variant 52: dispatcher `continue` (ledger.rs:8809-8828, NEW-CRIT-4).
  PqSignedTransfer: Object.freeze({
    message: 'PqSignedTransfer (variant 52) is skipped by the node dispatcher (NEW-CRIT-4). Transfers are Ed25519-signed NativeTransfer (variant 11); PqKeyRegister (50) and PqKeyRotate (51) remain live.',
    replacement: 'Instructions.nativeTransfer',
    citation: 'ledger.rs:8809-8828',
  }),
  // GET /airdrop/{address}/{amount} replies HTTP 200 with {"error": ..., "status": 501} (network.rs:4314-4327, NEW-HIGH-7).
  airdrop: Object.freeze({
    message: 'GET /airdrop/{address}/{amount} is disabled on the node (HTTP 200 body {"status":501}, NEW-HIGH-7). Fund an account with a NativeTransfer from a funded key.',
    replacement: 'XerisClient.transferXrs',
    citation: 'network.rs:4314-4327',
  }),
  // POST /stake/claim replies HTTP 501 (network.rs:5705-5740); rewards are credited in-block every
  // STAKING_REWARD_INTERVAL blocks (ledger.rs:9372-9438).
  stakeClaim: Object.freeze({
    message: 'POST /stake/claim returns HTTP 501 (NEW-CRIT-6). Staking rewards are paid automatically every 900 blocks to the liquid balance; there is nothing to claim.',
    replacement: null,
    citation: 'network.rs:5705-5740; ledger.rs:9372-9438',
  }),
  // POST /governance/vote and /governance/propose reply HTTP 501 (network.rs:5788-5817).
  governanceRpcWrite: Object.freeze({
    message: 'POST /governance/vote and /governance/propose return HTTP 501 (NEW-CRIT-6). Use the on-chain instructions CreateProposal (39), CastVote (40), ExecuteProposal (41) via POST /submit.',
    replacement: 'XerisClient.createProposal / castVote / executeProposal',
    citation: 'network.rs:5788-5817',
  }),
  // POST /governance/lock and /governance/delegate reply HTTP 501 (network.rs:5838-5867).
  governanceLock: Object.freeze({
    message: 'POST /governance/lock and /governance/delegate return HTTP 501 (NEW-CRIT-6). No on-chain lock or delegation instruction exists; GET /governance/lock/{address} remains readable.',
    replacement: null,
    citation: 'network.rs:5838-5867',
  }),
  // Delegated ContractCall args must parse as a JSON object (ledger.rs:6436-6442) and the swap methods
  // are absent from delegated_call_spend (ledger.rs:2138-2175), so the dispatcher `continue`s.
  agentSwap: Object.freeze({
    message: 'AgentExecute cannot wrap a DEX swap: delegated ContractCall args must be a JSON object and swap_a_to_b/swap_b_to_a are not in delegated_call_spend, so the node fails closed. The owner must sign the swap directly.',
    replacement: 'XerisClient.swap / XerisDApp.swapTokens',
    citation: 'ledger.rs:6436-6469, 2138-2175',
  }),
  // is_launchpad_contract branch of the delegated ContractCall path (ledger.rs:6554-6556, XWC-07).
  agentLaunchpad: Object.freeze({
    message: 'AgentExecute inner calls to Launchpad contracts are rejected by the node (XWC-07). The owner must sign launchpad buys and sells directly.',
    replacement: 'XerisClient.buyOnLaunchpad / sellOnLaunchpad, XerisDApp.buyOnLaunchpad / sellOnLaunchpad',
    citation: 'ledger.rs:6554-6556',
  }),
  // is_rwa_contract branch of the delegated ContractCall path (ledger.rs:6557-6561, XWC-03).
  agentRwa: Object.freeze({
    message: 'AgentExecute inner calls to RWA contracts are rejected by the node (XWC-03). The owner must sign RWA contract calls directly.',
    replacement: 'XerisClient.callContract',
    citation: 'ledger.rs:6557-6561',
  }),
  // Inner Stake/Unstake are budgeted (ledger.rs:6474-6475) and then fall through to
  // token::process_token_instruction, which returns Ok(()) without touching stakes (token.rs:1183-1200).
  agentStake: Object.freeze({
    message: 'Delegated Stake/Unstake via AgentExecute execute as no-ops on the node (token.rs:1183-1200 returns Ok without touching stakes) while consuming the agent\'s budget. Stake with the owner key directly.',
    replacement: 'XerisClient.stakeXrs / unstakeXrs',
    citation: 'ledger.rs:6474-6475; token.rs:1183-1200',
  }),
  // delegated_call_spend returns None for unknown methods and for confirm/verify (ledger.rs:2138-2175).
  agentDelegatedMethod: Object.freeze({
    message: 'Delegated ContractCall method is not in the node\'s delegated_call_spend table, so AgentExecute fails closed. See DELEGATED_CALL_METHODS.',
    replacement: 'XerisClient.callContract',
    citation: 'ledger.rs:2138-2175',
  }),
});

/**
 * Builds the `FeatureDisabledError` for a `DISABLED_FEATURES` key. The caller
 * throws it (`throw disabledFeature('SubDelegate')`).
 * @param {string} key A key of `DISABLED_FEATURES`.
 * @returns {FeatureDisabledError} Error whose `message` is exactly `DISABLED_FEATURES[key].message`.
 * @throws {TypeError} When `key` is not a string or not a known key.
 */
function disabledFeature(key) {
  if (typeof key !== 'string') {
    throw new TypeError(`disabledFeature: expected a DISABLED_FEATURES key (string), got ${key === null ? 'null' : typeof key}`);
  }
  if (!Object.prototype.hasOwnProperty.call(DISABLED_FEATURES, key)) {
    throw new TypeError(`disabledFeature: unknown feature '${key}'; known keys: ${Object.keys(DISABLED_FEATURES).join(', ')}`);
  }
  const entry = DISABLED_FEATURES[key];
  return new FeatureDisabledError(entry.message, {
    feature: key,
    replacement: entry.replacement,
    citation: entry.citation,
  });
}

module.exports = {
  XerisError,
  EncodingError,
  FeatureDisabledError,
  RpcError,
  DISABLED_FEATURES,
  disabledFeature,
};
