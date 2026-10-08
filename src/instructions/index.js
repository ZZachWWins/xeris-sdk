'use strict';

/**
 * @file Aggregates the four instruction modules into the public
 * `Instructions` namespace and publishes the variant tables of the node's
 * `enum XerisInstruction` (`token.rs:30-808`, 62 variants):
 *
 * - `src/instructions/core.js`  variants 0-17
 * - `src/instructions/ari.js`   variants 18-45
 * - `src/instructions/zkpq.js`  variants 46-53 and 61
 * - `src/instructions/deals.js` variants 54-60
 *
 * `Variant` maps each PascalCase Rust variant name to its index (the
 * declaration position, which bincode writes as `u32le` before the fields;
 * serde derive at `token.rs:29`), `VARIANT_NAMES[index]` gives the name back
 * and `BUILDER_NAMES[index]` names the camelCase builder in `Instructions`.
 * The three tables are derived from one list below, and the module verifies
 * at load time that the sibling modules supplied exactly the 62 expected
 * builders, so a missing, renamed or duplicated builder fails on `require`
 * rather than on the first call.
 *
 * Four variants are refused or skipped by the node: SubDelegate (22,
 * `ledger.rs:1445-1450, 6911-6914`), ZkPrivateTransfer (48,
 * `ledger.rs:8669-8685`), ZkIdentityProof (49, `ledger.rs:8687-8697`) and
 * PqSignedTransfer (52, `ledger.rs:8809-8828`). Their public builders throw
 * `FeatureDisabledError`; the wire encoders are collected here as `_raw` for
 * the wire-format tests only and are not re-exported from the package root.
 * `isDisabledVariant` lets `src/transaction.js` and the clients refuse those
 * indices again before anything is signed.
 */

const { core, encodeSwapCall, _raw: coreRaw } = require('./core');
const { ari, channelStateMessage, channelCloseMessage, _raw: ariRaw } = require('./ari');
const { zkpq, buildPqRotationMessage, _raw: zkpqRaw } = require('./zkpq');
const { deals, dealTermsHash, _raw: dealsRaw } = require('./deals');
const { INSTRUCTION_COUNT, DISABLED_VARIANTS } = require('../constants');
const { XerisError } = require('../errors');

// ---------------------------------------------------------------------------
// Variant tables
// ---------------------------------------------------------------------------

/**
 * One row per variant, in declaration order of `enum XerisInstruction`:
 * `[Rust variant name, camelCase builder name]`. The row's position is the
 * variant index; the comment gives the declaring line in `token.rs`.
 * @type {ReadonlyArray<readonly [string, string]>}
 */
