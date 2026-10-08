'use strict';

/**
 * @file `XerisAgent`: an agent key acting under a RegisterAgent delegation.
 *
 * Two kinds of method exist:
 *
 * * Direct, agent-signed instructions (identity, heartbeat, tasks, messages,
 *   capability listings). The agent key is the signer and pays the fee.
 * * Delegated instructions wrapped in AgentExecute (variant 17): the node
 *   validates the inner instruction against the owner's agent registry
 *   (`ledger.rs:6425-6485`; `contracts.rs:3430-3477`) and executes it with
 *   the owner as signer (`ledger.rs:6522-6657`). Only NativeTransfer,
 *   TokenTransfer, ContractCall, WrapXrs, UnwrapXrs, Stake, Unstake,
 *   TokenMint and TokenBurn are allowed as inner instructions
 *   (`AGENT_OPERATIONS`); `RegisterAgent.allowed_operations` is matched by
 *   exact string and an empty list allows all (`contracts.rs:3471-3477`);
 *   `allowed_contracts` is matched against the inner ContractCall's
 *   `contract_id` (`contracts.rs:3463-3469`). Spend is recorded only after
 *   the inner instruction succeeded (`ledger.rs:6664-6682`) within a daily
 *   window of `AGENT_DAILY_WINDOW_SLOTS` (`contracts.rs:3439`).
 *
 * Delegated ContractCall rules (`ledger.rs:6427-6470, 6554-6561, 2138-2175`):
 * `args` must be a JSON object; the method must be in
 * `DELEGATED_CALL_METHODS` (`add_liquidity` is budgeted through
 * `quote_add_liquidity`, `ledger.rs:6448-6459`); `contract_id` must not start
 * with `agent_registry_`; protected protocol methods, Launchpad contracts
 * (XWC-07) and RWA contracts (XWC-03) are rejected; `confirm`/`verify` fail
 * closed. The AMM swap methods and launchpad trades are therefore not
 * reachable through delegation, and delegated Stake/Unstake execute as
 * no-ops that still consume budget (`token.rs:1183-1200`); the matching
 * methods here throw `FeatureDisabledError`.
 *
 * Node business rules are applied through `checks` from `src/client.js`
 * before any network call (blueprint D2).
 */

const { XerisClient, checks } = require('./client');
const { Instructions } = require('./instructions/index');
const { assertString, normalizeU64, toBytes, xrsToLamports } = require('./encoding');
const { XerisError, RpcError, disabledFeature } = require('./errors');
const {
  TESTNET_SEED,
  MAINNET_HOST_ENV,
  TASK_RESOLUTIONS,
  MESSAGE_TYPES,
  STRING_LIMITS,
} = require('./constants');

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/** Keys `findTasks` accepts; anything else is refused rather than ignored. */
const TASK_FILTER_KEYS = Object.freeze(['category', 'status', 'tag']);

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Short description of a value for error messages (never prints key material).
 * @param {unknown} v
 * @returns {string}
 */
