'use strict';

/**
 * @file `TestVectors`: twenty reference byte vectors for the instruction
 * builders plus seven primitive-level checks, so an installed copy of the SDK
 * can confirm that `Instructions.*` still produce the bytes the node decodes.
 *
 * Every `expectedHex` below was produced by the reference encoder
 * (`scratchpad/tools/xeris_bincode.py`: bincode 1.3.3 default options, schema
 * parsed from `token.rs`) whose 91 vectors were verified byte-identical against
 * the real `bincode` 1.3.3 crate. The five classic entries (`nativeTransfer`,
 * `stake`, `tokenMint`, `tokenTransfer`, `wrapXrs`) are the `sdk-test-js`
 * vectors of `test/vectors.json`, unchanged since 4.x.
 *
 * Wire layout (`token.rs:29-808`): `u32le(variant index)` then the fields in
 * declaration order; `String` and `Vec<T>` carry a `u64le` length prefix,
 * `Option<T>` a `0x00`/`0x01` tag, `bool` one byte, `[u8; 32]` no prefix
 * (`token.rs:753-759`, AcceptDeal). The node decodes `instruction.data` with
 * `bincode::deserialize::<XerisInstruction>` at ingress (`network.rs:187-192`).
 *
 * `hex` is computed by calling the builder when the entry is requested;
 * `expectedHex` is the embedded reference. Only `printAll()` writes to stdout.
 * Nothing here touches the network.
 */

const { Buffer } = require('buffer');
const { Instructions, Variant, encodeSwapCall, dealTermsHash } = require('./instructions/index.js');

/**
 * One reference vector.
 * @typedef {object} Vector
 * @property {string} name         Entry name (the `TestVectors` method that produced it).
 * @property {string} variant      PascalCase `XerisInstruction` variant name.
 * @property {number} index        Variant index (`Variant[variant]`, `token.rs` declaration order).
 * @property {string} description  What the call encodes.
 * @property {unknown[]} inputs    Arguments passed to the builder, in order.
 * @property {string} hex          Bytes the installed builder produced, lowercase hex.
 * @property {Buffer} bytes        The same bytes.
 * @property {number} length       `bytes.length`.
 * @property {string} expectedHex  Reference bytes from the arbiter encoder, lowercase hex.
 */

/**
 * One failed comparison reported by `verify()`.
 * @typedef {object} VectorFailure
 * @property {string} name         Entry name, or the primitive check's label.
 * @property {string} expectedHex  Reference bytes.
 * @property {string|null} hex     Bytes produced, or `null` when the builder threw.
 * @property {string} [error]      The builder's error message when it threw.
 */

/**
 * @typedef {object} Spec
 * @property {string} name
 * @property {string} variant
 * @property {number} index
 * @property {string} description
 * @property {() => unknown[]} args          Builds the argument list (fresh Buffers each call).
 * @property {(...args: unknown[]) => Buffer} builder
 * @property {string} expectedHex
 */

