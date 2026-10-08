'use strict';

/**
 * `XerisClient`: a node client that holds no state beyond its base URLs,
 * signs with a caller-supplied `XerisKeypair`, and talks to the two HTTP
 * servers a node runs (`src/main.rs:831-832, 839-840`):
 *
 * - RPC port (default 56001, `src/network.rs`): the four write routes
 *   `POST /submit`, `/stake`, `/unstake`, `/pq-register` (`network.rs:4336,
 *   4440, 4571, 4664`) and the read routes catalogued in blueprint §10.6.
 * - Explorer port (default 50008, `src/explorer.rs`): the `/v2/*` routes and
 *   the JSON-RPC root `POST /` (`explorer.rs:1429-1431`), which is where the
 *   recent blockhash comes from (`explorer.rs:1489-1500`).
 *
 * Error mapping (blueprint D6): every handler on the RPC port replies HTTP 200
 * with `{"error": "..."}` on failure (`network.rs` uses `with_status` only on
 * the five 501 stubs, `network.rs:5735, 5798, 5815, 5848, 5865`), and the
 * explorer never sets a top-level JSON-RPC `error` (`explorer.rs:1631-1635`;
 * failures are `{"result": {"error": "..."}}`, `explorer.rs:1455, 1481, 1499,
 * 1517, 1536, 1554, 1565`). The transport turns all of those into `RpcError`,
 * so no read method ever returns an error object as a result.
 *
 * Node business rules that can be checked without chain state live in the
 * exported `checks` object (blueprint D2) and run before any network I/O in
 * every write wrapper here and in `XerisDApp` / `XerisAgent`.
 *
 * Routes the node refuses are not wrapped: `airdrop()`, `claimStakingReward()`,
 * `governanceLock()`, `governanceDelegate()` and the four disabled-variant
 * builders throw `FeatureDisabledError` synchronously and never touch the
 * network (`network.rs:4314-4327, 5705-5740, 5788-5867`; `ledger.rs:1445-1450,
 * 8669-8685, 8687-8697, 8809-8828`).
 *
 * @module xeris-sdk/client
 */

const { Buffer } = require('buffer');
const { XerisKeypair, isCanonicalPubkey } = require('./keypair');
const {
  blockhashFromHex,
  assertInstructionSubmittable,
  assembleSignedTransaction,
  submitBody,
  parseSubmitResponse,
  signatureOf,
} = require('./transaction');
const {
  Instructions,
  Variant,
  VARIANT_NAMES,
  encodeSwapCall,
  dealTermsHash,
  buildPqRotationMessage,
  tryDecodeInstruction,
} = require('./instructions/index');
const {
  normalizeU64,
  normalizeU8,
  assertString,
  toBytes,
  readVariant,
  xrsToLamports,
  stringifyJson,
  parseJson,
} = require('./encoding');
const { XerisError, EncodingError, RpcError, disabledFeature } = require('./errors');
const {
  DEFAULT_RPC_PORT,
  DEFAULT_EXPLORER_PORT,
  TESTNET_SEED,
  MAINNET_HOST_ENV,
  SLOT_MS,
  BLOCKHASH_EXPIRY_WINDOW,
  MAX_IX_PER_TX,
  MAX_TX_BYTES,
  MAX_RECENT_BLOCKS,
  PQ_PUBLIC_KEY_LEN,
  PQ_SIGNATURE_LEN,
  PQ_SECURITY_LEVEL,
  SUPPORTED_PQ_ALGORITHM,
  PQ_CLAIM_TOKENS,
  MAX_GROTH16_PROOF_BYTES,
  MAX_GROTH16_VK_BYTES,
  MAX_GROTH16_PUBLIC_INPUTS,
  AGENT_OPERATIONS,
  AGENT_INNER_VARIANTS,
  DELEGATED_CALL_METHODS,
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
  MIN_DEAL_DISPUTE_BOND,
  ORDER_STORAGE_BOND,
  MAX_CONDITIONAL_INNER_BYTES,
  MIN_ORACLE_STAKE_LAMPORTS,
  MIN_VOTING_PERIOD_SLOTS,
  MAX_VOTING_PERIOD_SLOTS,
  STRING_LIMITS,
  REGISTRY_PAGE_ITEMS,
  ACCOUNT_HISTORY_MAX_PAGE,
  ACCOUNT_HISTORY_MAX_PAGE_SIZE,
  LIST_MAX_PAGE_SIZE,
  SIGNATURES_MAX_LIMIT,
  PRICE_HISTORY_MAX_LIMIT,
} = require('./constants');

// ---------------------------------------------------------------------------
// Local helpers (not exported)
// ---------------------------------------------------------------------------

/** The four write routes of the RPC server (`network.rs:4336, 4440, 4571, 4664`). */
const WRITE_ROUTES = Object.freeze(['/submit', '/stake', '/unstake', '/pq-register']);

/**
 * Variant the dedicated write routes require as the transaction's first
 * instruction: `/stake` → `Stake` (`network.rs:4360-4370`), `/unstake` →
 * `Unstake` (`network.rs:4464-4474`), `/pq-register` → `PqKeyRegister`
 * (`network.rs:4597-4602`). `/submit` accepts any admissible instruction.
 */
const ROUTE_FIRST_VARIANT = Object.freeze({
  '/stake': Variant.Stake,
  '/unstake': Variant.Unstake,
  '/pq-register': Variant.PqKeyRegister,
});

/** Exact text of the write limiter's rejection (`network.rs:4665-4667`, 30 requests / 60 s / IP, `network.rs:4308`). */
const RATE_LIMIT_MESSAGE = 'Rate limited. Max 30 write RPCs per minute per IP.';

/** Exact text of the explorer's miss for `GET /v2/tx/{sig}` (`explorer.rs:1244-1247`). */
const TX_NOT_FOUND_MESSAGE = 'Transaction not found';

/**
 * The write routes' replies for a transaction whose first signature the node
 * already holds: in `processed_signatures` (`network.rs:4390, 4510, 4622,
 * 4691`) or in the mempool (`network.rs:4776, 4828`).
 */
const DUPLICATE_MESSAGES = Object.freeze(['Transaction already processed', 'Transaction already in mempool']);

/**
 * Error codes after which a submitted transaction may or may not have reached
 * the node: the request was sent but no usable answer came back.
 */
const UNCERTAIN_SUBMIT_CODES = Object.freeze(['timeout', 'rpc_transport', 'rpc_http', 'rpc_json']);

/** The two AMM swap methods that take 16 raw bytes (`contracts.rs:2419-2441`, `ledger.rs:2359-2365`). */
const SWAP_METHODS = Object.freeze(['swap_a_to_b', 'swap_b_to_a']);

/** Strict UTF-8 decoder: serde_json::from_slice refuses invalid UTF-8. */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Padded standard-alphabet base64, the form `base64::decode` / `crypto::base64_decode` accept (`crypto.rs:129-130`). */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Ed25519 signature length (`solana_sdk::signature::Signature`). */
const ED25519_SIGNATURE_LEN = 64;

/** Block hash length (`[u8; 32]`, `ledger.rs:297`); attestation claims must be exactly this long (`ledger.rs:1398-1403`). */
const BLOCK_HASH_LEN = 32;

/** Bytes per Groth16 public input (`Fr`, 32-byte little-endian; `crypto.rs:1086-1095`). */
const GROTH16_INPUT_BYTES = 32;

/**
 * Short rendering of a value for error messages.
 * @param {unknown} v
 * @returns {string}
 */
function describe(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  const t = typeof v;
  if (t === 'bigint') return `${v}n`;
  if (t === 'number') return Object.is(v, -0) ? '-0' : String(v);
  if (t === 'boolean') return `${v} (boolean)`;
  if (t === 'string') return JSON.stringify(v.length > 48 ? `${v.slice(0, 45)}...` : v);
  if (t === 'symbol') return 'symbol';
  if (t === 'function') return 'function';
  if (Array.isArray(v)) return `array of length ${v.length}`;
  if (v instanceof Uint8Array) return `${v.constructor.name} of length ${v.length}`;
  return `object (${v.constructor && v.constructor.name ? v.constructor.name : 'no constructor'})`;
}

/**
 * True for a plain JSON-style object (not an array, not bytes, not a class instance).
 * @param {unknown} v
 * @returns {boolean}
 */
function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v) || v instanceof Uint8Array) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Throws unless a method was called with the declared number of arguments.
 * Mirrors D4 for the wrappers: an omitted trailing argument would otherwise
 * reach a builder as `undefined` and, for an `Option<T>` field, encode `None`
 * without the caller having said so.
 * @param {number} got `arguments.length`
 * @param {number} expected Required argument count.
 * @param {string} name Method name for the message.
 * @param {string} params Comma-separated parameter list for the message.
 * @param {number} [optional=0] Number of trailing optional arguments also accepted.
 * @throws {TypeError}
 */
function arity(got, expected, name, params, optional = 0) {
  if (got < expected || got > expected + optional) {
    const range = optional === 0 ? `exactly ${expected}` : `${expected} to ${expected + optional}`;
    throw new TypeError(`XerisClient.${name} expects ${range} arguments (${params}), got ${got}`);
  }
}

/**
 * @param {unknown} keypair
 * @returns {XerisKeypair}
 * @throws {TypeError} Unless `keypair` is an `XerisKeypair`.
 */
function requireKeypair(keypair) {
  if (!(keypair instanceof XerisKeypair)) {
    throw new TypeError(`keypair: expected a XerisKeypair, got ${describe(keypair)}`);
  }
  return keypair;
}

/**
 * Throws `RangeError` when `opts` has an own key outside `allowed`, so a
 * misspelt or 4.x-style option (`page_size`, `min_rep`) is reported instead
 * of being ignored. `renamed` maps a known old name to its replacement.
 * @param {object} opts
 * @param {ReadonlyArray<string>} allowed
 * @param {string} field e.g. `'opts'`
 * @param {Readonly<Record<string, string>>} [renamed={}]
 * @returns {void}
 * @throws {RangeError}
 */
function onlyKeys(opts, allowed, field, renamed = {}) {
  for (const key of Object.keys(opts)) {
    if (allowed.includes(key)) continue;
    const hint = Object.prototype.hasOwnProperty.call(renamed, key) ? `; use ${renamed[key]}` : '';
    throw new RangeError(`${field}.${key}: unknown option${hint} (allowed: ${allowed.join(', ')})`);
  }
}

/**
 * The `RpcError` (code `duplicate`) for a write-route reply saying the node
 * already holds the transaction's signature. `message` stays the node's text.
 * @param {RpcError} err The error `_request` / `parseSubmitResponse` raised.
 * @param {string} route
 * @param {string} signature
 * @param {string} txBase64
 * @returns {RpcError}
 */
function duplicateError(err, route, signature, txBase64) {
  const dup = new RpcError(err.message, {
    code: 'duplicate',
    route: err.route === null ? `POST ${route}` : err.route,
    httpStatus: err.httpStatus,
    body: err.body,
    nodeStatus: err.nodeStatus,
    hint: err.hint,
    cause: err,
  });
  dup.signature = signature;
  dup.txBase64 = txBase64;
  return dup;
}

/**
 * An integer `min..=max` page parameter. The node clamps these values
 * silently; the SDK refuses values outside the range instead.
 * @param {unknown} value
 * @param {string} field
 * @param {number} min
 * @param {number} max
 * @param {string} cite node `file:line` of the clamp, and advice
 * @returns {number}
 * @throws {TypeError|RangeError}
 */
function boundedInt(value, field, min, max, cite) {
  const v = pageInt(value, field, min);
  if (v > max) throw new RangeError(`${field}: ${v} is above ${max}; the node would clamp it to ${max} (${cite})`);
  return v;
}

/**
 * RFC 3986 `pchar` minus `%`: characters `fetch` sends unchanged in a path
 * segment. The node's router passes the raw segment to `FromStr` without
 * percent-decoding it (warp 0.3.7 `path::param`, `filters/path.rs:266-275,
 * 443-460`; `Cargo.lock` pins warp 0.3.7), so an escaped character would
 * reach the node in its escaped spelling.
 */