const VARIANT_TABLE = Object.freeze([
  ['TokenMint', 'tokenMint'], // 0  token.rs:32
  ['TokenTransfer', 'tokenTransfer'], // 1  token.rs:38
  ['TokenBurn', 'tokenBurn'], // 2  token.rs:45
  ['TokenCreate', 'tokenCreate'], // 3  token.rs:51
  ['ContractCall', 'contractCall'], // 4  token.rs:60
  ['ContractDeploy', 'contractDeploy'], // 5  token.rs:66
  ['TokenCreateRWA', 'tokenCreateRWA'], // 6  token.rs:83
  ['RWAUpdateStatus', 'rwaUpdateStatus'], // 7  token.rs:108
  ['RWATransfer', 'rwaTransfer'], // 8  token.rs:118
  ['Stake', 'stake'], // 9  token.rs:132
  ['Unstake', 'unstake'], // 10 token.rs:139
  ['NativeTransfer', 'nativeTransfer'], // 11 token.rs:152
  ['ValidatorAttestation', 'validatorAttestation'], // 12 token.rs:166
  ['WrapXrs', 'wrapXrs'], // 13 token.rs:184
  ['UnwrapXrs', 'unwrapXrs'], // 14 token.rs:191
  ['RegisterAgent', 'registerAgent'], // 15 token.rs:204
  ['UpdateAgent', 'updateAgent'], // 16 token.rs:225
  ['AgentExecute', 'agentExecute'], // 17 token.rs:246
  ['CreateIdentity', 'createIdentity'], // 18 token.rs:268
  ['UpdateIdentity', 'updateIdentity'], // 19 token.rs:282
  ['AttestReputation', 'attestReputation'], // 20 token.rs:290
  ['AgentMessage', 'agentMessage'], // 21 token.rs:300
  ['SubDelegate', 'subDelegate'], // 22 token.rs:311 (disabled, ledger.rs:1445-1450)
  ['ConditionalOrder', 'conditionalOrder'], // 23 token.rs:325
  ['CancelConditionalOrder', 'cancelConditionalOrder'], // 24 token.rs:336
  ['RegisterOracle', 'registerOracle'], // 25 token.rs:343
  ['OracleSubmit', 'oracleSubmit'], // 26 token.rs:352
  ['HardwareAttest', 'hardwareAttest'], // 27 token.rs:361
  ['RegisterCapability', 'registerCapability'], // 28 token.rs:375
  ['UpdateCapability', 'updateCapability'], // 29 token.rs:396
  ['QueryCapabilities', 'queryCapabilities'], // 30 token.rs:414 (no-op in blocks, ledger.rs:7460-7464)
  ['PostTask', 'postTask'], // 31 token.rs:427
  ['ClaimTask', 'claimTask'], // 32 token.rs:456
  ['ResolveTask', 'resolveTask'], // 33 token.rs:463
  ['RegisterModel', 'registerModel'], // 34 token.rs:477
  ['UpdateModel', 'updateModel'], // 35 token.rs:489
  ['OpenDispute', 'openDispute'], // 36 token.rs:499
  ['ResolveDispute', 'resolveDispute'], // 37 token.rs:517
  ['SlashReport', 'slashReport'], // 38 token.rs:524
  ['CreateProposal', 'createProposal'], // 39 token.rs:533
  ['CastVote', 'castVote'], // 40 token.rs:544
  ['ExecuteProposal', 'executeProposal'], // 41 token.rs:550
  ['OpenChannel', 'openChannel'], // 42 token.rs:555
  ['CloseChannel', 'closeChannel'], // 43 token.rs:564
  ['ForceCloseChannel', 'forceCloseChannel'], // 44 token.rs:581
  ['AgentHeartbeat', 'agentHeartbeat'], // 45 token.rs:590
  ['ZkProofSubmit', 'zkProofSubmit'], // 46 token.rs:607
  ['ZkProofVerify', 'zkProofVerify'], // 47 token.rs:626
  ['ZkPrivateTransfer', 'zkPrivateTransfer'], // 48 token.rs:634 (disabled, ledger.rs:8669-8685)
  ['ZkIdentityProof', 'zkIdentityProof'], // 49 token.rs:654 (disabled, ledger.rs:8687-8697)
  ['PqKeyRegister', 'pqKeyRegister'], // 50 token.rs:680
  ['PqKeyRotate', 'pqKeyRotate'], // 51 token.rs:694
  ['PqSignedTransfer', 'pqSignedTransfer'], // 52 token.rs:709 (disabled, ledger.rs:8809-8828)
  ['PqAttest', 'pqAttest'], // 53 token.rs:722
  ['CreateDeal', 'createDeal'], // 54 token.rs:743
  ['AcceptDeal', 'acceptDeal'], // 55 token.rs:753
  ['ConfirmDeal', 'confirmDeal'], // 56 token.rs:762
  ['CancelDeal', 'cancelDeal'], // 57 token.rs:765
  ['DisputeDeal', 'disputeDeal'], // 58 token.rs:768
  ['SettleDeal', 'settleDeal'], // 59 token.rs:777
  ['ReclaimDeal', 'reclaimDeal'], // 60 token.rs:781
  ['ZkVkRegister', 'zkVkRegister'], // 61 token.rs:795
]);

/**
 * PascalCase Rust variant name for each index, `VARIANT_NAMES[index]`.
 * @type {ReadonlyArray<string>}
 */
const VARIANT_NAMES = Object.freeze(VARIANT_TABLE.map((row) => row[0]));

/**
 * camelCase builder name in `Instructions` for each index,
 * `BUILDER_NAMES[index]`.
 * @type {ReadonlyArray<string>}
 */
const BUILDER_NAMES = Object.freeze(VARIANT_TABLE.map((row) => row[1]));