/** @type {readonly Spec[]} In blueprint §13 table order. */
const SPECS = Object.freeze([
  {
    name: 'nativeTransfer',
    variant: 'NativeTransfer',
    index: 11,
    description: 'NativeTransfer: 5 XRS (5_000_000_000 lamports) from "Alice" to "Bob"',
    args: () => ['Alice', 'Bob', 5_000_000_000],
    builder: (...a) => Instructions.nativeTransfer(...a),
    expectedHex: '0b0000000500000000000000416c6963650300000000000000426f6200f2052a01000000',
  },
  {
    name: 'stake',
    variant: 'Stake',
    index: 9,
    description: 'Stake: 1,000 XRS (1_000_000_000_000 lamports) for "TestVal"',
    args: () => ['TestVal', 1_000_000_000_000],
    builder: (...a) => Instructions.stake(...a),
    expectedHex: '0900000007000000000000005465737456616c0010a5d4e8000000',
  },
  {
    name: 'tokenMint',
    variant: 'TokenMint',
    index: 0,
    description: 'TokenMint: 1_000_000_000 base units of "xUSDC" to "Bob"',
    args: () => ['xUSDC', 'Bob', 1_000_000_000],
    builder: (...a) => Instructions.tokenMint(...a),
    expectedHex: '00000000050000000000000078555344430300000000000000426f6200ca9a3b00000000',
  },
  {
    name: 'tokenTransfer',
    variant: 'TokenTransfer',
    index: 1,
    description: 'TokenTransfer: 500_000_000 base units of "xUSDC" from "Alice" to "Bob"',
    args: () => ['xUSDC', 'Alice', 'Bob', 500_000_000],
    builder: (...a) => Instructions.tokenTransfer(...a),
    expectedHex: '01000000050000000000000078555344430500000000000000416c6963650300000000000000426f620065cd1d00000000',
  },
  {
    name: 'wrapXrs',
    variant: 'WrapXrs',
    index: 13,
    description: 'WrapXrs: 10 XRS (10_000_000_000 lamports)',
    args: () => [10_000_000_000],
    builder: (...a) => Instructions.wrapXrs(...a),
    expectedHex: '0d00000000e40b5402000000',
  },
  {
    name: 'createDeal',
    variant: 'CreateDeal',
    index: 54,
    description: 'CreateDeal: "deal-1" with "Bob", 2 XRS escrow, terms "ship 1 widget"',
    args: () => ['deal-1', 'Bob', 2_000_000_000, 'ship 1 widget'],
    builder: (...a) => Instructions.createDeal(...a),
    expectedHex: '3600000006000000000000006465616c2d310300000000000000426f6200943577000000000d0000000000000073686970203120776964676574',
  },
  {
    name: 'acceptDeal',
    variant: 'AcceptDeal',
    index: 55,
    description: 'AcceptDeal: "deal-1" instance 1, party A "Alice", 2 XRS, sha256("ship 1 widget") as [u8; 32]',
    args: () => ['deal-1', 1, 'Alice', 2_000_000_000, dealTermsHash('ship 1 widget')],
    builder: (...a) => Instructions.acceptDeal(...a),
    expectedHex: '3700000006000000000000006465616c2d3101000000000000000500000000000000416c6963650094357700000000734c5fd1cd9fd0bb047abb8c90edf73dd1cc4584be43973dd64c92a8402fa65d',
  },
  {
    name: 'confirmDeal',
    variant: 'ConfirmDeal',
    index: 56,
    description: 'ConfirmDeal: "deal-1" instance 1',
    args: () => ['deal-1', 1],
    builder: (...a) => Instructions.confirmDeal(...a),
    expectedHex: '3800000006000000000000006465616c2d310100000000000000',
  },
  {
    name: 'disputeDeal',
    variant: 'DisputeDeal',
    index: 58,
    description: 'DisputeDeal: "deal-1" instance 1, reason "late", 1 XRS bond',
    args: () => ['deal-1', 1, 'late', 1_000_000_000],
    builder: (...a) => Instructions.disputeDeal(...a),
    expectedHex: '3a00000006000000000000006465616c2d31010000000000000004000000000000006c61746500ca9a3b00000000',
  },
  {
    name: 'zkVkRegister',
    variant: 'ZkVkRegister',
    index: 61,
    description: 'ZkVkRegister: vk "vk1", base64 "AAAA", claim "transfer", description "test"',
    args: () => ['vk1', 'AAAA', 'transfer', 'test'],
    builder: (...a) => Instructions.zkVkRegister(...a),
    expectedHex: '3d0000000300000000000000766b3104000000000000004141414108000000000000007472616e73666572040000000000000074657374',
  },
  {
    name: 'agentExecuteNativeTransfer',
    variant: 'AgentExecute',
    index: 17,
    description: 'AgentExecute: owner "Alice" wrapping NativeTransfer("Alice", "Bob", 5 XRS) as Vec<u8>',
    args: () => ['Alice', Instructions.nativeTransfer('Alice', 'Bob', 5_000_000_000)],
    builder: (...a) => Instructions.agentExecute(...a),
    expectedHex: '110000000500000000000000416c69636524000000000000000b0000000500000000000000416c6963650300000000000000426f6200f2052a01000000',
  },
  {
    name: 'contractCallSwap',
    variant: 'ContractCall',
    index: 4,
    description: 'ContractCall: "pool1" swap_a_to_b with 16 raw arg bytes u64le(10_000_000) || u64le(1) (contracts.rs:2419-2441)',
    args: () => ['pool1', 'swap_a_to_b', 10_000_000, 1],
    builder: (...a) => encodeSwapCall(...a),
    expectedHex: '040000000500000000000000706f6f6c310b00000000000000737761705f615f746f5f62100000000000000080969800000000000100000000000000',
  },
  {
    name: 'openDispute',
    variant: 'OpenDispute',
    index: 36,
    description: 'OpenDispute: 7 fields (token.rs:499-509) with defendant "Bob" and empty evidence, 1 XRS bond',
    args: () => ['d1', 'task', 't1', 'Bob', 'late', '', 1_000_000_000],
    builder: (...a) => Instructions.openDispute(...a),
    expectedHex: '240000000200000000000000643104000000000000007461736b020000000000000074310300000000000000426f6204000000000000006c617465000000000000000000ca9a3b00000000',
  },
  {
    name: 'forceCloseChannel',
    variant: 'ForceCloseChannel',
    index: 44,
    description: 'ForceCloseChannel: 5 fields (token.rs:581-587), state_sequence 0 with an empty counterparty signature',
    args: () => ['ch1', 100, 200, 0, Buffer.alloc(0)],
    builder: (...a) => Instructions.forceCloseChannel(...a),
    expectedHex: '2c00000003000000000000006368316400000000000000c80000000000000000000000000000000000000000000000',
  },
  {
    name: 'updateAgent',
    variant: 'UpdateAgent',
    index: 16,
    description: 'UpdateAgent: Option fields None, Some(7), None, Some(["NativeTransfer","WrapXrs"]), None; revoked true',
    args: () => ['AgentKey', null, 7, null, ['NativeTransfer', 'WrapXrs'], null, true],
    builder: (...a) => Instructions.updateAgent(...a),
    expectedHex: '1000000008000000000000004167656e744b657900010700000000000000000102000000000000000e000000000000004e61746976655472616e736665720700000000000000577261705872730001',
  },
  {
    name: 'registerAgent',
    variant: 'RegisterAgent',
    index: 15,
    description: 'RegisterAgent: "TestAgent"/"pubkey123", 1000 per tx, 2000 daily, ["pool_a"], ["ContractCall"], no expiry',
    args: () => ['TestAgent', 'pubkey123', 1000, 2000, ['pool_a'], ['ContractCall'], 0],
    builder: (...a) => Instructions.registerAgent(...a),
    expectedHex: '0f0000000900000000000000546573744167656e7409000000000000007075626b6579313233e803000000000000d00700000000000001000000000000000600000000000000706f6f6c5f6101000000000000000c00000000000000436f6e747261637443616c6c0000000000000000',
  },
  {
    name: 'rwaUpdateStatus',
    variant: 'RWAUpdateStatus',
    index: 7,
    description: 'RWAUpdateStatus: token "t" to "active", new_valuation Some(5), hash and uri None',
    args: () => ['t', 'active', 5, null, null],
    builder: (...a) => Instructions.rwaUpdateStatus(...a),
    expectedHex: '0700000001000000000000007406000000000000006163746976650105000000000000000000',
  },
  {
    name: 'agentHeartbeat',
    variant: 'AgentHeartbeat',
    index: 45,
    description: 'AgentHeartbeat: identity "Alice", empty model hash, active_tasks u32 1, available_capacity u32 9, status "ok"',
    args: () => ['Alice', '', 1, 9, 'ok'],
    builder: (...a) => Instructions.agentHeartbeat(...a),
    expectedHex: '2d0000000500000000000000416c6963650000000000000000010000000900000002000000000000006f6b',
  },
  {
    name: 'postTask',
    variant: 'PostTask',
    index: 31,
    description: 'PostTask: 12 fields, min_reputation u8 0, reward 1 XRS, max_claimants u32 1, verification "poster_confirm"',
    args: () => ['t1', 'T', '', '', [], 0, 1_000_000_000, 0, 1, 'poster_confirm', '', 0],
    builder: (...a) => Instructions.postTask(...a),
    expectedHex: '1f000000020000000000000074310100000000000000540000000000000000000000000000000000000000000000000000ca9a3b000000000000000000000000010000000e00000000000000706f737465725f636f6e6669726d00000000000000000000000000000000',
  },
  {
    name: 'validatorAttestation',
    variant: 'ValidatorAttestation',
    index: 12,
    description: 'ValidatorAttestation: validator "Alice", slot 42, 32-byte hash prefix 0x00..0x1f as Vec<u8>',
    args: () => ['Alice', 42, Buffer.from(Array.from({ length: 32 }, (_, i) => i))],
    builder: (...a) => Instructions.validatorAttestation(...a),
    expectedHex: '0c0000000500000000000000416c6963652a000000000000002000000000000000000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  },
]);

/**
 * Primitive-level checks run by `verify()` only (not entries of `all()`).
 * Each slices a known byte range out of a public builder's output, so the
 * bincode primitives are exercised exactly as callers reach them. Offsets
 * follow the wire layout of `UpdateAgent` (`token.rs:225-244`),
 * `UpdateCapability` (`token.rs:396-412`) and `PqKeyRegister`
 * (`token.rs:680-692`); the expected slices were produced by the arbiter
 * encoder.
 *
 * @typedef {object} PrimitiveCheck
 * @property {string} name
 * @property {() => Buffer} build
 * @property {number} start         Slice start (inclusive).
 * @property {number} end           Slice end (exclusive).
 * @property {string} expectedHex
 * @property {number} [totalLength] When set, the whole buffer must have this length.
 */

/** UpdateAgent('', None, Some(7), None, Some(['hi']), None, false): 44 bytes. */
const updateAgentSomeHi = () => Instructions.updateAgent('', null, 7, null, ['hi'], null, false);
/** UpdateAgent('', None, None, Some([]), None, None, false): 26 bytes. */
const updateAgentEmptyVec = () => Instructions.updateAgent('', null, null, [], null, null, false);
/** UpdateCapability('', '', None, None, None, Some(0u32), None, false): 30 bytes. */
const updateCapabilitySomeZero = () => Instructions.updateCapability('', '', null, null, null, 0, null, false);
/** PqKeyRegister('Alice', [0xab; 1952], 'dilithium3', 3): 1996 bytes. */
const pqKeyRegisterAb = () => Instructions.pqKeyRegister('Alice', Buffer.alloc(1952, 0xab), 'dilithium3', 3);

/** @type {readonly PrimitiveCheck[]} */
const PRIMITIVES = Object.freeze([
  // u32le(16) ‖ str('') [4..12] ‖ None [12] ‖ Some(7) [13..22] ‖ None [22] ‖ 0x01 [23] ‖ vec ['hi'] [24..42] ‖ None [42] ‖ bool [43]
  { name: 'Option<u64> None', build: updateAgentSomeHi, start: 12, end: 13, expectedHex: '00', totalLength: 44 },
  { name: 'Option<u64> Some(7)', build: updateAgentSomeHi, start: 13, end: 22, expectedHex: '010700000000000000', totalLength: 44 },
  { name: 'Vec<String> ["hi"]', build: updateAgentSomeHi, start: 24, end: 42, expectedHex: '010000000000000002000000000000006869', totalLength: 44 },
  // u32le(16) ‖ str('') [4..12] ‖ None [12] ‖ None [13] ‖ 0x01 [14] ‖ vec [] [15..23] ‖ None [23] ‖ None [24] ‖ bool [25]
  { name: 'Vec<String> []', build: updateAgentEmptyVec, start: 15, end: 23, expectedHex: '0000000000000000', totalLength: 26 },
  // u32le(29) ‖ str('') [4..12] ‖ str('') [12..20] ‖ None [20] ‖ None [21] ‖ None [22] ‖ Some(0u32) [23..28] ‖ None [28] ‖ bool [29]
  { name: 'Option<u32> Some(0)', build: updateCapabilitySomeZero, start: 23, end: 28, expectedHex: '0100000000', totalLength: 30 },
  // u32le(50) ‖ str('Alice') [4..17] ‖ u64le(1952) [17..25] ‖ 1952 × 0xab [25..1977] ‖ str('dilithium3') [1977..1995] ‖ u8 3 [1995]
  { name: 'PqKeyRegister head (first 40 of 1996 bytes)', build: pqKeyRegisterAb, start: 0, end: 40, expectedHex: '320000000500000000000000416c696365a007000000000000ababababababababababababababab', totalLength: 1996 },
  { name: 'PqKeyRegister tail (last 20 of 1996 bytes)', build: pqKeyRegisterAb, start: 1976, end: 1996, expectedHex: 'ab0a0000000000000064696c69746869756d3303', totalLength: 1996 },
]);

/**
 * Builds the vector for one spec by calling its builder now.
 * @param {Spec} spec
 * @returns {Vector}
 * @throws Whatever the builder throws (missing builder, encoding failure).
 */
function makeVector(spec) {
  const inputs = spec.args();
  const bytes = spec.builder(...inputs);
  return {
    name: spec.name,
    variant: spec.variant,
    index: spec.index,
    description: spec.description,
    inputs,
    hex: bytes.toString('hex'),
    bytes,
    length: bytes.length,
    expectedHex: spec.expectedHex,
  };
}

/**
 * Returns the twenty vectors in table order, computing each builder's bytes now.
 * @returns {Vector[]}
 * @throws Whatever a builder throws.
 */
function all() {
  return SPECS.map(makeVector);
}

/**
 * Compares every entry and every primitive check against its reference bytes.
 * Never throws: a builder that throws is reported as a failure with `hex: null`.
 * @returns {{ ok: boolean, failures: VectorFailure[] }}
 */
function verify() {
  /** @type {VectorFailure[]} */
  const failures = [];

  for (const spec of SPECS) {
    let v;
    try {
      v = makeVector(spec);
    } catch (err) {
      failures.push({ name: spec.name, expectedHex: spec.expectedHex, hex: null, error: errorMessage(err) });
      continue;
    }
    const indexOk = Variant[spec.variant] === spec.index;
    if (v.hex !== spec.expectedHex || v.length * 2 !== spec.expectedHex.length || !indexOk) {
      const failure = { name: spec.name, expectedHex: spec.expectedHex, hex: v.hex };
      if (!indexOk) failure.error = `Variant.${spec.variant} is ${Variant[spec.variant]}, expected ${spec.index}`;
      failures.push(failure);
    }
  }

  for (const p of PRIMITIVES) {
    let buf;
    try {
      buf = p.build();
    } catch (err) {
      failures.push({ name: p.name, expectedHex: p.expectedHex, hex: null, error: errorMessage(err) });
      continue;
    }
    const hex = buf.subarray(p.start, p.end).toString('hex');
    const lengthOk = p.totalLength === undefined || buf.length === p.totalLength;
    if (hex !== p.expectedHex || !lengthOk) {
      const failure = { name: p.name, expectedHex: p.expectedHex, hex };
      if (!lengthOk) failure.error = `length ${buf.length}, expected ${p.totalLength}`;
      failures.push(failure);
    }
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Prints every entry (name, variant, length, hex) and a `verify()` summary to
 * stdout. This is the only place in the SDK that writes to the console. The
 * process exit code is not changed; read `verify().ok` for a pass/fail signal.
 * @returns {void}
 */
function printAll() {
  for (const spec of SPECS) {
    let line;
    try {
      const v = makeVector(spec);
      const mark = v.hex === spec.expectedHex ? 'ok ' : 'XX ';
      line = `${mark}${v.name}  ${v.variant} (${v.index})  ${v.length} bytes\n    ${v.description}\n    hex: ${v.hex}`;
      if (v.hex !== spec.expectedHex) line += `\n    expected: ${spec.expectedHex}`;
    } catch (err) {
      line = `XX ${spec.name}  ${spec.variant} (${spec.index})  threw: ${errorMessage(err)}\n    expected: ${spec.expectedHex}`;
    }
    console.log(line);
  }
  const result = verify();
  if (result.ok) {
    console.log(`\nverify(): ok — ${SPECS.length} vectors and ${PRIMITIVES.length} primitive checks match the reference bytes`);
  } else {
    console.log(`\nverify(): FAILED — ${result.failures.length} of ${SPECS.length + PRIMITIVES.length} checks differ from the reference bytes`);
    for (const f of result.failures) {
      console.log(`  ${f.name}\n    expected: ${f.expectedHex}\n    got:      ${f.hex === null ? `(threw) ${f.error}` : f.hex}${f.hex !== null && f.error ? `\n    note:     ${f.error}` : ''}`);
    }
  }
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorMessage(err) {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * Frozen namespace: one method per entry (returns a `Vector`), plus
 * `all()`, `verify()` and `printAll()`.
 */
const TestVectors = Object.freeze({
  /** @returns {Vector} NativeTransfer("Alice", "Bob", 5_000_000_000). */
  nativeTransfer: () => makeVector(SPECS[0]),
  /** @returns {Vector} Stake("TestVal", 1_000_000_000_000). */
  stake: () => makeVector(SPECS[1]),
  /** @returns {Vector} TokenMint("xUSDC", "Bob", 1_000_000_000). */
  tokenMint: () => makeVector(SPECS[2]),
  /** @returns {Vector} TokenTransfer("xUSDC", "Alice", "Bob", 500_000_000). */
  tokenTransfer: () => makeVector(SPECS[3]),
  /** @returns {Vector} WrapXrs(10_000_000_000). */
  wrapXrs: () => makeVector(SPECS[4]),
  /** @returns {Vector} CreateDeal("deal-1", "Bob", 2_000_000_000, "ship 1 widget"). */
  createDeal: () => makeVector(SPECS[5]),
  /** @returns {Vector} AcceptDeal("deal-1", 1, "Alice", 2_000_000_000, dealTermsHash("ship 1 widget")). */
  acceptDeal: () => makeVector(SPECS[6]),
  /** @returns {Vector} ConfirmDeal("deal-1", 1). */
  confirmDeal: () => makeVector(SPECS[7]),
  /** @returns {Vector} DisputeDeal("deal-1", 1, "late", 1_000_000_000). */
  disputeDeal: () => makeVector(SPECS[8]),
  /** @returns {Vector} ZkVkRegister("vk1", "AAAA", "transfer", "test"). */
  zkVkRegister: () => makeVector(SPECS[9]),
  /** @returns {Vector} AgentExecute("Alice", NativeTransfer("Alice", "Bob", 5_000_000_000)). */
  agentExecuteNativeTransfer: () => makeVector(SPECS[10]),
  /** @returns {Vector} encodeSwapCall("pool1", "swap_a_to_b", 10_000_000, 1). */
  contractCallSwap: () => makeVector(SPECS[11]),
  /** @returns {Vector} OpenDispute("d1", "task", "t1", "Bob", "late", "", 1_000_000_000). */
  openDispute: () => makeVector(SPECS[12]),
  /** @returns {Vector} ForceCloseChannel("ch1", 100, 200, 0, Buffer.alloc(0)). */
  forceCloseChannel: () => makeVector(SPECS[13]),
  /** @returns {Vector} UpdateAgent("AgentKey", null, 7, null, ["NativeTransfer", "WrapXrs"], null, true). */
  updateAgent: () => makeVector(SPECS[14]),
  /** @returns {Vector} RegisterAgent("TestAgent", "pubkey123", 1000, 2000, ["pool_a"], ["ContractCall"], 0). */
  registerAgent: () => makeVector(SPECS[15]),
  /** @returns {Vector} RWAUpdateStatus("t", "active", 5, null, null). */
  rwaUpdateStatus: () => makeVector(SPECS[16]),
  /** @returns {Vector} AgentHeartbeat("Alice", "", 1, 9, "ok"). */
  agentHeartbeat: () => makeVector(SPECS[17]),
  /** @returns {Vector} PostTask("t1", "T", "", "", [], 0, 1_000_000_000, 0, 1, "poster_confirm", "", 0). */
  postTask: () => makeVector(SPECS[18]),
  /** @returns {Vector} ValidatorAttestation("Alice", 42, bytes 0x00..0x1f). */
  validatorAttestation: () => makeVector(SPECS[19]),
  all,
  verify,
  printAll,
});

module.exports = { TestVectors };
