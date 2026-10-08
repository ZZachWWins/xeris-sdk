'use strict';

/**
 * @file `XerisDApp`: browser adapter in which an injected wallet provider
 * (`window.xeris`) holds the key and signs. The SDK builds the transaction,
 * hands it to the provider, submits the signed bytes to `POST /submit`
 * itself (`network.rs:4664-4858`) and parses the node's reply, so every
 * node error surfaces as an `RpcError` (blueprint D6).
 *
 * Provider interface (`XerisWalletProvider`, blueprint §11.1):
 *   connect(opts?: { onlyIfTrusted?: boolean })
 *     → Promise<{ publicKey: PublicKey | string } | string>            required
 *   signTransaction?(tx: Transaction)
 *     → Promise<Transaction | Uint8Array | { signature } | { signedTransaction }>
 *   signAndSendTransaction?(tx: Transaction) → Promise<{ signature: string }>
 *       used only when signTransaction is absent; the wallet must then POST
 *       {tx_base64} to /submit itself and relay the node's {status, signature}
 *   signMessage?(message: Uint8Array) → Promise<{ signature: Uint8Array }>
 *   disconnect?() → Promise<void>
 *   getRpcUrl?() → Promise<string>
 *   on?(event: 'disconnect' | 'accountChanged', handler) / off?(event, handler)
 *
 * The three Xeris sites type the provider with exactly
 * `connect/disconnect/signTransaction/signAllTransactions/signMessage/on/off`
 * (`XerisDex/src/context/WalletContext.tsx:6-15`).
 *
 * Node rules applied before any network call come from `checks` in
 * `src/client.js` (blueprint D2); this file only wires them to the wallet.
 */

const { Buffer } = require('buffer');
const {
  XerisClient, checks, onlyKeys, CLIENT_OPTION_KEYS,
} = require('./client');
const {
  assertInstructionSubmittable,
  buildTransaction,
  serializedFromWalletResult,
} = require('./transaction');
const { Instructions, encodeSwapCall } = require('./instructions/index');
const {
  assertString, normalizeU64, toBytes, xrsToLamports, stringifyJson,
} = require('./encoding');
const { XerisError, disabledFeature } = require('./errors');
const {
  TESTNET_SEED, DEFAULT_RPC_PORT, DEFAULT_EXPLORER_PORT, MAX_IX_PER_TX,
} = require('./constants');
const bs58 = require('bs58');

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/** Events `XerisDApp.on` accepts. */
const EVENTS = Object.freeze(['connect', 'disconnect', 'accountChanged']);

/** Networks `opts.network` accepts; `'testnet'` is the fixed SDK default (blueprint §11.2). */
const NETWORKS = Object.freeze(['testnet', 'mainnet']);

/** Keys the constructor accepts: the `XerisClient` options plus `provider`, `host` and `network`. */
const DAPP_OPTION_KEYS = Object.freeze([...CLIENT_OPTION_KEYS, 'provider', 'host', 'network']);

// The two AMM methods whose `args` the dispatcher passes through as raw bytes
// when the payload is exactly 16 bytes (ledger.rs:2367-2370; the engine reads
// `input_amount` at bytes 0..8 and `min_output` at 8..16,
// contracts.rs:2419-2441 and 2484-2499). Every other method needs a JSON
// object (ledger.rs:2359-2365).
const SWAP_METHODS = Object.freeze(['swap_a_to_b', 'swap_b_to_a']);

/** Poll interval of `waitForProvider`, in ms. */
const PROVIDER_POLL_MS = 100;


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
 * True for a `Buffer` or `Uint8Array` (not `number[]`, not a string).
 * @param {unknown} v
 * @returns {boolean}
 */
function isByteArray(v) {
  return v instanceof Uint8Array
    || (ArrayBuffer.isView(v) && Object.prototype.toString.call(v) === '[object Uint8Array]');
}

/**
 * True for a plain object (`{}`), the only shape `ContractCall.args` may take
 * as JSON (`ledger.rs:2359-2365`: "contract args must be a JSON object").
 * @param {unknown} v
 * @returns {boolean}
 */
function isPlainObject(v) {
  return Object.prototype.toString.call(v) === '[object Object]';
}

/**
 * Builds the `XerisError` (`code: 'provider'`) used for every wallet-side
 * failure: missing provider, missing method, rejected or malformed result.
 * @param {string} message
 * @param {unknown} [cause]
 * @returns {XerisError}
 */
function providerError(message, cause) {
  return new XerisError(message, cause === undefined ? { code: 'provider' } : { code: 'provider', cause });
}

/**
 * Message text of a thrown value, for wrapping provider rejections.
 * @param {unknown} e
 * @returns {string}
 */
function causeText(e) {
  if (e && typeof e === 'object' && typeof e.message === 'string') return e.message;
  return String(e);
}

/**
 * Throws `TypeError` unless a wrapper was called with exactly `expected`
 * arguments. Bincode has no field names, so a dropped positional argument
 * would shift every later field on the wire; the error is raised here, with
 * the wrapper's name, before the builder sees it.
 * @param {number} actual `arguments.length`
 * @param {number} expected
 * @param {string} name e.g. `XerisDApp.transferXrs`
 * @param {string} fields comma-separated parameter list
 * @returns {void}
 */
function assertArity(actual, expected, name, fields) {
  if (actual !== expected) {
    throw new TypeError(`${name} expects exactly ${expected} arguments (${fields}), got ${actual}`);
  }
}



/**
 * Checks that a `ContractCall`/`ContractDeploy` JSON argument is a plain
 * object and returns it unchanged. Its values are checked when it is written
 * by `stringifyJson` (inside `Instructions.contractCall`, or here for deploy
 * parameters): `bigint` becomes an exact JSON integer, and anything
 * `JSON.stringify` would round, null or drop throws.
 * @param {unknown} args
 * @param {string} field
 * @returns {object}
 * @throws {TypeError}
 */
function jsonArgs(args, field) {
  if (!isPlainObject(args)) {
    throw new TypeError(`${field}: expected a plain object (JSON), got ${describe(args)}`);
  }
  return args;
}

/**
 * Interprets a node URL that names one of the two servers. Only a bare
 * `scheme://host:<defaultPort>` (no path) identifies the node host, from
 * which the other server's URL can be derived by port (RPC 56001, explorer
 * 50008; `main.rs:831-832, 839-840`). Any other URL (another port, no port,
 * a path behind a gateway) is kept exactly as given and says nothing about
 * where the other server is.
 * @param {unknown} raw
 * @param {string} source what produced the value, for error messages
 * @param {number} defaultPort `DEFAULT_RPC_PORT` or `DEFAULT_EXPLORER_PORT`
 * @returns {{host: string|null, url: string}} `host` is set only for a bare default-port URL;
 *   `url` is the input without trailing slashes.
 * @throws {XerisError} `code 'provider'` when `source` is the wallet, else `'config'`
 */