/**
 * Variant index by PascalCase Rust name, e.g. `Variant.NativeTransfer === 11`,
 * `Variant.ZkVkRegister === 61`. 62 entries in declaration order of
 * `enum XerisInstruction` (`token.rs:30-808`).
 * @type {Readonly<Record<string, number>>}
 */
const Variant = Object.freeze(
  Object.fromEntries(VARIANT_NAMES.map((name, index) => [name, index])),
);

// ---------------------------------------------------------------------------
// Builder namespace
// ---------------------------------------------------------------------------

/**
 * Every instruction builder, keyed by camelCase name: `Instructions.<name>(...)`
 * returns the encoded instruction as a `Buffer`. Parameters are positional,
 * named after the Rust fields in declaration order, with strict arity (an
 * `EncodingError` with `code: 'arity'` otherwise). `Option<T>` fields take
 * `null`/`undefined` for `None`. u64 fields take a safe-integer `number` or a
 * `bigint`. `subDelegate`, `zkPrivateTransfer`, `zkIdentityProof` and
 * `pqSignedTransfer` throw `FeatureDisabledError` without reading their
 * arguments; `queryCapabilities` encodes but is a no-op in blocks
 * (`ledger.rs:7460-7464`).
 * @type {Readonly<Record<string, Function>>}
 */
const Instructions = Object.freeze({ ...core, ...ari, ...zkpq, ...deals });

/**
 * Wire encoders for the four variants whose public builder throws
 * `FeatureDisabledError`: `subDelegate` (22), `zkPrivateTransfer` (48),
 * `zkIdentityProof` (49), `pqSignedTransfer` (52). They exist so the
 * reference vectors can be asserted; `src/transaction.js` and
 * `XerisClient.sendInstruction` refuse the indices, so the bytes cannot be
 * submitted through this SDK. Not re-exported from the package root.
 * @type {Readonly<{subDelegate: Function, zkPrivateTransfer: Function, zkIdentityProof: Function, pqSignedTransfer: Function}>}
 */
const _raw = Object.freeze({
  subDelegate: ariRaw.subDelegate,
  zkPrivateTransfer: zkpqRaw.zkPrivateTransfer,
  zkIdentityProof: zkpqRaw.zkIdentityProof,
  pqSignedTransfer: zkpqRaw.pqSignedTransfer,
});

// ---------------------------------------------------------------------------
// Load-time consistency check
// ---------------------------------------------------------------------------

/**
 * Verifies that the tables above and the builders the sibling modules
 * exported describe the same 62 variants. Runs once on `require`.
 * @returns {void}
 * @throws {XerisError} a table or a sibling module is inconsistent
 */
function assertTablesConsistent() {
  const fail = (what) => {
    throw new XerisError(`src/instructions/index.js: ${what}`, {
      details: { expected: INSTRUCTION_COUNT },
    });
  };
  if (VARIANT_TABLE.length !== INSTRUCTION_COUNT) {
    fail(`variant table has ${VARIANT_TABLE.length} rows, expected ${INSTRUCTION_COUNT}`);
  }
  if (new Set(VARIANT_NAMES).size !== INSTRUCTION_COUNT) fail('duplicate variant name in the table');
  if (new Set(BUILDER_NAMES).size !== INSTRUCTION_COUNT) fail('duplicate builder name in the table');
  const supplied = [core, ari, zkpq, deals].reduce((n, mod) => n + Object.keys(mod).length, 0);
  if (supplied !== INSTRUCTION_COUNT) {
    fail(`sibling modules supplied ${supplied} builders, expected ${INSTRUCTION_COUNT}`);
  }
  const keys = Object.keys(Instructions);
  if (keys.length !== INSTRUCTION_COUNT) {
    fail(`Instructions has ${keys.length} keys after merging, expected ${INSTRUCTION_COUNT} (a builder name is shared by two modules)`);
  }
  for (let index = 0; index < INSTRUCTION_COUNT; index += 1) {
    const name = BUILDER_NAMES[index];
    if (typeof Instructions[name] !== 'function') {
      fail(`no builder named '${name}' for variant ${index} (${VARIANT_NAMES[index]})`);
    }
  }
  for (const index of DISABLED_VARIANTS) {
    const name = BUILDER_NAMES[index];
    if (typeof _raw[name] !== 'function') {
      fail(`no raw encoder '_raw.${name}' for disabled variant ${index}`);
    }
  }
  const rawCount = [coreRaw, ariRaw, zkpqRaw, dealsRaw].reduce((n, mod) => n + Object.keys(mod).length, 0);
  if (rawCount !== DISABLED_VARIANTS.length) {
    fail(`sibling modules supplied ${rawCount} raw encoders, expected ${DISABLED_VARIANTS.length}`);
  }
}

