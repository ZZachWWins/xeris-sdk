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
  encodeBincodeStringVec,
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

// ── ZKP proof generation (v4.0) ──
console.log('\nZKP proof generation:');
const { createZkPrivateTransferProofs, domainHash, BASE_TX_FEE } = require('./index');
assert(BASE_TX_FEE === 1_000_000, 'BASE_TX_FEE = 1e6');

// Generate proofs
const blinding = Buffer.alloc(32, 42); // deterministic for testing
const proofs = createZkPrivateTransferProofs(5_000_000_000, 10_000_000_000, blinding);
assert(proofs.commitment.length === 48, 'Commitment is 48 bytes (amount + blinding + balance)');
assert(proofs.balanceProof.length === 64, 'Balance proof is 64 bytes');
assert(proofs.nullifier.length === 32, 'Nullifier is 32 bytes');
assert(proofs.rangeProof.length === 32, 'Range proof is 32 bytes');
assert(proofs.blinding.equals(blinding), 'Blinding roundtrips');

// Commitment format: [amount(8) | blinding(32) | balance(8)]
const proofAmount = proofs.commitment.readBigUInt64LE(0);
assert(proofAmount === 5_000_000_000n, 'Commitment contains correct amount');
const proofBalance = proofs.commitment.readBigUInt64LE(40);
assert(proofBalance === 10_000_000_000n, 'Commitment contains correct balance');

// Deterministic: same inputs = same outputs
const proofs2 = createZkPrivateTransferProofs(5_000_000_000, 10_000_000_000, blinding);
assert(proofs.balanceProof.equals(proofs2.balanceProof), 'Proofs are deterministic');
assert(proofs.nullifier.equals(proofs2.nullifier), 'Nullifiers are deterministic');

// Different blinding = different proofs
const proofs3 = createZkPrivateTransferProofs(5_000_000_000, 10_000_000_000, Buffer.alloc(32, 43));
assert(!proofs.nullifier.equals(proofs3.nullifier), 'Different blinding = different nullifier');
assert(!proofs.balanceProof.equals(proofs3.balanceProof), 'Different blinding = different balance proof');

// Error cases
try { createZkPrivateTransferProofs(0, 10_000_000_000); assert(false, 'Should reject zero amount'); }
catch(e) { assert(e.message.includes('> 0'), 'Rejects zero amount'); }
try { createZkPrivateTransferProofs(20_000_000_000, 10_000_000_000); assert(false, 'Should reject insufficient'); }
catch(e) { assert(e.message.includes('Insufficient'), 'Rejects insufficient balance'); }

// Domain hash matches SHA-256
const crypto = require('crypto');
const testHash = domainHash('test_tag', Buffer.from('test_data'));
const expectedHash = crypto.createHash('sha256').update('test_tag').update('test_data').digest();
assert(testHash.equals(expectedHash), 'domainHash matches manual SHA-256');

// ── Vec<String> encoding (v3.0 fix) ──
console.log('\nVec<String> encoding:');
// Empty vec: just u64(0)
assert(encodeBincodeStringVec([]).toString('hex') === '0000000000000000', 'empty Vec<String>');
// Single string "hi": u64(1) + u64(2) + "hi"
assert(encodeBincodeStringVec(['hi']).toString('hex') === '010000000000000002000000000000006869', 'Vec<String> ["hi"]');
// Two strings: verify count is 2
assert(encodeBincodeStringVec(['a','b']).readBigUInt64LE(0) === 2n, 'Vec<String> ["a","b"] has count=2');
// Verify total encoding: u64(2) + u64(1)+"a" + u64(1)+"b" = 8+8+1+8+1 = 26 bytes
assert(encodeBincodeStringVec(['a','b']).length === 26, 'Vec<String> ["a","b"] length=26');

// ── ZKP + PQC variant indices ──
console.log('\nZKP + PQC variant indices:');
assert(Instructions.zkProofSubmit('p', 'groth16', Buffer.alloc(1), Buffer.alloc(1), 'vk', 'custom', '{}').readUInt32LE(0) === 46, 'ZkProofSubmit = 46');
assert(Instructions.zkProofVerify('p').readUInt32LE(0) === 47, 'ZkProofVerify = 47');
assert(Instructions.zkPrivateTransfer('t', 'a', 'b', Buffer.alloc(1), Buffer.alloc(1), Buffer.alloc(1), Buffer.alloc(1)).readUInt32LE(0) === 48, 'ZkPrivateTransfer = 48');
assert(Instructions.zkIdentityProof('a', 'rep', 80, Buffer.alloc(1), Buffer.alloc(1)).readUInt32LE(0) === 49, 'ZkIdentityProof = 49');
assert(Instructions.pqKeyRegister('a', Buffer.alloc(32), 'dilithium3', 3).readUInt32LE(0) === 50, 'PqKeyRegister = 50');
assert(Instructions.pqKeyRotate('a', Buffer.alloc(32), 'dilithium3', Buffer.alloc(64)).readUInt32LE(0) === 51, 'PqKeyRotate = 51');
assert(Instructions.pqSignedTransfer('a', 'b', 100, Buffer.alloc(64), 'dilithium3').readUInt32LE(0) === 52, 'PqSignedTransfer = 52');
assert(Instructions.pqAttest('tx', 'ref', 'dilithium3', true).readUInt32LE(0) === 53, 'PqAttest = 53');

// ── New instruction builders (v3.0) ──
console.log('\nNew instruction builders:');
assert(Instructions.updateCapability('a', 'trading', { removed: false }).readUInt32LE(0) === 29, 'UpdateCapability = 29');
assert(Instructions.updateModel('a', 'hash', { retired: false }).readUInt32LE(0) === 35, 'UpdateModel = 35');
assert(Instructions.forceCloseChannel('ch1', 100, 200, 1).readUInt32LE(0) === 44, 'ForceCloseChannel = 44');

// ── RegisterAgent uses proper bincode Vec<String> (not JSON) ──
console.log('\nRegisterAgent Vec<String> encoding:');
const ra = Instructions.registerAgent('TestAgent', 'pubkey123', 1000, 2000, ['pool_a'], ['ContractCall'], 0);
// The allowedContracts field should start with u64(1) (count=1) not a JSON bracket
// Find the offset after: u32(15) + str("TestAgent") + str("pubkey123") + u64(1000) + u64(2000)
// = 4 + (8+9) + (8+9) + 8 + 8 = 54
const contractsOffset = 54;
const contractsCount = ra.readBigUInt64LE(contractsOffset);
assert(contractsCount === 1n, 'RegisterAgent allowedContracts is bincode Vec<String> with count=1');

// ── Summary ──
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(40)}`);
process.exit(failed > 0 ? 1 : 0);