function nodeUrl(raw, source, defaultPort) {
  const code = source.startsWith('provider.') ? 'provider' : 'config';
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new XerisError(`${source} returned ${describe(raw)}; expected an absolute http(s) URL`, { code });
  }
  const text = raw.trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(text);
  } catch (e) {
    throw new XerisError(`${source} returned '${text}', which is not an absolute http(s) URL`, { code, cause: e });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new XerisError(`${source} returned '${text}'; only http: and https: URLs are supported`, { code });
  }
  const bare = url.port === String(defaultPort) && (url.pathname === '/' || url.pathname === '')
    && url.search === '' && url.hash === '' && url.username === '' && url.password === '';
  return { host: bare ? `${url.protocol}//${url.hostname}` : null, url: text };
}

/**
 * Extracts a base58 public key string from what `provider.connect()` or an
 * `accountChanged` event delivered: a string, or an object exposing
 * `toBase58()`/`toString()` (web3.js `PublicKey`). Returns `null` for
 * `null`/`undefined`.
 * @param {unknown} value
 * @returns {string|null}
 */
function publicKeyString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' || typeof value === 'function') {
    if (typeof value.toBase58 === 'function') return String(value.toBase58());
    if (typeof value.toString === 'function' && value.toString !== Object.prototype.toString) {
      return String(value.toString());
    }
  }
  return null;
}

/**
 * True when `checks.pubkey` accepts `s` (canonical base58 of 32 bytes,
 * `ledger.rs:1569-1577`).
 * @param {unknown} s
 * @returns {boolean}
 */
function isCanonical(s) {
  if (typeof s !== 'string') return false;
  try {
    checks.pubkey(s, 'publicKey');
    return true;
  } catch (e) {
    if (e instanceof RangeError || e instanceof TypeError) return false;
    throw e;
  }
}

/**
 * Normalises `Buffer | Buffer[]` into a `Buffer[]` of 1..`MAX_IX_PER_TX`
 * entries (`ledger.rs:94`; `network.rs:145-197`), running
 * `assertInstructionSubmittable` on each so a disabled variant, an oversize
 * payload or data that does not decode is refused before any I/O.
 * @param {Buffer|Uint8Array|Array<Buffer|Uint8Array>} instructionData
 * @returns {Buffer[]}
 * @throws {TypeError|RangeError|EncodingError|FeatureDisabledError}
 */
function instructionList(instructionData) {
  const list = Array.isArray(instructionData) ? instructionData : [instructionData];
  if (list.length < 1 || list.length > MAX_IX_PER_TX) {
    throw new RangeError(`instructionData: a transaction carries 1..${MAX_IX_PER_TX} instructions, got ${list.length}`);
  }
  return list.map((entry, i) => {
    const field = Array.isArray(instructionData) ? `instructionData[${i}]` : 'instructionData';
    const bytes = toBytes(entry, field);
    assertInstructionSubmittable(bytes, i);
    return bytes;
  });
}

// ---------------------------------------------------------------------------
// XerisDApp
// ---------------------------------------------------------------------------

/**
 * Browser dApp adapter: the injected wallet signs, the SDK encodes, submits
 * and reads. Write methods return the node's `/submit` body
 * (`{status:'ok', signature}` = mempool admission, `network.rs:4847-4856`);
 * poll `waitForConfirmation` for inclusion.
 */
class XerisDApp {
  /**
   * @param {object} [opts={}]
   * @param {object} [opts.provider] Wallet provider to use instead of detecting `window.xeris`.
   * @param {string} [opts.host] Node base URL with scheme, e.g. `'http://138.197.116.81'`; ports default to 56001/50008.
   * @param {string} [opts.rpcUrl] Full RPC base URL (overrides host+port).
   * @param {string} [opts.explorerUrl] Full explorer base URL (overrides host+port).
   * @param {number} [opts.rpcPort] RPC port when deriving from `host` (default `DEFAULT_RPC_PORT`).
   * @param {number} [opts.explorerPort] Explorer port when deriving from `host` (default `DEFAULT_EXPLORER_PORT`).
   * @param {'testnet'|'mainnet'} [opts.network='testnet'] Fixed SDK default: when no host can be
   *   resolved, `'testnet'` falls back to `http://TESTNET_SEED`; `'mainnet'` has no built-in host
   *   (`network.rs:282-300`) and requires `opts.host`/`opts.rpcUrl` or `provider.getRpcUrl()`.
   * @param {Function} [opts.fetch] `fetch` implementation (default `globalThis.fetch`).
   * @param {number} [opts.timeoutMs] Per-request timeout for the internal `XerisClient`.
   * @throws {TypeError|RangeError|XerisError} on malformed options; `RangeError` for an unknown key
   *   (a misspelt `network` would otherwise fall back to testnet)
   */
  constructor(opts = {}) {
    if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
      throw new TypeError(`XerisDApp: opts must be an object, got ${describe(opts)}`);
    }
    onlyKeys(opts, DAPP_OPTION_KEYS, 'opts', { timeout: 'timeoutMs' });
    const network = opts.network === undefined ? 'testnet' : opts.network;
    if (!NETWORKS.includes(network)) {
      throw new RangeError(`opts.network: expected one of ${NETWORKS.map((n) => `'${n}'`).join(', ')}, got ${describe(opts.network)}`);
    }
    if (opts.provider !== undefined
      && (opts.provider === null || (typeof opts.provider !== 'object' && typeof opts.provider !== 'function'))) {
      throw new TypeError(`opts.provider: expected a wallet provider object, got ${describe(opts.provider)}`);
    }
    for (const key of ['host', 'rpcUrl', 'explorerUrl']) {
      if (opts[key] !== undefined && typeof opts[key] !== 'string') {
        throw new TypeError(`opts.${key}: expected a string, got ${describe(opts[key])}`);
      }
    }

    /** @private */ this._network = network;
    /** @private */ this._opts = Object.freeze({
      host: opts.host,
      rpcUrl: opts.rpcUrl,
      explorerUrl: opts.explorerUrl,
      rpcPort: opts.rpcPort,
      explorerPort: opts.explorerPort,
      fetch: opts.fetch,
      timeoutMs: opts.timeoutMs,
    });
    /** @private */ this._provider = opts.provider === undefined ? null : opts.provider;
    /** @private */ this._publicKey = null;
    /** @private */ this._connected = false;
    /** @private */ this._client = null;
    /** @private */ this._listeners = { connect: [], disconnect: [], accountChanged: [] };
    /** @private */ this._providerHandlers = null;

