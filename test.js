/**
 * xeris-sdk test suite
 * Run: node test.js
 */

'use strict';

const {
  Instructions,
  TestVectors,
  encodeU32,
  encodeU64,
  encodeBincodeString,
  LAMPORTS_PER_XRS,
} = require('./index');

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
  }
}

console.log('xeris-sdk test suite\n');

// ── Encoding primitives ──
console.log('Encoding primitives:');
assert(encodeU32(11).toString('hex') === '0b000000', 'encodeU32(11)');
assert(encodeU32(0).toString('hex') === '00000000', 'encodeU32(0)');
assert(encodeU32(13).toString('hex') === '0d000000', 'encodeU32(13)');
assert(encodeU64(5000000000).toString('hex') === '00f2052a01000000', 'encodeU64(5e9)');
assert(encodeU64(1000000000000).toString('hex') === '0010a5d4e8000000', 'encodeU64(1e12)');
assert(encodeU64(0).toString('hex') === '0000000000000000', 'encodeU64(0)');
assert(encodeBincodeString('Alice').toString('hex') === '0500000000000000416c696365', 'encodeBincodeString("Alice")');
assert(encodeBincodeString('Bob').toString('hex') === '0300000000000000426f62', 'encodeBincodeString("Bob")');
assert(encodeBincodeString('').toString('hex') === '0000000000000000', 'encodeBincodeString("")');

// ── Instruction builders ──
console.log('\nInstruction builders:');

const nt = Instructions.nativeTransfer('Alice', 'Bob', 5_000_000_000);
assert(nt.toString('hex') === '0b0000000500000000000000416c6963650300000000000000426f6200f2052a01000000', 'NativeTransfer');
assert(nt.length === 36, 'NativeTransfer length');

const st = Instructions.stake('TestVal', 1_000_000_000_000);
assert(st.toString('hex') === '0900000007000000000000005465737456616c0010a5d4e8000000', 'Stake');
assert(st.length === 27, 'Stake length');

const tm = Instructions.tokenMint('xUSDC', 'Bob', 1_000_000_000);
assert(tm.toString('hex') === '00000000050000000000000078555344430300000000000000426f6200ca9a3b00000000', 'TokenMint');
assert(tm.length === 36, 'TokenMint length');

const tt = Instructions.tokenTransfer('xUSDC', 'Alice', 'Bob', 500_000_000);
assert(tt.toString('hex') === '01000000050000000000000078555344430500000000000000416c6963650300000000000000426f620065cd1d00000000', 'TokenTransfer');
assert(tt.length === 49, 'TokenTransfer length');

const wx = Instructions.wrapXrs(10_000_000_000);
assert(wx.toString('hex') === '0d00000000e40b5402000000', 'WrapXrs');
assert(wx.length === 12, 'WrapXrs length');

const ux = Instructions.unwrapXrs(10_000_000_000);
assert(ux.readUInt32LE(0) === 14, 'UnwrapXrs variant is 14');
assert(ux.length === 12, 'UnwrapXrs length');

// ── Variant indices ──
console.log('\nVariant indices:');
assert(Instructions.nativeTransfer('a', 'b', 1).readUInt32LE(0) === 11, 'NativeTransfer = 11');
assert(Instructions.stake('a', 1).readUInt32LE(0) === 9, 'Stake = 9');
assert(Instructions.unstake('a', 1).readUInt32LE(0) === 10, 'Unstake = 10');
assert(Instructions.tokenMint('t', 'a', 1).readUInt32LE(0) === 0, 'TokenMint = 0');
assert(Instructions.tokenTransfer('t', 'a', 'b', 1).readUInt32LE(0) === 1, 'TokenTransfer = 1');
assert(Instructions.tokenBurn('t', 'a', 1).readUInt32LE(0) === 2, 'TokenBurn = 2');
assert(Instructions.tokenCreate('t', 'n', 's', 9, 1000, 'a').readUInt32LE(0) === 3, 'TokenCreate = 3');
assert(Instructions.contractCall('c', 'm', {}).readUInt32LE(0) === 4, 'ContractCall = 4');
assert(Instructions.contractDeploy('c', 'swap', {}).readUInt32LE(0) === 5, 'ContractDeploy = 5');
assert(Instructions.wrapXrs(1).readUInt32LE(0) === 13, 'WrapXrs = 13');
assert(Instructions.unwrapXrs(1).readUInt32LE(0) === 14, 'UnwrapXrs = 14');

// ── Test vectors match ──
console.log('\nTest vectors:');
const v1 = TestVectors.nativeTransfer();
assert(v1.hex === '0b0000000500000000000000416c6963650300000000000000426f6200f2052a01000000', 'Vector: NativeTransfer');
const v2 = TestVectors.stake();
assert(v2.hex === '0900000007000000000000005465737456616c0010a5d4e8000000', 'Vector: Stake');
const v3 = TestVectors.tokenMint();
assert(v3.hex === '00000000050000000000000078555344430300000000000000426f6200ca9a3b00000000', 'Vector: TokenMint');

// ── Constants ──
console.log('\nConstants:');
assert(LAMPORTS_PER_XRS === 1_000_000_000, 'LAMPORTS_PER_XRS = 1e9');

// ── Summary ──
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(40)}`);
process.exit(failed > 0 ? 1 : 0);