assertTablesConsistent();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * True when `index` is one of the variants the node refuses at ingress or
 * skips in blocks (`DISABLED_VARIANTS` = 22, 48, 49, 52).
 * @param {number} index variant index, e.g. from `readVariant(data)`
 * @returns {boolean}
 * @throws {TypeError} `index` is not a number (a `bigint` or string index would silently compare unequal)
 * @see ledger.rs:1445-1450
 * @see ledger.rs:8669-8685
 * @see ledger.rs:8687-8697
 * @see ledger.rs:8809-8828
 */
function isDisabledVariant(index) {
  if (typeof index !== 'number') {
    throw new TypeError(`isDisabledVariant: expected a variant index (number), got ${index === null ? 'null' : typeof index}`);
  }
  return DISABLED_VARIANTS.includes(index);
}

/**
 * True for a plain object (`{}`), false for `null`, arrays, typed arrays and
 * primitives.
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

/**
 * Describes a value for an error message without serialising it.
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
  if (value === null) return 'null';
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'undefined') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

/**
 * Reads a string parameter of a plan.
 * @param {object} params `plan.params`
 * @param {string} key parameter name as the node emits it
 * @returns {string}
 * @throws {TypeError} missing or not a string
 */
function planString(params, key) {
  const value = params[key];
  if (typeof value !== 'string') {
    throw new TypeError(`fromPlan: params.${key} must be a string, got ${describe(value)}`);
  }
  return value;
}

/**
 * Reads a u64 parameter of a plan. The node serialises lamports as a JSON
 * number (`network.rs:5399, 5409`), so a parsed value above 2^53-1 has
 * already lost precision and is refused; a caller that parsed the body with a
 * `bigint` reviver may pass a `bigint`, which the builder range-checks.
 * @param {object} params `plan.params`
 * @param {string} key parameter name as the node emits it
 * @returns {number|bigint}
 * @throws {TypeError} missing or not a number/bigint
 * @throws {RangeError} a `number` that is not a safe integer
 */