    // When the node is known from the options alone, the client exists before
    // connect() so read methods work without a wallet. Otherwise connect()
    // resolves it from provider.getRpcUrl() or the network default.
    const staticHost = this._staticHost();
    if (staticHost !== undefined) {
      this._client = new XerisClient(staticHost, this._clientOptions());
    }
  }

  // --------------------------------------------------------------------------
  // Provider detection
  // --------------------------------------------------------------------------

  /**
   * Returns the injected Xeris wallet provider: `window.xeris`, else
   * `window.solana` when it sets `isXeris`, else `null`. A `window.solana`
   * without `isXeris` (for example a Solana-only wallet) is not used: it would
   * be asked to sign XerisCoin transactions. 4.x fell back to it; pass such a
   * provider explicitly with `opts.provider` if that is intended.
   * @returns {object|null}
   */
  static detectProvider() {
    if (typeof window === 'undefined' || window === null) return null;
    if (window.xeris) return window.xeris;
    if (window.solana && window.solana.isXeris === true) return window.solana;
    return null;
  }

  /**
   * Polls `detectProvider()` every 100 ms until a provider appears or
   * `timeoutMs` elapses (wallet extensions inject `window.xeris` after the
   * page's own scripts have started). Resolves `null` immediately outside a
   * browser. 4.x additionally listened for `wallet-standard:app-ready`; that
   * event is dispatched by the app under the Wallet Standard, not by a wallet,
   * so it is no longer used.
   * @param {number} [timeoutMs=3000]
   * @returns {Promise<object|null>}
   * @throws {TypeError|RangeError} for a non-finite or negative timeout
   */
  static waitForProvider(timeoutMs = 3000) {
    if (typeof timeoutMs !== 'number') throw new TypeError(`timeoutMs: expected a number, got ${describe(timeoutMs)}`);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError(`timeoutMs: expected a finite number >= 0, got ${timeoutMs}`);
    return new Promise((resolve) => {
      const found = XerisDApp.detectProvider();
      if (found) { resolve(found); return; }
      if (typeof window === 'undefined' || window === null || timeoutMs === 0) { resolve(null); return; }

      const start = Date.now();
      const timer = setInterval(() => {
        const p = XerisDApp.detectProvider();
        if (p) { clearInterval(timer); resolve(p); return; }
        if (Date.now() - start >= timeoutMs) { clearInterval(timer); resolve(null); }
      }, PROVIDER_POLL_MS);
    });
  }

  // --------------------------------------------------------------------------
  // State
  // --------------------------------------------------------------------------

  /** @returns {string|null} Connected wallet public key (base58), or `null`. */
  get publicKey() { return this._publicKey; }

  /** @returns {boolean} True between a successful `connect()` and a disconnect. */
  get connected() { return this._connected; }

  /** @returns {object|null} The wallet provider in use (given, detected, or `null`). */
  get provider() { return this._provider; }

  /**
   * @returns {XerisClient|null} The internal client: available from
   *   construction when `opts.host` or `opts.rpcUrl`/`opts.explorerUrl` was
   *   given, otherwise after `connect()`.
   */
  get client() { return this._client; }

  // --------------------------------------------------------------------------
  // Connection
  // --------------------------------------------------------------------------

  /**
   * Resolves the provider, asks it to connect, resolves the node base URL and
   * creates the internal `XerisClient`.
   *
   * Base URL precedence: `opts.rpcUrl`/`opts.explorerUrl` → `opts.host` →
   * `await provider.getRpcUrl()` → `http://TESTNET_SEED` when
   * `opts.network === 'testnet'`; on `'mainnet'` with none of these,
   * `XerisError` (`code 'config'`).
   *
   * A `getRpcUrl()` result of the form `scheme://host:56001` (no path) names
   * the node host, and the explorer is taken as `scheme://host:50008`. Any
   * other URL (another port, no port, a path) is used unchanged as the RPC
   * URL, and the explorer URL must then come from `opts.explorerUrl` or the
   * provider's optional `getExplorerUrl()`; without either, `connect` throws
   * `XerisError` (`code 'config'`) rather than guess.
   * @param {object} [opts={}]
   * @param {boolean} [opts.onlyIfTrusted=false] Passed to `provider.connect`.
   * @returns {Promise<{publicKey: string}>}
   * @throws {XerisError} `code 'provider'` when no provider is found, `provider.connect` is
   *   missing or rejects, or it returns no usable public key; `code 'config'` for mainnet
   *   without a host, or a non-default `getRpcUrl()` with no explorer URL available.
   * @throws {RangeError} when the wallet's public key is not canonical (`ledger.rs:1569-1577`)
   */
  async connect(opts = {}) {
    if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
      throw new TypeError(`connect: opts must be an object, got ${describe(opts)}`);
    }
    onlyKeys(opts, ['onlyIfTrusted'], 'opts');
    const onlyIfTrusted = opts.onlyIfTrusted === undefined ? false : opts.onlyIfTrusted;
    if (typeof onlyIfTrusted !== 'boolean') {
      throw new TypeError(`opts.onlyIfTrusted: expected a boolean, got ${describe(opts.onlyIfTrusted)}`);
    }

    // 1. Provider.
    let provider = this._provider;
    if (provider === null) provider = XerisDApp.detectProvider();
    if (provider === null) provider = await XerisDApp.waitForProvider(2000);
    if (provider === null) throw providerError('no Xeris wallet provider found (window.xeris)');
    if (typeof provider.connect !== 'function') throw providerError('wallet provider has no connect() method');

    // Fail before the wallet prompt when mainnet can never resolve a host.
    if (this._client === null && this._network === 'mainnet' && this._opts.rpcUrl === undefined
      && typeof provider.getRpcUrl !== 'function') {
      throw new XerisError('mainnet requires opts.host or opts.rpcUrl, or a provider that implements getRpcUrl()', { code: 'config' });
    }

    // 2. Wallet approval and public key.
    let result;
    try {
      result = await provider.connect({ onlyIfTrusted });
    } catch (e) {
      throw providerError(`provider.connect() failed: ${causeText(e)}`, e);
    }
    const publicKey = typeof result === 'string'
      ? result
      : publicKeyString(result && typeof result === 'object' ? result.publicKey : undefined);
    if (publicKey === null) {
      throw providerError(`provider.connect() returned ${describe(result)}; expected { publicKey } or a base58 string`);
    }
    checks.pubkey(publicKey, 'publicKey');

    // 3. Node base URL.
    if (this._client === null) this._client = await this._resolveClient(provider);

    // 4. State and event forwarding.
    this._provider = provider;
    this._publicKey = publicKey;
    this._connected = true;
    this._attachProviderEvents(provider);
    this._emit('connect', { publicKey });
    return { publicKey };
  }

  /**
   * Calls `provider.disconnect()` when it exists, stops forwarding provider
   * events, clears the public key and emits `'disconnect'` once.
   * @returns {Promise<void>}
   * @throws {XerisError} `code 'provider'` when `provider.disconnect()` rejects
   */
  async disconnect() {
    const provider = this._provider;
    this._detachProviderEvents();
    if (provider !== null && typeof provider.disconnect === 'function') {
      try {
        await provider.disconnect();
      } catch (e) {
        throw providerError(`provider.disconnect() failed: ${causeText(e)}`, e);
      }
    }
    this._publicKey = null;
    this._connected = false;
    this._emit('disconnect', undefined);
  }

  /**
   * Registers a listener. `'connect'` receives `{publicKey}`, `'disconnect'`
   * nothing, `'accountChanged'` the new base58 key or `null`.
   * @param {'connect'|'disconnect'|'accountChanged'} event
   * @param {Function} callback
   * @returns {void}
   * @throws {RangeError|TypeError}
   */
  on(event, callback) {
    this._listenerList(event).push(this._assertCallback(callback));
  }

  /**
   * Removes a listener registered with `on`.
   * @param {'connect'|'disconnect'|'accountChanged'} event
   * @param {Function} callback
   * @returns {void}
   * @throws {RangeError|TypeError}
   */
  off(event, callback) {
    const list = this._listenerList(event);
    this._assertCallback(callback);
    const i = list.indexOf(callback);
    if (i !== -1) list.splice(i, 1);
  }

  // --------------------------------------------------------------------------
  // Signing and submission
  // --------------------------------------------------------------------------

  /**
   * Builds a transaction from encoded instruction bytes, has the wallet sign
   * it and submits it.
   *
   * With `provider.signTransaction` the SDK resolves the wallet's result
   * (`serializedFromWalletResult`, blueprint §9.6), POSTs `{tx_base64}` to
   * `/submit` (`network.rs:1577-1578, 4664-4675`) and returns the parsed node
   * body. With only `provider.signAndSendTransaction` the wallet submits and
   * the result is normalised to `{status:'ok', signature}`.
   *
   * The transaction passes `buildTransaction`'s checks (refused variants and
   * the node's semantic gate) before the wallet is asked to sign. When the
   * signed bytes were posted but no usable answer came back, the error
   * carries `signature` and `txBase64` (see `XerisClient.sendInstruction`):
   * poll `waitForConfirmation(err.signature)` or resend `err.txBase64` with
   * `client.submitSignedTransaction`, rather than asking the wallet to sign
   * again.
   * @param {Buffer|Uint8Array|Array<Buffer|Uint8Array>} instructionData 1..16 encoded instructions
   * @returns {Promise<SubmitResult>}
   * @throws {XerisError} `code 'provider'` when not connected, the wallet implements neither
   *   signing method, rejects, or returns an unusable result
   * @throws {FeatureDisabledError} for variants 22, 30, 48, 49, 52 (`ledger.rs:1445-1450, 7460-7464, 8669-8828`)
   * @throws {RangeError|EncodingError} for oversize or malformed instruction data, or an instruction the
   *   node's semantic gate rejects (`ledger.rs:1382-1455`)
   * @throws {RpcError} for any node error body (code `duplicate` when the node already holds it)
   */
  async sendInstruction(instructionData) {
    this._requireConnected();
    const instructions = instructionList(instructionData);
    const provider = this._provider;
    const hasSign = typeof provider.signTransaction === 'function';
    const hasSignAndSend = typeof provider.signAndSendTransaction === 'function';
    if (!hasSign && !hasSignAndSend) {
      throw providerError('wallet provider implements neither signTransaction() nor signAndSendTransaction()');
    }

    const blockhash = await this._client.getLatestBlockhash();
    const payer = this._publicKey;
    const tx = buildTransaction(payer, instructions, blockhash);

    if (hasSign) {
      let signed;
      try {
        signed = await provider.signTransaction(tx);
      } catch (e) {
        throw providerError(`provider.signTransaction() failed: ${causeText(e)}`, e);
      }
      const bytes = serializedFromWalletResult(signed, tx);
      return this._client.submitSignedTransaction(bytes.toString('base64'));
    }

    let sent;
    try {
      sent = await provider.signAndSendTransaction(tx);
    } catch (e) {
      throw providerError(`provider.signAndSendTransaction() failed: ${causeText(e)}`, e);
    }
    const sig = sent && typeof sent === 'object' ? sent.signature : undefined;
    let signature;
    if (typeof sig === 'string' && sig.length > 0) {
      signature = sig;
    } else if (isByteArray(sig) && sig.length === 64) {
      signature = bs58.encode(Buffer.from(sig));
    } else {
      throw providerError(`provider.signAndSendTransaction() returned ${describe(sent)}; expected { signature: string }`);
    }
    return { status: 'ok', signature };
  }

  /**
   * Signs arbitrary bytes with the wallet (`provider.signMessage`). A string
   * is signed as its UTF-8 bytes.
   * @param {Uint8Array|Buffer|string} message
   * @returns {Promise<Buffer>} 64-byte Ed25519 signature
   * @throws {XerisError} `code 'provider'` when not connected, the provider has no
   *   `signMessage`, it rejects, or it returns something other than a 64-byte signature
   * @throws {TypeError|RangeError} for a non-string, non-byte message or a lone surrogate
   */
  async signMessage(message) {
    this._requireConnected();
    const provider = this._provider;
    if (typeof provider.signMessage !== 'function') {
      throw providerError('wallet provider does not implement signMessage()');
    }
    const bytes = typeof message === 'string'
      ? Buffer.from(assertString(message, 'message'), 'utf8')
      : toBytes(message, 'message');
    let result;
    try {
      result = await provider.signMessage(Uint8Array.from(bytes));
    } catch (e) {
      throw providerError(`provider.signMessage() failed: ${causeText(e)}`, e);
    }
    const sig = isByteArray(result) ? result : (result && typeof result === 'object' ? result.signature : undefined);
    if (!isByteArray(sig) || sig.length !== 64) {
      throw providerError(`provider.signMessage() returned ${describe(result)}; expected { signature: Uint8Array(64) }`);
    }
    return Buffer.from(sig);
  }

  /**
   * Polls the explorer until the transaction is found or the window expires.
   * @param {string} signature base58 transaction signature
   * @param {{timeoutMs?: number, intervalMs?: number}} [opts] see `XerisClient.waitForConfirmation`
   * @returns {Promise<TxDetail>}
   * @throws {XerisError} `code 'config'` before a client exists; `code 'timeout'` on expiry
   * @throws {RpcError}
   */
  async waitForConfirmation(signature, opts) {
    const client = this._requireClient();
    return opts === undefined ? client.waitForConfirmation(signature) : client.waitForConfirmation(signature, opts);
  }

  // --------------------------------------------------------------------------
  // Write wrappers (signer = connected wallet; preflight = checks.*)
  // --------------------------------------------------------------------------

  /**
   * NativeTransfer (variant 11) of `amountXrs` XRS from the wallet to `to`.
   * @param {string} to canonical recipient public key, not a `__` pseudo-account (`ledger.rs:1562-1577, 5602`)
   * @param {number|string} amountXrs XRS as a number or decimal string, converted exactly (at most 9 fractional digits)
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|XerisError|RpcError}
   */
  async transferXrs(to, amountXrs) {
    assertArity(arguments.length, 2, 'XerisDApp.transferXrs', 'to, amountXrs');
    const signer = this._requireConnected();
    checks.transferTarget(to);
    const lamports = xrsToLamports(amountXrs, 'amountXrs');
    checks.positive(lamports, 'amountXrs');
    return this.sendInstruction(Instructions.nativeTransfer(signer, to, lamports));
  }

  /**
   * NativeTransfer (variant 11) in base units.
   * @param {string} to canonical recipient public key (`ledger.rs:1562-1577`)
   * @param {number|bigint} lamports amount > 0 (`ledger.rs:1570`)
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|XerisError|RpcError}
   */
  async transferLamports(to, lamports) {
    assertArity(arguments.length, 2, 'XerisDApp.transferLamports', 'to, lamports');
    const signer = this._requireConnected();
    checks.transferTarget(to);
    checks.positive(lamports, 'lamports');
    return this.sendInstruction(Instructions.nativeTransfer(signer, to, lamports));
  }

  /**
   * Stake (variant 9) for the wallet key, submitted through `/submit` (the
   * wallet-signed path does not use the dedicated `/stake` route, so its
   * signer/balance pre-checks, `network.rs:4336-4432`, do not run; the
   * consensus rules below still apply). Staking is federation-gated on a
   * federated node (`network.rs:2407-2417`) and the resulting stake must be
   * at least `MIN_STAKE_LAMPORTS` (`ledger.rs:5713-5718`).
   * @param {number|string} amountXrs XRS, converted exactly
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|XerisError|RpcError}
   */
  async stakeXrs(amountXrs) {
    assertArity(arguments.length, 1, 'XerisDApp.stakeXrs', 'amountXrs');
    const signer = this._requireConnected();
    const lamports = xrsToLamports(amountXrs, 'amountXrs');
    checks.positive(lamports, 'amountXrs');
    return this.sendInstruction(Instructions.stake(signer, lamports));
  }

  /**
   * Unstake (variant 10) for the wallet key through `/submit` (see `stakeXrs`
   * for why `/unstake` is not used). A partial unstake must be at least
   * `MIN_UNSTAKE_LAMPORTS` and must leave either nothing or at least
   * `MIN_STAKE_LAMPORTS` staked (`ledger.rs:5759, 5772-5776`; the `/unstake`
   * route mirrors this at `network.rs:4499-4505`). Unbonding takes
   * `UNBONDING_PERIOD_SLOTS`.
   * @param {number|string} amountXrs XRS, converted exactly
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|XerisError|RpcError}
   */
  async unstakeXrs(amountXrs) {
    assertArity(arguments.length, 1, 'XerisDApp.unstakeXrs', 'amountXrs');
    const signer = this._requireConnected();
    const lamports = xrsToLamports(amountXrs, 'amountXrs');
    checks.positive(lamports, 'amountXrs');
    return this.sendInstruction(Instructions.unstake(signer, lamports));
  }

  /**
   * WrapXrs (variant 13): moves native XRS into the `xrs_native` token
   * balance used by the AMM and launchpads (`ledger.rs:5631-5657`).
   * @param {number|string} amountXrs XRS > 0, converted exactly
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|XerisError|RpcError}
   */
  async wrapXrs(amountXrs) {
    assertArity(arguments.length, 1, 'XerisDApp.wrapXrs', 'amountXrs');
    this._requireConnected();
    const lamports = xrsToLamports(amountXrs, 'amountXrs');
    checks.positive(lamports, 'amountXrs');
    return this.sendInstruction(Instructions.wrapXrs(lamports));
  }

  /**
   * UnwrapXrs (variant 14): moves `xrs_native` token balance back to native
   * XRS (`ledger.rs:5658-5684`).
   * @param {number|string} amountXrs XRS > 0, converted exactly
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|XerisError|RpcError}
   */
  async unwrapXrs(amountXrs) {
    assertArity(arguments.length, 1, 'XerisDApp.unwrapXrs', 'amountXrs');
    this._requireConnected();
    const lamports = xrsToLamports(amountXrs, 'amountXrs');
    checks.positive(lamports, 'amountXrs');
    return this.sendInstruction(Instructions.unwrapXrs(lamports));
  }

  /**
   * TokenTransfer (variant 1) from the wallet. The node requires
   * `signer == from`, `from != to` and `amount > 0` (`token.rs:1104-1114`).
   * @param {string} tokenId
   * @param {string} to recipient (must differ from the wallet key)
   * @param {number|bigint} amount base units of the token (the token's own decimals)
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|XerisError|RpcError}
   */
  async transferToken(tokenId, to, amount) {
    assertArity(arguments.length, 3, 'XerisDApp.transferToken', 'tokenId, to, amount');
    const signer = this._requireConnected();
    assertString(tokenId, 'tokenId');
    assertString(to, 'to');
    checks.positive(amount, 'amount');
    if (to === signer) {
      throw new RangeError('to: must differ from the signer (token.rs:1111 rejects from == to)');
    }
    return this.sendInstruction(Instructions.tokenTransfer(tokenId, signer, to, amount));
  }

  /**
   * AMM swap by input token: reads `GET /contract/{poolId}` and picks
   * `swap_b_to_a` when `state.Swap.token_b === tokenIn`, `swap_a_to_b` when
   * `token_a === tokenIn` (`network.rs:5018-5026`; `contracts.rs:443-460`),
   * then sends the 16-byte binary call (`contracts.rs:2419-2441, 2484-2499`).
   * The wallet must hold the input token as a token balance (wrap XRS first
   * for `xrs_native`).
   * @param {string} poolId Swap contract id
   * @param {string} tokenIn token id being sold
   * @param {number|bigint} amountIn base units > 0
   * @param {number|bigint} minAmountOut base units > 0; the node requires an explicit minimum (`contracts.rs:2423-2432`)
   * @returns {Promise<SubmitResult>}
   * @throws {RangeError} when `tokenIn` is neither pool token or the contract is not a Swap
   * @throws {TypeError|XerisError|RpcError}
   */
  async swapTokens(poolId, tokenIn, amountIn, minAmountOut) {
    assertArity(arguments.length, 4, 'XerisDApp.swapTokens', 'poolId, tokenIn, amountIn, minAmountOut');
    this._requireConnected();
    assertString(poolId, 'poolId');
    assertString(tokenIn, 'tokenIn');
    checks.positive(amountIn, 'amountIn');
    checks.positive(minAmountOut, 'minAmountOut');

    const res = await this._client.getContract(poolId);
    const contract = res && typeof res === 'object' ? res.contract : undefined;
    const swapState = contract && contract.state && typeof contract.state === 'object' ? contract.state.Swap : undefined;
    if (!swapState || typeof swapState !== 'object') {
      throw new RangeError(`poolId: contract '${poolId}' is not a Swap pool (no state.Swap in GET /contract/${poolId})`);
    }
    let method;
    if (swapState.token_b === tokenIn) method = 'swap_b_to_a';
    else if (swapState.token_a === tokenIn) method = 'swap_a_to_b';
    else {
      throw new RangeError(`tokenIn: '${tokenIn}' is neither token_a ('${swapState.token_a}') nor token_b ('${swapState.token_b}') of pool '${poolId}'`);
    }
    return this.sendInstruction(encodeSwapCall(poolId, method, amountIn, minAmountOut));
  }

  /**
   * AMM swap with an explicit direction (`swap_a_to_b` sells `token_a`,
   * `swap_b_to_a` sells `token_b`); args are the 16 raw bytes
   * `u64le(inputAmount) ‖ u64le(minOutput)` (`contracts.rs:2419-2441, 2484-2499`).
   * @param {string} poolId
   * @param {'swap_a_to_b'|'swap_b_to_a'} method
   * @param {number|bigint} inputAmount base units > 0
   * @param {number|bigint} minOutput base units > 0 (`contracts.rs:2423-2432`)
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|XerisError|RpcError}
   */
  async swap(poolId, method, inputAmount, minOutput) {
    assertArity(arguments.length, 4, 'XerisDApp.swap', 'poolId, method, inputAmount, minOutput');
    this._requireConnected();
    assertString(poolId, 'poolId');
    checks.swapMethod(method);
    checks.positive(inputAmount, 'inputAmount');
    checks.positive(minOutput, 'minOutput');
    return this.sendInstruction(encodeSwapCall(poolId, method, inputAmount, minOutput));
  }

  /**
   * Launchpad `buy_tokens` with `{xrs_amount, min_tokens_out}`
   * (`contracts.rs:2842-2850`). The curve debits the buyer's `xrs_native`
   * token balance, so wrap first (`contracts.rs:2852-2857`).
   * @param {string} launchpadId
   * @param {number|bigint} xrsAmount lamports of wrapped XRS to spend, > 0
   * @param {number|bigint} minTokensOut minimum tokens accepted (base units; 0 disables the check on the node)
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|XerisError|RpcError}
   */
  async buyOnLaunchpad(launchpadId, xrsAmount, minTokensOut) {
    assertArity(arguments.length, 3, 'XerisDApp.buyOnLaunchpad', 'launchpadId, xrsAmount, minTokensOut');
    this._requireConnected();
    assertString(launchpadId, 'launchpadId');
    checks.positive(xrsAmount, 'xrsAmount');
    const args = { xrs_amount: normalizeU64(xrsAmount, 'xrsAmount'), min_tokens_out: normalizeU64(minTokensOut, 'minTokensOut') };
    return this.sendInstruction(Instructions.contractCall(launchpadId, 'buy_tokens', args));
  }

  /**
   * Launchpad `sell_tokens` with `{token_amount, min_xrs_out}`
   * (`contracts.rs:2939-2947`); proceeds arrive as `xrs_native` token balance.
   * @param {string} launchpadId
   * @param {number|bigint} tokenAmount base units > 0
   * @param {number|bigint} minXrsOut minimum lamports accepted (0 disables the check on the node)
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|XerisError|RpcError}
   */
  async sellOnLaunchpad(launchpadId, tokenAmount, minXrsOut) {
    assertArity(arguments.length, 3, 'XerisDApp.sellOnLaunchpad', 'launchpadId, tokenAmount, minXrsOut');
    this._requireConnected();
    assertString(launchpadId, 'launchpadId');
    checks.positive(tokenAmount, 'tokenAmount');
    const args = { token_amount: normalizeU64(tokenAmount, 'tokenAmount'), min_xrs_out: normalizeU64(minXrsOut, 'minXrsOut') };
    return this.sendInstruction(Instructions.contractCall(launchpadId, 'sell_tokens', args));
  }

  /**
   * Swap `add_liquidity` with the five fields the node requires, all > 0
   * (`contracts.rs:2214-2231`).
   * @param {string} poolId
   * @param {number|bigint} amountA max token_a to deposit (base units)
   * @param {number|bigint} amountB max token_b to deposit
   * @param {number|bigint} minLpShares minimum LP shares accepted
   * @param {number|bigint} minAmountA minimum token_a actually taken
   * @param {number|bigint} minAmountB minimum token_b actually taken
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|XerisError|RpcError}
   */
  async addLiquidity(poolId, amountA, amountB, minLpShares, minAmountA, minAmountB) {
    assertArity(arguments.length, 6, 'XerisDApp.addLiquidity', 'poolId, amountA, amountB, minLpShares, minAmountA, minAmountB');
    this._requireConnected();
    assertString(poolId, 'poolId');
    const args = {
      amount_a: normalizeU64(amountA, 'amountA'),
      amount_b: normalizeU64(amountB, 'amountB'),
      min_lp_shares: normalizeU64(minLpShares, 'minLpShares'),
      min_amount_a: normalizeU64(minAmountA, 'minAmountA'),
      min_amount_b: normalizeU64(minAmountB, 'minAmountB'),
    };
    checks.liquidityArgs(args);
    return this.sendInstruction(Instructions.contractCall(poolId, 'add_liquidity', args));
  }

  /**
   * Swap `remove_liquidity` with `{shares, min_amount_a, min_amount_b}`
   * (`contracts.rs:2378-2384`).
   * @param {string} poolId
   * @param {number|bigint} shares LP shares to burn, > 0
   * @param {number|bigint} minAmountA minimum token_a out
   * @param {number|bigint} minAmountB minimum token_b out
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|XerisError|RpcError}
   */
  async removeLiquidity(poolId, shares, minAmountA, minAmountB) {
    assertArity(arguments.length, 4, 'XerisDApp.removeLiquidity', 'poolId, shares, minAmountA, minAmountB');
    this._requireConnected();
    assertString(poolId, 'poolId');
    checks.positive(shares, 'shares');
    const args = {
      shares: normalizeU64(shares, 'shares'),
      min_amount_a: normalizeU64(minAmountA, 'minAmountA'),
      min_amount_b: normalizeU64(minAmountB, 'minAmountB'),
    };
    return this.sendInstruction(Instructions.contractCall(poolId, 'remove_liquidity', args));
  }

  /**
   * ContractCall (variant 4). For `swap_a_to_b`/`swap_b_to_a`, `args` must be
   * the 16 raw bytes (`contracts.rs:2419-2441`); for every other method it
   * must be a plain object, sent as JSON (`ledger.rs:2359-2365`; shapes in
   * blueprint §7.3) by `stringifyJson`: `bigint` values become exact JSON
   * integers; an integer `number` above 2^53-1, `NaN`/`Infinity`,
   * `undefined` and functions throw instead of being rounded, nulled or
   * dropped (a missing slippage field is read as 0 by the node,
   * `contracts.rs:2849-2850, 2946-2947`).
   * @param {string} contractId
   * @param {string} method
   * @param {object|Buffer|Uint8Array} args
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|XerisError|RpcError}
   */
  async callContract(contractId, method, args) {
    assertArity(arguments.length, 3, 'XerisDApp.callContract', 'contractId, method, args');
    this._requireConnected();
    assertString(contractId, 'contractId');
    assertString(method, 'method');
    let payload;
    if (SWAP_METHODS.includes(method)) {
      if (!isByteArray(args)) {
        throw new TypeError(`args: ${method} takes 16 raw bytes (u64le input, u64le min_output); pass a Buffer/Uint8Array or use swap()`);
      }
      if (args.length !== 16) {
        throw new RangeError(`args: ${method} takes exactly 16 raw bytes, got ${args.length}`);
      }
      payload = args;
    } else {
      payload = jsonArgs(args, 'args');
    }
    return this.sendInstruction(Instructions.contractCall(contractId, method, payload));
  }

  /**
   * ContractDeploy (variant 5). `contractId` must match
   * `CONTRACT_ID_PATTERN` and avoid the reserved prefixes/suffix
   * (`contracts.rs:1316-1320`; `ledger.rs:1524-1530`); `contractType` must be
   * a `ContractType::from_str` alias that is not protocol-managed
   * (`contracts.rs:385-411`; `ledger.rs:2344-2349`). `params` is sent as JSON.
   * @param {string} contractId
   * @param {string} contractType alias such as `'swap'`, `'escrow'`, `'launchpad'`
   * @param {object} params plain object; shape depends on the type
   * @returns {Promise<SubmitResult>}
   * @throws {TypeError|RangeError|XerisError|RpcError}
   */
  async deployContract(contractId, contractType, params) {
    assertArity(arguments.length, 3, 'XerisDApp.deployContract', 'contractId, contractType, params');
    this._requireConnected();
    assertString(contractId, 'contractId');
    assertString(contractType, 'contractType');
    checks.contractId(contractId);
    checks.contractType(contractType);
    const paramsJson = stringifyJson(jsonArgs(params, 'params'), 'params');
    return this.sendInstruction(Instructions.contractDeploy(contractId, contractType, paramsJson));
  }

  // --------------------------------------------------------------------------
  // Read wrappers (delegate to the internal XerisClient)
  // --------------------------------------------------------------------------

  /**
   * JSON-RPC `getBalance` → lamports (`explorer.rs:1447-1565`).
   * @param {string} [address=this.publicKey]
   * @returns {Promise<number>}
   * @throws {XerisError} `code 'config'` without a client; `code 'provider'` when no address and not connected
   * @throws {RpcError}
   */
  async getBalance(address = this.publicKey) {
    return this._requireClient().getBalance(this._addressArg(address, 'address'));
  }

  /**
   * `GET /token/accounts/{address}` (`network.rs:5186-5211`).
   * @param {string} [address=this.publicKey]
   * @returns {Promise<object>} `{address, native_xrs (lamports), token_accounts}`
   * @throws {XerisError|RpcError}
   */
  async getTokenAccounts(address = this.publicKey) {
    return this._requireClient().getTokenAccounts(this._addressArg(address, 'address'));
  }

  /**
   * Explorer `GET /v2/account/{address}` (`explorer.rs:1251-1284`).
   * @param {string} [address=this.publicKey]
   * @returns {Promise<object>} `{success, data:{address, balance, balance_xrs, stake, is_validator, blocks_proposed}}`
   * @throws {XerisError|RpcError}
   */
  async getAccountInfo(address = this.publicKey) {
    return this._requireClient().getAccountInfo(this._addressArg(address, 'address'));
  }

  /**
   * `GET /launchpads` (`network.rs:5215-5271`).
   * @returns {Promise<object>} `{launchpads: [...]}`
   * @throws {XerisError|RpcError}
   */
  async getLaunchpads() {
    return this._requireClient().getLaunchpads();
  }

  /**
   * `GET /launchpad/{id}/quote?xrs_amount=` (`network.rs:5274-5327`).
   * @param {string} launchpadId
   * @param {number|bigint} xrsAmountLamports
   * @returns {Promise<object>} `{xrs_amount, tokens_out, creator_fee, xeris_fee, total_fees, effective_price, price_after, price_impact_pct}`
   * @throws {XerisError|RpcError}
   */
  async getLaunchpadQuote(launchpadId, xrsAmountLamports) {
    return this._requireClient().getLaunchpadQuote(launchpadId, xrsAmountLamports);
  }

  /**
   * `GET /contracts` (`network.rs:5029-5045`).
   * @returns {Promise<object>} `{success, count, contracts}`
   * @throws {XerisError|RpcError}
   */
  async getContracts() {
    return this._requireClient().getContracts();
  }

  /**
   * `GET /contract/{id}` (`network.rs:5018-5026`); not found → `RpcError('Contract not found')`.
   * @param {string} contractId
   * @returns {Promise<object>} `{success:true, contract:{contract_id, contract_type, owner, created_slot, state, is_active}}`
   * @throws {XerisError|RpcError}
   */
  async getContract(contractId) {
    return this._requireClient().getContract(contractId);
  }

  /**
   * AMM quote: `GET /contract/{poolId}/quote?input_token=&amount=` (`network.rs:5048-5066`).
   * @param {string} poolId
   * @param {string} inputToken
   * @param {number|bigint} amount base units > 0
   * @returns {Promise<object>} `{success, quote:{input_token, input_amount, output_token, output_amount, fee, fee_bps, price_impact_pct, effective_price}}`
   * @throws {XerisError|RpcError}
   */
  async getSwapQuote(poolId, inputToken, amount) {
    return this._requireClient().getContractQuote(poolId, inputToken, amount);
  }

  /**
   * Explorer `GET /v2/pools` (`explorer.rs:1970-2120`).
   * @param {{after?: string, limit?: number}} [opts]
   * @returns {Promise<object>} `{success, count, next_after, pools}`
   * @throws {XerisError|RpcError}
   */
  async getPools(opts) {
    const client = this._requireClient();
    return opts === undefined ? client.getPools() : client.getPools(opts);
  }

  /**
   * `GET /tokens` (`network.rs:4915-4922`).
   * @returns {Promise<object>} `{tokens: TokenInfo[]}`
   * @throws {XerisError|RpcError}
   */
  async getTokenList() {
    return this._requireClient().getTokenList();
  }

  /**
   * Explorer `GET /v2/stats` (`explorer.rs:965-1011`).
   * @returns {Promise<object>} `{success, data:{block_height, current_slot, total_transactions, total_accounts, total_staked, validator_count, tps_estimate}}`
   * @throws {XerisError|RpcError}
   */
  async getStats() {
    return this._requireClient().getStats();
  }

  /**
   * Explorer `GET /v2/tx/{signature}` (`explorer.rs:1183-1249`); not found → `RpcError('Transaction not found')`.
   * @param {string} signature
   * @returns {Promise<object>} `{success, data: TxDetail}`
   * @throws {XerisError|RpcError}
   */
  async getTransaction(signature) {
    return this._requireClient().getTransaction(signature);
  }

  // --------------------------------------------------------------------------
  // Routes and variants the node refuses (throw synchronously, no I/O)
  // --------------------------------------------------------------------------

  /**
   * `GET /airdrop/{address}/{amount}` answers `{"error": ..., "status": 501}`
   * on this node (`network.rs:4314-4327`). Fund an account with a
   * NativeTransfer from a funded key instead.
   * @returns {never}
   * @throws {FeatureDisabledError} always (`feature: 'airdrop'`)
   */
  airdrop() {
    throw disabledFeature('airdrop');
  }

  /**
   * ZkPrivateTransfer (variant 48) is skipped by the dispatcher after the fee
   * is charged (`ledger.rs:8669-8685`); use `transferXrs`/`transferToken`.
   * @returns {never}
   * @throws {FeatureDisabledError} always (`feature: 'ZkPrivateTransfer'`)
   */
  sendZkPrivateTransfer() {
    throw disabledFeature('ZkPrivateTransfer');
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  /**
   * Creates the internal client at `connect()` when the constructor options
   * did not fix the node. The RPC URL comes from `opts.rpcUrl`, else
   * `provider.getRpcUrl()`. A bare `scheme://host:56001` names the node host
   * (explorer `host:50008`, unless `opts.explorerUrl` overrides it). Any other
   * RPC URL is used unchanged and the explorer URL must come from
   * `opts.explorerUrl` or `provider.getExplorerUrl()`; nothing is guessed.
   * Without an RPC URL, testnet falls back to `TESTNET_SEED`.
   * @private
   * @param {object} provider
   * @returns {Promise<XerisClient>}
   * @throws {XerisError} `code 'provider'` when a provider URL method fails or returns a bad URL;
   *   `code 'config'` when no explorer URL is available for a non-default RPC URL, or on mainnet without a host
   */
  async _resolveClient(provider) {
    let rpcUrl = this._opts.rpcUrl;
    if (rpcUrl === undefined && typeof provider.getRpcUrl === 'function') {
      let raw;
      try {
        raw = await provider.getRpcUrl();
      } catch (e) {
        throw providerError(`provider.getRpcUrl() failed: ${causeText(e)}`, e);
      }
      const rpc = nodeUrl(raw, 'provider.getRpcUrl()', DEFAULT_RPC_PORT);
      if (rpc.host !== null) return new XerisClient(rpc.host, this._clientOptions());
      rpcUrl = rpc.url;
    }
    if (rpcUrl !== undefined) {
      let explorerUrl = this._opts.explorerUrl;
      if (explorerUrl === undefined && typeof provider.getExplorerUrl === 'function') {
        let raw;
        try {
          raw = await provider.getExplorerUrl();
        } catch (e) {
          throw providerError(`provider.getExplorerUrl() failed: ${causeText(e)}`, e);
        }
        explorerUrl = nodeUrl(raw, 'provider.getExplorerUrl()', DEFAULT_EXPLORER_PORT).url;
      }
      if (explorerUrl === undefined) {
        throw new XerisError(
          `RPC URL '${rpcUrl}' is not <host>:${DEFAULT_RPC_PORT}, so the explorer URL cannot be derived from it; pass opts.explorerUrl or use a provider with getExplorerUrl()`,
          { code: 'config' },
        );
      }
      return new XerisClient(null, this._clientOptions({ rpcUrl, explorerUrl }));
    }
    if (this._network === 'testnet') return new XerisClient(`http://${TESTNET_SEED}`, this._clientOptions());
    throw new XerisError('mainnet requires opts.host or opts.rpcUrl, or a provider that implements getRpcUrl()', { code: 'config' });
  }

  /**
   * Host derivable from the constructor options alone: `opts.host`; `null`
   * when both URLs are given (XerisClient then needs no host); the host of a
   * single URL only when it is a bare `scheme://host:<default port>`;
   * otherwise `undefined` (the node is resolved at `connect()`).
   * @private
   * @returns {string|null|undefined}
   */
  _staticHost() {
    const { host, rpcUrl, explorerUrl } = this._opts;
    if (host !== undefined) return host;
    if (rpcUrl !== undefined && explorerUrl !== undefined) return null;
    // One URL alone fixes the node only when it is a bare default-port URL;
    // otherwise the other URL is resolved at connect() (_resolveClient).
    if (rpcUrl !== undefined) {
      const r = nodeUrl(rpcUrl, 'opts.rpcUrl', DEFAULT_RPC_PORT);
      return r.host === null ? undefined : r.host;
    }
    if (explorerUrl !== undefined) {
      const r = nodeUrl(explorerUrl, 'opts.explorerUrl', DEFAULT_EXPLORER_PORT);
      return r.host === null ? undefined : r.host;
    }
    return undefined;
  }

  /**
   * `XerisClient` options from the constructor options (only keys that were
   * given), merged with `extra`.
   * @private
   * @param {object} [extra={}]
   * @returns {object}
   */
  _clientOptions(extra = {}) {
    const out = {};
    for (const key of ['rpcPort', 'explorerPort', 'rpcUrl', 'explorerUrl', 'fetch', 'timeoutMs']) {
      if (this._opts[key] !== undefined) out[key] = this._opts[key];
    }
    return Object.assign(out, extra);
  }

  /**
   * @private
   * @returns {string} the connected public key
   * @throws {XerisError} `code 'provider'` when not connected
   */
  _requireConnected() {
    if (!this._connected || this._provider === null || this._publicKey === null || this._client === null) {
      throw providerError('wallet not connected: call connect() first');
    }
    return this._publicKey;
  }

  /**
   * @private
   * @returns {XerisClient}
   * @throws {XerisError} `code 'config'` when no node is configured yet
   */
  _requireClient() {
    if (this._client === null) {
      throw new XerisError('no node configured: call connect() first, or pass opts.host or opts.rpcUrl/opts.explorerUrl', { code: 'config' });
    }
    return this._client;
  }

  /**
   * @private
   * @param {unknown} address
   * @param {string} field
   * @returns {string}
   * @throws {XerisError} `code 'provider'` when neither an address nor a connected key exists
   */
  _addressArg(address, field) {
    if (address === null || address === undefined) {
      throw providerError(`${field}: no wallet connected and no address given`);
    }
    return address;
  }

  /**
   * @private
   * @param {unknown} event
   * @returns {Function[]}
   * @throws {RangeError}
   */
  _listenerList(event) {
    if (!EVENTS.includes(event)) {
      throw new RangeError(`event: expected one of ${EVENTS.map((e) => `'${e}'`).join(', ')}, got ${describe(event)}`);
    }
    return this._listeners[event];
  }

  /**
   * @private
   * @param {unknown} callback
   * @returns {Function}
   * @throws {TypeError}
   */
  _assertCallback(callback) {
    if (typeof callback !== 'function') throw new TypeError(`callback: expected a function, got ${describe(callback)}`);
    return callback;
  }

  /**
   * Invokes the listeners of `event` in registration order; a listener's
   * exception propagates to the emitter's caller.
   * @private
   * @param {string} event
   * @param {unknown} data
   * @returns {void}
   */
  _emit(event, data) {
    for (const cb of this._listeners[event].slice()) cb(data);
  }

  /**
   * Forwards the provider's `disconnect` and `accountChanged` events. An
   * `accountChanged` value that is `null` or not a canonical public key is
   * reported as `null` and leaves the adapter disconnected until the next
   * `connect()`.
   * @private
   * @param {object} provider
   * @returns {void}
   */
  _attachProviderEvents(provider) {
    this._detachProviderEvents();
    if (typeof provider.on !== 'function') return;
    const onDisconnect = () => {
      this._publicKey = null;
      this._connected = false;
      this._emit('disconnect', undefined);
    };
    const onAccountChanged = (arg) => {
      const key = publicKeyString(arg);
      if (key !== null && isCanonical(key)) {
        this._publicKey = key;
        this._connected = true;
      } else {
        this._publicKey = null;
        this._connected = false;
      }
      this._emit('accountChanged', this._publicKey);
    };
    provider.on('disconnect', onDisconnect);
    provider.on('accountChanged', onAccountChanged);
    this._providerHandlers = { provider, onDisconnect, onAccountChanged };
  }

  /**
   * @private
   * @returns {void}
   */
  _detachProviderEvents() {
    const h = this._providerHandlers;
    if (h === null) return;
    this._providerHandlers = null;
    if (typeof h.provider.off === 'function') {
      h.provider.off('disconnect', h.onDisconnect);
      h.provider.off('accountChanged', h.onAccountChanged);
    }
  }
}

module.exports = { XerisDApp };