const PATH_SEGMENT = /^[A-Za-z0-9\-._~!$&'()*+,;=:@]+$/;

/**
 * Validates one path segment and returns it unencoded.
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 * @throws {TypeError} Not a string.
 * @throws {RangeError} Empty, `.` or `..` (the URL parser removes them), or a
 *   character outside RFC 3986 `pchar` (space, `/`, `?`, `#`, `%`, `[`, `]`,
 *   `"`, `<`, `>`, `\`, `^`, `` ` ``, `{`, `|`, `}`, control or non-ASCII
 *   characters), which would have to be percent-encoded and the node does not
 *   decode.
 */
function seg(value, field) {
  assertString(value, field);
  if (value.length === 0) throw new RangeError(`${field}: must not be empty`);
  if (value === '.' || value === '..' || !PATH_SEGMENT.test(value)) {
    throw new RangeError(
      `${field}: ${describe(value)} cannot be sent as a URL path segment: the node's router (warp 0.3 path::param) does not percent-decode, so only RFC 3986 pchar characters other than '%' reach it unchanged, and '.' / '..' are removed by URL parsing; read it from a list route (getTokens, getTasks, getRwaTokens) instead`,
    );
  }
  return value;
}

/**
 * Appends only the query parameters whose value is not `undefined`.
 * @param {string} path
 * @param {Array<[string, string|number|undefined]>} params
 * @returns {string}
 */
function withQuery(path, params) {
  const qs = new URLSearchParams();
  for (const [key, value] of params) {
    if (value !== undefined) qs.append(key, String(value));
  }
  const s = qs.toString();
  return s.length === 0 ? path : `${path}?${s}`;
}

/**
 * Validates a page number / page size style integer (`>= min`).
 * @param {unknown} value
 * @param {string} field
 * @param {number} min
 * @returns {number}
 * @throws {TypeError|RangeError}
 */
function pageInt(value, field, min) {
  if (typeof value !== 'number') throw new TypeError(`${field}: expected a number, got ${describe(value)}`);
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${field}: expected an integer >= ${min}, got ${describe(value)}`);
  }
  return value;
}

/**
 * Validates a finite JSON number (used for `amount_xrs` / `slippage_pct`,
 * which the planner reads with `as_f64`, `network.rs:5398`).
 * @param {unknown} value
 * @param {string} field
 * @param {number} min
 * @param {number} [max]
 * @returns {number}
 * @throws {TypeError|RangeError}
 */
function jsonNumber(value, field, min, max) {
  if (typeof value !== 'number') throw new TypeError(`${field}: expected a number, got ${describe(value)}`);
  if (!Number.isFinite(value)) throw new RangeError(`${field}: expected a finite number, got ${describe(value)}`);
  if (value < min) throw new RangeError(`${field}: expected >= ${min}, got ${value}`);
  if (max !== undefined && value > max) throw new RangeError(`${field}: expected <= ${max}, got ${value}`);
  return value;
}

/**
 * Validates an absolute http(s) URL used as a base, returning it without
 * trailing slashes. Query strings and fragments are refused.
 * @param {unknown} value
 * @param {string} field
 * @param {{allowPort: boolean, allowPath: boolean}} rules
 * @returns {string}
 * @throws {TypeError} Not a string.
 * @throws {XerisError} code `'config'` for anything else.
 */
function baseUrl(value, field, rules) {
  if (typeof value !== 'string') throw new TypeError(`${field}: expected a URL string, got ${describe(value)}`);
  const text = value.trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(text);
  } catch (cause) {
    throw new XerisError(`${field}: '${value}' is not an absolute http(s) URL (the scheme is required)`, { code: 'config', cause });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new XerisError(`${field}: '${value}' must use http: or https:`, { code: 'config' });
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new XerisError(`${field}: '${value}' must not carry credentials, a query string or a fragment`, { code: 'config' });
  }
  if (!rules.allowPort && url.port !== '') {
    throw new XerisError(
      `${field}: '${value}' carries a port; ports are appended from opts.rpcPort / opts.explorerPort, or pass opts.rpcUrl and opts.explorerUrl`,
      { code: 'config' },
    );
  }
  if (!rules.allowPath && url.pathname !== '/' && url.pathname !== '') {
    throw new XerisError(`${field}: '${value}' must be scheme and host only (ports are appended per server)`, { code: 'config' });
  }
  return text;
}

/**
 * Validates a TCP port.
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 * @throws {TypeError|RangeError}
 */
function port(value, field) {
  if (typeof value !== 'number') throw new TypeError(`${field}: expected a number, got ${describe(value)}`);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new RangeError(`${field}: expected an integer 1..65535, got ${describe(value)}`);
  }
  return value;
}

/**
 * The mainnet host from the environment, or `null` when unset or blank.
 * @returns {string|null}
 */
function mainnetHostFromEnv() {
  const env = typeof process !== 'undefined' && process && process.env ? process.env[MAINNET_HOST_ENV] : undefined;
  return typeof env === 'string' && env.trim() !== '' ? env.trim() : null;
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * @param {unknown} e
 * @returns {string}
 */
function causeText(e) {
  if (e && typeof e === 'object' && typeof e.message === 'string') return e.message;
  return String(e);
}

// ---------------------------------------------------------------------------
// checks: node business rules that need no chain state (blueprint D2, §10.3)
// ---------------------------------------------------------------------------

/**
 * Pure preflight checks mirroring rules the node applies at ingress or in the
 * block dispatcher. Each function throws (`TypeError` for a wrong JS type,
 * `RangeError` for a value outside the node's domain, `FeatureDisabledError`
 * for a path the node refuses) or returns `undefined`. They are applied by
 * every write wrapper of `XerisClient`, `XerisDApp` and `XerisAgent` before
 * any network call. Rules that need state (balances, registered keys, the
 * current slot) are not mirrored; the node reports those as `RpcError` or
 * as a failed instruction outcome.
 * @namespace checks
 */
const checks = Object.freeze({
  /**
   * `s` must be the canonical base58 form of a 32-byte public key: decodes to
   * 32 bytes and re-encodes to the same string (`ledger.rs:1569-1577`,
   * `pk.to_string() == to`).
   * @param {string} s
   * @param {string} [field='pubkey']
   * @throws {TypeError|RangeError}
   */
  pubkey(s, field = 'pubkey') {
    assertString(s, field);
    if (!isCanonicalPubkey(s)) {
      throw new RangeError(`${field}: '${s}' is not a canonical base58 32-byte public key (ledger.rs:1569-1577)`);
    }
  },

  /**
   * NativeTransfer destination: canonical public key and not a `__*`
   * protocol pseudo-account (`ledger.rs:1562-1564, 1569-1577, 5602`).
   * @param {string} to
   * @throws {TypeError|RangeError}
   */
  transferTarget(to) {
    checks.pubkey(to, 'to');
    if (to.startsWith('__')) {
      throw new RangeError(`to: '${to}' is a reserved protocol pseudo-account (ledger.rs:1562-1564)`);
    }
  },

  /**
   * A `u64` amount that must be strictly positive (per-handler `amount > 0`
   * rules, e.g. `ledger.rs:1570, 1420-1421, 5710`; `token.rs:1114, 1297`).
   * @param {number|bigint} amount
   * @param {string} [field='amount']
   * @throws {TypeError|RangeError}
   */
  positive(amount, field = 'amount') {
    if (normalizeU64(amount, field) === 0n) {
      throw new RangeError(`${field}: must be greater than 0`);
    }
  },

  /**
   * ValidatorAttestation ingress rules: the claimed hash is exactly 32 bytes
   * and `validator` equals the transaction signer (`ledger.rs:1398-1413`).
   * @param {Buffer|Uint8Array} blockHash
   * @param {string} validator
   * @param {string} signer
   * @throws {TypeError|RangeError}
   */
  attestation(blockHash, validator, signer) {
    const hash = toBytes(blockHash, 'blockHash');
    if (hash.length !== BLOCK_HASH_LEN) {
      throw new RangeError(`blockHash: expected exactly ${BLOCK_HASH_LEN} bytes, got ${hash.length} (ledger.rs:1400-1403)`);
    }
    assertString(validator, 'validator');
    assertString(signer, 'signer');
    if (validator !== signer) {
      throw new RangeError(`validator: must equal the transaction signer ${signer} (ledger.rs:1407-1409)`);
    }
  },

  /**
   * A field the node requires to equal the transaction signer.
   * @param {string} value
   * @param {string} signer
   * @param {string} [field='value']
   * @throws {TypeError|RangeError}
   */
  signerIs(value, signer, field = 'value') {
    assertString(value, field);
    assertString(signer, 'signer');
    if (value !== signer) {
      throw new RangeError(`${field}: must equal the transaction signer ${signer}, got '${value}'`);
    }
  },

  /**
   * `value` must be one of the listed strings.
   * @param {string} value
   * @param {ReadonlyArray<string>} list
   * @param {string} [field='value']
   * @throws {TypeError|RangeError}
   */
  oneOf(value, list, field = 'value') {
    if (!Array.isArray(list)) throw new TypeError(`${field}: the allowed-value list must be an array, got ${describe(list)}`);
    assertString(value, field);
    if (!list.includes(value)) {
      throw new RangeError(`${field}: expected one of ${list.map((v) => `'${v}'`).join(', ')}, got '${value}'`);
    }
  },

  /**
   * UTF-8 byte length of `s` is at most `n` (the node measures `String::len`,
   * bytes; limits in `STRING_LIMITS`).
   * @param {string} s
   * @param {number} n
   * @param {string} [field='string']
   * @throws {TypeError|RangeError}
   */
  maxBytes(s, n, field = 'string') {
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
      throw new TypeError(`${field}: the byte limit must be a non-negative integer, got ${describe(n)}`);
    }
    assertString(s, field);
    const len = Buffer.byteLength(s, 'utf8');
    if (len > n) throw new RangeError(`${field}: ${len} UTF-8 bytes exceeds the node's limit of ${n} bytes`);
  },

  /**
   * A user-deployable contract id: 1..128 characters of `[A-Za-z0-9_-]`
   * (`contracts.rs:1316-1320`; the node's `is_alphanumeric` is Unicode-aware,
   * the SDK accepts the ASCII subset `CONTRACT_ID_PATTERN`) and none of the
   * reserved prefixes/suffix (`ledger.rs:1524-1530`).
   * @param {string} id
   * @throws {TypeError|RangeError}
   */
  contractId(id) {
    assertString(id, 'contractId');
    if (!CONTRACT_ID_PATTERN.test(id)) {
      throw new RangeError(`contractId: '${id}' must be 1..128 characters of [A-Za-z0-9_-] (contracts.rs:1316-1320)`);
    }
    for (const prefix of RESERVED_CONTRACT_ID_PREFIXES) {
      if (id.startsWith(prefix)) {
        throw new RangeError(`contractId: prefix '${prefix}' is reserved for protocol contracts (ledger.rs:1524-1530)`);
      }
    }
    for (const suffix of RESERVED_CONTRACT_ID_SUFFIXES) {
      if (id.endsWith(suffix)) {
        throw new RangeError(`contractId: suffix '${suffix}' is reserved for protocol pool ids (ledger.rs:1524-1530)`);
      }
    }
  },

  /**
   * A `ContractType::from_str` alias (`contracts.rs:385-411`, matched after
   * lower-casing) whose type a user may deploy; the registries in
   * `PROTOCOL_MANAGED_CONTRACT_TYPES` are refused (`ledger.rs:2344-2349`).
   * @param {string} s
   * @throws {TypeError|RangeError}
   */
  contractType(s) {
    assertString(s, 'contractType');
    const key = s.toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(CONTRACT_TYPE_ALIASES, key)) {
      throw new RangeError(
        `contractType: '${s}' is not a ContractType alias; expected one of ${Object.keys(CONTRACT_TYPE_ALIASES).join(', ')} (contracts.rs:385-411)`,
      );
    }
    const name = CONTRACT_TYPE_ALIASES[key];
    if (PROTOCOL_MANAGED_CONTRACT_TYPES.includes(name)) {
      throw new RangeError(`contractType: ${name} is protocol-managed; user deployment is refused by the node (ledger.rs:2344-2349)`);
    }
  },

  /**
   * One of the two AMM swap methods (`contracts.rs:2419-2441`).
   * @param {string} m
   * @throws {TypeError|RangeError}
   */
  swapMethod(m) {
    checks.oneOf(m, SWAP_METHODS, 'method');
  },

  /**
   * Swap `add_liquidity` args: `amount_a`, `amount_b`, `min_lp_shares`,
   * `min_amount_a`, `min_amount_b`, all present and all > 0
   * (`contracts.rs:2214-2231`; the minimums are rejected at 0, a zero deposit
   * yields zero shares and fails the share minimum).
   * @param {{amount_a: number|bigint, amount_b: number|bigint, min_lp_shares: number|bigint, min_amount_a: number|bigint, min_amount_b: number|bigint}} a
   * @throws {TypeError|RangeError}
   */
  liquidityArgs(a) {
    if (!isPlainObject(a)) throw new TypeError(`args: expected a plain object, got ${describe(a)}`);
    for (const name of ['amount_a', 'amount_b', 'min_lp_shares', 'min_amount_a', 'min_amount_b']) {
      if (!Object.prototype.hasOwnProperty.call(a, name) || a[name] === undefined) {
        throw new TypeError(`args.${name}: missing; add_liquidity requires it (contracts.rs:2219-2225)`);
      }
      checks.positive(a[name], `args.${name}`);
    }
  },

  /**
   * `s` must not assert a post-quantum claim: lower-cased, it contains none
   * of `PQ_CLAIM_TOKENS` (`ledger.rs:5362-5374`; applied to ZkVkRegister at
   * `ledger.rs:8492` and ZkProofSubmit at `ledger.rs:8566-8573`).
   * @param {string} s
   * @param {string} [field='string']
   * @throws {TypeError|RangeError}
   */
  noPqClaim(s, field = 'string') {
    assertString(s, field);
    const lc = s.toLowerCase();
    for (const token of PQ_CLAIM_TOKENS) {
      if (lc.includes(token)) {
        throw new RangeError(`${field}: contains '${token}'; the node rejects post-quantum claims in classical ZK metadata (ledger.rs:5362-5374)`);
      }
    }
  },

  /**
   * PqKeyRegister: `pqPublicKey` is exactly `PQ_PUBLIC_KEY_LEN` (1952) bytes,
   * `pqAlgorithm` is `'dilithium3'`, `securityLevel` is 3
   * (`crypto.rs:924-976`; `contracts.rs:6168-6215`).
   * @param {Buffer|Uint8Array} pqPublicKey
   * @param {string} pqAlgorithm
   * @param {number|bigint} securityLevel
   * @throws {TypeError|RangeError}
   */
  pqRegister(pqPublicKey, pqAlgorithm, securityLevel) {
    const pk = toBytes(pqPublicKey, 'pqPublicKey');
    if (pk.length !== PQ_PUBLIC_KEY_LEN) {
      throw new RangeError(`pqPublicKey: expected exactly ${PQ_PUBLIC_KEY_LEN} bytes (Dilithium3), got ${pk.length} (crypto.rs:948-976)`);
    }
    assertString(pqAlgorithm, 'pqAlgorithm');
    if (pqAlgorithm !== SUPPORTED_PQ_ALGORITHM) {
      throw new RangeError(`pqAlgorithm: only '${SUPPORTED_PQ_ALGORITHM}' is accepted (case-sensitive), got '${pqAlgorithm}' (crypto.rs:924-938)`);
    }
    const level = normalizeU8(securityLevel, 'securityLevel');
    if (level !== PQ_SECURITY_LEVEL) {
      throw new RangeError(`securityLevel: Dilithium3 requires ${PQ_SECURITY_LEVEL}, got ${level} (contracts.rs:6208-6210)`);
    }
  },

  /**
   * PqKeyRotate: the new key is 1952 bytes of `'dilithium3'` and the rotation
   * proof is a `PQ_SIGNATURE_LEN` (3309) byte Dilithium3 signature over
   * `buildPqRotationMessage` by the currently registered key
   * (`ledger.rs:8738-8807`; `crypto.rs:851-870`).
   * @param {Buffer|Uint8Array} newPk
   * @param {string} algorithm
   * @param {Buffer|Uint8Array} proof
   * @throws {TypeError|RangeError}
   */
  pqRotate(newPk, algorithm, proof) {
    const pk = toBytes(newPk, 'newPqPublicKey');
    if (pk.length !== PQ_PUBLIC_KEY_LEN) {
      throw new RangeError(`newPqPublicKey: expected exactly ${PQ_PUBLIC_KEY_LEN} bytes (Dilithium3), got ${pk.length} (ledger.rs:8757-8763)`);
    }
    assertString(algorithm, 'newPqAlgorithm');
    if (algorithm !== SUPPORTED_PQ_ALGORITHM) {
      throw new RangeError(`newPqAlgorithm: only '${SUPPORTED_PQ_ALGORITHM}' is accepted, got '${algorithm}' (ledger.rs:8757-8763)`);
    }
    const sig = toBytes(proof, 'rotationProof');
    if (sig.length !== PQ_SIGNATURE_LEN) {
      throw new RangeError(`rotationProof: expected a ${PQ_SIGNATURE_LEN}-byte Dilithium3 signature, got ${sig.length} bytes (crypto.rs:1162-1166)`);
    }
  },

  /**
   * ZkProofSubmit: `proofSystem` is `'groth16'`, `proofData` is 1..512 bytes,
   * `publicInputs` is a multiple of 32 bytes up to 64 inputs, and none of the
   * three caller strings asserts a PQ claim (`ledger.rs:8566-8573`;
   * `crypto.rs:1041-1043, 1079-1095`). A proof that fails verification is not
   * stored at all (`ledger.rs:8620-8623`).
   * @param {string} proofSystem
   * @param {Buffer|Uint8Array} proofData
   * @param {Buffer|Uint8Array} publicInputs
   * @param {string} proofType
   * @param {string} metadataJson
   * @throws {TypeError|RangeError}
   */
  groth16(proofSystem, proofData, publicInputs, proofType, metadataJson) {
    assertString(proofSystem, 'proofSystem');
    if (proofSystem !== 'groth16') {
      throw new RangeError(`proofSystem: only 'groth16' is accepted on-chain, got '${proofSystem}' (ledger.rs:8566-8573)`);
    }
    const proof = toBytes(proofData, 'proofData');
    if (proof.length === 0 || proof.length > MAX_GROTH16_PROOF_BYTES) {
      throw new RangeError(`proofData: expected 1..${MAX_GROTH16_PROOF_BYTES} bytes, got ${proof.length} (crypto.rs:1041, 1079-1085)`);
    }
    const inputs = toBytes(publicInputs, 'publicInputs');
    if (inputs.length % GROTH16_INPUT_BYTES !== 0) {
      throw new RangeError(`publicInputs: length must be a multiple of ${GROTH16_INPUT_BYTES} bytes, got ${inputs.length} (crypto.rs:1086-1095)`);
    }
    if (inputs.length > MAX_GROTH16_PUBLIC_INPUTS * GROTH16_INPUT_BYTES) {
      throw new RangeError(`publicInputs: at most ${MAX_GROTH16_PUBLIC_INPUTS} inputs (${MAX_GROTH16_PUBLIC_INPUTS * GROTH16_INPUT_BYTES} bytes), got ${inputs.length} bytes (crypto.rs:1043)`);
    }
    checks.noPqClaim(proofSystem, 'proofSystem');
    checks.noPqClaim(proofType, 'proofType');
    checks.noPqClaim(metadataJson, 'metadataJson');
  },

  /**
   * ZkVkRegister: `s` is padded standard base64 decoding to 1..16384 bytes
   * (`crypto.rs:1143-1152`; the registered VK must also deserialise as a
   * BN254 Groth16 verifying key, which the SDK does not check).
   * @param {string} s
   * @throws {TypeError|RangeError}
   */
  vkBase64(s) {
    assertString(s, 'vkBase64');
    if (s.length === 0 || s.length % 4 !== 0 || !BASE64_PATTERN.test(s)) {
      throw new RangeError('vkBase64: expected padded standard-alphabet base64');
    }
    const len = Buffer.from(s, 'base64').length;
    if (len === 0 || len > MAX_GROTH16_VK_BYTES) {
      throw new RangeError(`vkBase64: decodes to ${len} bytes; expected 1..${MAX_GROTH16_VK_BYTES} (crypto.rs:1143-1146)`);
    }
  },

  /**
   * DisputeDeal bond is at least `MIN_DEAL_DISPUTE_BOND` (`ledger.rs:7814`;
   * `contracts.rs:1008`).
   * @param {number|bigint} bond
   * @throws {TypeError|RangeError}
   */
  dealBond(bond) {
    const b = normalizeU64(bond, 'bond');
    if (b < BigInt(MIN_DEAL_DISPUTE_BOND)) {
      throw new RangeError(`bond: ${b} is below the minimum deal-dispute bond ${MIN_DEAL_DISPUTE_BOND} lamports (ledger.rs:7814)`);
    }
  },

  /**
   * OpenDispute ids may not use the `deal_` namespace reserved for
   * DisputeDeal (`ledger.rs:7690`).
   * @param {string} id
   * @throws {TypeError|RangeError}
   */
  disputeId(id) {
    assertString(id, 'disputeId');
    if (id.startsWith('deal_')) {
      throw new RangeError(`disputeId: prefix 'deal_' is reserved for deal arbitration (ledger.rs:7690)`);
    }
  },

  /**
   * CreateProposal voting period within `[MIN_VOTING_PERIOD_SLOTS,
   * MAX_VOTING_PERIOD_SLOTS]` (`ledger.rs:8267-8272`; `contracts.rs:5527-5530`).
   * @param {number|bigint} slots
   * @throws {TypeError|RangeError}
   */
  votingPeriod(slots) {
    const v = normalizeU64(slots, 'votingPeriodSlots');
    if (v < BigInt(MIN_VOTING_PERIOD_SLOTS) || v > BigInt(MAX_VOTING_PERIOD_SLOTS)) {
      throw new RangeError(`votingPeriodSlots: ${v} is outside [${MIN_VOTING_PERIOD_SLOTS}, ${MAX_VOTING_PERIOD_SLOTS}] (ledger.rs:8267-8272; contracts.rs:5527-5530)`);
    }
  },

  /**
   * ForceCloseChannel: with `stateSequence` 0 the close is refund-only and no
   * signature is used (pass empty bytes); with `stateSequence >= 1` the
   * counterparty's 64-byte Ed25519 signature over `channelStateMessage` is
   * required (`contracts.rs:5821-5838`, `verify_ed25519_hex` at
   * `contracts.rs:191-205`; the ledger hex-encodes the bytes, `ledger.rs:8415`).
   * @param {number|bigint} stateSequence
   * @param {Buffer|Uint8Array} sig
   * @throws {TypeError|RangeError}
   */
  channelSignature(stateSequence, sig) {
    const seq = normalizeU64(stateSequence, 'stateSequence');
    const bytes = toBytes(sig, 'counterpartySignature');
    if (seq === 0n) {
      if (bytes.length !== 0) {
        throw new RangeError(`counterpartySignature: stateSequence 0 is a refund-only close that uses no signature; pass empty bytes, got ${bytes.length} (contracts.rs:5821-5826)`);
      }
    } else if (bytes.length !== ED25519_SIGNATURE_LEN) {
      throw new RangeError(`counterpartySignature: expected a ${ED25519_SIGNATURE_LEN}-byte Ed25519 signature for stateSequence ${seq}, got ${bytes.length} (contracts.rs:5827-5838, 197-199)`);
    }
  },

  /**
   * A detached Ed25519 signature is exactly 64 bytes (`ledger.rs:8332-8333`
   * for CloseChannel, `ledger.rs:7313-7315` for HardwareAttest).
   * @param {Buffer|Uint8Array} sig
   * @param {string} [field='signature']
   * @throws {TypeError|RangeError}
   */
  ed25519Signature(sig, field = 'signature') {
    const bytes = toBytes(sig, field);
    if (bytes.length !== ED25519_SIGNATURE_LEN) {
      throw new RangeError(`${field}: expected a ${ED25519_SIGNATURE_LEN}-byte Ed25519 signature, got ${bytes.length} bytes`);
    }
  },

  /**
   * PostTask rules the task board enforces (`contracts.rs:4698-4700,
   * 4723-4760, 4775-4785`): `minReputation` must be 0; `verification` is
   * `'poster_confirm'` or `'oracle'`, and `'oracle'` needs a non-empty
   * `verificationOracle`; `title` ≤ 256 bytes, `description` ≤ 4096 bytes;
   * `reward` > 0.
   * @param {number|bigint} minReputation
   * @param {string} verification
   * @param {string} verificationOracle
   * @param {string} title
   * @param {string} description
   * @param {number|bigint} reward
   * @throws {TypeError|RangeError}
   */
  taskPost(minReputation, verification, verificationOracle, title, description, reward) {
    if (normalizeU8(minReputation, 'minReputation') !== 0) {
      throw new RangeError('minReputation: must be 0; the node rejects any other value for escrowed tasks (contracts.rs:4698-4700)');
    }
    checks.oneOf(verification, TASK_VERIFICATION_MODES, 'verification');
    assertString(verificationOracle, 'verificationOracle');
    if (verification === 'oracle' && verificationOracle.length === 0) {
      throw new RangeError("verificationOracle: verification 'oracle' requires a non-empty oracle signer (contracts.rs:4777-4781)");
    }
    checks.maxBytes(title, STRING_LIMITS.taskTitle, 'title');
    checks.maxBytes(description, STRING_LIMITS.taskDescription, 'description');
    checks.positive(reward, 'reward');
  },

  /**
   * AgentExecute inner-instruction rules (`ledger.rs:6399-6485, 6522,
   * 6648-6655`): the inner bytes must decode as a `XerisInstruction`
   * (`decodeInstruction`; else the block skips it after charging the fee,
   * `ledger.rs:6399-6405`); a nested AgentExecute/ConditionalOrder is
   * refused at ingress (`ledger.rs:1439`); the inner variant must be one of
   * `AGENT_INNER_VARIANTS`; Stake/Unstake are accepted by the dispatcher but
   * execute as no-ops (`FeatureDisabledError 'agentStake'`,
   * `token.rs:1183-1200`); an inner TokenTransfer/TokenBurn runs through the
   * token processor as the owner, so its `from` must be `ownerPubkey`
   * (`token.rs:1104, 1151`); for an inner ContractCall the args must be a
   * JSON object serde_json parses (no invalid UTF-8, lone surrogate or
   * out-of-range number; `ledger.rs:6436-6442`; a 16-byte swap payload →
   * `'agentSwap'`), the method must be in `DELEGATED_CALL_METHODS`
   * (`ledger.rs:2138-2175`, else `'agentDelegatedMethod'`) and the target may
   * not be an `agent_registry_` contract (`ledger.rs:6428-6431`).
   * Launchpad/RWA targets and protected protocol methods are also rejected by
   * the node (`ledger.rs:6554-6561, 2184-2240`) but need state to recognise.
   * @param {Buffer|Uint8Array} innerData Encoded inner instruction.
   * @param {string} ownerPubkey The AgentExecute `owner_pubkey` the inner instruction runs as.
   * @throws {TypeError|EncodingError|RangeError|FeatureDisabledError|XerisError}
   */
  agentInner(innerData, ownerPubkey) {
    const data = toBytes(innerData, 'innerInstruction');
    assertString(ownerPubkey, 'ownerPubkey');
    const decoded = tryDecodeInstruction(data);
    if (!decoded.ok) {
      throw new EncodingError(
        `innerInstruction: does not decode as a XerisInstruction (${decoded.reason}); the block skips it after charging the fee (ledger.rs:6399-6405)`,
        { field: 'innerInstruction' },
      );
    }
    const { variant, name, fields } = decoded.value;
    if (variant === Variant.AgentExecute || variant === Variant.ConditionalOrder) {
      throw new RangeError(`innerInstruction: nested ${name} (variant ${variant}) is rejected at ingress (ledger.rs:1439)`);
    }
    if (!AGENT_INNER_VARIANTS.includes(variant)) {
      throw new RangeError(`innerInstruction: AgentExecute inner instruction type not in allowlist (${name}, variant ${variant}); allowed: ${AGENT_OPERATIONS.join(', ')} (ledger.rs:6425-6485)`);
    }
    if (variant === Variant.Stake || variant === Variant.Unstake) {
      throw disabledFeature('agentStake');
    }
    if ((variant === Variant.TokenTransfer || variant === Variant.TokenBurn) && fields.from !== ownerPubkey) {
      // ledger.rs:6522, 6648-6655 run the inner instruction with owner_pubkey as the
      // signer; token.rs:1104 / 1151 then refuse a different `from`.
      throw new RangeError(
        `innerInstruction: nested ${name}.from ${fields.from} is not the AgentExecute owner ${ownerPubkey}; the block runs it as the owner and drops it after charging the fee (ledger.rs:6522, 6648-6655; token.rs:${variant === Variant.TokenTransfer ? 1104 : 1151})`,
      );
    }
    if (variant === Variant.ContractCall) {
      const contractId = fields.contract_id;
      const method = fields.method;
      const args = fields.args;
      if (contractId.startsWith('agent_registry_')) {
        throw new RangeError(`innerInstruction: delegated calls to agent registries are rejected by the node (contract '${contractId}', ledger.rs:6428-6431)`);
      }
      // serde_json::from_slice::<Value> (ledger.rs:6436-6442) refuses invalid UTF-8,
      // lone surrogates and out-of-range numbers; parseJson with forNode mirrors it.
      let parsed;
      let why = 'not a JSON object';
      try {
        parsed = parseJson(STRICT_UTF8.decode(args), 'innerInstruction.args', { forNode: true });
      } catch (err) {
        if (!(err instanceof SyntaxError || err instanceof RangeError || err instanceof TypeError)) throw err;
        parsed = undefined;
        why = err.message;
      }
      if (!isPlainObject(parsed)) {
        if (SWAP_METHODS.includes(method)) throw disabledFeature('agentSwap');
        throw new XerisError(`innerInstruction: delegated ContractCall args must be a JSON object the node can parse so it can bound the spend; method '${method}' carried ${args.length} bytes that are not (${why}) (ledger.rs:6436-6442)`);
      }
      if (!DELEGATED_CALL_METHODS.includes(method)) {
        throw disabledFeature('agentDelegatedMethod');
      }
    }
  },

  /**
   * RegisterAgent/UpdateAgent `allowed_operations`: every entry is one of
   * `AGENT_OPERATIONS`, matched by exact string by the registry
   * (`contracts.rs:3471-3477`; the operation names come from
   * `ledger.rs:6425-6477`). An empty list allows every operation.
   * @param {string[]} list
   * @throws {TypeError|RangeError}
   */
  agentOperations(list) {
    if (!Array.isArray(list)) throw new TypeError(`allowedOperations: expected an array of strings, got ${describe(list)}`);
    for (let i = 0; i < list.length; i += 1) {
      checks.oneOf(list[i], AGENT_OPERATIONS, `allowedOperations[${i}]`);
    }
  },
});

// ---------------------------------------------------------------------------
// XerisClient
// ---------------------------------------------------------------------------

/**
 * Options accepted by the `XerisClient` constructor.
 * @typedef {object} ClientOptions
 * @property {number} [rpcPort] RPC server port appended to `host` (default `DEFAULT_RPC_PORT`, `main.rs:831, 839`).
 * @property {number} [explorerPort] Explorer port appended to `host` (default `DEFAULT_EXPLORER_PORT`, `main.rs:832, 840`).
 * @property {string} [rpcUrl] Full RPC base URL; overrides `host` + `rpcPort`.
 * @property {string} [explorerUrl] Full explorer base URL; overrides `host` + `explorerPort`.
 * @property {typeof fetch} [fetch] `fetch` implementation (default `globalThis.fetch`).
 * @property {number} [timeoutMs] Per-request timeout in milliseconds (default 30000).
 */

/**
 * `getLatestBlockhashInfo` result (JSON-RPC `getLatestBlockhash`, `explorer.rs:1489-1500`).
 * @typedef {object} BlockhashInfo
 * @property {number} slot Slot of the newest in-memory block.
 * @property {string} blockhash 64 lowercase hex characters (32 bytes).
 * @property {number} lastValidBlockHeight `slot + 150` (`BLOCKHASH_EXPIRY_WINDOW`, `ledger.rs:239`).
 */

/**
 * `GET /v2/tx/{sig}` data object (`explorer.rs:1226-1241`).
 * @typedef {object} TxDetail
 * @property {string} signature
 * @property {number} block_slot
 * @property {string} block_hash hex
 * @property {number} poh_timestamp Unix milliseconds.
 * @property {string} from
 * @property {string} to
 * @property {number} amount
 * @property {number} amount_xrs
 * @property {string} tx_type
 * @property {object|null} details
 * @property {'confirmed'|'failed'|'partial'|'included'} status `explorer.rs:680-690`
 * @property {Array<{index: number, status: 'confirmed'|'failed'}>} instructions
 * @property {number} confirmations `current_slot - block_slot`
 */

/**
 * Client for one node: builds, signs and submits transactions with an
 * `XerisKeypair`, and reads the RPC and explorer servers. Construct with a
 * host (`new XerisClient('http://138.197.116.81')`), or use
 * `XerisClient.testnet()` / `XerisClient.mainnet(host)`.
 */
class XerisClient {
  /** @type {string|null} */
  #host;
  /** @type {string} */
  #rpcUrl;
  /** @type {string} */
  #explorerUrl;
  /** @type {typeof fetch} */
  #fetch;
  /** @type {number} */
  #timeoutMs;
  /** @type {number} */
  #nextRpcId = 1;

  /**
   * @param {string|null} host Node base URL with scheme and no port, e.g.
   *   `'http://138.197.116.81'`; trailing slashes are stripped. May be `null`
   *   only when both `opts.rpcUrl` and `opts.explorerUrl` are given.
   * @param {ClientOptions} [opts={}]
   * @throws {TypeError} For a non-object `opts` or wrongly typed option.
   * @throws {RangeError} For a port outside 1..65535 or a non-positive `timeoutMs`.
   * @throws {XerisError} code `'config'` for a malformed host/URL, a missing
   *   `fetch`, or a `null` host without both URL overrides.
   */
  constructor(host, opts = {}) {
    if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
      throw new TypeError(`opts: expected an object, got ${describe(opts)}`);
    }
    const rpcPort = opts.rpcPort === undefined ? DEFAULT_RPC_PORT : port(opts.rpcPort, 'opts.rpcPort');
    const explorerPort = opts.explorerPort === undefined ? DEFAULT_EXPLORER_PORT : port(opts.explorerPort, 'opts.explorerPort');
    const rpcOverride = opts.rpcUrl === undefined ? null : baseUrl(opts.rpcUrl, 'opts.rpcUrl', { allowPort: true, allowPath: true });
    const explorerOverride = opts.explorerUrl === undefined ? null : baseUrl(opts.explorerUrl, 'opts.explorerUrl', { allowPort: true, allowPath: true });