function planU64(params, key) {
  const value = params[key];
  if (typeof value === 'bigint') return value;
  if (typeof value !== 'number') {
    throw new TypeError(`fromPlan: params.${key} must be a number, got ${describe(value)}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(
      `fromPlan: params.${key} is not a safe integer (${value}); a JSON number above 2^53-1 has lost precision and cannot be encoded exactly`,
    );
  }
  return value;
}

/**
 * Converts the JSON byte array the node emits for a swap plan
 * (`serde_json` serialises `Vec<u8>` as an array of numbers;
 * `network.rs:5455-5465`) into a `Buffer`, refusing anything that is not an
 * integer `0..=255` (`Buffer.from([256])` would wrap silently).
 * @param {unknown[]} values `params.args`
 * @returns {Buffer}
 * @throws {TypeError} an element is not a number
 * @throws {RangeError} an element is not an integer in `0..=255`
 */
function planByteArray(values) {
  const bytes = Buffer.alloc(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (typeof v !== 'number') {
      throw new TypeError(`fromPlan: params.args[${i}] must be a number, got ${describe(v)}`);
    }
    if (!Number.isInteger(v) || v < 0 || v > 255) {
      throw new RangeError(`fromPlan: params.args[${i}] must be an integer 0..=255, got ${v}`);
    }
    bytes[i] = v;
  }
  return bytes;
}

/**
 * Converts a `POST /agent/plan` response (`network.rs:5386-5577`;
 * `XerisClient.agentPlan` and the `plan*` helpers) into encoded instruction
 * bytes by calling the builder the plan names:
 *
 * | `variant_index` | action(s)                | builder call |
 * |---|---|---|
 * | 11 | `transfer`, `send`     | `nativeTransfer(params.from, params.to, params.amount)` (`network.rs:5407-5409`) |
 * | 4  | `swap`                 | `contractCall(params.contract_id, params.method, Buffer(params.args))` with `params.args` a 16-element byte array (`network.rs:5455-5465`) |
 * | 4  | `buy_launchpad`, `buy` | `contractCall(params.contract_id, params.method, params.args)` with `params.args` an object (`network.rs:5512-5520`) |
 * | 9  | `stake`                | `stake(params.pubkey, params.amount)` (`network.rs:5540-5542`) |
 * | 13 | `wrap`                 | `wrapXrs(params.amount)` (`network.rs:5552-5554`) |
 * | 14 | `unwrap`               | `unwrapXrs(params.amount)` (`network.rs:5563-5565`) |
 *
 * `params.amount` is the lamport value the node computed from `amount_xrs`
 * with `(amount_xrs * 1e9) as u64` (`network.rs:5399, 5537, 5549, 5560`),
 * so it may differ from an exact decimal conversion of the requested XRS;
 * compare it with `xrsToLamports` before signing when exactness matters. The
 * node's error replies (`{"error": ...}`, no `variant_index`) are raised as
 * `RpcError` by the client before reaching this function. The resulting
 * bytes are not checked against node business rules (for example that a
 * swap byte array is exactly 16 bytes, `contract_call_args`,
 * `ledger.rs:2368-2372`); the client wrappers do that.
 * @param {object} plan the parsed JSON body returned by `POST /agent/plan`
 * @returns {Buffer} encoded instruction
 * @throws {TypeError} `plan` or `plan.params` is not an object, `variant_index` is not one of 11, 4, 9, 13, 14, `variant_name` (when present) does not match it, or a parameter has the wrong type
 * @throws {RangeError} a numeric parameter is not a safe integer or a byte is outside `0..=255`
 * @see network.rs:5386-5577
 */
function fromPlan(plan) {
  if (!isPlainObject(plan)) {
    throw new TypeError(`fromPlan: expected the object returned by POST /agent/plan, got ${describe(plan)}`);
  }
  const index = plan.variant_index;
  if (typeof index !== 'number' || !Number.isInteger(index)) {
    throw new TypeError(`fromPlan: plan.variant_index must be an integer, got ${describe(index)}`);
  }
  if (plan.variant_name !== undefined && plan.variant_name !== VARIANT_NAMES[index]) {
    throw new TypeError(
      `fromPlan: plan.variant_name ${describe(plan.variant_name)} does not match variant_index ${index} (${VARIANT_NAMES[index] ?? 'unknown'})`,
    );
  }
  const params = plan.params;
  if (!isPlainObject(params)) {
    throw new TypeError(`fromPlan: plan.params must be an object, got ${describe(params)}`);
  }
  switch (index) {
    case Variant.NativeTransfer:
      return core.nativeTransfer(planString(params, 'from'), planString(params, 'to'), planU64(params, 'amount'));
    case Variant.ContractCall: {
      const contractId = planString(params, 'contract_id');
      const method = planString(params, 'method');
      const args = params.args;
      if (Array.isArray(args)) return core.contractCall(contractId, method, planByteArray(args));
      if (isPlainObject(args)) return core.contractCall(contractId, method, args);
      throw new TypeError(
        `fromPlan: params.args must be a byte array (swap) or an object (buy_launchpad), got ${describe(args)}`,
      );
    }
    case Variant.Stake:
      return core.stake(planString(params, 'pubkey'), planU64(params, 'amount'));
    case Variant.WrapXrs:
      return core.wrapXrs(planU64(params, 'amount'));
    case Variant.UnwrapXrs:
      return core.unwrapXrs(planU64(params, 'amount'));
    default:
      throw new TypeError(
        `fromPlan: unsupported plan.variant_index ${index}; POST /agent/plan produces 11 (NativeTransfer), 4 (ContractCall), 9 (Stake), 13 (WrapXrs) or 14 (UnwrapXrs)`,
      );
  }
}

module.exports = {
  Instructions,
  Variant,
  VARIANT_NAMES,
  BUILDER_NAMES,
  _raw,
  isDisabledVariant,
  fromPlan,
  encodeSwapCall,
  dealTermsHash,
  buildPqRotationMessage,
  channelStateMessage,
  channelCloseMessage,
};