function describe(v) {
  if (v === null) return 'null';
  if (typeof v === 'string') return `string '${v.length > 48 ? `${v.slice(0, 45)}...` : v}'`;
  if (typeof v === 'bigint') return `bigint ${v}n`;
  if (typeof v === 'number' || typeof v === 'boolean') return `${typeof v} ${String(v)}`;
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * True for a plain object (`{}`), the only shape a delegated
 * `ContractCall.args` may take (`ledger.rs:6436-6441`).
 * @param {unknown} v
 * @returns {boolean}
 */
function isPlainObject(v) {
  return Object.prototype.toString.call(v) === '[object Object]';
}

/**
 * Duck-typed `XerisKeypair` check (this module may not require
 * `src/keypair.js`, blueprint §1); `XerisClient.sendInstruction` enforces the
 * class itself before signing.
 * @param {unknown} kp
 * @returns {boolean}
 */
function isKeypairLike(kp) {
  return kp !== null && typeof kp === 'object'
    && typeof kp.publicKey === 'string' && typeof kp.sign === 'function';
}

/**
 * Throws `TypeError` unless a wrapper was called with exactly `expected`
 * arguments, so a dropped positional argument is reported with the
 * wrapper's name instead of shifting a wire field.
 * @param {number} actual `arguments.length`
 * @param {number} expected
 * @param {string} name e.g. `XerisAgent.heartbeat`
 * @param {string} fields comma-separated parameter list
 * @returns {void}
 */
function assertArity(actual, expected, name, fields) {
  if (actual !== expected) {
    throw new TypeError(`${name} expects exactly ${expected} arguments (${fields}), got ${actual}`);
  }
}

/**
 * Converts a u64 field value into a JSON number for a delegated
 * `ContractCall` args object. The node reads these with `as_u64` from a JSON
 * number (`ledger.rs:2139`; `contracts.rs:2218-2224, 2381-2383`), and
 * `JSON.stringify` cannot carry an integer above 2^53-1 exactly, so larger
 * values are refused rather than rounded (blueprint §7.3).
 * @param {number|bigint} value
 * @param {string} field
 * @returns {number}
 * @throws {TypeError|RangeError}
 */
function jsonU64(value, field) {
  const v = normalizeU64(value, field);
  if (v > MAX_SAFE_BIGINT) {
    throw new RangeError(`${field}: JSON numbers above 2^53-1 cannot be carried exactly (the node reads a JSON number with as_u64); got ${v}`);
  }
  return Number(v);
}

/**
 * Deep-copies a caller-supplied JSON args object, converting `bigint` to a
 * JSON-safe number and refusing anything `JSON.stringify` would silently
 * alter or drop: non-finite numbers (become `null`), `undefined`, functions
 * and symbols (keys vanish), non-plain objects, and strings with a lone
 * surrogate (`serde_json` rejects the `\uD800` escape).
 * @param {unknown} value
 * @param {string} path field path for error messages
 * @returns {unknown}
 * @throws {TypeError|RangeError}
 */
function jsonValue(value, path) {
  if (typeof value === 'bigint') return jsonU64(value, path);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError(`${path}: JSON cannot carry ${String(value)}`);
    return value;
  }
  if (typeof value === 'string') return assertString(value, path);
  if (typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.map((v, i) => jsonValue(v, `${path}[${i}]`));
  if (value !== null && typeof value === 'object') {
    if (!isPlainObject(value)) throw new TypeError(`${path}: expected a plain object or array, got ${describe(value)}`);
    const out = {};
    for (const key of Object.keys(value)) out[key] = jsonValue(value[key], `${path}.${key}`);
    return out;
  }
  throw new TypeError(`${path}: ${typeof value} cannot be serialised to JSON`);
}

/**
 * Value of `process.env[MAINNET_HOST_ENV]`, or `null` when unset or empty
 * (or when `process` does not exist, e.g. in a browser bundle).
 * @returns {string|null}
 */
function mainnetHostFromEnv() {
  if (typeof process === 'undefined' || process === null || !process.env) return null;
  const v = process.env[MAINNET_HOST_ENV];
  return typeof v === 'string' && v !== '' ? v : null;
}

// ---------------------------------------------------------------------------
// XerisAgent
// ---------------------------------------------------------------------------

/**
 * Agent-side client: direct agent-signed instructions plus delegated
 * execution as the owner through AgentExecute. Write methods return the
 * node's `/submit` body (`{status:'ok', signature}` = mempool admission,
 * `network.rs:4847-4856`); poll `client.waitForConfirmation` for inclusion.
 * A delegated instruction the node rejects (budget, allow-list, inner
 * failure) is recorded as a failed transaction, not an error at submission.
 */
class XerisAgent {
  /**
   * @param {XerisKeypair} keypair the agent's key (signer and fee payer of every transaction)
   * @param {string} ownerPubkey canonical public key of the owner who registered this agent
   * @param {string} host node base URL with scheme, e.g. `'http://138.197.116.81'` (required)
   * @param {object} [opts={}] `XerisClient` options (`rpcPort`, `explorerPort`, `rpcUrl`, `explorerUrl`, `fetch`, `timeoutMs`)
   * @throws {TypeError} for a non-keypair, non-string owner, or missing host
   * @throws {RangeError} for a non-canonical owner key (`ledger.rs:1569-1577`)
   * @throws {XerisError} `code 'config'` for a malformed host
   */
  constructor(keypair, ownerPubkey, host, opts = {}) {
    if (!isKeypairLike(keypair)) {
      throw new TypeError(`keypair: expected an XerisKeypair, got ${describe(keypair)}`);
    }
    assertString(ownerPubkey, 'ownerPubkey');
    checks.pubkey(ownerPubkey, 'ownerPubkey');
    if (typeof host !== 'string') {
      throw new TypeError(`host: expected the node base URL as a string (e.g. 'http://138.197.116.81'), got ${describe(host)}; use XerisAgent.testnet() or XerisAgent.mainnet() for the named networks`);
    }
    if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
      throw new TypeError(`opts: expected an object, got ${describe(opts)}`);
    }
    /** @private */ this._keypair = keypair;
    /** @private */ this._ownerPubkey = ownerPubkey;
    /** @private */ this._client = new XerisClient(host, opts);
  }

  /**
   * Agent on the published testnet validator (`TESTNET_SEED`, `network.rs:298`).
   * @param {XerisKeypair} keypair
   * @param {string} ownerPubkey
   * @param {object} [opts] `XerisClient` options
   * @returns {XerisAgent}
   */
  static testnet(keypair, ownerPubkey, opts) {
    return opts === undefined
      ? new XerisAgent(keypair, ownerPubkey, `http://${TESTNET_SEED}`)
      : new XerisAgent(keypair, ownerPubkey, `http://${TESTNET_SEED}`, opts);
  }

  /**
   * Agent on mainnet. The node has no built-in mainnet host
   * (`network.rs:282-300`; `main.rs:821, 841` only define the `--mainnet`
   * flag), so `host` or the `XERIS_MAINNET_HOST` environment variable is
   * required.
   * @param {XerisKeypair} keypair
   * @param {string} ownerPubkey
   * @param {string} [host] node base URL; defaults to `process.env.XERIS_MAINNET_HOST`
   * @param {object} [opts] `XerisClient` options
   * @returns {XerisAgent}
   * @throws {XerisError} `code 'config'` when neither `host` nor the environment variable is set
   */
  static mainnet(keypair, ownerPubkey, host, opts) {
    const resolved = host === undefined || host === null ? mainnetHostFromEnv() : host;
    if (resolved === null) {
      throw new XerisError(`mainnet host not configured: pass a host or set ${MAINNET_HOST_ENV}`, { code: 'config' });
    }
    return opts === undefined
      ? new XerisAgent(keypair, ownerPubkey, resolved)
      : new XerisAgent(keypair, ownerPubkey, resolved, opts);
  }

  /** @returns {string} The agent's public key (base58). */
  get publicKey() { return this._keypair.publicKey; }

  /** @returns {string} The owner's public key (base58). */
  get ownerPubkey() { return this._ownerPubkey; }

  /** @returns {XerisClient} The underlying client. */
  get client() { return this._client; }

  // --------------------------------------------------------------------------
  // Registry reads
  // --------------------------------------------------------------------------

  /**
   * `GET /agent/validate/{agent}/{owner}` (`network.rs:5358-5383`).
   * @returns {Promise<object>} `{authorized, revoked, expired, agent}`
   * @throws {RpcError} `'Agent not found in registry'` when the owner has not registered this key
   */
  async getPermissions() {
    return this._client.validateAgent(this.publicKey, this._ownerPubkey);
  }

  /**
   * `GET /agent/registry/{owner}` (`network.rs:5332-5355`).
   * @returns {Promise<object>} `{owner, registry_id, agent_count, agents}`
   * @throws {RpcError}
   */
  async getRegistry() {
    return this._client.getAgentRegistry(this._ownerPubkey);
  }

  // --------------------------------------------------------------------------
  // Direct, agent-signed instructions
  // --------------------------------------------------------------------------

  /**
   * CreateIdentity (variant 18) for the agent key with `identity_type
   * 'agent'` and no parent. The node requires `signer == identity_pubkey`
   * (`ledger.rs:6690`), caps `display_name` at 128 bytes and `metadata_json`
   * at 4096 (`ledger.rs:6702-6706`), and a non-empty `parent_identity` would
   * need the parent to co-sign the transaction (`ledger.rs:6717-6727`),
   * which a single-signer submission cannot do. An active identity is
   * required before `heartbeat` (`ledger.rs:8441`), `claimTask`
   * (`ledger.rs:7527`), `sendMessage` (`ledger.rs:6857-6864`) and
   * `registerCapability` (`ledger.rs:7390`).
   * @param {string} displayName at most 128 UTF-8 bytes
   * @param {string} metadataJson at most 4096 UTF-8 bytes
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|RpcError}
   */
  async createIdentity(displayName, metadataJson) {
    assertArity(arguments.length, 2, 'XerisAgent.createIdentity', 'displayName, metadataJson');
    assertString(displayName, 'displayName');
    assertString(metadataJson, 'metadataJson');
    checks.maxBytes(displayName, STRING_LIMITS.identityDisplayName, 'displayName');
    checks.maxBytes(metadataJson, STRING_LIMITS.identityMetadata, 'metadataJson');
    return this._send(Instructions.createIdentity(this.publicKey, displayName, 'agent', '', metadataJson));
  }

  /**
   * AgentHeartbeat (variant 45) for the agent's own identity. The node
   * requires `identity_pubkey == signer` and an active identity
   * (`ledger.rs:8420-8452`). All four values are required; nothing is
   * substituted for an omitted one.
   * @param {string} currentModelHash
   * @param {number|bigint} activeTasks u32
   * @param {number|bigint} availableCapacity u32
   * @param {string} statusMessage
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError} when not called with exactly four arguments
   * @throws {RangeError|RpcError}
   */
  async heartbeat(currentModelHash, activeTasks, availableCapacity, statusMessage) {
    assertArity(arguments.length, 4, 'XerisAgent.heartbeat', 'currentModelHash, activeTasks, availableCapacity, statusMessage');
    return this._send(Instructions.agentHeartbeat(
      this.publicKey, currentModelHash, activeTasks, availableCapacity, statusMessage,
    ));
  }

  /**
   * ClaimTask (variant 32) as the agent's own identity; the node requires
   * `claimant_identity == signer` with an active identity (`ledger.rs:7507-7527`).
   * @param {string} taskId
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|RpcError}
   */
  async claimTask(taskId) {
    assertArity(arguments.length, 1, 'XerisAgent.claimTask', 'taskId');
    return this._send(Instructions.claimTask(taskId, this.publicKey));
  }

  /**
   * ResolveTask (variant 33). The node maps `complete` → `submit_proof`
   * (claimant), `verify` / `reject` / `cancel` (poster) and rejects any other
   * resolution (`ledger.rs:7603-7612`).
   * @param {string} taskId
   * @param {'complete'|'verify'|'reject'|'cancel'} resolution one of `TASK_RESOLUTIONS`
   * @param {string} proof completion proof, or the reject reason
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|RpcError}
   */
  async resolveTask(taskId, resolution, proof) {
    assertArity(arguments.length, 3, 'XerisAgent.resolveTask', 'taskId, resolution, proof');
    checks.oneOf(resolution, TASK_RESOLUTIONS, 'resolution');
    return this._send(Instructions.resolveTask(taskId, resolution, proof));
  }

  /**
   * `resolveTask(taskId, 'complete', proof)`: submits the claimant's proof
   * (`ledger.rs:7603`).
   * @param {string} taskId
   * @param {string} proof
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|RpcError}
   */
  async completeTask(taskId, proof) {
    assertArity(arguments.length, 2, 'XerisAgent.completeTask', 'taskId, proof');
    return this.resolveTask(taskId, 'complete', proof);
  }

  /**
   * AgentMessage (variant 21). The node requires `message_type` in
   * `MESSAGE_TYPES`, `payload_json` ≤ 8192 bytes and an active sender
   * identity (`ledger.rs:6844-6871`); the message is block data only, no
   * state is written.
   * @param {string} toIdentity
   * @param {'proposal'|'counteroffer'|'accept'|'reject'|'info'|'request'} messageType
   * @param {string} payloadJson at most 8192 UTF-8 bytes
   * @param {string} replyTo signature or id being answered, or `''`
   * @param {number|bigint} expiresAtSlot u64
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|RpcError}
   */
  async sendMessage(toIdentity, messageType, payloadJson, replyTo, expiresAtSlot) {
    assertArity(arguments.length, 5, 'XerisAgent.sendMessage', 'toIdentity, messageType, payloadJson, replyTo, expiresAtSlot');
    checks.oneOf(messageType, MESSAGE_TYPES, 'messageType');
    assertString(payloadJson, 'payloadJson');
    checks.maxBytes(payloadJson, STRING_LIMITS.messagePayload, 'payloadJson');
    return this._send(Instructions.agentMessage(toIdentity, messageType, payloadJson, replyTo, expiresAtSlot));
  }

  /**
   * RegisterCapability (variant 28) with the agent key as
   * `provider_identity`; the node requires it to equal the signer and to be
   * an active identity (`ledger.rs:7389-7392`).
   * @param {string} category
   * @param {string[]} tags
   * @param {string} region
   * @param {string} description
   * @param {number|bigint} pricePerUnit u64 lamports
   * @param {number|bigint} maxConcurrent u32
   * @param {string} metadataJson
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|RpcError}
   */
  async registerCapability(category, tags, region, description, pricePerUnit, maxConcurrent, metadataJson) {
    assertArity(arguments.length, 7, 'XerisAgent.registerCapability',
      'category, tags, region, description, pricePerUnit, maxConcurrent, metadataJson');
    return this._send(Instructions.registerCapability(
      this.publicKey, category, tags, region, description, pricePerUnit, maxConcurrent, metadataJson,
    ));
  }

  // --------------------------------------------------------------------------
  // Delegated execution (AgentExecute, runs as the owner)
  // --------------------------------------------------------------------------

  /**
   * Wraps `innerInstruction` in AgentExecute (variant 17) for the owner and
   * submits it signed by the agent key. `checks.agentInner` applies the
   * node's allow-list first (`ledger.rs:6425-6485, 2138-2175`): inner
   * variants outside `AGENT_INNER_VARIANTS` → `RangeError`; Stake/Unstake →
   * `FeatureDisabledError('agentStake')`; a ContractCall with non-object
   * args, a method outside `DELEGATED_CALL_METHODS` or an `agent_registry_`
   * target → `FeatureDisabledError`/`XerisError`. Nested AgentExecute or
   * ConditionalOrder is rejected at ingress (`ledger.rs:1439`).
   * @param {Buffer|Uint8Array} innerInstruction encoded inner instruction
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|FeatureDisabledError|XerisError|RpcError}
   */
  async execute(innerInstruction) {
    assertArity(arguments.length, 1, 'XerisAgent.execute', 'innerInstruction');
    const inner = toBytes(innerInstruction, 'innerInstruction');
    checks.agentInner(inner);
    return this._send(Instructions.agentExecute(this._ownerPubkey, inner));
  }

  /**
   * Delegated NativeTransfer from the owner's balance (`ledger.rs:6525-6546`;
   * the inner `from` is ignored and the owner is debited, `ledger.rs:6522, 6525`).
   * @param {string} to canonical recipient public key, not a `__` pseudo-account (`ledger.rs:1569-1577, 6530`)
   * @param {number|string} amountXrs XRS as a number or decimal string, converted exactly
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|FeatureDisabledError|XerisError|RpcError}
   */
  async transferXrs(to, amountXrs) {
    assertArity(arguments.length, 2, 'XerisAgent.transferXrs', 'to, amountXrs');
    checks.transferTarget(to);
    const lamports = xrsToLamports(amountXrs, 'amountXrs');
    checks.positive(lamports, 'amountXrs');
    return this.execute(Instructions.nativeTransfer(this._ownerPubkey, to, lamports));
  }

  /**
   * Delegated TokenTransfer from the owner's token balance. The inner
   * instruction runs through the token processor with the owner as signer
   * (`ledger.rs:6648-6657`), so `from` is the owner and `to` must differ
   * from it (`token.rs:1104-1114`).
   * @param {string} tokenId
   * @param {string} to recipient (must differ from the owner key)
   * @param {number|bigint} amount base units > 0
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|FeatureDisabledError|XerisError|RpcError}
   */
  async transferToken(tokenId, to, amount) {
    assertArity(arguments.length, 3, 'XerisAgent.transferToken', 'tokenId, to, amount');
    assertString(tokenId, 'tokenId');
    assertString(to, 'to');
    checks.positive(amount, 'amount');
    if (to === this._ownerPubkey) {
      throw new RangeError('to: must differ from the owner (token.rs:1111 rejects from == to)');
    }
    return this.execute(Instructions.tokenTransfer(tokenId, this._ownerPubkey, to, amount));
  }

  /**
   * Delegated TokenMint as the owner, who must be the token's
   * `mint_authority` (`token.rs:1080`); `amount > 0` (`token.rs:1057`);
   * launchpad-managed tokens cannot be minted (`token.rs:1076`).
   * @param {string} tokenId
   * @param {string} to recipient
   * @param {number|bigint} amount base units > 0
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|FeatureDisabledError|XerisError|RpcError}
   */
  async mintTokens(tokenId, to, amount) {
    assertArity(arguments.length, 3, 'XerisAgent.mintTokens', 'tokenId, to, amount');
    assertString(tokenId, 'tokenId');
    assertString(to, 'to');
    checks.positive(amount, 'amount');
    return this.execute(Instructions.tokenMint(tokenId, to, amount));
  }

  /**
   * Delegated TokenBurn from the owner's balance (`from` = owner,
   * `token.rs:1147-1160`).
   * @param {string} tokenId
   * @param {number|bigint} amount base units > 0 (`token.rs:1158`)
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|FeatureDisabledError|XerisError|RpcError}
   */
  async burnTokens(tokenId, amount) {
    assertArity(arguments.length, 2, 'XerisAgent.burnTokens', 'tokenId, amount');
    assertString(tokenId, 'tokenId');
    checks.positive(amount, 'amount');
    return this.execute(Instructions.tokenBurn(tokenId, this._ownerPubkey, amount));
  }

  /**
   * Delegated WrapXrs: moves the owner's native XRS into the owner's
   * `xrs_native` token balance (`ledger.rs:6613-6632`).
   * @param {number|string} amountXrs XRS > 0, converted exactly
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|FeatureDisabledError|XerisError|RpcError}
   */
  async wrapXrs(amountXrs) {
    assertArity(arguments.length, 1, 'XerisAgent.wrapXrs', 'amountXrs');
    const lamports = xrsToLamports(amountXrs, 'amountXrs');
    checks.positive(lamports, 'amountXrs');
    return this.execute(Instructions.wrapXrs(lamports));
  }

  /**
   * Delegated UnwrapXrs: moves the owner's `xrs_native` token balance back to
   * native XRS (`ledger.rs:6633-6647`).
   * @param {number|string} amountXrs XRS > 0, converted exactly
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|FeatureDisabledError|XerisError|RpcError}
   */
  async unwrapXrs(amountXrs) {
    assertArity(arguments.length, 1, 'XerisAgent.unwrapXrs', 'amountXrs');
    const lamports = xrsToLamports(amountXrs, 'amountXrs');
    checks.positive(lamports, 'amountXrs');
    return this.execute(Instructions.unwrapXrs(lamports));
  }

  /**
   * Delegated ContractCall with JSON-object args. The node derives the spend
   * ceiling from the method (`DELEGATED_CALL_METHODS`, `ledger.rs:2138-2175`)
   * and executes as the owner. Launchpad and RWA contracts are rejected on
   * this path (`ledger.rs:6554-6561`), as are `confirm`/`verify` and any
   * method not in the table; `checks.agentInner` refuses those it can see
   * before signing. `bigint` values are converted to JSON numbers when
   * ≤ 2^53-1, otherwise refused.
   * @param {string} contractId not starting with `agent_registry_` (`ledger.rs:6428-6431`)
   * @param {string} method one of `DELEGATED_CALL_METHODS`
   * @param {object} args plain object; shapes in blueprint §7.3
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError} for non-object args (raw bytes are rejected by the node, `ledger.rs:6436-6441`)
   * @throws {RangeError|FeatureDisabledError|XerisError|RpcError}
   */
  async callContract(contractId, method, args) {
    assertArity(arguments.length, 3, 'XerisAgent.callContract', 'contractId, method, args');
    assertString(contractId, 'contractId');
    assertString(method, 'method');
    if (!isPlainObject(args)) {
      throw new TypeError(`args: a delegated ContractCall takes a plain object (JSON); raw bytes are rejected by the node (ledger.rs:6436-6441); got ${describe(args)}`);
    }
    return this.execute(Instructions.contractCall(contractId, method, jsonValue(args, 'args')));
  }

  /**
   * Delegated Swap `add_liquidity` with the five fields the node requires,
   * all > 0 (`contracts.rs:2214-2231`); the agent's budget is charged the
   * accepted deposit from `quote_add_liquidity` (`ledger.rs:6448-6459`).
   * @param {string} poolId
   * @param {number|bigint} amountA max token_a to deposit (base units)
   * @param {number|bigint} amountB max token_b to deposit
   * @param {number|bigint} minLpShares minimum LP shares accepted
   * @param {number|bigint} minAmountA minimum token_a actually taken
   * @param {number|bigint} minAmountB minimum token_b actually taken
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|FeatureDisabledError|XerisError|RpcError}
   */
  async addLiquidity(poolId, amountA, amountB, minLpShares, minAmountA, minAmountB) {
    assertArity(arguments.length, 6, 'XerisAgent.addLiquidity', 'poolId, amountA, amountB, minLpShares, minAmountA, minAmountB');
    assertString(poolId, 'poolId');
    const args = {
      amount_a: jsonU64(amountA, 'amountA'),
      amount_b: jsonU64(amountB, 'amountB'),
      min_lp_shares: jsonU64(minLpShares, 'minLpShares'),
      min_amount_a: jsonU64(minAmountA, 'minAmountA'),
      min_amount_b: jsonU64(minAmountB, 'minAmountB'),
    };
    checks.liquidityArgs(args);
    return this.callContract(poolId, 'add_liquidity', args);
  }

  /**
   * Delegated Swap `remove_liquidity` with `{shares, min_amount_a, min_amount_b}`
   * (`contracts.rs:2378-2384`); budgeted as `shares` (`ledger.rs:2147`).
   * @param {string} poolId
   * @param {number|bigint} shares LP shares to burn, > 0
   * @param {number|bigint} minAmountA minimum token_a out
   * @param {number|bigint} minAmountB minimum token_b out
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|FeatureDisabledError|XerisError|RpcError}
   */
  async removeLiquidity(poolId, shares, minAmountA, minAmountB) {
    assertArity(arguments.length, 4, 'XerisAgent.removeLiquidity', 'poolId, shares, minAmountA, minAmountB');
    assertString(poolId, 'poolId');
    checks.positive(shares, 'shares');
    const args = {
      shares: jsonU64(shares, 'shares'),
      min_amount_a: jsonU64(minAmountA, 'minAmountA'),
      min_amount_b: jsonU64(minAmountB, 'minAmountB'),
    };
    return this.callContract(poolId, 'remove_liquidity', args);
  }

  // --------------------------------------------------------------------------
  // Planner (POST /agent/plan, read-only; network.rs:5386-5577)
  // --------------------------------------------------------------------------

  /**
   * Plans a transfer from the owner: `{action:'transfer', from: owner, to, amount_xrs}`
   * (`network.rs:5394-5417`). `amount_xrs` is a JSON number the node parses
   * as f64 and truncates to lamports, so pass a `number`.
   * @param {string} to
   * @param {number} amountXrs
   * @returns {Promise<AgentPlan>}
   * @throws {TypeError|RangeError|RpcError}
   */
  async planTransfer(to, amountXrs) {
    assertArity(arguments.length, 2, 'XerisAgent.planTransfer', 'to, amountXrs');
    return this._client.planTransfer(this._ownerPubkey, to, amountXrs);
  }

  /**
   * Plans an AMM swap: `{action:'swap', pool_id, token_in, amount_in, slippage_pct}`
   * (`network.rs:5418-5481`). The plan's `params.args` is the 16-byte binary
   * swap payload, which cannot be delegated (`swapTokens` throws); convert
   * with `fromPlan` and sign it with the owner key.
   * @param {string} poolId
   * @param {string} tokenIn
   * @param {number|bigint} amountIn base units
   * @param {number} slippagePct 0..100
   * @returns {Promise<AgentPlan>}
   * @throws {TypeError|RangeError|RpcError}
   */
  async planSwap(poolId, tokenIn, amountIn, slippagePct) {
    assertArity(arguments.length, 4, 'XerisAgent.planSwap', 'poolId, tokenIn, amountIn, slippagePct');
    return this._client.planSwap(poolId, tokenIn, amountIn, slippagePct);
  }

  /**
   * Plans a launchpad buy: `{action:'buy_launchpad', launchpad_id, xrs_amount, slippage_pct}`
   * (`network.rs:5482-5532`). Launchpad calls cannot be delegated
   * (`buyOnLaunchpad` throws); the owner signs the plan directly.
   * @param {string} launchpadId
   * @param {number|bigint} xrsAmount lamports of wrapped XRS
   * @param {number} slippagePct 0..100
   * @returns {Promise<AgentPlan>}
   * @throws {TypeError|RangeError|RpcError}
   */
  async planBuy(launchpadId, xrsAmount, slippagePct) {
    assertArity(arguments.length, 3, 'XerisAgent.planBuy', 'launchpadId, xrsAmount, slippagePct');
    return this._client.planBuyLaunchpad(launchpadId, xrsAmount, slippagePct);
  }

  /**
   * Plans a stake for the owner: `{action:'stake', pubkey: owner, amount_xrs}`
   * (`network.rs:5533-5545`). Delegated Stake is a budget-consuming no-op
   * (`stakeXrs` throws); the owner signs the plan directly.
   * @param {number} amountXrs
   * @returns {Promise<AgentPlan>}
   * @throws {TypeError|RangeError|RpcError}
   */
  async planStake(amountXrs) {
    assertArity(arguments.length, 1, 'XerisAgent.planStake', 'amountXrs');
    return this._client.planStake(this._ownerPubkey, amountXrs);
  }

  /**
   * Plans a wrap: `{action:'wrap', amount_xrs}` (`network.rs:5546-5556`).
   * @param {number} amountXrs
   * @returns {Promise<AgentPlan>}
   * @throws {TypeError|RangeError|RpcError}
   */
  async planWrap(amountXrs) {
    assertArity(arguments.length, 1, 'XerisAgent.planWrap', 'amountXrs');
    return this._client.planWrap(amountXrs);
  }

  /**
   * Plans an unwrap: `{action:'unwrap', amount_xrs}` (`network.rs:5557-5567`).
   * @param {number} amountXrs
   * @returns {Promise<AgentPlan>}
   * @throws {TypeError|RangeError|RpcError}
   */
  async planUnwrap(amountXrs) {
    assertArity(arguments.length, 1, 'XerisAgent.planUnwrap', 'amountXrs');
    return this._client.planUnwrap(amountXrs);
  }

  // --------------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------------

  /**
   * Open and claimed tasks from `GET /tasks` (`network.rs:5640-5659`),
   * filtered client-side by exact match: `required_category === category`,
   * `status === status`, `required_tags.includes(tag)` (`TaskEntry`,
   * `contracts.rs:864-907`). Unknown filter keys are refused.
   * @param {{category?: string, status?: string, tag?: string}} [filters={}]
   * @returns {Promise<TaskEntry[]>}
   * @throws {TypeError|RangeError} for a malformed filter
   * @throws {RpcError} when the node body has no `data` array
   */
  async findTasks(filters = {}) {
    if (filters === null || typeof filters !== 'object' || Array.isArray(filters)) {
      throw new TypeError(`filters: expected an object { category?, status?, tag? }, got ${describe(filters)}`);
    }
    for (const key of Object.keys(filters)) {
      if (!TASK_FILTER_KEYS.includes(key)) {
        throw new RangeError(`filters.${key}: unknown filter; expected only ${TASK_FILTER_KEYS.join(', ')}`);
      }
      if (filters[key] !== undefined) assertString(filters[key], `filters.${key}`);
    }
    const { category, status, tag } = filters;
    const res = await this._client.getTasks();
    const data = res !== null && typeof res === 'object' ? res.data : undefined;
    if (!Array.isArray(data)) {
      throw new RpcError('GET /tasks: response has no data array', { route: 'GET /tasks', body: res });
    }
    return data.filter((t) => t !== null && typeof t === 'object'
      && (category === undefined || t.required_category === category)
      && (status === undefined || t.status === status)
      && (tag === undefined || (Array.isArray(t.required_tags) && t.required_tags.includes(tag))));
  }

  /**
   * Owner's native balance in lamports (JSON-RPC `getBalance`).
   * @returns {Promise<number>}
   * @throws {RpcError}
   */
  async getBalance() {
    return this._client.getBalance(this._ownerPubkey);
  }

  /**
   * Owner's token balances: `GET /token/accounts/{owner}` (`network.rs:5186-5211`).
   * @returns {Promise<object>}
   * @throws {RpcError}
   */
  async getTokenAccounts() {
    return this._client.getTokenAccounts(this._ownerPubkey);
  }

  /**
   * `GET /capabilities` (`network.rs:5619-5632`).
   * @returns {Promise<object>} `{success, count, data}`
   * @throws {RpcError}
   */
  async getCapabilities() {
    return this._client.getCapabilities();
  }

  /**
   * `GET /capabilities/search` (`network.rs:5583-5615`).
   * @param {{category?: string, tags?: string[], region?: string, minRep?: number, maxPrice?: number|bigint, limit?: number}} params
   * @returns {Promise<object>} `{success, data: CapabilityListing[]}`
   * @throws {RpcError}
   */
  async searchCapabilities(params) {
    return this._client.searchCapabilities(params);
  }

  // --------------------------------------------------------------------------
  // Delegations the node refuses (throw synchronously, no I/O)
  // --------------------------------------------------------------------------

  /**
   * AMM swaps cannot be delegated: the inner ContractCall args must be a
   * JSON object and `swap_a_to_b`/`swap_b_to_a` have no entry in
   * `delegated_call_spend` (`ledger.rs:6436-6469, 2138-2175`). Use `planSwap`
   * and have the owner sign (`XerisClient.swap` / `XerisDApp.swapTokens`).
   * @returns {never}
   * @throws {FeatureDisabledError} always (`feature: 'agentSwap'`)
   */
  swapTokens() {
    throw disabledFeature('agentSwap');
  }

  /**
   * Launchpad contracts are rejected on the delegated path (XWC-07,
   * `ledger.rs:6554-6556`); the owner signs `buy_tokens` directly.
   * @returns {never}
   * @throws {FeatureDisabledError} always (`feature: 'agentLaunchpad'`)
   */
  buyOnLaunchpad() {
    throw disabledFeature('agentLaunchpad');
  }

  /**
   * Launchpad contracts are rejected on the delegated path (XWC-07,
   * `ledger.rs:6554-6556`); the owner signs `sell_tokens` directly.
   * @returns {never}
   * @throws {FeatureDisabledError} always (`feature: 'agentLaunchpad'`)
   */
  sellOnLaunchpad() {
    throw disabledFeature('agentLaunchpad');
  }

  /**
   * Delegated Stake executes as a no-op that still consumes the agent's
   * budget (`ledger.rs:6474, 6648-6657`; `token.rs:1183-1200`); the owner
   * stakes directly.
   * @returns {never}
   * @throws {FeatureDisabledError} always (`feature: 'agentStake'`)
   */
  stakeXrs() {
    throw disabledFeature('agentStake');
  }

  /**
   * Delegated Unstake executes as a no-op that still consumes the agent's
   * budget (`ledger.rs:6475, 6648-6657`; `token.rs:1183-1200`); the owner
   * unstakes directly.
   * @returns {never}
   * @throws {FeatureDisabledError} always (`feature: 'agentStake'`)
   */
  unstakeXrs() {
    throw disabledFeature('agentStake');
  }

  /**
   * SubDelegate (variant 22) is refused at ingress (`ledger.rs:1445-1450`)
   * and skipped in blocks (`ledger.rs:6911-6914`); the owner registers each
   * agent directly with RegisterAgent.
   * @returns {never}
   * @throws {FeatureDisabledError} always (`feature: 'SubDelegate'`)
   */
  subDelegate() {
    throw disabledFeature('SubDelegate');
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  /**
   * Signs and submits one instruction with the agent key via `POST /submit`.
   * @private
   * @param {Buffer} instruction
   * @returns {Promise<SubmitResult>}
   */
  async _send(instruction) {
    return this._client.sendInstruction(this._keypair, instruction);
  }
}

module.exports = { XerisAgent };