    if (host === null || host === undefined) {
      if (rpcOverride === null || explorerOverride === null) {
        throw new XerisError('host: pass the node base URL, or both opts.rpcUrl and opts.explorerUrl', { code: 'config' });
      }
      this.#host = null;
    } else {
      this.#host = baseUrl(host, 'host', { allowPort: false, allowPath: false });
    }
    this.#rpcUrl = rpcOverride !== null ? rpcOverride : `${this.#host}:${rpcPort}`;
    this.#explorerUrl = explorerOverride !== null ? explorerOverride : `${this.#host}:${explorerPort}`;

    if (opts.fetch !== undefined) {
      if (typeof opts.fetch !== 'function') throw new TypeError(`opts.fetch: expected a function, got ${describe(opts.fetch)}`);
      this.#fetch = opts.fetch;
    } else if (typeof globalThis.fetch === 'function') {
      this.#fetch = globalThis.fetch.bind(globalThis);
    } else {
      throw new XerisError('opts.fetch: no global fetch is available (Node >= 18 required); pass opts.fetch', { code: 'config' });
    }

    if (opts.timeoutMs === undefined) {
      this.#timeoutMs = 30000;
    } else {
      if (typeof opts.timeoutMs !== 'number') throw new TypeError(`opts.timeoutMs: expected a number, got ${describe(opts.timeoutMs)}`);
      if (!Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs <= 0) {
        throw new RangeError(`opts.timeoutMs: expected a positive integer number of milliseconds, got ${describe(opts.timeoutMs)}`);
      }
      this.#timeoutMs = opts.timeoutMs;
    }
  }

  /**
   * Client for the published testnet validator (`TESTNET_SEED`, `network.rs:298`).
   * @param {ClientOptions} [opts]
   * @returns {XerisClient}
   */
  static testnet(opts) {
    return opts === undefined ? new XerisClient(`http://${TESTNET_SEED}`) : new XerisClient(`http://${TESTNET_SEED}`, opts);
  }

  /**
   * Client for mainnet. The node has no built-in mainnet host
   * (`network.rs:282-300`; `main.rs:821, 841` only define `--mainnet`), so
   * `host` or the `XERIS_MAINNET_HOST` environment variable is required.
   * @param {string} [host] Node base URL; defaults to `process.env.XERIS_MAINNET_HOST`.
   * @param {ClientOptions} [opts]
   * @returns {XerisClient}
   * @throws {XerisError} code `'config'`: `mainnet host not configured: pass a host or set XERIS_MAINNET_HOST`.
   */
  static mainnet(host, opts) {
    const resolved = host === undefined || host === null ? mainnetHostFromEnv() : host;
    if (resolved === null) {
      throw new XerisError(`mainnet host not configured: pass a host or set ${MAINNET_HOST_ENV}`, { code: 'config' });
    }
    return opts === undefined ? new XerisClient(resolved) : new XerisClient(resolved, opts);
  }

  /**
   * True when `err` is the write limiter's rejection (30 write requests per
   * 60 s per IP on `/submit`, `/stake`, `/unstake`, `/pq-register`;
   * `network.rs:4308, 4665-4667`). The client never retries on its own.
   * @param {unknown} err
   * @returns {boolean}
   */
  static isRateLimited(err) {
    return err instanceof RpcError && err.message === RATE_LIMIT_MESSAGE;
  }

  /** @returns {string|null} The base URL the ports were appended to, or `null` when both URLs were given. */
  get host() { return this.#host; }

  /** @returns {string} RPC server base URL (no trailing slash). */
  get rpcUrl() { return this.#rpcUrl; }

  /** @returns {string} Explorer server base URL (no trailing slash). */
  get explorerUrl() { return this.#explorerUrl; }

  /** @returns {number} Per-request timeout in milliseconds. */
  get timeoutMs() { return this.#timeoutMs; }

  // --------------------------------------------------------------------------
  // Transport
  // --------------------------------------------------------------------------

  /**
   * One HTTP round trip with the D6 error rule. The request body is written
   * with `stringifyJson` (a `bigint` becomes an exact JSON integer; values
   * `JSON.stringify` would drop or rewrite throw) and the response is read
   * with `parseJson`, so integers above 2^53-1 (token balances and supplies
   * on 10^18-unit tokens, `tokens_out`, a plan's `min_tokens_out`) arrive as
   * `bigint` with their exact value; every other number is a `number`.
   * @private
   * @param {'GET'|'POST'} method
   * @param {string} url Absolute URL.
   * @param {unknown} [body] JSON body for POST.
   * @param {string} [routeLabel] Label recorded on `RpcError.route` (default `METHOD path`).
   * @returns {Promise<unknown>} Parsed JSON body.
   * @throws {XerisError} code `'timeout'` when the request exceeds `timeoutMs`.
   * @throws {RpcError} code `'rpc_transport'` (fetch failed), `'rpc_http'` (non-2xx),
   *   `'rpc_json'` (unparsable body), `'rpc'` (HTTP 200 body with a string `error`
   *   and `success !== true`).
   */
  async _request(method, url, body, routeLabel) {
    let route = routeLabel;
    if (route === undefined) {
      try {
        const u = new URL(url);
        route = `${method} ${u.pathname}${u.search}`;
      } catch (_) {
        route = `${method} ${url}`;
      }
    }
    const init = { method, headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = stringifyJson(body, 'body');
    }
    const controller = new AbortController();
    init.signal = controller.signal;
    const timeoutMs = this.#timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let resp;
    let text;
    try {
      resp = await this.#fetch(url, init);
      text = await resp.text();
    } catch (cause) {
      if (controller.signal.aborted || (cause && cause.name === 'AbortError')) {
        throw new XerisError(`${route}: no response within ${timeoutMs} ms`, { code: 'timeout', cause });
      }
      throw new RpcError(`${route}: request failed: ${causeText(cause)}`, { code: 'rpc_transport', route, cause });
    } finally {
      clearTimeout(timer);
    }

    let data;
    let parsed = false;
    let parseError = null;
    try {
      data = parseJson(text, 'response');
      parsed = true;
    } catch (e) {
      data = undefined;
      parseError = e;
    }

    if (!resp.ok) {
      const bodyValue = parsed ? data : text;
      let detail = '';
      if (parsed && isPlainObject(data)) {
        if (typeof data.error === 'string') detail += `: ${data.error}`;
        if (typeof data.reason === 'string') detail += ` (${data.reason})`;
      }
      throw new RpcError(`${route}: HTTP ${resp.status}${resp.statusText ? ` ${resp.statusText}` : ''}${detail}`, {
        code: 'rpc_http',
        route,
        httpStatus: resp.status,
        body: bodyValue,
      });
    }
    if (!parsed) {
      throw new RpcError(`${route}: response is not usable JSON (${text.length} bytes): ${causeText(parseError)}`, {
        code: 'rpc_json', route, httpStatus: resp.status, body: text, cause: parseError,
      });
    }
    // D6: handlers reply HTTP 200 with {"error": "..."} on failure (network.rs:4825-4843 and
    // every warp::reply::json error branch; explorer.rs:1063, 1077, 1103, 1246, 1963).
    if (isPlainObject(data) && typeof data.error === 'string' && data.success !== true) {
      throw new RpcError(data.error, {
        route,
        httpStatus: resp.status,
        body: data,
        nodeStatus: typeof data.status === 'string' ? data.status : null,
        hint: typeof data.hint === 'string' ? data.hint : null,
      });
    }
    return data;
  }

  /**
   * `GET url` through `_request`.
   * @private
   * @param {string} url
   * @returns {Promise<unknown>}
   */
  _get(url) {
    return this._request('GET', url);
  }

  /**
   * `POST url` with a JSON body through `_request`.
   * @private
   * @param {string} url
   * @param {unknown} body
   * @returns {Promise<unknown>}
   */
  _post(url, body) {
    return this._request('POST', url, body);
  }

  /**
   * JSON-RPC 2.0 call to `POST {explorerUrl}/` (`explorer.rs:1429-1431`).
   * `jsonrpc` and `id` are mandatory in the request (`explorer.rs:1420-1426`).
   * The node never sets a top-level `error`; failures come back as
   * `{"result": {"error": "..."}}` (`explorer.rs:1455, 1481, 1499, 1517, 1536,
   * 1554, 1565`) and are raised here as `RpcError`. A `null` result is a
   * valid value (`getBlock`, `getTransaction` misses).
   * @private
   * @param {string} method
   * @param {unknown[]} [params=[]]
   * @returns {Promise<unknown>} `result`.
   * @throws {RpcError|XerisError}
   */
  async _jsonRpc(method, params = []) {
    const route = `JSON-RPC ${method}`;
    const id = this.#nextRpcId;
    this.#nextRpcId += 1;
    const data = await this._request('POST', `${this.#explorerUrl}/`, { jsonrpc: '2.0', id, method, params }, route);
    if (!isPlainObject(data)) {
      throw new RpcError(`${route}: expected a JSON-RPC response object, got ${describe(data)}`, { code: 'rpc_json', route, httpStatus: 200, body: data });
    }
    if (data.error !== undefined && data.error !== null) {
      // Kept defensively; explorer.rs:1631-1635 never emits it.
      const e = data.error;
      const msg = typeof e === 'string' ? e : (isPlainObject(e) && typeof e.message === 'string' ? e.message : JSON.stringify(e));
      throw new RpcError(`${route}: ${msg}`, { route, httpStatus: 200, body: data });
    }
    const result = data.result;
    if (isPlainObject(result) && typeof result.error === 'string') {
      throw new RpcError(`${route}: ${result.error}`, { route, httpStatus: 200, body: data });
    }
    return result;
  }

  // --------------------------------------------------------------------------
  // Core transaction methods (blueprint §10.4)
  // --------------------------------------------------------------------------

  /**
   * JSON-RPC `getLatestBlockhash` (`explorer.rs:1489-1500`): the newest
   * in-memory block's hash as hex plus `lastValidBlockHeight = slot + 150`.
   * The node's error hint naming `/v2/recent_blockhash` refers to a route
   * that does not exist (`network.rs:4397, 4517, 4627, 4794`); this is the
   * real source, as used by the reference wallet (`bin/wallet.rs:484-510`).
   * @returns {Promise<BlockhashInfo>}
   * @throws {RpcError} `No blocks` on an empty chain (`explorer.rs:1499`), or a malformed result.
   */
  async getLatestBlockhashInfo() {
    const result = await this._jsonRpc('getLatestBlockhash');
    const ok = isPlainObject(result)
      && isPlainObject(result.context) && typeof result.context.slot === 'number'
      && isPlainObject(result.value) && typeof result.value.blockhash === 'string'
      && typeof result.value.lastValidBlockHeight === 'number';
    if (!ok) {
      throw new RpcError(`JSON-RPC getLatestBlockhash: unexpected result shape ${describe(result)}`, { code: 'rpc_json', route: 'JSON-RPC getLatestBlockhash', body: result });
    }
    return { slot: result.context.slot, blockhash: result.value.blockhash, lastValidBlockHeight: result.value.lastValidBlockHeight };
  }

  /**
   * The newest block hash as the 32 raw bytes a transaction carries
   * (`getLatestBlockhashInfo` → `blockhashFromHex`). Valid for the next 150
   * blocks (`ledger.rs:239, 4006-4035`).
   * @returns {Promise<Buffer>} 32 bytes.
   * @throws {RpcError|EncodingError}
   */
  async getLatestBlockhash() {
    const info = await this.getLatestBlockhashInfo();
    return blockhashFromHex(info.blockhash);
  }

  /**
   * Builds, signs and submits a single-signer transaction holding 1..16
   * encoded instructions (`ledger.rs:94`): each is checked with
   * `assertInstructionSubmittable` (size caps, disabled variants), then
   * `getLatestBlockhash` → `assembleSignedTransaction` → `POST {route}` with
   * `{tx_base64}` (`network.rs:1577-1578`). `opts.route` selects one of the
   * four write routes; the dedicated ones require a matching first
   * instruction (`/stake` → Stake `network.rs:4360-4370`, `/unstake` →
   * Unstake `network.rs:4464-4474`, `/pq-register` → PqKeyRegister
   * `network.rs:4597-4602`). `status: 'ok'`/`'queued'` means mempool
   * admission, not confirmation: poll `waitForConfirmation`.
   *
   * Retrying: when the request was sent but no usable answer came back
   * (`code` `timeout`, `rpc_transport`, `rpc_http`, `rpc_json`), the node may
   * already hold the transaction. The error then carries `err.signature` and
   * `err.txBase64`. Do not call `sendInstruction` again: it fetches a new
   * blockhash and signs a second transaction with a new signature, which the
   * node's signature-based duplicate check (`network.rs:4686-4692,
   * 4772-4778`) does not catch, so the transfer can execute twice. Instead poll
   * `waitForConfirmation(err.signature)`, or resend the same bytes with
   * `submitSignedTransaction(err.txBase64)` while the blockhash is valid
   * (150 slots); a copy the node already holds is answered with an
   * `RpcError` of code `duplicate`.
   * @param {XerisKeypair} keypair Signer and fee payer (`BASE_TX_FEE` per transaction, `ledger.rs:58`).
   * @param {Buffer|Uint8Array|Array<Buffer|Uint8Array>} instructionData One encoded instruction or 1..16 of them.
   * @param {{route?: '/submit'|'/stake'|'/unstake'|'/pq-register'}} [opts={}] Default route `'/submit'`.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError} Wrong keypair/instruction/opts types.
   * @throws {RangeError} 0 or more than 16 instructions, an unknown route, an oversize instruction, or a
   *   first instruction that does not match the dedicated route.
   * @throws {EncodingError|FeatureDisabledError} From `assertInstructionSubmittable`.
   * @throws {RpcError|XerisError} Node rejection (`network.rs:4664-4858`), transport failure or timeout;
   *   after the request was sent, `timeout` / `rpc_transport` / `rpc_http` / `rpc_json` / `duplicate`
   *   errors carry `.signature` and `.txBase64`.
   */
  async sendInstruction(keypair, instructionData, opts = {}) {
    requireKeypair(keypair);
    if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
      throw new TypeError(`opts: expected an object, got ${describe(opts)}`);
    }
    onlyKeys(opts, ['route'], 'opts');
    const route = opts.route === undefined ? '/submit' : opts.route;
    if (!WRITE_ROUTES.includes(route)) {
      throw new RangeError(`opts.route: expected one of ${WRITE_ROUTES.map((r) => `'${r}'`).join(', ')}, got ${describe(route)} (network.rs:4336, 4440, 4571, 4664)`);
    }
    let list;
    if (Array.isArray(instructionData)) list = instructionData;
    else if (instructionData instanceof Uint8Array) list = [instructionData];
    else throw new TypeError(`instructionData: expected a Buffer or an array of Buffers, got ${describe(instructionData)}`);
    if (list.length === 0) throw new RangeError('instructionData: at least one instruction is required (network.rs:159-161)');
    if (list.length > MAX_IX_PER_TX) {
      throw new RangeError(`instructionData: ${list.length} instructions exceeds MAX_IX_PER_TX = ${MAX_IX_PER_TX} (ledger.rs:94)`);
    }
    const variants = list.map((data, i) => assertInstructionSubmittable(data, i));
    const required = ROUTE_FIRST_VARIANT[route];
    if (required !== undefined && variants[0] !== required) {
      throw new RangeError(`opts.route: POST ${route} requires the first instruction to be ${VARIANT_NAMES[required]} (variant ${required}), got ${VARIANT_NAMES[variants[0]]} (variant ${variants[0]})`);
    }
    const blockhash = await this.getLatestBlockhash();
    const { txBytes, txBase64, signature } = assembleSignedTransaction(keypair, list, blockhash);
    return this._submit(route, submitBody(txBytes), txBase64, signature);
  }

  /**
   * Posts `{tx_base64}` to a write route and parses the reply. When the request
   * was sent but its outcome is unknown (`timeout`, `rpc_transport`,
   * `rpc_http`, `rpc_json`), the error gets `signature` and `txBase64` so the
   * caller can poll or resend the same bytes instead of signing again. A node
   * reply saying it already holds the signature becomes `RpcError` with code
   * `duplicate` and the same two properties.
   * @private
   * @param {string} route One of `WRITE_ROUTES`.
   * @param {{tx_base64: string}} body
   * @param {string} txBase64
   * @param {string} signature base58 first signature of the transaction.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {RpcError|XerisError}
   */
  async _submit(route, body, txBase64, signature) {
    const label = `POST ${route}`;
    let data;
    try {
      data = await this._post(`${this.#rpcUrl}${route}`, body);
    } catch (err) {
      if (err instanceof XerisError && UNCERTAIN_SUBMIT_CODES.includes(err.code)) {
        err.signature = signature;
        err.txBase64 = txBase64;
        err.message = `${err.message}; the node may hold transaction ${signature}: poll waitForConfirmation(err.signature) or resend err.txBase64 with submitSignedTransaction, do not sign again`;
        throw err;
      }
      if (err instanceof RpcError && DUPLICATE_MESSAGES.includes(err.message)) {
        throw duplicateError(err, route, signature, txBase64);
      }
      throw err;
    }
    try {
      return parseSubmitResponse(data, label, 200);
    } catch (err) {
      if (err instanceof RpcError && DUPLICATE_MESSAGES.includes(err.message)) {
        throw duplicateError(err, route, signature, txBase64);
      }
      throw err;
    }
  }

  /**
   * Submits an already signed and serialized transaction (for example from a
   * wallet provider via `serializedFromWalletResult`, or `err.txBase64` from a
   * send that timed out) as `{tx_base64}`. Resending identical bytes is safe:
   * the node deduplicates by first signature and answers a copy it already
   * holds with `Transaction already processed` / `Transaction already in
   * mempool` (`network.rs:4690-4692, 4774-4777`), raised here as `RpcError`
   * with code `duplicate` and `.signature`.
   * @param {string} txBase64 Padded standard base64 of the serialized transaction, at most `MAX_TX_BYTES` (`tx_pool.rs:183`).
   * @param {'/submit'|'/stake'|'/unstake'|'/pq-register'} [route='/submit']
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError} Non-string input.
   * @throws {EncodingError} Not padded base64, too short to hold a signature, or not a single-signature transaction.
   * @throws {RangeError} Unknown route or oversize transaction.
   * @throws {RpcError|XerisError} As `sendInstruction`, including `.signature` / `.txBase64` on an uncertain outcome
   *   and code `duplicate`.
   */
  async submitSignedTransaction(txBase64, route = '/submit') {
    if (typeof txBase64 !== 'string') throw new TypeError(`txBase64: expected a base64 string, got ${describe(txBase64)}`);
    if (txBase64.length === 0 || txBase64.length % 4 !== 0 || !BASE64_PATTERN.test(txBase64)) {
      throw new EncodingError('txBase64: expected padded standard-alphabet base64 (network.rs:4668 "Invalid base64 encoding")', { field: 'txBase64' });
    }
    if (!WRITE_ROUTES.includes(route)) {
      throw new RangeError(`route: expected one of ${WRITE_ROUTES.map((r) => `'${r}'`).join(', ')}, got ${describe(route)}`);
    }
    const bytes = Buffer.from(txBase64, 'base64');
    if (bytes.length < 1 + ED25519_SIGNATURE_LEN) {
      throw new EncodingError(`txBase64: ${bytes.length} bytes is too short for a signed transaction`, { field: 'txBase64' });
    }
    if (bytes.length > MAX_TX_BYTES) {
      throw new RangeError(`txBase64: ${bytes.length} bytes exceeds MAX_TX_BYTES = ${MAX_TX_BYTES} (tx_pool.rs:183)`);
    }
    return this._submit(route, { tx_base64: txBase64 }, txBase64, signatureOf(bytes));
  }

  /**
   * Polls `GET /v2/tx/{signature}` until the explorer reports the
   * transaction. Resolves with the `data` object on the first hit; its
   * `status` is `confirmed`, `failed`, `partial` or `included` (`included`
   * means the node has no receipt store and can vouch only for block
   * membership, `explorer.rs:680-690`). `Transaction not found` keeps
   * polling; any other error propagates. The explorer searches only the
   * newest `MAX_RECENT_BLOCKS` (1000) in-memory blocks (`ledger.rs:36`).
   * @param {string} signature base58 transaction signature.
   * @param {{timeoutMs?: number, intervalMs?: number}} [opts={}] Defaults:
   *   `timeoutMs = BLOCKHASH_EXPIRY_WINDOW * SLOT_MS` (600000), `intervalMs = SLOT_MS` (4000).
   * @returns {Promise<TxDetail>}
   * @throws {TypeError|RangeError} Bad arguments, including an unknown `opts` key.
   * @throws {XerisError} code `'timeout'`: `transaction <sig> not found within <ms> ms (the node only searches its last 1000 in-memory blocks)`.
   * @throws {RpcError} Any explorer error other than `Transaction not found`.
   */
  async waitForConfirmation(signature, opts = {}) {
    assertString(signature, 'signature');
    if (signature.length === 0) throw new RangeError('signature: must not be empty');
    if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
      throw new TypeError(`opts: expected an object, got ${describe(opts)}`);
    }
    onlyKeys(opts, ['timeoutMs', 'intervalMs'], 'opts');
    const timeoutMs = opts.timeoutMs === undefined ? BLOCKHASH_EXPIRY_WINDOW * SLOT_MS : pageInt(opts.timeoutMs, 'opts.timeoutMs', 0);
    const intervalMs = opts.intervalMs === undefined ? SLOT_MS : pageInt(opts.intervalMs, 'opts.intervalMs', 0);
    const started = Date.now();
    for (;;) {
      let res = null;
      try {
        res = await this.getTransaction(signature);
      } catch (e) {
        if (!(e instanceof RpcError && e.message === TX_NOT_FOUND_MESSAGE)) throw e;
      }
      if (res !== null) {
        return isPlainObject(res) && res.data !== undefined ? res.data : res;
      }
      if (Date.now() - started >= timeoutMs) {
        throw new XerisError(
          `transaction ${signature} not found within ${timeoutMs} ms (the node only searches its last ${MAX_RECENT_BLOCKS} in-memory blocks)`,
          { code: 'timeout' },
        );
      }
      await sleep(intervalMs);
    }
  }

  // --------------------------------------------------------------------------
  // Write wrappers (blueprint §10.5). Signature: (keypair, ...fields minus the
  // signer-bound ones). `*Xrs` amounts are XRS (number | decimal string),
  // converted exactly with xrsToLamports; every other amount is base units.
  // --------------------------------------------------------------------------

  /**
   * NativeTransfer (variant 11) of `amountXrs` XRS from the keypair to `to`.
   * `to` must be a canonical public key and not a `__*` pseudo-account
   * (`ledger.rs:1569-1577, 5602`); the amount must be > 0 (`ledger.rs:1570`).
   * @param {XerisKeypair} keypair Sender; the node requires `from` to be the signer (`ledger.rs:5594`).
   * @param {string} to Recipient address.
   * @param {number|string} amountXrs XRS as a number or decimal string with at most 9 fractional digits.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async transferXrs(keypair, to, amountXrs) {
    arity(arguments.length, 3, 'transferXrs', 'keypair, to, amountXrs');
    requireKeypair(keypair);
    checks.transferTarget(to);
    const lamports = xrsToLamports(amountXrs, 'amountXrs');
    checks.positive(lamports, 'amountXrs');
    return this.sendInstruction(keypair, Instructions.nativeTransfer(keypair.publicKey, to, lamports));
  }

  /**
   * NativeTransfer (variant 11) in base units.
   * @param {XerisKeypair} keypair Sender.
   * @param {string} to Recipient address (canonical, not `__*`; `ledger.rs:1569-1577`).
   * @param {number|bigint} lamports Amount > 0.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async transferLamports(keypair, to, lamports) {
    arity(arguments.length, 3, 'transferLamports', 'keypair, to, lamports');
    requireKeypair(keypair);
    checks.transferTarget(to);
    checks.positive(lamports, 'lamports');
    return this.sendInstruction(keypair, Instructions.nativeTransfer(keypair.publicKey, to, lamports));
  }

  /**
   * Stake (variant 9) `amountXrs` XRS for the keypair, by default through
   * `POST /stake` (`network.rs:4336-4432`: signer/balance pre-checks, reply
   * `status: 'queued'`). Staking is federation-gated: when the node runs with
   * `XRS_FEDERATED_PRODUCERS` (mandatory on mainnet) only roster keys may
   * stake (`network.rs:2407-2417`). The resulting stake must reach
   * `MIN_STAKE_LAMPORTS` (1,000 XRS) or the block dispatcher drops it
   * (`ledger.rs:5713-5718`).
   * @param {XerisKeypair} keypair Staker; `pubkey` must be the signer (`network.rs:4372-4378`).
   * @param {number|string} amountXrs XRS, > 0.
   * @param {{route?: '/stake'|'/submit'}} [opts={}] Default `'/stake'`.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async stakeXrs(keypair, amountXrs, opts = {}) {
    arity(arguments.length, 2, 'stakeXrs', 'keypair, amountXrs, [opts]', 1);
    requireKeypair(keypair);
    const route = this._routeOption(opts, '/stake');
    const lamports = xrsToLamports(amountXrs, 'amountXrs');
    checks.positive(lamports, 'amountXrs');
    return this.sendInstruction(keypair, Instructions.stake(keypair.publicKey, lamports), { route });
  }

  /**
   * Unstake (variant 10) `amountXrs` XRS, by default through `POST /unstake`
   * (`network.rs:4440-4552`; reply carries `unbonding_period_slots: 151200`,
   * `ledger.rs:201`). Dust rules: a partial unstake must be at least
   * `MIN_UNSTAKE_LAMPORTS` (1 XRS) unless it unstakes everything
   * (`ledger.rs:5759-5763`), and must leave either nothing or at least
   * `MIN_STAKE_LAMPORTS` staked (`network.rs:4499-4505`; `ledger.rs:5772-5776`).
   * @param {XerisKeypair} keypair Staker; `pubkey` must be the signer (`network.rs:4477-4482`).
   * @param {number|string} amountXrs XRS, > 0.
   * @param {{route?: '/unstake'|'/submit'}} [opts={}] Default `'/unstake'`.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async unstakeXrs(keypair, amountXrs, opts = {}) {
    arity(arguments.length, 2, 'unstakeXrs', 'keypair, amountXrs, [opts]', 1);
    requireKeypair(keypair);
    const route = this._routeOption(opts, '/unstake');
    const lamports = xrsToLamports(amountXrs, 'amountXrs');
    checks.positive(lamports, 'amountXrs');
    return this.sendInstruction(keypair, Instructions.unstake(keypair.publicKey, lamports), { route });
  }

  /**
   * WrapXrs (variant 13): moves `amountXrs` XRS from the native balance into
   * the `xrs_native` token balance (`ledger.rs:5631-5657`), which Launchpad
   * buys and AMM swaps spend (`contracts.rs:2852-2857`).
   * @param {XerisKeypair} keypair
   * @param {number|string} amountXrs XRS, > 0.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async wrapXrs(keypair, amountXrs) {
    arity(arguments.length, 2, 'wrapXrs', 'keypair, amountXrs');
    requireKeypair(keypair);
    const lamports = xrsToLamports(amountXrs, 'amountXrs');
    checks.positive(lamports, 'amountXrs');
    return this.sendInstruction(keypair, Instructions.wrapXrs(lamports));
  }

  /**
   * UnwrapXrs (variant 14): the inverse of `wrapXrs` (`ledger.rs:5658-5684`).
   * @param {XerisKeypair} keypair
   * @param {number|string} amountXrs XRS, > 0.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async unwrapXrs(keypair, amountXrs) {
    arity(arguments.length, 2, 'unwrapXrs', 'keypair, amountXrs');
    requireKeypair(keypair);
    const lamports = xrsToLamports(amountXrs, 'amountXrs');
    checks.positive(lamports, 'amountXrs');
    return this.sendInstruction(keypair, Instructions.unwrapXrs(lamports));
  }

  /**
   * ValidatorAttestation (variant 12) for block `blockSlot` with its exact
   * 32-byte hash. `/submit` pre-checks (`network.rs:4694-4768`): the attestor
   * needs ≥ 100 XRS staked (`MIN_ATTESTOR_STAKE_LAMPORTS`), the slot must be
   * within `ATTESTATION_SLOT_WINDOW` (200) of the chain tip, the hash must
   * match exactly, and one reward per 10 slots per validator is paid
   * (`ATTESTATION_REWARD_LAMPORTS`, 0.01 XRS). The hash of the newest block
   * is `getBlocks(1, 1).data[0].hash` (hex).
   * @param {XerisKeypair} keypair The validator (`validator` must equal the signer, `ledger.rs:1407-1409`).
   * @param {number|bigint} blockSlot Slot being attested.
   * @param {Buffer|Uint8Array|string} blockHash 32 raw bytes, or 64 hex characters.
   * @returns {Promise<import('./transaction').SubmitResult>} Includes `attestation_accepted`, `reward`, `reward_xrs` (`network.rs:4847-4856`).
   * @throws {TypeError|RangeError|EncodingError|RpcError|XerisError}
   */
  async submitAttestation(keypair, blockSlot, blockHash) {
    arity(arguments.length, 3, 'submitAttestation', 'keypair, blockSlot, blockHash');
    requireKeypair(keypair);
    const hash = typeof blockHash === 'string' ? blockhashFromHex(blockHash) : toBytes(blockHash, 'blockHash');
    checks.attestation(hash, keypair.publicKey, keypair.publicKey);
    return this.sendInstruction(keypair, Instructions.validatorAttestation(keypair.publicKey, blockSlot, hash));
  }

  /**
   * TokenCreate (variant 3) with the keypair as mint authority
   * (`token.rs:1036`).
   * @param {XerisKeypair} keypair Mint authority.
   * @param {string} tokenId
   * @param {string} name
   * @param {string} symbol
   * @param {number|bigint} decimals `u8`.
   * @param {number|bigint} maxSupply Base units.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async createToken(keypair, tokenId, name, symbol, decimals, maxSupply) {
    arity(arguments.length, 6, 'createToken', 'keypair, tokenId, name, symbol, decimals, maxSupply');
    requireKeypair(keypair);
    return this.sendInstruction(keypair, Instructions.tokenCreate(tokenId, name, symbol, decimals, maxSupply, keypair.publicKey));
  }

  /**
   * TokenMint (variant 0); the signer must be the token's mint authority
   * (`token.rs:1080`) and the amount > 0 (`ledger.rs:1420-1421`).
   * @param {XerisKeypair} keypair Mint authority.
   * @param {string} tokenId
   * @param {string} to Recipient.
   * @param {number|bigint} amount Base units, > 0.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async mintTokens(keypair, tokenId, to, amount) {
    arity(arguments.length, 4, 'mintTokens', 'keypair, tokenId, to, amount');
    requireKeypair(keypair);
    checks.positive(amount, 'amount');
    return this.sendInstruction(keypair, Instructions.tokenMint(tokenId, to, amount));
  }

  /**
   * TokenTransfer (variant 1) from the keypair; `to` must differ from the
   * signer and the amount be > 0 (`token.rs:1104-1116`).
   * @param {XerisKeypair} keypair Sender (`from`).
   * @param {string} tokenId
   * @param {string} to Recipient.
   * @param {number|bigint} amount Base units, > 0.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async transferToken(keypair, tokenId, to, amount) {
    arity(arguments.length, 4, 'transferToken', 'keypair, tokenId, to, amount');
    requireKeypair(keypair);
    assertString(to, 'to');
    checks.positive(amount, 'amount');
    if (to === keypair.publicKey) throw new RangeError('to: a token transfer to the sender is rejected by the node (token.rs:1111)');
    return this.sendInstruction(keypair, Instructions.tokenTransfer(tokenId, keypair.publicKey, to, amount));
  }

  /**
   * TokenBurn (variant 2) from the keypair's balance (`token.rs:1147-1175`).
   * @param {XerisKeypair} keypair Holder (`from`).
   * @param {string} tokenId
   * @param {number|bigint} amount Base units, > 0.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async burnTokens(keypair, tokenId, amount) {
    arity(arguments.length, 3, 'burnTokens', 'keypair, tokenId, amount');
    requireKeypair(keypair);
    checks.positive(amount, 'amount');
    return this.sendInstruction(keypair, Instructions.tokenBurn(tokenId, keypair.publicKey, amount));
  }

  /**
   * TokenCreateRWA (variant 6) with the keypair as mint authority.
   * `legalDocHash` must be non-empty and `assetType` one of
   * `RWA_ASSET_TYPES` (`token.rs:1214-1217`).
   * @param {XerisKeypair} keypair Issuer / mint authority.
   * @param {string} tokenId
   * @param {string} name
   * @param {string} symbol
   * @param {number|bigint} decimals `u8`.
   * @param {number|bigint} maxSupply Base units.
   * @param {string} assetType One of `RWA_ASSET_TYPES`.
   * @param {string} legalDocHash SHA-256 (hex) of the legal document; non-empty.
   * @param {string} legalDocUri
   * @param {string} jurisdiction
   * @param {boolean} transferRestricted
   * @param {boolean} accreditedOnly
   * @param {number|bigint} valuation USD cents.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async createRwaToken(keypair, tokenId, name, symbol, decimals, maxSupply, assetType, legalDocHash, legalDocUri, jurisdiction, transferRestricted, accreditedOnly, valuation) {
    arity(arguments.length, 13, 'createRwaToken', 'keypair, tokenId, name, symbol, decimals, maxSupply, assetType, legalDocHash, legalDocUri, jurisdiction, transferRestricted, accreditedOnly, valuation');
    requireKeypair(keypair);
    checks.oneOf(assetType, RWA_ASSET_TYPES, 'assetType');
    assertString(legalDocHash, 'legalDocHash');
    if (legalDocHash.length === 0) throw new RangeError('legalDocHash: RWA tokens require a non-empty legal_doc_hash (token.rs:1214-1216)');
    return this.sendInstruction(keypair, Instructions.tokenCreateRWA(
      tokenId, name, symbol, decimals, maxSupply, keypair.publicKey,
      assetType, legalDocHash, legalDocUri, jurisdiction, transferRestricted, accreditedOnly, valuation,
    ));
  }

  /**
   * RWAUpdateStatus (variant 7); only the issuer may call it
   * (`token.rs:1268-1270`) and `newStatus` must be one of `RWA_STATUSES`
   * (`token.rs:1272-1275`). `Option` fields take `null` for no change.
   * @param {XerisKeypair} keypair Issuer (mint authority).
   * @param {string} tokenId
   * @param {string} newStatus
   * @param {number|bigint|null} newValuation USD cents, or `null`.
   * @param {string|null} newLegalDocHash
   * @param {string|null} newLegalDocUri
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async rwaUpdateStatus(keypair, tokenId, newStatus, newValuation, newLegalDocHash, newLegalDocUri) {
    arity(arguments.length, 6, 'rwaUpdateStatus', 'keypair, tokenId, newStatus, newValuation, newLegalDocHash, newLegalDocUri');
    requireKeypair(keypair);
    checks.oneOf(newStatus, RWA_STATUSES, 'newStatus');
    return this.sendInstruction(keypair, Instructions.rwaUpdateStatus(tokenId, newStatus, newValuation, newLegalDocHash, newLegalDocUri));
  }

  /**
   * RWATransfer (variant 8) from the keypair; amount > 0 and `to` ≠ signer
   * (`token.rs:1296-1312`; ingress `ledger.rs:1424-1428`). The RWA
   * compliance gate (holder approval, restrictions) is applied by the node.
   * @param {XerisKeypair} keypair Sender.
   * @param {string} tokenId
   * @param {string} to Recipient.
   * @param {number|bigint} amount Base units, > 0.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async rwaTransfer(keypair, tokenId, to, amount) {
    arity(arguments.length, 4, 'rwaTransfer', 'keypair, tokenId, to, amount');
    requireKeypair(keypair);
    assertString(to, 'to');
    checks.positive(amount, 'amount');
    if (to === keypair.publicKey) throw new RangeError('to: an RWA transfer to the sender is rejected by the node (token.rs:1300-1302)');
    return this.sendInstruction(keypair, Instructions.rwaTransfer(tokenId, keypair.publicKey, to, amount));
  }

  /**
   * ContractDeploy (variant 5). `contractId` must satisfy
   * `checks.contractId` and `contractType` `checks.contractType`; `params`
   * is sent as JSON (`params_json`) written by `stringifyJson`: a `bigint`
   * is written as an exact integer (e.g. a launchpad `total_supply` of
   * `10n ** 18n`), and an integer `number` above 2^53-1, `NaN`, `undefined`
   * or a non-plain object throws.
   * @param {XerisKeypair} keypair Owner.
   * @param {string} contractId
   * @param {string} contractType `ContractType::from_str` alias, e.g. `'swap'`, `'escrow'`, `'launchpad'` (`contracts.rs:385-411`).
   * @param {object} params Plain object; shape depends on the type.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async deployContract(keypair, contractId, contractType, params) {
    arity(arguments.length, 4, 'deployContract', 'keypair, contractId, contractType, params');
    requireKeypair(keypair);
    checks.contractId(contractId);
    checks.contractType(contractType);
    if (!isPlainObject(params)) throw new TypeError(`params: expected a plain object, got ${describe(params)}`);
    const paramsJson = stringifyJson(params, 'params');
    return this.sendInstruction(keypair, Instructions.contractDeploy(contractId, contractType, paramsJson));
  }

  /**
   * ContractCall (variant 4). For `swap_a_to_b` / `swap_b_to_a`, `args` must
   * be the 16 raw bytes `u64le(input) ‖ u64le(min_output)`
   * (`contracts.rs:2419-2441`; see `swap`); for every other method it must be
   * a plain object sent as JSON (`ledger.rs:2359-2371`; shapes in blueprint
   * §7.3), written by `stringifyJson`: `bigint` values become exact JSON
   * integers (the node reads u64 fields with `as_u64`, which is exact up to
   * 2^64-1); an integer `number` above 2^53-1, `NaN`/`Infinity`, `undefined`
   * and functions throw, because `JSON.stringify` would round, null or drop
   * them and the node reads a missing slippage field as 0
   * (`contracts.rs:2849-2850, 2946-2947`).
   * The node injects `current_slot` into JSON args (`ledger.rs:2360-2365`).
   * Protocol contract ids such as `xeris_channels` are valid call targets.
   * @param {XerisKeypair} keypair Caller.
   * @param {string} contractId
   * @param {string} method
   * @param {object|Buffer|Uint8Array} args
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async callContract(keypair, contractId, method, args) {
    arity(arguments.length, 4, 'callContract', 'keypair, contractId, method, args');
    requireKeypair(keypair);
    assertString(contractId, 'contractId');
    assertString(method, 'method');
    let payload;
    if (SWAP_METHODS.includes(method)) {
      const bytes = toBytes(args, 'args');
      if (bytes.length !== 16) {
        throw new RangeError(`args: ${method} takes exactly 16 raw bytes (u64le input, u64le min_output; contracts.rs:2419-2441), got ${bytes.length}; use swap() or encodeSwapCall()`);
      }
      payload = bytes;
    } else {
      if (!isPlainObject(args)) {
        throw new TypeError(`args: expected a plain object for method '${method}' (sent as JSON, ledger.rs:2359-2371), got ${describe(args)}`);
      }
      payload = args;
    }
    return this.sendInstruction(keypair, Instructions.contractCall(contractId, method, payload));
  }

  /**
   * AMM swap on a Swap pool: ContractCall with the 16-byte payload
   * `u64le(inputAmount) ‖ u64le(minOutput)` (`encodeSwapCall`;
   * `contracts.rs:2419-2441, 2484-2499`). The node requires an explicit
   * `min_output` (`contracts.rs:2423-2432`); the input token is the pool's
   * `token_a` for `swap_a_to_b` and `token_b` for `swap_b_to_a`, spent from
   * the caller's token balance (wrap XRS first for `xrs_native`).
   * @param {XerisKeypair} keypair Caller.
   * @param {string} poolId Swap contract id.
   * @param {'swap_a_to_b'|'swap_b_to_a'} method
   * @param {number|bigint} inputAmount Base units, > 0.
   * @param {number|bigint} minOutput Base units, > 0.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async swap(keypair, poolId, method, inputAmount, minOutput) {
    arity(arguments.length, 5, 'swap', 'keypair, poolId, method, inputAmount, minOutput');
    requireKeypair(keypair);
    assertString(poolId, 'poolId');
    checks.swapMethod(method);
    checks.positive(inputAmount, 'inputAmount');
    checks.positive(minOutput, 'minOutput');
    return this.sendInstruction(keypair, encodeSwapCall(poolId, method, inputAmount, minOutput));
  }

  /**
   * `swap` with the direction resolved from the pool state: reads
   * `GET /contract/{poolId}` (`network.rs:5018-5026`) and picks
   * `swap_b_to_a` when `state.Swap.token_b === tokenIn`, `swap_a_to_b` when
   * `state.Swap.token_a === tokenIn` (`contracts.rs:414-421, 443-460`).
   * @param {XerisKeypair} keypair Caller.
   * @param {string} poolId Swap contract id.
   * @param {string} tokenIn Token id being sold.
   * @param {number|bigint} inputAmount Base units, > 0.
   * @param {number|bigint} minOutput Base units, > 0.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError} Including when the contract is not a Swap pool or `tokenIn` is not in it.
   * @throws {RpcError|XerisError}
   */
  async swapByToken(keypair, poolId, tokenIn, inputAmount, minOutput) {
    arity(arguments.length, 5, 'swapByToken', 'keypair, poolId, tokenIn, inputAmount, minOutput');
    requireKeypair(keypair);
    assertString(poolId, 'poolId');
    assertString(tokenIn, 'tokenIn');
    checks.positive(inputAmount, 'inputAmount');
    checks.positive(minOutput, 'minOutput');
    const res = await this.getContract(poolId);
    const contract = isPlainObject(res) ? res.contract : undefined;
    const state = isPlainObject(contract) && isPlainObject(contract.state) ? contract.state.Swap : undefined;
    if (!isPlainObject(state)) {
      throw new RangeError(`poolId: contract '${poolId}' is not a Swap pool (its state has no Swap variant; contracts.rs:443-460)`);
    }
    let method;
    if (state.token_b === tokenIn) method = 'swap_b_to_a';
    else if (state.token_a === tokenIn) method = 'swap_a_to_b';
    else throw new RangeError(`tokenIn: '${tokenIn}' is not in pool '${poolId}' (token_a '${state.token_a}', token_b '${state.token_b}')`);
    return this.sendInstruction(keypair, encodeSwapCall(poolId, method, inputAmount, minOutput));
  }

  /**
   * Swap `add_liquidity` with the five fields the pool requires, all > 0
   * (`contracts.rs:2214-2231`).
   * @param {XerisKeypair} keypair Liquidity provider.
   * @param {string} poolId
   * @param {number|bigint} amountA Max token_a deposited (base units).
   * @param {number|bigint} amountB Max token_b deposited.
   * @param {number|bigint} minLpShares Minimum LP shares accepted.
   * @param {number|bigint} minAmountA Minimum token_a actually taken.
   * @param {number|bigint} minAmountB Minimum token_b actually taken.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async addLiquidity(keypair, poolId, amountA, amountB, minLpShares, minAmountA, minAmountB) {
    arity(arguments.length, 7, 'addLiquidity', 'keypair, poolId, amountA, amountB, minLpShares, minAmountA, minAmountB');
    requireKeypair(keypair);
    assertString(poolId, 'poolId');
    const args = {
      amount_a: normalizeU64(amountA, 'amountA'),
      amount_b: normalizeU64(amountB, 'amountB'),
      min_lp_shares: normalizeU64(minLpShares, 'minLpShares'),
      min_amount_a: normalizeU64(minAmountA, 'minAmountA'),
      min_amount_b: normalizeU64(minAmountB, 'minAmountB'),
    };
    checks.liquidityArgs(args);
    return this.sendInstruction(keypair, Instructions.contractCall(poolId, 'add_liquidity', args));
  }

  /**
   * Swap `remove_liquidity` with `{shares, min_amount_a, min_amount_b}`
   * (`contracts.rs:2378-2384`); `shares` > 0.
   * @param {XerisKeypair} keypair Liquidity provider.
   * @param {string} poolId
   * @param {number|bigint} shares LP shares to burn.
   * @param {number|bigint} minAmountA Minimum token_a out.
   * @param {number|bigint} minAmountB Minimum token_b out.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async removeLiquidity(keypair, poolId, shares, minAmountA, minAmountB) {
    arity(arguments.length, 5, 'removeLiquidity', 'keypair, poolId, shares, minAmountA, minAmountB');
    requireKeypair(keypair);
    assertString(poolId, 'poolId');
    checks.positive(shares, 'shares');
    const args = {
      shares: normalizeU64(shares, 'shares'),
      min_amount_a: normalizeU64(minAmountA, 'minAmountA'),
      min_amount_b: normalizeU64(minAmountB, 'minAmountB'),
    };
    return this.sendInstruction(keypair, Instructions.contractCall(poolId, 'remove_liquidity', args));
  }

  /**
   * Launchpad `buy_tokens` with `{xrs_amount, min_tokens_out}`
   * (`contracts.rs:2842-2850`). Spends the buyer's `xrs_native` token
   * balance, so native XRS must be wrapped first (`contracts.rs:2852-2857`).
   * Quote with `getLaunchpadQuote`.
   * @param {XerisKeypair} keypair Buyer.
   * @param {string} launchpadId Launchpad contract id.
   * @param {number|bigint} xrsAmount Lamports of wrapped XRS to spend, > 0.
   * @param {number|bigint} minTokensOut Minimum tokens accepted (base units).
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async buyOnLaunchpad(keypair, launchpadId, xrsAmount, minTokensOut) {
    arity(arguments.length, 4, 'buyOnLaunchpad', 'keypair, launchpadId, xrsAmount, minTokensOut');
    requireKeypair(keypair);
    assertString(launchpadId, 'launchpadId');
    checks.positive(xrsAmount, 'xrsAmount');
    const args = { xrs_amount: normalizeU64(xrsAmount, 'xrsAmount'), min_tokens_out: normalizeU64(minTokensOut, 'minTokensOut') };
    return this.sendInstruction(keypair, Instructions.contractCall(launchpadId, 'buy_tokens', args));
  }

  /**
   * Launchpad `sell_tokens` with `{token_amount, min_xrs_out}`
   * (`contracts.rs:2939-2947`).
   * @param {XerisKeypair} keypair Seller.
   * @param {string} launchpadId
   * @param {number|bigint} tokenAmount Tokens to sell (base units), > 0.
   * @param {number|bigint} minXrsOut Minimum wrapped XRS out (lamports).
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async sellOnLaunchpad(keypair, launchpadId, tokenAmount, minXrsOut) {
    arity(arguments.length, 4, 'sellOnLaunchpad', 'keypair, launchpadId, tokenAmount, minXrsOut');
    requireKeypair(keypair);
    assertString(launchpadId, 'launchpadId');
    checks.positive(tokenAmount, 'tokenAmount');
    const args = { token_amount: normalizeU64(tokenAmount, 'tokenAmount'), min_xrs_out: normalizeU64(minXrsOut, 'minXrsOut') };
    return this.sendInstruction(keypair, Instructions.contractCall(launchpadId, 'sell_tokens', args));
  }

  /**
   * RegisterAgent (variant 15): delegates to `agentPubkey` within the given
   * budgets (`ledger.rs:6318-6363`; registry `contracts.rs:3334`, at most 50
   * agents per owner). `allowedOperations` entries must be `AGENT_OPERATIONS`
   * names (`contracts.rs:3471-3477`); an empty list allows all. The daily
   * budget window is `AGENT_DAILY_WINDOW_SLOTS` (`contracts.rs:3439`).
   * @param {XerisKeypair} keypair Owner.
   * @param {string} agentName
   * @param {string} agentPubkey Canonical public key of the agent.
   * @param {number|bigint} maxPerTx Lamports.
   * @param {number|bigint} maxDaily Lamports.
   * @param {string[]} allowedContracts Contract ids; empty allows all.
   * @param {string[]} allowedOperations `AGENT_OPERATIONS` names; empty allows all.
   * @param {number|bigint} expiresAtSlot 0 for no expiry.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async registerAgent(keypair, agentName, agentPubkey, maxPerTx, maxDaily, allowedContracts, allowedOperations, expiresAtSlot) {
    arity(arguments.length, 8, 'registerAgent', 'keypair, agentName, agentPubkey, maxPerTx, maxDaily, allowedContracts, allowedOperations, expiresAtSlot');
    requireKeypair(keypair);
    checks.pubkey(agentPubkey, 'agentPubkey');
    checks.agentOperations(allowedOperations);
    return this.sendInstruction(keypair, Instructions.registerAgent(agentName, agentPubkey, maxPerTx, maxDaily, allowedContracts, allowedOperations, expiresAtSlot));
  }

  /**
   * UpdateAgent (variant 16); `null` leaves a field unchanged
   * (`ledger.rs:6365-6392`).
   * @param {XerisKeypair} keypair Owner.
   * @param {string} agentPubkey
   * @param {number|bigint|null} newMaxPerTx
   * @param {number|bigint|null} newMaxDaily
   * @param {string[]|null} newAllowedContracts
   * @param {string[]|null} newAllowedOperations `AGENT_OPERATIONS` names.
   * @param {number|bigint|null} newExpiresAtSlot
   * @param {boolean} revoked
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async updateAgent(keypair, agentPubkey, newMaxPerTx, newMaxDaily, newAllowedContracts, newAllowedOperations, newExpiresAtSlot, revoked) {
    arity(arguments.length, 8, 'updateAgent', 'keypair, agentPubkey, newMaxPerTx, newMaxDaily, newAllowedContracts, newAllowedOperations, newExpiresAtSlot, revoked');
    requireKeypair(keypair);
    if (newAllowedOperations !== null && newAllowedOperations !== undefined) checks.agentOperations(newAllowedOperations);
    return this.sendInstruction(keypair, Instructions.updateAgent(agentPubkey, newMaxPerTx, newMaxDaily, newAllowedContracts, newAllowedOperations, newExpiresAtSlot, revoked));
  }

  /**
   * Resolves `opts.route` for the wrappers with a dedicated default route.
   * @private
   * @param {unknown} opts
   * @param {string} dedicated `'/stake'`, `'/unstake'` or `'/pq-register'`.
   * @returns {string}
   * @throws {TypeError|RangeError}
   */
  _routeOption(opts, dedicated) {
    if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
      throw new TypeError(`opts: expected an object, got ${describe(opts)}`);
    }
    const route = opts.route === undefined ? dedicated : opts.route;
    if (route !== dedicated && route !== '/submit') {
      throw new RangeError(`opts.route: expected '${dedicated}' or '/submit', got ${describe(route)}`);
    }
    return route;
  }

  /**
   * CreateIdentity (variant 18) for the keypair itself (`identity_pubkey` =
   * signer) with an empty `parent_identity`: a non-empty parent must co-sign
   * the transaction (`ledger.rs:6717-6727`), which `sendInstruction` does not
   * build. `identityType` ∈ `IDENTITY_TYPES` (`ledger.rs:6696`); `displayName`
   * ≤ 128 bytes, `metadataJson` ≤ 4096 bytes (`ledger.rs:6702-6706`).
   * @param {XerisKeypair} keypair The identity.
   * @param {string} displayName
   * @param {string} identityType `'agent'`, `'device'`, `'service'` or `'human'`.
   * @param {string} metadataJson
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async createIdentity(keypair, displayName, identityType, metadataJson) {
    arity(arguments.length, 4, 'createIdentity', 'keypair, displayName, identityType, metadataJson');
    requireKeypair(keypair);
    checks.oneOf(identityType, IDENTITY_TYPES, 'identityType');
    checks.maxBytes(displayName, STRING_LIMITS.identityDisplayName, 'displayName');
    checks.maxBytes(metadataJson, STRING_LIMITS.identityMetadata, 'metadataJson');
    return this.sendInstruction(keypair, Instructions.createIdentity(keypair.publicKey, displayName, identityType, '', metadataJson));
  }

  /**
   * UpdateIdentity (variant 19) of the keypair's own identity
   * (`ledger.rs:6795-6807`); `null` leaves a field unchanged.
   * @param {XerisKeypair} keypair The identity.
   * @param {string|null} newDisplayName
   * @param {string|null} newMetadata
   * @param {boolean} deactivated
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async updateIdentity(keypair, newDisplayName, newMetadata, deactivated) {
    arity(arguments.length, 4, 'updateIdentity', 'keypair, newDisplayName, newMetadata, deactivated');
    requireKeypair(keypair);
    return this.sendInstruction(keypair, Instructions.updateIdentity(keypair.publicKey, newDisplayName, newMetadata, deactivated));
  }

  /**
   * AttestReputation (variant 20). The attestor needs an active identity
   * (`ledger.rs:6815-6818`); `category` ∈ `REPUTATION_CATEGORIES` and
   * `evidence` ≤ 512 bytes (`ledger.rs:6820-6828`); self-attestation is
   * refused (`contracts.rs:3572`). The node clamps `score` to 100
   * (`contracts.rs:3568`); the SDK refuses larger values instead.
   * @param {XerisKeypair} keypair Attestor.
   * @param {string} subjectPubkey Subject identity, not the signer.
   * @param {number|bigint} score 0..100.
   * @param {string} category
   * @param {string} evidence
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async attestReputation(keypair, subjectPubkey, score, category, evidence) {
    arity(arguments.length, 5, 'attestReputation', 'keypair, subjectPubkey, score, category, evidence');
    requireKeypair(keypair);
    assertString(subjectPubkey, 'subjectPubkey');
    if (normalizeU8(score, 'score') > 100) throw new RangeError(`score: expected 0..100, got ${score} (the node clamps at contracts.rs:3568; the SDK refuses)`);
    checks.oneOf(category, REPUTATION_CATEGORIES, 'category');
    checks.maxBytes(evidence, STRING_LIMITS.reputationEvidence, 'evidence');
    if (subjectPubkey === keypair.publicKey) throw new RangeError('subjectPubkey: self-attestation is rejected by the node (contracts.rs:3572)');
    return this.sendInstruction(keypair, Instructions.attestReputation(subjectPubkey, score, category, evidence));
  }

  /**
   * AgentMessage (variant 21): recorded in the block, writes no state
   * (`ledger.rs:6844-6871`). `messageType` ∈ `MESSAGE_TYPES`, `payloadJson`
   * ≤ 8192 bytes; the sender needs an active identity.
   * @param {XerisKeypair} keypair Sender.
   * @param {string} toIdentity
   * @param {string} messageType
   * @param {string} payloadJson
   * @param {string} replyTo Message id being answered, or `''`.
   * @param {number|bigint} expiresAtSlot
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async sendAgentMessage(keypair, toIdentity, messageType, payloadJson, replyTo, expiresAtSlot) {
    arity(arguments.length, 6, 'sendAgentMessage', 'keypair, toIdentity, messageType, payloadJson, replyTo, expiresAtSlot');
    requireKeypair(keypair);
    checks.oneOf(messageType, MESSAGE_TYPES, 'messageType');
    checks.maxBytes(payloadJson, STRING_LIMITS.messagePayload, 'payloadJson');
    return this.sendInstruction(keypair, Instructions.agentMessage(toIdentity, messageType, payloadJson, replyTo, expiresAtSlot));
  }

  /**
   * ConditionalOrder (variant 23): escrows `lockedAmount` and executes
   * `innerInstruction` when the condition holds (`ledger.rs:6916-7122`).
   * `conditionType` ∈ `CONDITION_TYPES`; the inner instruction is at most
   * `MAX_CONDITIONAL_INNER_BYTES` (2048, `ledger.rs:6941-6944`), must decode
   * as a `XerisInstruction` (`ledger.rs:6923-6927`), pass
   * `assertInstructionSubmittable`, and not be a nested
   * AgentExecute/ConditionalOrder (`ledger.rs:1439`); an inner token
   * instruction runs as the signer when the order fires, so its `from` /
   * `mint_authority` must be the signer (checked by `buildTransaction`);
   * `lockedAmount` ≥ `ORDER_STORAGE_BOND` (`ledger.rs:6998-7002`);
   * `expiresAtSlot` must be in the future and within `MAX_ORDER_LIFETIME_SLOTS`.
   * @param {XerisKeypair} keypair Order owner.
   * @param {string} orderId
   * @param {string} conditionType
   * @param {string} conditionSource Pool id, oracle id or account depending on the type.
   * @param {number|bigint} conditionThreshold
   * @param {Buffer|Uint8Array} innerInstruction Encoded instruction to execute.
   * @param {number|bigint} expiresAtSlot
   * @param {number|bigint} lockedAmount Lamports.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|EncodingError|FeatureDisabledError|RpcError|XerisError}
   */
  async conditionalOrder(keypair, orderId, conditionType, conditionSource, conditionThreshold, innerInstruction, expiresAtSlot, lockedAmount) {
    arity(arguments.length, 8, 'conditionalOrder', 'keypair, orderId, conditionType, conditionSource, conditionThreshold, innerInstruction, expiresAtSlot, lockedAmount');
    requireKeypair(keypair);
    checks.oneOf(conditionType, CONDITION_TYPES, 'conditionType');
    const inner = toBytes(innerInstruction, 'innerInstruction');
    if (inner.length > MAX_CONDITIONAL_INNER_BYTES) {
      throw new RangeError(`innerInstruction: ${inner.length} bytes exceeds the node's ${MAX_CONDITIONAL_INNER_BYTES}-byte cap (ledger.rs:6941-6944)`);
    }
    const decoded = tryDecodeInstruction(inner);
    if (!decoded.ok) {
      throw new EncodingError(
        `innerInstruction: does not decode as a XerisInstruction (${decoded.reason}); the block skips it after charging the fee (ledger.rs:6923-6927)`,
        { field: 'innerInstruction' },
      );
    }
    const innerVariant = assertInstructionSubmittable(inner);
    if (innerVariant === Variant.AgentExecute || innerVariant === Variant.ConditionalOrder) {
      throw new RangeError(`innerInstruction: nested ${VARIANT_NAMES[innerVariant]} is rejected at ingress (ledger.rs:1439)`);
    }
    if (normalizeU64(lockedAmount, 'lockedAmount') < BigInt(ORDER_STORAGE_BOND)) {
      throw new RangeError(`lockedAmount: below the storage bond ${ORDER_STORAGE_BOND} lamports (ledger.rs:6998-7002)`);
    }
    return this.sendInstruction(keypair, Instructions.conditionalOrder(orderId, conditionType, conditionSource, conditionThreshold, inner, expiresAtSlot, lockedAmount));
  }

  /**
   * CancelConditionalOrder (variant 24); refunds the escrow to the owner
   * (`ledger.rs:7124-7160`).
   * @param {XerisKeypair} keypair Order owner.
   * @param {string} orderId
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async cancelConditionalOrder(keypair, orderId) {
    arity(arguments.length, 2, 'cancelConditionalOrder', 'keypair, orderId');
    requireKeypair(keypair);
    return this.sendInstruction(keypair, Instructions.cancelConditionalOrder(orderId));
  }

  /**
   * RegisterOracle (variant 25): `feedType` ∈ `FEED_TYPES`, `stakeAmount` ≥
   * `MIN_ORACLE_STAKE_LAMPORTS` (1 XRS), `description` ≤ 512 bytes
   * (`ledger.rs:7162-7207`).
   * @param {XerisKeypair} keypair Oracle operator.
   * @param {string} oracleId
   * @param {string} description
   * @param {string} feedType
   * @param {number|bigint} updateIntervalSlots
   * @param {number|bigint} stakeAmount Lamports.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async registerOracle(keypair, oracleId, description, feedType, updateIntervalSlots, stakeAmount) {
    arity(arguments.length, 6, 'registerOracle', 'keypair, oracleId, description, feedType, updateIntervalSlots, stakeAmount');
    requireKeypair(keypair);
    checks.oneOf(feedType, FEED_TYPES, 'feedType');
    if (normalizeU64(stakeAmount, 'stakeAmount') < BigInt(MIN_ORACLE_STAKE_LAMPORTS)) {
      throw new RangeError(`stakeAmount: below the minimum oracle stake ${MIN_ORACLE_STAKE_LAMPORTS} lamports (ledger.rs:7170-7173)`);
    }
    checks.maxBytes(description, STRING_LIMITS.oracleDescription, 'description');
    return this.sendInstruction(keypair, Instructions.registerOracle(oracleId, description, feedType, updateIntervalSlots, stakeAmount));
  }

  /**
   * OracleSubmit (variant 26); `metadata` ≤ 1024 bytes (`ledger.rs:7209-7228`).
   * @param {XerisKeypair} keypair Oracle operator.
   * @param {string} oracleId
   * @param {number|bigint} value
   * @param {string} metadata
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async oracleSubmit(keypair, oracleId, value, metadata) {
    arity(arguments.length, 4, 'oracleSubmit', 'keypair, oracleId, value, metadata');
    requireKeypair(keypair);
    checks.maxBytes(metadata, STRING_LIMITS.oracleMetadata, 'metadata');
    return this.sendInstruction(keypair, Instructions.oracleSubmit(oracleId, value, metadata));
  }

  /**
   * HardwareAttest (variant 27). `deviceType` ∈ `DEVICE_TYPES`
   * (`ledger.rs:7232-7237`); `attestationProof` is the device key's 64-byte
   * Ed25519 signature over `hardwareAttestChallenge(devicePubkey,
   * boundIdentity, deviceType, manufacturer, model, firmwareVersion, slot)`
   * (`ledger.rs:7311-7332`, challenge at `ledger.rs:5299-5319`); the signer
   * must be the device when `boundIdentity` is empty and must be the bound
   * identity otherwise (`ledger.rs:7239-7252`).
   *
   * `slot` must be the slot of the block that includes this transaction: the
   * node rebuilds the challenge with `block.slot` (`ledger.rs:7320-7322`) and
   * allows no window. That slot is not known in advance, so a proof succeeds
   * only if the transaction lands in exactly the block it was signed for;
   * otherwise the dispatcher skips the instruction after charging the fee and
   * the call must be repeated with a proof for a later slot. The resolved
   * `status: 'ok'` means mempool admission only; check the outcome with
   * `waitForConfirmation`.
   * @param {XerisKeypair} keypair Device key or bound identity.
   * @param {string} devicePubkey
   * @param {string} deviceType
   * @param {string} manufacturer
   * @param {string} model
   * @param {string} firmwareVersion
   * @param {Buffer|Uint8Array} attestationProof 64-byte device signature over the challenge for the including block's slot.
   * @param {string} boundIdentity Identity public key, or `''`.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async hardwareAttest(keypair, devicePubkey, deviceType, manufacturer, model, firmwareVersion, attestationProof, boundIdentity) {
    arity(arguments.length, 8, 'hardwareAttest', 'keypair, devicePubkey, deviceType, manufacturer, model, firmwareVersion, attestationProof, boundIdentity');
    requireKeypair(keypair);
    assertString(devicePubkey, 'devicePubkey');
    assertString(boundIdentity, 'boundIdentity');
    checks.oneOf(deviceType, DEVICE_TYPES, 'deviceType');
    checks.ed25519Signature(attestationProof, 'attestationProof');
    const signer = keypair.publicKey;
    if (boundIdentity.length === 0) {
      if (devicePubkey !== signer) throw new RangeError(`devicePubkey: with an empty boundIdentity the signer must be the device (${signer}) (ledger.rs:7239-7243)`);
    } else if (boundIdentity !== signer) {
      throw new RangeError(`boundIdentity: must equal the signer ${signer} when set (ledger.rs:7249-7252)`);
    }
    return this.sendInstruction(keypair, Instructions.hardwareAttest(devicePubkey, deviceType, manufacturer, model, firmwareVersion, attestationProof, boundIdentity));
  }

  /**
   * RegisterCapability (variant 28) for the keypair's identity
   * (`provider_identity` = signer; `ledger.rs:7389-7433`).
   * @param {XerisKeypair} keypair Provider identity.
   * @param {string} category
   * @param {string[]} tags
   * @param {string} region `'global'` matches every region search (`network.rs:5602`).
   * @param {string} description
   * @param {number|bigint} pricePerUnit Lamports; 0 matches every `max_price` search.
   * @param {number|bigint} maxConcurrent `u32`.
   * @param {string} metadataJson
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async registerCapability(keypair, category, tags, region, description, pricePerUnit, maxConcurrent, metadataJson) {
    arity(arguments.length, 8, 'registerCapability', 'keypair, category, tags, region, description, pricePerUnit, maxConcurrent, metadataJson');
    requireKeypair(keypair);
    return this.sendInstruction(keypair, Instructions.registerCapability(keypair.publicKey, category, tags, region, description, pricePerUnit, maxConcurrent, metadataJson));
  }

  /**
   * UpdateCapability (variant 29) of the keypair's listing in `category`;
   * `null` leaves a field unchanged (`ledger.rs:7435-7458`).
   * @param {XerisKeypair} keypair Provider identity.
   * @param {string} category
   * @param {string[]|null} newTags
   * @param {string|null} newDescription
   * @param {number|bigint|null} newPricePerUnit
   * @param {number|bigint|null} newMaxConcurrent
   * @param {string|null} newMetadata
   * @param {boolean} removed
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async updateCapability(keypair, category, newTags, newDescription, newPricePerUnit, newMaxConcurrent, newMetadata, removed) {
    arity(arguments.length, 8, 'updateCapability', 'keypair, category, newTags, newDescription, newPricePerUnit, newMaxConcurrent, newMetadata, removed');
    requireKeypair(keypair);
    return this.sendInstruction(keypair, Instructions.updateCapability(keypair.publicKey, category, newTags, newDescription, newPricePerUnit, newMaxConcurrent, newMetadata, removed));
  }

  /**
   * PostTask (variant 31): escrows `reward` from the poster
   * (`ledger.rs:7466-7505`; board rules `contracts.rs:4698-4790`, see
   * `checks.taskPost`). `requiredTags` need a non-empty `requiredCategory`
   * (`contracts.rs:4745-4748`); `expiresAtSlot` must be in
   * `(now, now + MAX_TASK_LIFETIME_SLOTS]` (`contracts.rs:4702-4707`).
   * @param {XerisKeypair} keypair Poster.
   * @param {string} taskId
   * @param {string} title ≤ 256 bytes.
   * @param {string} description ≤ 4096 bytes.
   * @param {string} requiredCategory
   * @param {string[]} requiredTags
   * @param {number|bigint} minReputation Must be 0.
   * @param {number|bigint} reward Lamports, > 0.
   * @param {number|bigint} expiresAtSlot
   * @param {number|bigint} maxClaimants `u32`.
   * @param {string} verification `'poster_confirm'` or `'oracle'`.
   * @param {string} verificationOracle Oracle signer for `'oracle'`, else `''`.
   * @param {number|bigint} verificationThreshold
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async postTask(keypair, taskId, title, description, requiredCategory, requiredTags, minReputation, reward, expiresAtSlot, maxClaimants, verification, verificationOracle, verificationThreshold) {
    arity(arguments.length, 13, 'postTask', 'keypair, taskId, title, description, requiredCategory, requiredTags, minReputation, reward, expiresAtSlot, maxClaimants, verification, verificationOracle, verificationThreshold');
    requireKeypair(keypair);
    checks.taskPost(minReputation, verification, verificationOracle, title, description, reward);
    assertString(requiredCategory, 'requiredCategory');
    if (Array.isArray(requiredTags) && requiredTags.length > 0 && requiredCategory.length === 0) {
      throw new RangeError('requiredTags: need a non-empty requiredCategory to be enforced against (contracts.rs:4745-4748)');
    }
    return this.sendInstruction(keypair, Instructions.postTask(
      taskId, title, description, requiredCategory, requiredTags, minReputation, reward,
      expiresAtSlot, maxClaimants, verification, verificationOracle, verificationThreshold,
    ));
  }

  /**
   * ClaimTask (variant 32) as the keypair's identity (`claimant_identity` =
   * signer; `ledger.rs:7507-7588`, requires an active identity).
   * @param {XerisKeypair} keypair Claimant.
   * @param {string} taskId
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async claimTask(keypair, taskId) {
    arity(arguments.length, 2, 'claimTask', 'keypair, taskId');
    requireKeypair(keypair);
    return this.sendInstruction(keypair, Instructions.claimTask(taskId, keypair.publicKey));
  }

  /**
   * ResolveTask (variant 33); `resolution` ∈ `TASK_RESOLUTIONS`
   * (`ledger.rs:7603-7612`: `complete` by the claimant, `verify`/`reject` by
   * the poster or named oracle, `cancel` by the poster).
   * @param {XerisKeypair} keypair
   * @param {string} taskId
   * @param {string} resolution
   * @param {string} proof Completion proof or rejection reason (≤ 512 bytes for `reject`).
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async resolveTask(keypair, taskId, resolution, proof) {
    arity(arguments.length, 4, 'resolveTask', 'keypair, taskId, resolution, proof');
    requireKeypair(keypair);
    checks.oneOf(resolution, TASK_RESOLUTIONS, 'resolution');
    return this.sendInstruction(keypair, Instructions.resolveTask(taskId, resolution, proof));
  }

  /**
   * RegisterModel (variant 34) under the keypair's identity
   * (`identity_pubkey` = signer; `ledger.rs:7633-7663`).
   * @param {XerisKeypair} keypair Identity.
   * @param {string} modelName
   * @param {string} modelHash
   * @param {string} modelVersion
   * @param {string} framework
   * @param {string} capabilitiesJson
   * @param {number|bigint} modelSizeBytes
   * @param {string} executionEnvironment
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async registerModel(keypair, modelName, modelHash, modelVersion, framework, capabilitiesJson, modelSizeBytes, executionEnvironment) {
    arity(arguments.length, 8, 'registerModel', 'keypair, modelName, modelHash, modelVersion, framework, capabilitiesJson, modelSizeBytes, executionEnvironment');
    requireKeypair(keypair);
    return this.sendInstruction(keypair, Instructions.registerModel(keypair.publicKey, modelName, modelHash, modelVersion, framework, capabilitiesJson, modelSizeBytes, executionEnvironment));
  }

  /**
   * UpdateModel (variant 35); the dispatcher resolves the model by `modelHash`
   * and the signer, ignoring `identity_pubkey` (`ledger.rs:7671`); `null`
   * leaves a field unchanged.
   * @param {XerisKeypair} keypair Model owner.
   * @param {string} modelHash
   * @param {string|null} newVersion
   * @param {string|null} newCapabilities
   * @param {string|null} newEnvironment
   * @param {boolean} retired
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async updateModel(keypair, modelHash, newVersion, newCapabilities, newEnvironment, retired) {
    arity(arguments.length, 6, 'updateModel', 'keypair, modelHash, newVersion, newCapabilities, newEnvironment, retired');
    requireKeypair(keypair);
    return this.sendInstruction(keypair, Instructions.updateModel(keypair.publicKey, modelHash, newVersion, newCapabilities, newEnvironment, retired));
  }

  /**
   * OpenDispute (variant 36, 7 fields, `token.rs:499-509`); `disputeId` may
   * not start with `deal_` (`ledger.rs:7690`); `bond` is escrowed
   * (`ledger.rs:7682-7708`).
   * @param {XerisKeypair} keypair Disputer.
   * @param {string} disputeId
   * @param {string} disputeType
   * @param {string} subjectId
   * @param {string} defendant
   * @param {string} reason
   * @param {string} evidence
   * @param {number|bigint} bond Lamports.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async openDispute(keypair, disputeId, disputeType, subjectId, defendant, reason, evidence, bond) {
    arity(arguments.length, 8, 'openDispute', 'keypair, disputeId, disputeType, subjectId, defendant, reason, evidence, bond');
    requireKeypair(keypair);
    checks.disputeId(disputeId);
    return this.sendInstruction(keypair, Instructions.openDispute(disputeId, disputeType, subjectId, defendant, reason, evidence, bond));
  }

  /**
   * ResolveDispute (variant 37); `action` ∈ `DISPUTE_ACTIONS`
   * (`ledger.rs:7739-7756`).
   * @param {XerisKeypair} keypair
   * @param {string} disputeId
   * @param {string} action
   * @param {string} data Evidence text or empty.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async resolveDispute(keypair, disputeId, action, data) {
    arity(arguments.length, 4, 'resolveDispute', 'keypair, disputeId, action, data');
    requireKeypair(keypair);
    checks.oneOf(action, DISPUTE_ACTIONS, 'action');
    return this.sendInstruction(keypair, Instructions.resolveDispute(disputeId, action, data));
  }

  /**
   * SlashReport (variant 38) against `agentPubkey` delegated by
   * `ownerPubkey`; the reporter may not be the owner (`ledger.rs:7959-7970`)
   * and `ownerPubkey` must parse as a public key (`ledger.rs:7950-7956`).
   * Instruction data may be up to `MAX_SLASH_IX_DATA_SIZE` (65,535) bytes
   * (`ledger.rs:119`), which `sendInstruction` allows for this variant.
   * @param {XerisKeypair} keypair Reporter.
   * @param {string} agentPubkey
   * @param {string} ownerPubkey
   * @param {string} violationType
   * @param {string} evidence
   * @param {number|bigint} violationSlot
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async slashReport(keypair, agentPubkey, ownerPubkey, violationType, evidence, violationSlot) {
    arity(arguments.length, 6, 'slashReport', 'keypair, agentPubkey, ownerPubkey, violationType, evidence, violationSlot');
    requireKeypair(keypair);
    checks.pubkey(ownerPubkey, 'ownerPubkey');
    if (ownerPubkey === keypair.publicKey) throw new RangeError('ownerPubkey: a report against the signer\'s own delegation is rejected (ledger.rs:7966-7969)');
    return this.sendInstruction(keypair, Instructions.slashReport(agentPubkey, ownerPubkey, violationType, evidence, violationSlot));
  }

  /**
   * CreateProposal (variant 39). `votingPeriodSlots` within
   * `[MIN_VOTING_PERIOD_SLOTS, MAX_VOTING_PERIOD_SLOTS]` (`ledger.rs:8267-8272`;
   * `contracts.rs:5527-5530`); the proposer needs ≥ `MIN_PROPOSAL_STAKE_LAMPORTS`
   * (100 XRS) staked (`ledger.rs:8278-8282`); `quorum` 0 selects
   * `DEFAULT_PROPOSAL_QUORUM` (`ledger.rs:8284-8288`).
   * @param {XerisKeypair} keypair Proposer.
   * @param {string} proposalId
   * @param {string} title
   * @param {string} description
   * @param {string} proposalType
   * @param {string} parameterJson
   * @param {number|bigint} votingPeriodSlots
   * @param {number|bigint} quorum Lamports of stake, or 0 for the default.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async createProposal(keypair, proposalId, title, description, proposalType, parameterJson, votingPeriodSlots, quorum) {
    arity(arguments.length, 8, 'createProposal', 'keypair, proposalId, title, description, proposalType, parameterJson, votingPeriodSlots, quorum');
    requireKeypair(keypair);
    checks.votingPeriod(votingPeriodSlots);
    return this.sendInstruction(keypair, Instructions.createProposal(proposalId, title, description, proposalType, parameterJson, votingPeriodSlots, quorum));
  }

  /**
   * CastVote (variant 40); `vote` ∈ `VOTES` (`contracts.rs:5584-5588`).
   * This is the on-chain replacement for the disabled `POST /governance/vote`.
   * @param {XerisKeypair} keypair Voter (weight = stake).
   * @param {string} proposalId
   * @param {string} vote `'yes'`, `'no'` or `'abstain'`.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async castVote(keypair, proposalId, vote) {
    arity(arguments.length, 3, 'castVote', 'keypair, proposalId, vote');
    requireKeypair(keypair);
    checks.oneOf(vote, VOTES, 'vote');
    return this.sendInstruction(keypair, Instructions.castVote(proposalId, vote));
  }

  /**
   * ExecuteProposal (variant 41) after the voting period (`ledger.rs:8299-8303`).
   * @param {XerisKeypair} keypair
   * @param {string} proposalId
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async executeProposal(keypair, proposalId) {
    arity(arguments.length, 2, 'executeProposal', 'keypair, proposalId');
    requireKeypair(keypair);
    return this.sendInstruction(keypair, Instructions.executeProposal(proposalId));
  }

  /**
   * OpenChannel (variant 42): `channelId` 1..128 bytes, `channelType` 1..64
   * bytes (`contracts.rs:5637, 5652-5654`), `deposit` > 0, `counterparty` ≠
   * signer (`ledger.rs:8305-8312`). Off-chain states are signed over
   * `channelStateMessage` with the channel's `generation` and `created_slot`
   * from `getContract('xeris_channels')`.
   * @param {XerisKeypair} keypair Party A.
   * @param {string} channelId
   * @param {string} counterparty Party B.
   * @param {number|bigint} deposit Lamports, > 0.
   * @param {string} channelType
   * @param {number|bigint} expiresAtSlot
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async openChannel(keypair, channelId, counterparty, deposit, channelType, expiresAtSlot) {
    arity(arguments.length, 6, 'openChannel', 'keypair, channelId, counterparty, deposit, channelType, expiresAtSlot');
    requireKeypair(keypair);
    checks.maxBytes(channelId, STRING_LIMITS.channelId, 'channelId');
    if (channelId.length === 0) throw new RangeError('channelId: must be 1..128 bytes (contracts.rs:5637)');
    checks.maxBytes(channelType, STRING_LIMITS.channelType, 'channelType');
    if (channelType.length === 0) throw new RangeError('channelType: must be 1..64 bytes (contracts.rs:5652-5654)');
    checks.positive(deposit, 'deposit');
    assertString(counterparty, 'counterparty');
    if (counterparty === keypair.publicKey) throw new RangeError('counterparty: must differ from the signer');
    return this.sendInstruction(keypair, Instructions.openChannel(channelId, counterparty, deposit, channelType, expiresAtSlot));
  }

  /**
   * CloseChannel (variant 43) with the counterparty's 64-byte Ed25519
   * signature over `channelCloseMessage` (`ledger.rs:8314-8400`).
   * @param {XerisKeypair} keypair Closing party.
   * @param {string} channelId
   * @param {number|bigint} finalBalanceA
   * @param {number|bigint} finalBalanceB
   * @param {number|bigint} messageCount
   * @param {Buffer|Uint8Array} counterpartySignature 64 bytes.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async closeChannel(keypair, channelId, finalBalanceA, finalBalanceB, messageCount, counterpartySignature) {
    arity(arguments.length, 6, 'closeChannel', 'keypair, channelId, finalBalanceA, finalBalanceB, messageCount, counterpartySignature');
    requireKeypair(keypair);
    checks.ed25519Signature(counterpartySignature, 'counterpartySignature');
    return this.sendInstruction(keypair, Instructions.closeChannel(channelId, finalBalanceA, finalBalanceB, messageCount, counterpartySignature));
  }

  /**
   * ForceCloseChannel (variant 44, 5 fields, `token.rs:581-587`): starts the
   * challenge window (`CHANNEL_CHALLENGE_PERIOD_SLOTS`). `stateSequence` 0 is
   * refund-only with empty signature bytes; otherwise the counterparty's
   * 64-byte signature over `channelStateMessage` is required and the claims
   * must sum to the deposits (`contracts.rs:5787-5838`).
   * @param {XerisKeypair} keypair Closing party.
   * @param {string} channelId
   * @param {number|bigint} claimedBalanceSelf
   * @param {number|bigint} claimedBalanceOther
   * @param {number|bigint} stateSequence
   * @param {Buffer|Uint8Array} counterpartySignature Empty, or 64 bytes.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async forceCloseChannel(keypair, channelId, claimedBalanceSelf, claimedBalanceOther, stateSequence, counterpartySignature) {
    arity(arguments.length, 6, 'forceCloseChannel', 'keypair, channelId, claimedBalanceSelf, claimedBalanceOther, stateSequence, counterpartySignature');
    requireKeypair(keypair);
    checks.channelSignature(stateSequence, counterpartySignature);
    return this.sendInstruction(keypair, Instructions.forceCloseChannel(channelId, claimedBalanceSelf, claimedBalanceOther, stateSequence, counterpartySignature));
  }

  /**
   * AgentHeartbeat (variant 45) for the keypair's own identity
   * (`identity_pubkey` = signer; `ledger.rs:8420-8452`, requires an active
   * self-owned identity).
   * @param {XerisKeypair} keypair Identity.
   * @param {string} currentModelHash
   * @param {number|bigint} activeTasks `u32`.
   * @param {number|bigint} availableCapacity `u32`.
   * @param {string} statusMessage
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async agentHeartbeat(keypair, currentModelHash, activeTasks, availableCapacity, statusMessage) {
    arity(arguments.length, 5, 'agentHeartbeat', 'keypair, currentModelHash, activeTasks, availableCapacity, statusMessage');
    requireKeypair(keypair);
    return this.sendInstruction(keypair, Instructions.agentHeartbeat(keypair.publicKey, currentModelHash, activeTasks, availableCapacity, statusMessage));
  }

  /**
   * ZkVkRegister (variant 61): registers a Groth16 verifying key under
   * `vkId`. The signer needs ≥ `MIN_STAKE_LAMPORTS` (1,000 XRS) staked
   * (`ledger.rs:8480-8491`); none of `vkId`, `claimType`, `description` may
   * assert a post-quantum claim (`ledger.rs:8492-8495`); `vkBase64` must be
   * 1..16384 bytes of padded base64 (`crypto.rs:1143-1152`).
   * @param {XerisKeypair} keypair Staked validator.
   * @param {string} vkId
   * @param {string} vkBase64
   * @param {string} claimType Becomes the authoritative `proof_type` of proofs against this VK (`ledger.rs:8640-8647`).
   * @param {string} description
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async zkVkRegister(keypair, vkId, vkBase64, claimType, description) {
    arity(arguments.length, 5, 'zkVkRegister', 'keypair, vkId, vkBase64, claimType, description');
    requireKeypair(keypair);
    checks.noPqClaim(vkId, 'vkId');
    checks.noPqClaim(claimType, 'claimType');
    checks.noPqClaim(description, 'description');
    checks.vkBase64(vkBase64);
    return this.sendInstruction(keypair, Instructions.zkVkRegister(vkId, vkBase64, claimType, description));
  }

  /**
   * ZkProofSubmit (variant 46): a Groth16/BN254 proof against a VK registered
   * with `zkVkRegister` (`verificationKeyHash` = its `vk_id`;
   * `ledger.rs:8529-8661`). Only `'groth16'` is accepted; a proof that fails
   * verification is not stored (`ledger.rs:8620-8623`). See `checks.groth16`.
   * @param {XerisKeypair} keypair Submitter.
   * @param {string} proofId
   * @param {string} proofSystem `'groth16'`.
   * @param {Buffer|Uint8Array} proofData Compressed arkworks proof, 1..512 bytes.
   * @param {Buffer|Uint8Array} publicInputs 32 bytes per field element, ≤ 64 elements.
   * @param {string} verificationKeyHash Registered `vk_id`.
   * @param {string} proofType Ignored by the node in favour of the VK's `claim_type` (`ledger.rs:8640-8647`); may not assert a PQ claim.
   * @param {string} metadataJson Stored verbatim; may not assert a PQ claim.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async zkProofSubmit(keypair, proofId, proofSystem, proofData, publicInputs, verificationKeyHash, proofType, metadataJson) {
    arity(arguments.length, 8, 'zkProofSubmit', 'keypair, proofId, proofSystem, proofData, publicInputs, verificationKeyHash, proofType, metadataJson');
    requireKeypair(keypair);
    checks.groth16(proofSystem, proofData, publicInputs, proofType, metadataJson);
    return this.sendInstruction(keypair, Instructions.zkProofSubmit(proofId, proofSystem, proofData, publicInputs, verificationKeyHash, proofType, metadataJson));
  }

  /**
   * ZkProofVerify (variant 47): a read-only check of a stored proof record
   * (`ledger.rs:8663-8667`); it cannot upgrade `verified`. `getZkProofStatus`
   * reads the same record without a transaction.
   * @param {XerisKeypair} keypair
   * @param {string} proofId
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async zkProofVerify(keypair, proofId) {
    arity(arguments.length, 2, 'zkProofVerify', 'keypair, proofId');
    requireKeypair(keypair);
    return this.sendInstruction(keypair, Instructions.zkProofVerify(proofId));
  }

  /**
   * PqKeyRegister (variant 50) for the keypair (`ed25519_pubkey` = signer),
   * by default through `POST /pq-register` (`network.rs:4571-4655`; reply
   * `status: 'queued'`). Only a 1952-byte Dilithium3 key with
   * `securityLevel` 3 is accepted (`crypto.rs:924-976`;
   * `contracts.rs:6168-6215`); a first registration only, later changes go
   * through `pqKeyRotate` (`contracts.rs:6187-6196`).
   * @param {XerisKeypair} keypair Ed25519 owner.
   * @param {Buffer|Uint8Array} pqPublicKey 1952 bytes.
   * @param {string} pqAlgorithm `'dilithium3'`.
   * @param {number|bigint} securityLevel 3.
   * @param {{route?: '/pq-register'|'/submit'}} [opts={}] Default `'/pq-register'`.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async pqKeyRegister(keypair, pqPublicKey, pqAlgorithm, securityLevel, opts = {}) {
    arity(arguments.length, 4, 'pqKeyRegister', 'keypair, pqPublicKey, pqAlgorithm, securityLevel, [opts]', 1);
    requireKeypair(keypair);
    const route = this._routeOption(opts, '/pq-register');
    checks.pqRegister(pqPublicKey, pqAlgorithm, securityLevel);
    return this.sendInstruction(keypair, Instructions.pqKeyRegister(keypair.publicKey, pqPublicKey, pqAlgorithm, securityLevel), { route });
  }

  /**
   * PqKeyRotate (variant 51) for the keypair (`ed25519_pubkey` = signer,
   * `ledger.rs:8751-8754`). `rotationProof` is the currently registered
   * Dilithium3 key's signature over
   * `buildPqRotationMessage(chainId, oldPk, newPk, rotationCount)` with
   * `rotationCount` from `getPqKey(address).rotation_count`
   * (`ledger.rs:8738-8807`; `crypto.rs:851-870`).
   * @param {XerisKeypair} keypair Ed25519 owner.
   * @param {Buffer|Uint8Array} newPqPublicKey 1952 bytes.
   * @param {string} newPqAlgorithm `'dilithium3'`.
   * @param {Buffer|Uint8Array} rotationProof 3309-byte Dilithium3 signature.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async pqKeyRotate(keypair, newPqPublicKey, newPqAlgorithm, rotationProof) {
    arity(arguments.length, 4, 'pqKeyRotate', 'keypair, newPqPublicKey, newPqAlgorithm, rotationProof');
    requireKeypair(keypair);
    checks.pqRotate(newPqPublicKey, newPqAlgorithm, rotationProof);
    return this.sendInstruction(keypair, Instructions.pqKeyRotate(keypair.publicKey, newPqPublicKey, newPqAlgorithm, rotationProof));
  }

  /**
   * PqAttest (variant 53): records a self-asserted PQ adoption marker in the
   * ZK verifier's `pq_attestations` map. The node performs no cryptographic
   * check and stores the record with `verified = false`; the caller's
   * `verified` flag is kept only under `self_asserted` (`ledger.rs:8830-8871`).
   * @param {XerisKeypair} keypair
   * @param {string} attestationType
   * @param {string} referenceId
   * @param {string} pqAlgorithm
   * @param {boolean} verified Caller's claim; not a verification result.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async pqAttest(keypair, attestationType, referenceId, pqAlgorithm, verified) {
    arity(arguments.length, 5, 'pqAttest', 'keypair, attestationType, referenceId, pqAlgorithm, verified');
    requireKeypair(keypair);
    return this.sendInstruction(keypair, Instructions.pqAttest(attestationType, referenceId, pqAlgorithm, verified));
  }

  /**
   * CreateDeal (variant 54): escrows `amount` for `counterparty` under
   * `terms` (`ledger.rs:7781-7788`). `counterparty` must be a canonical
   * public key other than the signer; `amount` > 0.
   * @param {XerisKeypair} keypair Party A.
   * @param {string} dealId
   * @param {string} counterparty Party B.
   * @param {number|bigint} amount Lamports.
   * @param {string} terms Hashed with `dealTermsHash` for `acceptDeal`.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async createDeal(keypair, dealId, counterparty, amount, terms) {
    arity(arguments.length, 5, 'createDeal', 'keypair, dealId, counterparty, amount, terms');
    requireKeypair(keypair);
    checks.pubkey(counterparty, 'counterparty');
    if (counterparty === keypair.publicKey) throw new RangeError('counterparty: must differ from the signer');
    checks.positive(amount, 'amount');
    return this.sendInstruction(keypair, Instructions.createDeal(dealId, counterparty, amount, terms));
  }

  /**
   * AcceptDeal (variant 55) by party B, binding the expected party A, amount
   * and terms hash (`ledger.rs:7789-7798`; `[u8; 32]` at `token.rs:753-759`,
   * compared as hex at `contracts.rs:5381-5382`).
   * @param {XerisKeypair} keypair Party B.
   * @param {string} dealId
   * @param {number|bigint} instance Deal instance number.
   * @param {string} expectedPartyA
   * @param {number|bigint} expectedAmount Lamports.
   * @param {Buffer|Uint8Array|string} expectedTermsHash 32-byte SHA-256, or the terms string (hashed with `dealTermsHash`).
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async acceptDeal(keypair, dealId, instance, expectedPartyA, expectedAmount, expectedTermsHash) {
    arity(arguments.length, 6, 'acceptDeal', 'keypair, dealId, instance, expectedPartyA, expectedAmount, expectedTermsHash');
    requireKeypair(keypair);
    const hash = typeof expectedTermsHash === 'string' ? dealTermsHash(expectedTermsHash) : toBytes(expectedTermsHash, 'expectedTermsHash');
    return this.sendInstruction(keypair, Instructions.acceptDeal(dealId, instance, expectedPartyA, expectedAmount, hash));
  }

  /**
   * ConfirmDeal (variant 56) by a party (`ledger.rs:7799-7802`).
   * @param {XerisKeypair} keypair
   * @param {string} dealId
   * @param {number|bigint} instance
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async confirmDeal(keypair, dealId, instance) {
    arity(arguments.length, 3, 'confirmDeal', 'keypair, dealId, instance');
    requireKeypair(keypair);
    return this.sendInstruction(keypair, Instructions.confirmDeal(dealId, instance));
  }

  /**
   * CancelDeal (variant 57) (`ledger.rs:7803-7806`).
   * @param {XerisKeypair} keypair
   * @param {string} dealId
   * @param {number|bigint} instance
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async cancelDeal(keypair, dealId, instance) {
    arity(arguments.length, 3, 'cancelDeal', 'keypair, dealId, instance');
    requireKeypair(keypair);
    return this.sendInstruction(keypair, Instructions.cancelDeal(dealId, instance));
  }

  /**
   * DisputeDeal (variant 58): freezes the escrow and opens `deal_<dealId>`
   * arbitration; `bond` ≥ `MIN_DEAL_DISPUTE_BOND` (`ledger.rs:7814`).
   * @param {XerisKeypair} keypair A party.
   * @param {string} dealId
   * @param {number|bigint} instance
   * @param {string} reason
   * @param {number|bigint} bond Lamports.
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async disputeDeal(keypair, dealId, instance, reason, bond) {
    arity(arguments.length, 5, 'disputeDeal', 'keypair, dealId, instance, reason, bond');
    requireKeypair(keypair);
    checks.dealBond(bond);
    return this.sendInstruction(keypair, Instructions.disputeDeal(dealId, instance, reason, bond));
  }

  /**
   * SettleDeal (variant 59): permissionless settlement of a resolved dispute
   * (`ledger.rs:7862-7905`).
   * @param {XerisKeypair} keypair
   * @param {string} dealId
   * @param {number|bigint} instance
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async settleDeal(keypair, dealId, instance) {
    arity(arguments.length, 3, 'settleDeal', 'keypair, dealId, instance');
    requireKeypair(keypair);
    return this.sendInstruction(keypair, Instructions.settleDeal(dealId, instance));
  }

  /**
   * ReclaimDeal (variant 60): refunds an inactive deal after
   * `DEAL_TIMEOUT_SLOTS` (648,000) (`ledger.rs:7906-7914`; `contracts.rs:1079`).
   * @param {XerisKeypair} keypair
   * @param {string} dealId
   * @param {number|bigint} instance
   * @returns {Promise<import('./transaction').SubmitResult>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async reclaimDeal(keypair, dealId, instance) {
    arity(arguments.length, 3, 'reclaimDeal', 'keypair, dealId, instance');
    requireKeypair(keypair);
    return this.sendInstruction(keypair, Instructions.reclaimDeal(dealId, instance));
  }

  /**
   * The bytes a PqKeyRotate proof must sign:
   * `'xrs_pq_rotate_v5' ‖ chainId ‖ oldPk ‖ newPk ‖ u64le(rotationCount)`
   * (`crypto.rs:851-870`). Re-export of the instructions helper.
   * @param {string|Buffer|Uint8Array} chainId `CHAIN_ID_TESTNET` / `CHAIN_ID_MAINNET` (ASCII) or raw bytes.
   * @param {Buffer|Uint8Array} oldPk Currently registered key, 1952 bytes.
   * @param {Buffer|Uint8Array} newPk New key, 1952 bytes.
   * @param {number|bigint} rotationCount `getPqKey(address).rotation_count`.
   * @returns {Buffer}
   * @throws {TypeError|RangeError}
   */
  static buildPqRotationMessage(chainId, oldPk, newPk, rotationCount) {
    return buildPqRotationMessage(chainId, oldPk, newPk, rotationCount);
  }

  // --------------------------------------------------------------------------
  // Paths the node refuses: synchronous FeatureDisabledError, no network
  // --------------------------------------------------------------------------

  /**
   * SubDelegate (variant 22) is rejected at ingress (`ledger.rs:1445-1450`).
   * @throws {FeatureDisabledError} Always; `.replacement` names `registerAgent`.
   */
  subDelegate() { throw disabledFeature('SubDelegate'); }

  /**
   * ZkPrivateTransfer (variant 48) is skipped by the dispatcher after the fee
   * is charged (`ledger.rs:8669-8685`).
   * @throws {FeatureDisabledError} Always.
   */
  zkPrivateTransfer() { throw disabledFeature('ZkPrivateTransfer'); }

  /**
   * ZkIdentityProof (variant 49) is skipped by the dispatcher (`ledger.rs:8687-8697`).
   * @throws {FeatureDisabledError} Always.
   */
  zkIdentityProof() { throw disabledFeature('ZkIdentityProof'); }

  /**
   * PqSignedTransfer (variant 52) is skipped by the dispatcher (`ledger.rs:8809-8828`).
   * @throws {FeatureDisabledError} Always.
   */
  pqSignedTransfer() { throw disabledFeature('PqSignedTransfer'); }

  /**
   * 4.x `sendZkPrivateTransfer`: no private-transfer path exists (`ledger.rs:8669-8685`).
   * @throws {FeatureDisabledError} Always.
   */
  sendZkPrivateTransfer() { throw disabledFeature('ZkPrivateTransfer'); }

  /**
   * 4.x `sendPqTransfer`: transfers are Ed25519-signed NativeTransfer only (`ledger.rs:8809-8828`).
   * @throws {FeatureDisabledError} Always.
   */
  sendPqTransfer() { throw disabledFeature('PqSignedTransfer'); }

  /**
   * `GET /airdrop/{address}/{amount}` is disabled (`network.rs:4314-4327`).
   * @throws {FeatureDisabledError} Always; `.replacement` names `transferXrs`.
   */
  airdrop() { throw disabledFeature('airdrop'); }

  /**
   * `POST /stake/claim` returns HTTP 501 (`network.rs:5705-5740`); staking
   * rewards are credited automatically every 900 blocks (`ledger.rs:9372-9438`).
   * @throws {FeatureDisabledError} Always.
   */
  claimStakingReward() { throw disabledFeature('stakeClaim'); }

  /**
   * `POST /governance/lock` returns HTTP 501 (`network.rs:5838-5850`); no
   * on-chain lock instruction exists. `getGovernanceLock` remains readable.
   * @throws {FeatureDisabledError} Always.
   */
  governanceLock() { throw disabledFeature('governanceLock'); }

  /**
   * `POST /governance/delegate` returns HTTP 501 (`network.rs:5855-5867`).
   * @throws {FeatureDisabledError} Always.
   */
  governanceDelegate() { throw disabledFeature('governanceLock'); }

  // --------------------------------------------------------------------------
  // Planner (POST /agent/plan, network.rs:5386-5577; read-only, no limiter)
  // --------------------------------------------------------------------------

  /**
   * `POST /agent/plan` with a free-form body carrying `action`. Returns the
   * instruction the node suggests (`AgentPlan`, blueprint §12.4); convert
   * with `fromPlan`. An unknown action is reported as `RpcError`
   * (`network.rs:5568-5572`). Body cap 16 KiB (`network.rs:5388`). The body
   * is written with `stringifyJson` (exact `bigint`), and the response is
   * read with `parseJson`, so a plan's u64 values above 2^53-1 (a launchpad
   * `min_tokens_out`) arrive as `bigint` and `fromPlan` encodes them exactly.
   * @param {object} body Plain JSON object, e.g. `{action: 'transfer', from, to, amount_xrs}`.
   * @returns {Promise<object>} The plan.
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async agentPlan(body) {
    if (!isPlainObject(body)) throw new TypeError(`body: expected a plain object with an 'action' field, got ${describe(body)}`);
    return this._post(`${this.#rpcUrl}/agent/plan`, body);
  }

  /**
   * Plans a NativeTransfer (`network.rs:5395-5416`). `amountXrs` is sent as a
   * JSON number and read by the node as `f64`, then truncated to lamports
   * (`network.rs:5398-5399`); amounts with more than ~15 significant digits
   * lose precision on this path. Use `transferXrs` for exact amounts.
   * @param {string} from Sender address.
   * @param {string} to Recipient address.
   * @param {number} amountXrs XRS as a number.
   * @returns {Promise<object>} `{action:'transfer', variant_index:11, params:{from,to,amount}, fee, fee_xrs, sender_balance, sufficient_balance, ...}`.
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async planTransfer(from, to, amountXrs) {
    assertString(from, 'from');
    assertString(to, 'to');
    return this.agentPlan({ action: 'transfer', from, to, amount_xrs: jsonNumber(amountXrs, 'amountXrs', 0) });
  }

  /**
   * Plans an AMM swap (`network.rs:5417-5481`): resolves the direction,
   * quotes the output and returns the 16-byte swap args as a byte array
   * (`params.args`, `network.rs:5455`) with `min_amount_out` derived from
   * `slippagePct`. `slippagePct` is required and always sent: the node
   * would otherwise apply 5% (`network.rs:5421`).
   * @param {string} poolId
   * @param {string} tokenIn
   * @param {number|bigint} amountIn Base units.
   * @param {number} slippagePct Percent, 0..100.
   * @returns {Promise<object>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async planSwap(poolId, tokenIn, amountIn, slippagePct) {
    arity(arguments.length, 4, 'planSwap', 'poolId, tokenIn, amountIn, slippagePct');
    assertString(poolId, 'poolId');
    assertString(tokenIn, 'tokenIn');
    return this.agentPlan({
      action: 'swap',
      pool_id: poolId,
      token_in: tokenIn,
      amount_in: normalizeU64(amountIn, 'amountIn'),
      slippage_pct: jsonNumber(slippagePct, 'slippagePct', 0, 100),
    });
  }

  /**
   * Plans a Launchpad buy (`network.rs:5482-5533`); `params.args` is the JSON
   * object `{xrs_amount, min_tokens_out}` for `buy_tokens`. `slippagePct` is
   * required and always sent: the node would otherwise apply 5%
   * (`network.rs:5485`).
   * @param {string} launchpadId
   * @param {number|bigint} xrsAmount Lamports of wrapped XRS.
   * @param {number} slippagePct Percent, 0..100.
   * @returns {Promise<object>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async planBuyLaunchpad(launchpadId, xrsAmount, slippagePct) {
    arity(arguments.length, 3, 'planBuyLaunchpad', 'launchpadId, xrsAmount, slippagePct');
    assertString(launchpadId, 'launchpadId');
    return this.agentPlan({
      action: 'buy_launchpad',
      launchpad_id: launchpadId,
      xrs_amount: normalizeU64(xrsAmount, 'xrsAmount'),
      slippage_pct: jsonNumber(slippagePct, 'slippagePct', 0, 100),
    });
  }

  /**
   * Plans a Stake (`network.rs:5534-5546`); `amount_xrs` is read as `f64` and
   * truncated to lamports.
   * @param {string} pubkey Staker.
   * @param {number} amountXrs XRS as a number.
   * @returns {Promise<object>} Includes `min_stake_xrs: 1000`.
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async planStake(pubkey, amountXrs) {
    assertString(pubkey, 'pubkey');
    return this.agentPlan({ action: 'stake', pubkey, amount_xrs: jsonNumber(amountXrs, 'amountXrs', 0) });
  }

  /**
   * Plans a WrapXrs (`network.rs:5547-5557`); `amount_xrs` is read as `f64`.
   * @param {number} amountXrs XRS as a number.
   * @returns {Promise<object>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async planWrap(amountXrs) {
    return this.agentPlan({ action: 'wrap', amount_xrs: jsonNumber(amountXrs, 'amountXrs', 0) });
  }

  /**
   * Plans an UnwrapXrs (`network.rs:5558-5567`); `amount_xrs` is read as `f64`.
   * @param {number} amountXrs XRS as a number.
   * @returns {Promise<object>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async planUnwrap(amountXrs) {
    return this.agentPlan({ action: 'unwrap', amount_xrs: jsonNumber(amountXrs, 'amountXrs', 0) });
  }

  // --------------------------------------------------------------------------
  // Read methods, RPC port (blueprint §10.6; network.rs)
  // Path parameters go through `seg`: sent unencoded, refused when the node
  // could not receive them unchanged.
  // --------------------------------------------------------------------------

  /**
   * `GET /health` (`network.rs:4860-4862`); proves only that the HTTP server is up.
   * @returns {Promise<{status: 'ok'}>}
   * @throws {RpcError|XerisError}
   */
  async getHealth() {
    return this._get(`${this.#rpcUrl}/health`);
  }

  /**
   * `GET /blocks` (`network.rs:4555-4559`): up to 50 newest blocks, newest
   * first, as raw `ledger::Block` serde (`ledger.rs:294-331`). `hash`,
   * `merkle_root`, `previous_hash`, `poh_hash`, `proposer` (a `Pubkey`,
   * serialised as its 32 raw bytes; base58-encode it to display) and
   * `proposer_sig` are JSON byte arrays, not hex or base58; `poh_timestamp`
   * is Unix milliseconds.
   * @returns {Promise<object[]>}
   * @throws {RpcError|XerisError}
   */
  async getRecentBlocks() {
    return this._get(`${this.#rpcUrl}/blocks`);
  }

  /**
   * `GET /stake/{address}` (`network.rs:4866-4899`). An unparseable address
   * is treated as the default key and returns zeros.
   * @param {string} address
   * @returns {Promise<{address: string, stake: number|bigint, stake_xrs: number, isValidator: boolean, blocksProposed: number,
   *   staking_apy_pct: number, earns_staking_rewards: boolean, estimated_hourly_reward_lamports: number,
   *   estimated_hourly_reward_xrs: number, estimated_annual_reward_xrs: number, min_stake_for_rewards_xrs: number}>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async getStakeInfo(address) {
    return this._get(`${this.#rpcUrl}/stake/${seg(address, 'address')}`);
  }

  /**
   * `GET /account/{address}/unstaking` (`network.rs:5683-5703`). The
   * `start_time`, `end_time` and `unlock_time` fields are slot × 4 seconds,
   * not Unix epoch (`network.rs:5694`).
   * @param {string} address
   * @returns {Promise<{address: string, count: number, sessions: Array<{id: string, amount: number|bigint, start_time: number,
   *   end_time: number, start_slot: number, unlock_time: number}>}>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async getUnstaking(address) {
    return this._get(`${this.#rpcUrl}/account/${seg(address, 'address')}/unstaking`);
  }

  /**
   * `GET /network/economics` (`network.rs:5147-5183`).
   * @returns {Promise<object>} Emission, fee, staking and height figures (blueprint §10.6).
   * @throws {RpcError|XerisError}
   */
  async getNetworkEconomics() {
    return this._get(`${this.#rpcUrl}/network/economics`);
  }

  /**
   * `GET /tokens` (`network.rs:4915-4922`): every token, unpaginated
   * (`getTokens` is the paginated explorer alternative).
   * @returns {Promise<{tokens: object[]}>} `TokenInfo` rows (`token.rs:835-852`).
   * @throws {RpcError|XerisError}
   */
  async getTokenList() {
    return this._get(`${this.#rpcUrl}/tokens`);
  }

  /**
   * `GET /token/balance/{address}/{tokenId}` (`network.rs:4903-4913`).
   * @param {string} address
   * @param {string} tokenId
   * @returns {Promise<{address: string, token_id: string, balance: number, token_info: object|null}>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async getTokenBalance(address, tokenId) {
    return this._get(`${this.#rpcUrl}/token/balance/${seg(address, 'address')}/${seg(tokenId, 'tokenId')}`);
  }

  /**
   * `GET /token/accounts/{address}` (`network.rs:5186-5211`). `native_xrs`
   * holds lamports despite its name; only balances > 0 are listed.
   * @param {string} address
   * @returns {Promise<{address: string, native_xrs: number, token_accounts: Array<{token_id: string, symbol: string,
   *   balance: number, balance_display: number, decimals: number}>}>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async getTokenAccounts(address) {
    return this._get(`${this.#rpcUrl}/token/accounts/${seg(address, 'address')}`);
  }

  /**
   * `GET /contracts` (`network.rs:5029-5045`).
   * @returns {Promise<{success: true, count: number, contracts: Array<{contract_id: string, type: string, owner: string,
   *   is_active: boolean, created_slot: number}>}>}
   * @throws {RpcError|XerisError}
   */
  async getContracts() {
    return this._get(`${this.#rpcUrl}/contracts`);
  }

  /**
   * `GET /contract/{id}` (`network.rs:5018-5026`): the full contract with its
   * externally tagged `state` (`contracts.rs:416-423`, e.g. `state.Swap`).
   * @param {string} contractId
   * @returns {Promise<{success: true, contract: {contract_id: string, contract_type: string, owner: string,
   *   created_slot: number, state: object, is_active: boolean}}>}
   * @throws {RpcError} `Contract not found`.
   * @throws {TypeError|RangeError|XerisError}
   */
  async getContract(contractId) {
    return this._get(`${this.#rpcUrl}/contract/${seg(contractId, 'contractId')}`);
  }

  /**
   * `GET /contract/{id}/quote?input_token=&amount=` (`network.rs:5048-5066`;
   * math `contracts.rs:1868-1921`). Swap pools only; `amount` > 0.
   * `quote.price_impact_pct` is a string with two decimals.
   * @param {string} contractId Swap pool id.
   * @param {string} inputToken Token id being sold.
   * @param {number|bigint} amount Base units, > 0.
   * @returns {Promise<{success: true, quote: {input_token: string, input_amount: number|bigint, output_token: string,
   *   output_amount: number|bigint, fee: number|bigint, fee_bps: number, price_impact_pct: string, effective_price: number}}>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async getContractQuote(contractId, inputToken, amount) {
    assertString(inputToken, 'inputToken');
    checks.positive(amount, 'amount');
    const path = `${this.#rpcUrl}/contract/${seg(contractId, 'contractId')}/quote`;
    return this._get(withQuery(path, [['input_token', inputToken], ['amount', normalizeU64(amount, 'amount').toString()]]));
  }

  /**
   * `GET /contract/{id}/vesting/{wallet}` (`network.rs:5070-5109`), Launchpad
   * only. Every deployable launchpad answers `{success: true, vesting:
   * {enabled: false}}` because `vesting_enabled: true` is refused at deploy
   * (`contracts.rs:1666-1668`); the enabled shape is at `contracts.rs:3215-3260`.
   * @param {string} contractId
   * @param {string} wallet
   * @returns {Promise<{success: boolean, vesting: object}>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async getVestingStatus(contractId, wallet) {
    return this._get(`${this.#rpcUrl}/contract/${seg(contractId, 'contractId')}/vesting/${seg(wallet, 'wallet')}`);
  }

  /**
   * `GET /launchpads` (`network.rs:5215-5271`): every Launchpad contract,
   * newest first; `xeris_fee_bps` is 77 (`contracts.rs:308`).
   * @returns {Promise<{launchpads: object[]}>}
   * @throws {RpcError|XerisError}
   */
  async getLaunchpads() {
    return this._get(`${this.#rpcUrl}/launchpads`);
  }

  /**
   * `GET /launchpad/{id}/quote?xrs_amount=` (`network.rs:5274-5327`;
   * execution-equivalent math `contracts.rs:296-333`). `price_impact_pct` is a number here.
   * @param {string} contractId Launchpad id.
   * @param {number|bigint} xrsAmountLamports Wrapped XRS to spend, in lamports, > 0.
   * @returns {Promise<{xrs_amount: number|bigint, tokens_out: number|bigint, creator_fee: number|bigint, xeris_fee: number|bigint, total_fees: number|bigint,
   *   effective_price: number, price_after: number, price_impact_pct: number}>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async getLaunchpadQuote(contractId, xrsAmountLamports) {
    checks.positive(xrsAmountLamports, 'xrsAmountLamports');
    const path = `${this.#rpcUrl}/launchpad/${seg(contractId, 'contractId')}/quote`;
    return this._get(withQuery(path, [['xrs_amount', normalizeU64(xrsAmountLamports, 'xrsAmountLamports').toString()]]));
  }

  /**
   * `GET /agent/registry/{owner}` (`network.rs:5332-5355`); an owner without a
   * registry gets `agent_count: 0, agents: []`.
   * @param {string} owner
   * @returns {Promise<{owner: string, registry_id: string, agent_count: number, agents: object[]}>} `AgentEntry` rows (`contracts.rs:1267-1298`).
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async getAgentRegistry(owner) {
    return this._get(`${this.#rpcUrl}/agent/registry/${seg(owner, 'owner')}`);
  }

  /**
   * `GET /agent/validate/{agent}/{owner}` (`network.rs:5358-5383`). An agent
   * missing from the registry is reported as `{authorized: false, error:
   * 'Agent not found in registry'}`, which this method raises as `RpcError`.
   * @param {string} agentPubkey
   * @param {string} owner
   * @returns {Promise<{authorized: boolean, revoked: boolean, expired: boolean, agent: object}>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async validateAgent(agentPubkey, owner) {
    return this._get(`${this.#rpcUrl}/agent/validate/${seg(agentPubkey, 'agentPubkey')}/${seg(owner, 'owner')}`);
  }

  /**
   * `GET /capabilities/search` (`network.rs:5583-5615`): active listings whose
   * provider identity is active, sorted by reputation, filtered by the given
   * parameters (`region` also matches listings whose region is `'global'`;
   * `maxPrice` also matches `price_per_unit` 0). Only supplied parameters are
   * sent; the node defaults `limit` to 50. Keys use camelCase; the node's
   * query names (`min_rep`, `max_price`, which 4.x passed through) and any
   * other unknown key throw instead of being dropped. The node joins `tags`
   * with `,` and trims each tag (`network.rs:5593-5594`), so a tag that is
   * empty, contains `,` or has leading/trailing whitespace is refused.
   * @param {{category?: string, tags?: string[], region?: string, minRep?: number|bigint, maxPrice?: number|bigint, limit?: number}} [params={}]
   * @returns {Promise<{success: true, data: object[]}>} `CapabilityListing` rows (`contracts.rs:805-818`).
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async searchCapabilities(params = {}) {
    if (!isPlainObject(params)) throw new TypeError(`params: expected an object, got ${describe(params)}`);
    onlyKeys(params, ['category', 'tags', 'region', 'minRep', 'maxPrice', 'limit'], 'params', {
      min_rep: 'minRep', max_price: 'maxPrice',
    });
    const q = [];
    if (params.category !== undefined) q.push(['category', assertString(params.category, 'params.category')]);
    if (params.tags !== undefined) {
      if (!Array.isArray(params.tags)) throw new TypeError(`params.tags: expected an array of strings, got ${describe(params.tags)}`);
      const tags = params.tags.map((t, i) => {
        const field = `params.tags[${i}]`;
        assertString(t, field);
        if (t.length === 0 || t.includes(',') || t.trim() !== t) {
          throw new RangeError(`${field}: '${t}' is empty, contains ',' or has surrounding whitespace; the node splits tags on ',' and trims them (network.rs:5593-5594)`);
        }
        return t;
      });
      q.push(['tags', tags.join(',')]);
    }
    if (params.region !== undefined) q.push(['region', assertString(params.region, 'params.region')]);
    if (params.minRep !== undefined) q.push(['min_rep', normalizeU64(params.minRep, 'params.minRep').toString()]);
    if (params.maxPrice !== undefined) q.push(['max_price', normalizeU64(params.maxPrice, 'params.maxPrice').toString()]);
    if (params.limit !== undefined) q.push(['limit', pageInt(params.limit, 'params.limit', 0)]);
    return this._get(withQuery(`${this.#rpcUrl}/capabilities/search`, q));
  }

  /**
   * `GET /capabilities` (`network.rs:5619-5632`): all active listings, unsorted.
   * @returns {Promise<{success: true, count: number, data: object[]}>}
   * @throws {RpcError|XerisError}
   */
  async getCapabilities() {
    return this._get(`${this.#rpcUrl}/capabilities`);
  }

  /**
   * `GET /tasks` (`network.rs:5640-5659`).
   * @returns {Promise<{success: true, open_tasks: number, total_posted?: number, total_completed?: number,
   *   total_rewards_paid_xrs?: number, data: object[]}>} `TaskEntry` rows (`contracts.rs:864-907`).
   * @throws {RpcError|XerisError}
   */
  async getTasks() {
    return this._get(`${this.#rpcUrl}/tasks`);
  }

  /**
   * `GET /tasks/{id}` (`network.rs:5663-5675`).
   * @param {string} taskId
   * @returns {Promise<{success: true, data: object}>}
   * @throws {RpcError} `Task not found`.
   * @throws {TypeError|RangeError|XerisError}
   */
  async getTask(taskId) {
    return this._get(`${this.#rpcUrl}/tasks/${seg(taskId, 'taskId')}`);
  }

  /**
   * `GET /zk/proofs/{identity}` (`network.rs:5912-5923`): proofs submitted by `identity`.
   * @param {string} identity
   * @returns {Promise<{success: true, count: number, proofs: object[]}>} `ZkProofRecord` rows (`contracts.rs:1175-1189`).
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async getZkProofs(identity) {
    return this._get(`${this.#rpcUrl}/zk/proofs/${seg(identity, 'identity')}`);
  }

  /**
   * `GET /zk/verify/{proofId}` (`network.rs:5927-5938`).
   * @param {string} proofId
   * @returns {Promise<{success: true, data: object}>}
   * @throws {RpcError} `Proof not found`.
   * @throws {TypeError|RangeError|XerisError}
   */
  async getZkProofStatus(proofId) {
    return this._get(`${this.#rpcUrl}/zk/verify/${seg(proofId, 'proofId')}`);
  }

  /**
   * `GET /zk/stats` (`network.rs:5942-5954`).
   * @returns {Promise<{total_proofs: number, total_verified: number, verification_keys?: number, nullifiers_used?: number}>}
   * @throws {RpcError|XerisError}
   */
  async getZkStats() {
    return this._get(`${this.#rpcUrl}/zk/stats`);
  }

  /**
   * `GET /pq/keys/{address}` (`network.rs:5958-5974`); `rotation_count` is the
   * nonce `buildPqRotationMessage` needs.
   * @param {string} address
   * @returns {Promise<{success: true, has_pq_key: boolean, algorithm?: string, security_level?: number, key_hash?: string,
   *   registered_slot?: number, rotation_count?: number, active?: boolean}>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async getPqKey(address) {
    return this._get(`${this.#rpcUrl}/pq/keys/${seg(address, 'address')}`);
  }

  /**
   * `GET /pq/status` (`network.rs:5978-6001`). `quantum_ready_pct` divides the
   * key count by the chain height, not by the account count.
   * @returns {Promise<{total_registered: number, total_rotations?: number, total_pq_transactions?: number,
   *   algorithms?: Record<string, number>, quantum_ready_pct: number}>}
   * @throws {RpcError|XerisError}
   */
  async getPqStatus() {
    return this._get(`${this.#rpcUrl}/pq/status`);
  }

  /**
   * `GET /governance/proposals` (`network.rs:5745-5783`). `expiry_timestamp`
   * and `created_at` are slot × 4000, not epoch milliseconds;
   * `discussion_url` is always `null` and `action.params` always `{}`.
   * @returns {Promise<{proposals: object[], total_proposals: number, total_executed: number}>}
   * @throws {RpcError|XerisError}
   */
  async getGovernanceProposals() {
    return this._get(`${this.#rpcUrl}/governance/proposals`);
  }

  /**
   * `GET /governance/lock/{address}` (`network.rs:5821-5833`). Readable even
   * though the lock/delegate write routes are disabled.
   * @param {string} address
   * @returns {Promise<{address: string, locked_amount: number|bigint, locked_xrs: number, delegate: string|null}>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async getGovernanceLock(address) {
    return this._get(`${this.#rpcUrl}/governance/lock/${seg(address, 'address')}`);
  }

  /**
   * `GET /price-history?pool_id=&limit=` (`network.rs:6026-6075`): the last
   * `limit` snapshots of a pool's node-local price file (one per 100 blocks,
   * `ledger.rs:3785-3788`). The node caps `limit` at 10,080
   * (`network.rs:6030-6033`) and drops every `pool_id` character outside
   * `[A-Za-z0-9_-]` (`network.rs:6036-6039`), so the SDK refuses a larger
   * `limit` and a `poolId` that does not match `CONTRACT_ID_PATTERN` rather
   * than read a different pool's file. A pool with no price file returns
   * `{pair: 'XRS-xUSDC', count: 0}`, not an error (`network.rs:6050-6068`).
   * @param {string} poolId Contract id of the pool (`CONTRACT_ID_PATTERN`).
   * @param {number} [limit=500] `0..=PRICE_HISTORY_MAX_LIMIT`; 500 is the node's own default (`network.rs:6032`).
   * @returns {Promise<{pair: string, count: number, history: Array<{slot: number, timestamp_ms: number, price: number,
   *   tvl: number, token_a: string, token_b: string, total_fees_lamports: number|bigint}>}>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async getPriceHistory(poolId, limit = 500) {
    assertString(poolId, 'poolId');
    if (!CONTRACT_ID_PATTERN.test(poolId)) {
      throw new RangeError(`poolId: ${describe(poolId)} is not 1..128 characters of [A-Za-z0-9_-]; the node strips other characters and would read another pool's file (network.rs:6036-6039)`);
    }
    const lim = boundedInt(limit, 'limit', 0, PRICE_HISTORY_MAX_LIMIT, 'network.rs:6030-6033');
    return this._get(withQuery(`${this.#rpcUrl}/price-history`, [['pool_id', poolId], ['limit', lim]]));
  }

  /**
   * `GET /pools/price-history` (`network.rs:6079-6106`): the last 100
   * snapshots of every pool with a price file.
   * @returns {Promise<{pools: Record<string, {history: object[], count: number}>}>}
   * @throws {RpcError|XerisError}
   */
  async getAllPoolPriceHistory() {
    return this._get(`${this.#rpcUrl}/pools/price-history`);
  }

  // --------------------------------------------------------------------------
  // Read methods, explorer port (blueprint §10.7; explorer.rs /v2/*)
  // --------------------------------------------------------------------------

  /**
   * `GET /v2/stats` (`explorer.rs:965-1011`). `validator_count` counts every
   * address with any stake; `total_transactions` counts included, not
   * necessarily executed, transactions.
   * @returns {Promise<{success: true, data: {block_height: number, current_slot: number, total_transactions: number,
   *   total_accounts: number, total_staked: number, validator_count: number, tps_estimate: number}}>}
   * @throws {RpcError|XerisError}
   */
  async getStats() {
    return this._get(`${this.#explorerUrl}/v2/stats`);
  }

  /**
   * `GET /v2/blocks?page=&page_size=` (`explorer.rs:1014-1034`): newest-first
   * summaries over the ≤ 1000 in-memory blocks; `hash` is hex. The node
   * clamps `page_size` to 1..100 (`explorer.rs:280, 1020`); the SDK refuses
   * a value outside that range instead.
   * @param {number} [page=1]
   * @param {number} [pageSize=20] `1..=LIST_MAX_PAGE_SIZE` (100).
   * @returns {Promise<{success: true, data: Array<{slot: number, hash: string, proposer: string, tx_count: number,
   *   poh_timestamp: number}>, pagination: {total: number, page: number, page_size: number, total_pages: number}}>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async getBlocks(page = 1, pageSize = 20) {
    const size = boundedInt(pageSize, 'pageSize', 1, LIST_MAX_PAGE_SIZE, 'explorer.rs:280, 1020');
    return this._get(withQuery(`${this.#explorerUrl}/v2/blocks`, [['page', pageInt(page, 'page', 1)], ['page_size', size]]));
  }

  /**
   * `GET /v2/block/slot/{slot}` (`explorer.rs:1037-1081`): the only block
   * route that reaches the on-disk index for slots no longer in memory.
   * Transactions inside carry `status: 'included'` (`explorer.rs:735-738`).
   * @param {number|bigint} slot
   * @returns {Promise<{success: true, data: object}>} `BlockDetail` (`explorer.rs:63-72`).
   * @throws {RpcError} `Block not found` / `Block lookup busy`.
   * @throws {TypeError|RangeError|XerisError}
   */
  async getBlockBySlot(slot) {
    return this._get(`${this.#explorerUrl}/v2/block/slot/${normalizeU64(slot, 'slot').toString()}`);
  }

  /**
   * `GET /v2/block/hash/{hash}` (`explorer.rs:1084-1106`); in-memory blocks only.
   * @param {string} hashHex 64 hex characters.
   * @returns {Promise<{success: true, data: object}>}
   * @throws {RpcError} `Block not found`.
   * @throws {TypeError|EncodingError|XerisError}
   */
  async getBlockByHash(hashHex) {
    blockhashFromHex(hashHex);
    return this._get(`${this.#explorerUrl}/v2/block/hash/${hashHex.toLowerCase()}`);
  }

  /**
   * `GET /v2/transactions?page=&page_size=` (`explorer.rs:1109-1180`):
   * newest-first across in-memory blocks. The node clamps `page_size` to
   * 1..100 (`explorer.rs:1114, 1125`); the SDK refuses a value outside that
   * range instead.
   * @param {number} [page=1]
   * @param {number} [pageSize=20] `1..=LIST_MAX_PAGE_SIZE` (100).
   * @returns {Promise<{success: true, data: object[], pagination: object}>} `TransactionSummary` rows (`explorer.rs:75-88`).
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async getTransactions(page = 1, pageSize = 20) {
    const size = boundedInt(pageSize, 'pageSize', 1, LIST_MAX_PAGE_SIZE, 'explorer.rs:1114, 1125');
    return this._get(withQuery(`${this.#explorerUrl}/v2/transactions`, [['page', pageInt(page, 'page', 1)], ['page_size', size]]));
  }

  /**
   * `GET /v2/tx/{signature}` (`explorer.rs:1183-1249`); searches the newest
   * `MAX_RECENT_BLOCKS` in-memory blocks only.
   * @param {string} signature base58.
   * @returns {Promise<{success: true, data: TxDetail}>}
   * @throws {RpcError} `Transaction not found`.
   * @throws {TypeError|RangeError|XerisError}
   */
  async getTransaction(signature) {
    return this._get(`${this.#explorerUrl}/v2/tx/${seg(signature, 'signature')}`);
  }

  /**
   * `GET /v2/account/{address}` (`explorer.rs:1251-1284`); never 404s, an
   * unknown address returns zeros.
   * @param {string} address
   * @returns {Promise<{success: true, data: {address: string, balance: number|bigint, balance_xrs: number, stake: number|bigint,
   *   is_validator: boolean, blocks_proposed: number}}>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async getAccountInfo(address) {
    return this._get(`${this.#explorerUrl}/v2/account/${seg(address, 'address')}`);
  }

  /**
   * `GET /v2/account/{address}/transactions?page=&page_size=&before=`
   * (`explorer.rs:1287-1375`), served from the receipt store: one row per
   * committed instruction, `tx_type` prefixed `sent:`/`received:`. The node
   * clamps `page` to 1..50 and `page_size` to 1..200 (`explorer.rs:1305-1307`,
   * `tx_store.rs:57`); the SDK refuses values outside those ranges instead,
   * because a clamped page silently repeats page 50 while
   * `pagination.total_pages` can exceed 50. Past page 50, pass the previous
   * response's `cursor` as `before`. The node ignores `page` when `before`
   * is present (`explorer.rs:1321-1322`), so the SDK refuses the two together
   * and sends `page` only without `before`.
   *
   * 4.x took `(address, page, pageSize)`; a non-object second argument now
   * throws `TypeError` rather than being ignored.
   * @param {string} address
   * @param {{page?: number, pageSize?: number, before?: number}} [opts={}] Defaults `page = 1`, `pageSize = 20`.
   * @returns {Promise<{success: true, data: object[], pagination: object, cursor: number|null}>}
   * @throws {TypeError} `opts` is not a plain object (for example a 4.x positional page number).
   * @throws {RangeError} An unknown key, `page` outside 1..50, `pageSize` outside 1..200, or both `page` and `before`.
   * @throws {RpcError|XerisError}
   */
  async getAccountTransactions(address, opts = {}) {
    if (!isPlainObject(opts)) {
      throw new TypeError(`opts: expected {page, pageSize, before}, got ${describe(opts)}; 5.0 no longer takes positional page arguments`);
    }
    onlyKeys(opts, ['page', 'pageSize', 'before'], 'opts', { page_size: 'pageSize' });
    if (opts.page !== undefined && opts.before !== undefined) {
      throw new RangeError('opts: pass either page or before, not both; the node ignores page when before is present (explorer.rs:1321-1322)');
    }
    const pageSize = opts.pageSize === undefined ? 20 : boundedInt(opts.pageSize, 'opts.pageSize', 1, ACCOUNT_HISTORY_MAX_PAGE_SIZE,
      'explorer.rs:1307, tx_store.rs:57');
    let q;
    if (opts.before !== undefined) {
      q = [['page_size', pageSize], ['before', pageInt(opts.before, 'opts.before', 0)]];
    } else {
      const page = opts.page === undefined ? 1 : boundedInt(opts.page, 'opts.page', 1, ACCOUNT_HISTORY_MAX_PAGE,
        'explorer.rs:1300-1306; past page 50 pass the previous response\'s cursor as opts.before');
      q = [['page', page], ['page_size', pageSize]];
    }
    return this._get(withQuery(`${this.#explorerUrl}/v2/account/${seg(address, 'address')}/transactions`, q));
  }

  /**
   * `GET /v2/validators` (`explorer.rs:1377-1410`): every address with stake,
   * unordered, no minimum-stake filter.
   * @returns {Promise<{success: true, data: Array<{address: string, stake: number|bigint, stake_percentage: number,
   *   blocks_proposed: number}>, total_staked: number, total_staked_xrs: number, validator_count: number}>}
   * @throws {RpcError|XerisError}
   */
  async getValidators() {
    return this._get(`${this.#explorerUrl}/v2/validators`);
  }

  /**
   * `GET /v2/search?q=` (`explorer.rs:763-832`): slot, block hash, signature,
   * funded account or validator, in that order.
   * @param {string} q
   * @returns {Promise<{success: true, result_type: 'block'|'transaction'|'account'|'validator', data: object}>}
   * @throws {RpcError} `Not found`.
   * @throws {TypeError|RangeError|XerisError}
   */
  async search(q) {
    assertString(q, 'q');
    if (q.trim().length === 0) throw new RangeError('q: must not be empty');
    return this._get(withQuery(`${this.#explorerUrl}/v2/search`, [['q', q]]));
  }

  /**
   * Validates the `{after, limit}` cursor options of the registry routes.
   * The node clamps `limit` to 1..32 (`REGISTRY_PAGE_ITEMS`, `explorer.rs:126,
   * 168`); the SDK refuses values outside that range and unknown keys
   * instead of letting them be clamped or ignored.
   * @private
   * @param {unknown} opts
   * @returns {Array<[string, string|number|undefined]>}
   * @throws {TypeError|RangeError}
   */
  _cursorQuery(opts) {
    if (!isPlainObject(opts)) throw new TypeError(`opts: expected an object, got ${describe(opts)}`);
    onlyKeys(opts, ['after', 'limit'], 'opts', { page_size: 'limit', pageSize: 'limit' });
    const q = [];
    if (opts.after !== undefined) q.push(['after', assertString(opts.after, 'opts.after')]);
    if (opts.limit !== undefined) {
      q.push(['limit', boundedInt(opts.limit, 'opts.limit', 1, REGISTRY_PAGE_ITEMS, 'explorer.rs:126, 168')]);
    }
    return q;
  }

  /**
   * `GET /v2/tokens?after=&limit=` (`explorer.rs:1646-1679`): cursor page
   * over the token registry; pass `next_after` back as `after`.
   * @param {{after?: string, limit?: number}} [opts={}]
   * @returns {Promise<{success: true, data: object[], count: number, next_after: string|null}>} `TokenInfo` rows.
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async getTokens(opts = {}) {
    return this._get(withQuery(`${this.#explorerUrl}/v2/tokens`, this._cursorQuery(opts)));
  }

  /**
   * `GET /v2/token/{id}/holders?after=&limit=` (`explorer.rs:1681-1712`). An
   * unknown token answers `success: true` with zero holders, not an error.
   * @param {string} tokenId
   * @param {{after?: string, limit?: number}} [opts={}]
   * @returns {Promise<{success: true, token_id: string, holder_count: number, holders: Array<{address: string, balance: number}>,
   *   next_after: string|null}>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async getTokenHolders(tokenId, opts = {}) {
    return this._get(withQuery(`${this.#explorerUrl}/v2/token/${seg(tokenId, 'tokenId')}/holders`, this._cursorQuery(opts)));
  }

  /**
   * `GET /v2/rwa?after=&limit=` (`explorer.rs:1719-1740`).
   * @param {{after?: string, limit?: number}} [opts={}]
   * @returns {Promise<{success: true, count: number, tokens: object[], next_after: string|null}>} `RwaListRow` rows (`explorer.rs:216-236`).
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async getRwaTokens(opts = {}) {
    return this._get(withQuery(`${this.#explorerUrl}/v2/rwa`, this._cursorQuery(opts)));
  }

  /**
   * `GET /v2/rwa/{id}?after=&limit=` (`explorer.rs:1743-1805`); holders are
   * cursor-paged.
   * @param {string} tokenId
   * @param {{after?: string, limit?: number}} [opts={}]
   * @returns {Promise<{success: true, token: object, rwa: object, contract: object|null, holders: object[],
   *   holder_count: number, next_after: string|null}>}
   * @throws {RpcError} `<id> is not a registered RWA token`.
   * @throws {TypeError|RangeError|XerisError}
   */
  async getRwa(tokenId, opts = {}) {
    return this._get(withQuery(`${this.#explorerUrl}/v2/rwa/${seg(tokenId, 'tokenId')}`, this._cursorQuery(opts)));
  }

  /**
   * `GET /v2/contracts?after=&limit=` (`explorer.rs:1815-1840`); `type` is the
   * `ContractType` enum name.
   * @param {{after?: string, limit?: number}} [opts={}]
   * @returns {Promise<{success: true, count: number, contracts: Array<{contract_id: string, type: string, owner: string,
   *   is_active: boolean, created_slot: number}>, next_after: string|null}>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async getContractsV2(opts = {}) {
    return this._get(withQuery(`${this.#explorerUrl}/v2/contracts`, this._cursorQuery(opts)));
  }

  /**
   * `GET /v2/contract/{id}?page=&page_size=` (`explorer.rs:1843-1967`).
   * Model, Capability, Device and Heartbeat registries return a page object
   * (`page_size` clamped to 1..32, default 16); every other contract returns
   * `{success, contract}` capped at 256 KiB. Only supplied parameters are sent;
   * unknown keys and a `pageSize` above 32 throw instead of being ignored or
   * clamped.
   * @param {string} contractId
   * @param {{page?: number, pageSize?: number}} [opts={}]
   * @returns {Promise<object>}
   * @throws {RpcError} `Contract not found` or a response-limit error.
   * @throws {TypeError|RangeError|XerisError}
   */
  async getContractV2(contractId, opts = {}) {
    if (!isPlainObject(opts)) throw new TypeError(`opts: expected an object, got ${describe(opts)}`);
    onlyKeys(opts, ['page', 'pageSize'], 'opts', { page_size: 'pageSize' });
    const q = [];
    if (opts.page !== undefined) q.push(['page', pageInt(opts.page, 'opts.page', 1)]);
    if (opts.pageSize !== undefined) {
      q.push(['page_size', boundedInt(opts.pageSize, 'opts.pageSize', 1, REGISTRY_PAGE_ITEMS, 'explorer.rs:1855-1856')]);
    }
    return this._get(withQuery(`${this.#explorerUrl}/v2/contract/${seg(contractId, 'contractId')}`, q));
  }

  /**
   * `GET /v2/pools?after=&limit=` (`explorer.rs:1970-2120`): every Swap
   * contract. `price_a_in_b` / `price_b_in_a` are strings with 8 decimals;
   * `total_value_locked`, `volume_24h`, `apr` come from the node-local price
   * file and are `0.0` without one.
   * @param {{after?: string, limit?: number}} [opts={}]
   * @returns {Promise<{success: true, count: number, next_after: string|null, pools: object[]}>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async getPools(opts = {}) {
    return this._get(withQuery(`${this.#explorerUrl}/v2/pools`, this._cursorQuery(opts)));
  }

  // --------------------------------------------------------------------------
  // JSON-RPC methods, explorer port (blueprint §10.8; explorer.rs:1447-1565)
  // --------------------------------------------------------------------------

  /**
   * JSON-RPC `getBalance` (`explorer.rs:1447-1457`): native balance in
   * lamports; an unknown address is 0. The node sends a JSON integer; a
   * balance above 2^53-1 lamports (about 9,007,199 XRS) is returned as a
   * `bigint` with its exact value, anything smaller as a `number`. Both are
   * accepted by `lamportsToXrs`.
   * @param {string} address
   * @returns {Promise<number|bigint>} Lamports.
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async getBalance(address) {
    assertString(address, 'address');
    if (address.length === 0) throw new RangeError('address: must not be empty');
    const result = await this._jsonRpc('getBalance', [address]);
    if (!isPlainObject(result) || (typeof result.value !== 'number' && typeof result.value !== 'bigint')) {
      throw new RpcError(`JSON-RPC getBalance: unexpected result shape ${describe(result)}`, { code: 'rpc_json', route: 'JSON-RPC getBalance', body: result });
    }
    return result.value;
  }

  /**
   * JSON-RPC `getAccountInfo` (`explorer.rs:1459-1483`). The shape is the
   * node's own, not Solana's: `owner` is the literal `'system'`.
   * @param {string} address
   * @returns {Promise<{context: {slot: number}, value: {lamports: number|bigint, owner: 'system', executable: false,
   *   stake: number|bigint, isValidator: boolean}}>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async getAccountInfoRpc(address) {
    assertString(address, 'address');
    if (address.length === 0) throw new RangeError('address: must not be empty');
    return this._jsonRpc('getAccountInfo', [address]);
  }

  /**
   * JSON-RPC `getSlot` (`explorer.rs:1485`): slot of the newest in-memory block, 0 if none.
   * @returns {Promise<number>}
   * @throws {RpcError|XerisError}
   */
  async getSlot() {
    return this._expectNumber(await this._jsonRpc('getSlot'), 'getSlot');
  }

  /**
   * JSON-RPC `getBlockHeight` (`explorer.rs:1487`): `ledger.chain_height`.
   * @returns {Promise<number>}
   * @throws {RpcError|XerisError}
   */
  async getBlockHeight() {
    return this._expectNumber(await this._jsonRpc('getBlockHeight'), 'getBlockHeight');
  }

  /**
   * JSON-RPC `getBlock` (`explorer.rs:1503-1518`); `transactions` is a count,
   * `blockTime` is seconds. `null` when the slot is not in memory.
   * @param {number|bigint} slot
   * @returns {Promise<{blockhash: string, parentSlot: number, blockTime: number, blockHeight: number, transactions: number}|null>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async getBlockRpc(slot) {
    const result = await this._jsonRpc('getBlock', [normalizeU64(slot, 'slot')]);
    return result === undefined ? null : result;
  }

  /**
   * JSON-RPC `getTransaction` (`explorer.rs:1521-1537, 1573-1602`). `meta.fee`
   * is always `BASE_TX_FEE`; `meta.err` is `null`, `'OutcomeUnknown'`,
   * `'ExecutionFailed'` or `{InstructionError: [index, 'ExecutionFailed']}`.
   * `null` when not found in memory.
   * @param {string} signature
   * @returns {Promise<object|null>}
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async getTransactionRpc(signature) {
    assertString(signature, 'signature');
    if (signature.length === 0) throw new RangeError('signature: must not be empty');
    const result = await this._jsonRpc('getTransaction', [signature]);
    return result === undefined ? null : result;
  }

  /**
   * JSON-RPC `getSignaturesForAddress` (`explorer.rs:1540-1555, 1605-1629`):
   * one row per committed instruction from the receipt store, newest first;
   * `[]` on a node without a store. The store clamps `limit` to 1..200
   * (`tx_store.rs:57, 351`), so the SDK refuses a value outside that range;
   * the node ignores `before`/`until`.
   * @param {string} address
   * @param {number} [limit=20] `1..=SIGNATURES_MAX_LIMIT` (200); 20 is the node's own default (`explorer.rs:1545`).
   * @returns {Promise<object[]>} `{signature, slot, blockTime, err, from, to, amount, amount_xrs, tx_type, type}` rows.
   * @throws {TypeError|RangeError|RpcError|XerisError}
   */
  async getSignaturesForAddress(address, limit = 20) {
    assertString(address, 'address');
    if (address.length === 0) throw new RangeError('address: must not be empty');
    const result = await this._jsonRpc('getSignaturesForAddress', [address, { limit: boundedInt(limit, 'limit', 1, SIGNATURES_MAX_LIMIT, 'tx_store.rs:57, 351') }]);
    if (!Array.isArray(result)) {
      throw new RpcError(`JSON-RPC getSignaturesForAddress: unexpected result shape ${describe(result)}`, { code: 'rpc_json', route: 'JSON-RPC getSignaturesForAddress', body: result });
    }
    return result;
  }

  /**
   * JSON-RPC `getHealth` (`explorer.rs:1558`): the literal `'ok'`, unconditionally.
   * @returns {Promise<'ok'>}
   * @throws {RpcError|XerisError}
   */
  async getHealthRpc() {
    return this._jsonRpc('getHealth');
  }

  /**
   * JSON-RPC `getVersion` (`explorer.rs:1560-1563`): hard-coded literals,
   * not the crate version.
   * @returns {Promise<{'solana-core': string, xeriscoin: string}>}
   * @throws {RpcError|XerisError}
   */
  async getVersion() {
    return this._jsonRpc('getVersion');
  }

  /**
   * @private
   * @param {unknown} result
   * @param {string} method
   * @returns {number} Slot and height values; one above 2^53-1 (a `bigint` from
   *   `parseJson`, about 10^9 years of 4 s slots) is reported as malformed.
   * @throws {RpcError}
   */
  _expectNumber(result, method) {
    if (typeof result !== 'number') {
      throw new RpcError(`JSON-RPC ${method}: expected a number, got ${describe(result)}`, { code: 'rpc_json', route: `JSON-RPC ${method}`, body: result });
    }
    return result;
  }
}

module.exports = { XerisClient, checks };
