'use strict';

/**
 * Transaction assembly against the golden vector (blueprint §9.4) and the
 * node's structural gate (network.rs:145-197, ledger.rs:93-130, tx_pool.rs:183).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const bs58 = require('bs58');

const {
  Instructions, XerisKeypair, EncodingError, FeatureDisabledError, RpcError, XerisError,
  blockhashFromHex, buildTransaction, signTransaction, serializeTransaction, signatureOf,
  assembleSignedTransaction, assertInstructionSubmittable, parseSubmitResponse, encodeVariant,
  MAX_IX_DATA_SIZE, MAX_SLASH_IX_DATA_SIZE, MAX_IX_PER_TX,
} = require('..');
const { serializedFromWalletResult, submitBody } = require('../src/transaction');
const H = require('./_helpers');

const ix = () => Buffer.from(H.GOLDEN_IX_HEX, 'hex');
/** A NativeTransfer the node's semantic gate accepts (canonical target, amount > 0). */
const validIx = () => Instructions.nativeTransfer(H.GOLDEN_PUBKEY, H.OTHER_PUBKEY, 5_000_000_000);
/** A buffer of `len` bytes whose first four bytes are `u32le(variant)`. */
const sized = (variant, len) => Buffer.concat([encodeVariant(variant), Buffer.alloc(len - 4)]);

test('golden keypair and instruction', () => {
  const kp = H.goldenKeypair();
  assert.equal(kp.publicKey, H.GOLDEN_PUBKEY);
  assert.equal(Instructions.nativeTransfer('Alice', 'Bob', 5_000_000_000).toString('hex'), H.GOLDEN_IX_HEX);
});

test('signTransaction + serializeTransaction reproduce the 206-byte golden transaction', () => {
  const kp = H.goldenKeypair();
  const tx = signTransaction(H.goldenUnsignedTx(), kp);
  const b = serializeTransaction(tx);
  assert.equal(b.toString('hex'), H.GOLDEN_TX_HEX);
  assert.equal(b.length, 206);
  assert.equal(signatureOf(b), H.GOLDEN_SIGNATURE);
  assert.equal(b[0], 1, 'one signature');
  assert.deepEqual([...b.subarray(65, 68)], [1, 0, 1], 'header');
  assert.equal(b[68], 2, 'two account keys');
  assert.equal(bs58.encode(b.subarray(69, 101)), H.GOLDEN_PUBKEY, 'payer first');
  assert.ok(b.subarray(101, 133).every((x) => x === 0), 'zero program id');
  assert.equal(b.subarray(133, 165).toString('hex'), H.GOLDEN_BLOCKHASH_HEX);
  assert.deepEqual([...b.subarray(165, 170)], [1, 1, 1, 0, 0x24]);
  assert.equal(b.subarray(170).toString('hex'), H.GOLDEN_IX_HEX);
  // The signature verifies over the message bytes tx[65..].
  assert.ok(XerisKeypair.verify(H.GOLDEN_PUBKEY, b.subarray(65), b.subarray(1, 65)));
  assert.equal(signatureOf(b), H.GOLDEN_SIGNATURE);
  assert.deepEqual(submitBody(b), { tx_base64: b.toString('base64') });
});

test('buildTransaction + signTransaction + serializeTransaction equal assembleSignedTransaction', () => {
  const kp = H.goldenKeypair();
  const bh = blockhashFromHex(H.GOLDEN_BLOCKHASH_HEX);
  const tx = buildTransaction(kp.publicKey, [validIx()], bh);
  signTransaction(tx, kp);
  const out = assembleSignedTransaction(kp, validIx(), bh);
  assert.equal(serializeTransaction(tx).toString('hex'), out.txBytes.toString('hex'));
  assert.equal(out.txBase64, out.txBytes.toString('base64'));
  assert.equal(out.signature, signatureOf(out.txBytes));
  // Same layout as the golden vector: only the instruction data differs.
  const golden = Buffer.from(H.GOLDEN_TX_HEX, 'hex');
  assert.equal(out.txBytes.subarray(65, 169).toString('hex'), golden.subarray(65, 169).toString('hex'));
  assert.equal(out.txBytes[169], validIx().length);
  assert.equal(out.txBytes.subarray(170).toString('hex'), validIx().toString('hex'));
});

test('the golden instruction pays a non-canonical key, so the SDK refuses to sign it', () => {
  const kp = H.goldenKeypair();
  assert.throws(
    () => assembleSignedTransaction(kp, ix(), blockhashFromHex(H.GOLDEN_BLOCKHASH_HEX)),
    (e) => e instanceof RangeError && /NativeTransfer destination must be a canonical public key/.test(e.message),
  );
});

test('blockhashFromHex accepts 64 hex characters only', () => {
  assert.equal(blockhashFromHex('AB'.repeat(32)).toString('hex'), 'ab'.repeat(32));
  for (const bad of ['zz', '11'.repeat(31), '11'.repeat(33), 'g'.repeat(64)]) {
    assert.throws(() => blockhashFromHex(bad), EncodingError, bad);
  }
});

test('assertInstructionSubmittable mirrors the ingress size and variant rules', () => {
  assert.equal(assertInstructionSubmittable(ix()), 11);
  assert.equal(assertInstructionSubmittable(sized(11, MAX_IX_DATA_SIZE)), 11);
  assert.throws(() => assertInstructionSubmittable(sized(11, MAX_IX_DATA_SIZE + 1)), RangeError);
  assert.equal(assertInstructionSubmittable(sized(38, MAX_SLASH_IX_DATA_SIZE)), 38);
  assert.throws(() => assertInstructionSubmittable(sized(38, MAX_SLASH_IX_DATA_SIZE + 1)), RangeError);
  for (const v of [22, 48, 49, 52]) {
    assert.throws(() => assertInstructionSubmittable(sized(v, 16)), FeatureDisabledError, `variant ${v}`);
  }
  assert.throws(() => assertInstructionSubmittable(sized(62, 16)), EncodingError);
  assert.throws(() => assertInstructionSubmittable(Buffer.alloc(3)), EncodingError);
  assert.throws(() => assertInstructionSubmittable([11, 0, 0, 0]), TypeError);
});

test('buildTransaction takes 1..MAX_IX_PER_TX instructions and a 32-byte blockhash', () => {
  const kp = H.goldenKeypair();
  const bh = blockhashFromHex(H.GOLDEN_BLOCKHASH_HEX);
  assert.equal(buildTransaction(kp.publicKey, Array(MAX_IX_PER_TX).fill(validIx()), bh).instructions.length, MAX_IX_PER_TX);
  assert.throws(() => buildTransaction(kp.publicKey, Array(MAX_IX_PER_TX + 1).fill(validIx()), bh), RangeError);
  assert.throws(() => buildTransaction(kp.publicKey, [], bh), RangeError);
  assert.throws(() => buildTransaction(kp.publicKey, [validIx()], Buffer.alloc(31)));
  assert.throws(() => buildTransaction(kp.publicKey, [sized(52, 8)], bh), FeatureDisabledError);
});

test('signatureOf rejects bytes that are not a one-signature transaction', () => {
  assert.throws(() => signatureOf(Buffer.alloc(64)), EncodingError);
  const two = Buffer.from(H.GOLDEN_TX_HEX, 'hex');
  two[0] = 2;
  assert.throws(() => signatureOf(two), EncodingError);
});

test('parseSubmitResponse returns success bodies unchanged and raises node errors', () => {
  const ok = { status: 'ok', signature: 'x' };
  assert.equal(parseSubmitResponse(ok, 'POST /submit', 200), ok);
  const queued = { status: 'queued', message: 'm', staked: 1, pubkey: 'p', signature: 's' };
  assert.equal(parseSubmitResponse(queued, 'POST /stake', 200), queued);
  const full = { error: 'Mempool is full', status: 'rejected_mempool_full', signature: 'x' };
  assert.throws(() => parseSubmitResponse(full, 'POST /submit', 200), (e) => {
    assert.ok(e instanceof RpcError);
    assert.equal(e.message, 'Mempool is full');
    assert.equal(e.nodeStatus, 'rejected_mempool_full');
    assert.equal(e.route, 'POST /submit');
    return true;
  });
});

test('serializedFromWalletResult accepts the four wallet result shapes and verifies the signature', () => {
  const kp = H.goldenKeypair();
  const bh = blockhashFromHex(H.GOLDEN_BLOCKHASH_HEX);
  const unsigned = () => H.goldenUnsignedTx();
  void bh;
  const signed = Buffer.from(H.GOLDEN_TX_HEX, 'hex');
  const sig = signed.subarray(1, 65);

  const tx = unsigned();
  tx.sign(kp.solanaKeypair);
  assert.equal(serializedFromWalletResult(tx, unsigned()).toString('hex'), H.GOLDEN_TX_HEX, 'web3 Transaction');
  assert.equal(serializedFromWalletResult(new Uint8Array(signed), unsigned()).toString('hex'), H.GOLDEN_TX_HEX, 'full bytes');
  assert.equal(serializedFromWalletResult({ signature: new Uint8Array(sig) }, unsigned()).toString('hex'), H.GOLDEN_TX_HEX, '{signature: bytes}');
  assert.equal(serializedFromWalletResult({ signature: H.GOLDEN_SIGNATURE }, unsigned()).toString('hex'), H.GOLDEN_TX_HEX, '{signature: base58}');
  assert.equal(serializedFromWalletResult({ signedTransaction: signed.toString('base64') }, unsigned()).toString('hex'), H.GOLDEN_TX_HEX, '{signedTransaction}');

  const tampered = Buffer.from(sig);
  tampered[0] ^= 1;
  assert.throws(() => serializedFromWalletResult({ signature: tampered }, unsigned()), (e) => e instanceof XerisError && e.code === 'provider');
  assert.throws(() => serializedFromWalletResult('nonsense', unsigned()), (e) => e instanceof XerisError && e.code === 'provider');
});

// ---------------------------------------------------------------------------
// Messages above web3.js's 1232-byte PACKET_DATA_SIZE
// ---------------------------------------------------------------------------

/** Independent parser for a single-signer legacy transaction (Solana wire format). */
function parseTx(bytes) {
  let o = 0;
  const shortvec = () => {
    let len = 0;
    for (let shift = 0; ; shift += 7) {
      const b = bytes[o++];
      len |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return len;
    }
  };
  const sigCount = shortvec();
  const sigs = [];
  for (let i = 0; i < sigCount; i++) { sigs.push(bytes.subarray(o, o + 64)); o += 64; }
  const messageStart = o;
  const header = [...bytes.subarray(o, o + 3)]; o += 3;
  const keyCount = shortvec();
  const keys = [];
  for (let i = 0; i < keyCount; i++) { keys.push(bytes.subarray(o, o + 32)); o += 32; }
  const blockhash = bytes.subarray(o, o + 32); o += 32;
  const ixCount = shortvec();
  const ixs = [];
  for (let i = 0; i < ixCount; i++) {
    const programIndex = bytes[o++];
    const accCount = shortvec();
    const accounts = [...bytes.subarray(o, o + accCount)]; o += accCount;
    const dataLen = shortvec();
    ixs.push({ programIndex, accounts, data: bytes.subarray(o, o + dataLen) }); o += dataLen;
  }
  assert.equal(o, bytes.length, 'no trailing bytes');
  return { sigs, message: bytes.subarray(messageStart), header, keys, blockhash, ixs };
}

test('the SDK message encoder equals web3.js serializeMessage wherever web3.js can serialize', () => {
  const kp = H.goldenKeypair();
  const bh = blockhashFromHex(H.GOLDEN_BLOCKHASH_HEX);
  for (const sizes of [[36], [12, 12], [127, 128, 129], [500, 400], Array(16).fill(20), [1000]]) {
    const ixs = sizes.map((n) => sized(13, n));
    const out = assembleSignedTransaction(kp, ixs, bh);
    const viaWeb3 = buildTransaction(kp.publicKey, ixs, bh);
    viaWeb3.sign(kp.solanaKeypair);
    assert.equal(out.txBytes.toString('hex'), Buffer.from(viaWeb3.serialize()).toString('hex'), `sizes ${sizes}`);
  }
});

test('PqKeyRegister, PqKeyRotate and a 65,535-byte SlashReport assemble, parse and verify', () => {
  const kp = H.goldenKeypair();
  const bh = blockhashFromHex(H.GOLDEN_BLOCKHASH_HEX);
  const pqReg = Instructions.pqKeyRegister(kp.publicKey, Buffer.alloc(1952, 0xab), 'dilithium3', 3);
  const pqRot = Instructions.pqKeyRotate(kp.publicKey, Buffer.alloc(1952, 1), 'dilithium3', Buffer.alloc(3309, 2));
  const head = Instructions.slashReport('a', 'b', 'c', '', 1);
  const slash = Instructions.slashReport('a', 'b', 'c', 'x'.repeat(MAX_SLASH_IX_DATA_SIZE - head.length), 1);
  assert.equal(slash.length, MAX_SLASH_IX_DATA_SIZE);
  for (const [name, ixs] of [['pqKeyRegister', [pqReg]], ['pqKeyRotate', [pqRot]], ['slashReport', [slash]], ['mixed', [pqReg, validIx(), pqRot]]]) {
    const out = assembleSignedTransaction(kp, ixs, bh);
    const p = parseTx(out.txBytes);
    assert.equal(p.sigs.length, 1, name);
    assert.deepEqual(p.header, [1, 0, 1], name);
    assert.equal(bs58.encode(p.keys[0]), kp.publicKey, name);
    assert.ok(p.keys[1].every((b) => b === 0), name);
    assert.equal(p.blockhash.toString('hex'), H.GOLDEN_BLOCKHASH_HEX, name);
    assert.equal(p.ixs.length, ixs.length, name);
    p.ixs.forEach((parsed, i) => {
      assert.equal(parsed.programIndex, 1);
      assert.deepEqual(parsed.accounts, [0]);
      assert.deepEqual(Buffer.from(parsed.data), ixs[i], `${name} ix ${i}`);
    });
    assert.ok(XerisKeypair.verify(kp.publicKey, p.message, p.sigs[0]), `${name} signature`);
    assert.equal(out.signature, bs58.encode(p.sigs[0]));
  }
});

test('compact-u16 lengths at the 1/2/3-byte boundaries', () => {
  const kp = H.goldenKeypair();
  const bh = blockhashFromHex(H.GOLDEN_BLOCKHASH_HEX);
  // Expected encodings from the Solana short_vec definition.
  const cases = [[127, '7f'], [128, '8001'], [16383, 'ff7f'], [16384, '808001']];
  for (const [len, prefix] of cases) {
    const data = sized(38, len);
    const tx = assembleSignedTransaction(kp, data, bh).txBytes;
    const at = tx.length - len - prefix.length / 2;
    assert.equal(tx.subarray(at, at + prefix.length / 2).toString('hex'), prefix, `length ${len}`);
  }
});

test('transactions above MAX_TX_BYTES are refused before submission', () => {
  const kp = H.goldenKeypair();
  const bh = blockhashFromHex(H.GOLDEN_BLOCKHASH_HEX);
  const ixs = Array(MAX_IX_PER_TX).fill(sized(13, MAX_IX_DATA_SIZE));
  assert.throws(() => assembleSignedTransaction(kp, ixs, bh), RangeError);
});

test('serializeTransaction refuses an unsigned or wrongly signed SDK-shaped transaction', () => {
  const kp = H.goldenKeypair();
  const bh = blockhashFromHex(H.GOLDEN_BLOCKHASH_HEX);
  const tx = buildTransaction(kp.publicKey, [validIx()], bh);
  assert.throws(() => serializeTransaction(tx), EncodingError);
  signTransaction(tx, kp);
  tx.signatures[0].signature = Buffer.alloc(64, 1);
  assert.throws(() => serializeTransaction(tx), EncodingError);
  const other = XerisKeypair.generate();
  assert.throws(() => signTransaction(buildTransaction(kp.publicKey, [validIx()], bh), other), RangeError);
});

test('serializedFromWalletResult resolves a wallet signature for a PqKeyRegister transaction', () => {
  const kp = H.goldenKeypair();
  const bh = blockhashFromHex(H.GOLDEN_BLOCKHASH_HEX);
  const data = Instructions.pqKeyRegister(kp.publicKey, Buffer.alloc(1952, 0xab), 'dilithium3', 3);
  const expected = assembleSignedTransaction(kp, data, bh);
  const unsigned = buildTransaction(kp.publicKey, data, bh);
  const sig = expected.txBytes.subarray(1, 65);
  assert.deepEqual(serializedFromWalletResult({ signature: new Uint8Array(sig) }, unsigned), expected.txBytes);
  const walletTx = buildTransaction(kp.publicKey, data, bh);
  signTransaction(walletTx, kp);
  assert.deepEqual(serializedFromWalletResult(walletTx, unsigned), expected.txBytes);
  assert.equal(unsigned.signatures.length, 0, 'the unsigned transaction is not modified');
});

// ---------------------------------------------------------------------------
// validate_tx_semantics (ledger.rs:1382-1455) and QueryCapabilities (30)
// ---------------------------------------------------------------------------

test('assertInstructionSubmittable refuses QueryCapabilities, a paid no-op (ledger.rs:7460-7464)', () => {
  assert.throws(
    () => assertInstructionSubmittable(Instructions.queryCapabilities('c', [], 'r', 0, 1)),
    (e) => e instanceof FeatureDisabledError && e.feature === 'QueryCapabilities' && e.replacement === 'XerisClient.searchCapabilities',
  );
});

test('buildTransaction refuses a nested ContractCall whose args serde_json cannot parse', () => {
  const kp = H.goldenKeypair();
  const bh = blockhashFromHex(H.GOLDEN_BLOCKHASH_HEX);
  const P = kp.publicKey;
  const build = (ix) => buildTransaction(P, ix, bh);
  const bad = [
    Buffer.from('{"amount_a":1e400}'),
    Buffer.from('{"x":"\\ud800"}'),
    Buffer.from('{"amount_a":18446744073709551616}'),
    Buffer.from('[1]'),
    Buffer.from([0x7b, 0xff, 0x7d]),
  ];
  for (const args of bad) {
    const inner = Instructions.contractCall('pool', 'add_liquidity', args);
    assert.throws(() => build(inner), /args must be a JSON object the node can parse/);
    // AgentExecute: ledger.rs:6436-6442 skips it after the fee.
    assert.throws(() => build(Instructions.agentExecute(P, inner)),
      (e) => e instanceof RangeError && /nested ContractCall pool\.add_liquidity: AgentExecute args/.test(e.message) && /ledger\.rs:6436-6442/.test(e.message));
    // ConditionalOrder: contract_call_args at ledger.rs:9181 when the order fires.
    assert.throws(() => build(Instructions.conditionalOrder('o1', 'slot_reached', 'x', 5, inner, 1000, 0)),
      (e) => e instanceof RangeError && /nested ContractCall pool\.add_liquidity: ConditionalOrder args/.test(e.message) && /ledger\.rs:2359-2371, 9181/.test(e.message));
  }
  // The 16-byte swap payload passes contract_call_args (ConditionalOrder) but not the
  // AgentExecute JSON-object requirement.
  const swap = Instructions.contractCall('pool', 'swap_a_to_b', Buffer.alloc(16));
  assert.equal(build(Instructions.conditionalOrder('o1', 'slot_reached', 'x', 5, swap, 1000, 0)).instructions.length, 1);
  assert.throws(() => build(Instructions.agentExecute(P, swap)), /AgentExecute args must be a JSON object/);
  const good = Instructions.contractCall('pool', 'add_liquidity', { amount_a: 1, amount_b: 2n ** 63n });
  assert.equal(build(Instructions.agentExecute(P, good)).instructions.length, 1);
  assert.equal(build(Instructions.conditionalOrder('o1', 'slot_reached', 'x', 5, good, 1000, 0)).instructions.length, 1);
});

test('buildTransaction refuses an actor field that is not the signer (block skips it after the fee)', () => {
  const kp = H.goldenKeypair();
  const bh = blockhashFromHex(H.GOLDEN_BLOCKHASH_HEX);
  const P = kp.publicKey;
  const O = H.OTHER_PUBKEY;
  const make = {
    'Stake.pubkey': (a) => Instructions.stake(a, 1),
    'Unstake.pubkey': (a) => Instructions.unstake(a, 1),
    'NativeTransfer.from': (a) => Instructions.nativeTransfer(a, a === O ? P : O, 1),
    'CreateIdentity.identity_pubkey': (a) => Instructions.createIdentity(a, 'n', 'agent', '', '{}'),
    'RegisterCapability.provider_identity': (a) => Instructions.registerCapability(a, 'trading', ['x'], 'global', 'd', 0, 1, '{}'),
    'UpdateCapability.provider_identity': (a) => Instructions.updateCapability(a, 'trading', null, null, null, null, null, true),
    'ClaimTask.claimant_identity': (a) => Instructions.claimTask('t1', a),
    'RegisterModel.identity_pubkey': (a) => Instructions.registerModel(a, 'm', 'a'.repeat(64), '1', 'pytorch', '{}', 1, 'cloud'),
    'AgentHeartbeat.identity_pubkey': (a) => Instructions.agentHeartbeat(a, 'a'.repeat(64), 0, 1, 'ok'),
    'PqKeyRotate.ed25519_pubkey': (a) => Instructions.pqKeyRotate(a, Buffer.alloc(1952), 'dilithium3', Buffer.alloc(3309)),
    'HardwareAttest.device_pubkey': (a) => Instructions.hardwareAttest(a, 'iot', 'm', 'x', '1', Buffer.alloc(8), ''),
    'HardwareAttest.bound_identity': (a) => Instructions.hardwareAttest(O, 'iot', 'm', 'x', '1', Buffer.alloc(8), a),
  };
  for (const [field, f] of Object.entries(make)) {
    assert.equal(buildTransaction(P, f(P), bh).instructions.length, 1, field);
    assert.throws(() => buildTransaction(P, f(O), bh), (e) => e instanceof RangeError
      && e.message.startsWith(`instructions[0]: ${field} ${O} is not the signer ${P}`)
      && /after charging the fee \(token\.rs:\d+/.test(e.message), field);
  }
  // Ingress errors are reported before the block-level binding.
  assert.throws(() => buildTransaction(P, Instructions.nativeTransfer(O, O, 0), bh), /NativeTransfer amount must be positive/);
  // Not checked inside AgentExecute: the inner NativeTransfer moves the owner's funds.
  assert.equal(buildTransaction(P, Instructions.agentExecute(O, Instructions.nativeTransfer(O, P, 1)), bh).instructions.length, 1);
});

test('buildTransaction applies the node semantic gate for the payer', () => {
  const kp = H.goldenKeypair();
  const bh = blockhashFromHex(H.GOLDEN_BLOCKHASH_HEX);
  const P = kp.publicKey;
  const O = H.OTHER_PUBKEY;
  const build = (ixs) => buildTransaction(P, ixs, bh);
  const rejects = (ixs, re) => assert.throws(() => build(ixs), (e) => e instanceof RangeError && re.test(e.message), String(re));
  rejects(Instructions.nativeTransfer(P, O, 0), /NativeTransfer amount must be positive/);
  rejects(Instructions.nativeTransfer(P, 'Bob', 1), /canonical public key/);
  rejects(Instructions.nativeTransfer(P, '__escrow_order_1', 1), /canonical public key/);
  rejects(Instructions.tokenMint('t', O, 0), /TokenMint amount must be positive/);
  rejects(Instructions.rwaTransfer('t', P, O, 0), /RWATransfer requires positive amount/);
  rejects(Instructions.rwaTransfer('t', P, P, 1), /RWATransfer requires positive amount and distinct accounts/);
  rejects(Instructions.validatorAttestation(O, 5, Buffer.alloc(32)), /validator must equal the transaction signer/);
  rejects(Instructions.validatorAttestation(P, 5, Buffer.alloc(31)), /exactly 32 bytes \(got 31\)/);
  rejects(Instructions.agentExecute(P, Instructions.nativeTransfer(P, O, 0)), /NativeTransfer amount must be positive/);
  rejects(Instructions.agentExecute(P, Instructions.tokenMint('t', O, 0)), /nested TokenMint amount must be positive/);
  rejects(Instructions.conditionalOrder('o', 'slot_reached', 's', 1, Instructions.rwaTransfer('t', P, P, 1), 9, 0), /nested RWATransfer/);
  rejects(Instructions.agentExecute(P, Instructions.conditionalOrder('o', 'slot_reached', 's', 1, Buffer.alloc(0), 9, 0)), /recursive delegated/);
  rejects([Instructions.wrapXrs(1), Instructions.nativeTransfer(P, O, 0)], /instructions\[1\]/);
  rejects(Instructions.contractCall('c', 'buy_tokens', Buffer.from('not json')), /ContractCall c\.buy_tokens/);
  rejects(Instructions.contractCall('c', 'swap_a_to_b', Buffer.alloc(15)), /args must be a JSON object/);
  rejects(Instructions.contractCall('c', 'm', Buffer.from('[1]')), /not a JSON object/);
  rejects(Instructions.contractCall('c', 'm', Buffer.from([0x7b, 0xff, 0x7d])), /UTF-8/);
  rejects(Instructions.contractDeploy('c', 'swap', '{"token_a":'), /params_json/);
  // Accepted: what the node admits and executes.
  for (const ok of [
    Instructions.nativeTransfer(P, O, 1),
    Instructions.validatorAttestation(P, 5, Buffer.alloc(32)),
    Instructions.agentExecute(P, Instructions.nativeTransfer(P, O, 1)),
    Instructions.contractCall('c', 'swap_a_to_b', Buffer.alloc(16)),
    Instructions.contractCall('c', 'buy_tokens', { xrs_amount: 1n, min_tokens_out: 2n ** 63n }),
    Instructions.contractDeploy('c', 'swap', '{"token_a":"xrs_native","token_b":"x","fee_bps":30}'),
  ]) {
    assert.equal(build(ok).instructions.length, 1);
  }
});

// ---------------------------------------------------------------------------
// Strict decode and the inner-instruction / signer-binding rules
// ---------------------------------------------------------------------------

/** `u32le(variant)`, then each part: a Buffer as-is, a string or byte array with a u64le length prefix. */
const framed = (variant, ...parts) => Buffer.concat([
  encodeVariant(variant),
  ...parts.map((p) => {
    if (Buffer.isBuffer(p)) return p;
    const b = Buffer.from(p);
    const len = Buffer.alloc(8);
    len.writeBigUInt64LE(BigInt(b.length));
    return Buffer.concat([len, b]);
  }),
]);

test('assertInstructionSubmittable refuses data that does not decode as a XerisInstruction (network.rs:180-187)', () => {
  const bad = [
    [/NativeTransfer\.from: truncated/, Buffer.from([11, 0, 0, 0])],
    [/WrapXrs\.amount: truncated/, Buffer.from([13, 0, 0, 0, 1, 2])],
    [/NativeTransfer\.to: String is not valid UTF-8/, framed(11, 'a', [0xff], Buffer.alloc(8))],
    [/CancelConditionalOrder\.order_id: String is not valid UTF-8/, framed(24, [0xed, 0xa0, 0x80])], // UTF-8-encoded lone surrogate
    [/RWAUpdateStatus\.new_valuation: invalid Option tag 0x02/, Buffer.concat([framed(7, 't', 's'), Buffer.from([2])])],
    [/UpdateIdentity\.deactivated: invalid bool byte 0x02/, Buffer.concat([framed(19, 'k'), Buffer.from([0, 0, 2])])],
    [/RegisterAgent\.allowed_contracts: Vec<String> count/, Buffer.concat([framed(15, 'n', 'k'), Buffer.alloc(16), Buffer.from('ffffffffffffffff', 'hex')])],
  ];
  for (const [re, data] of bad) {
    assert.throws(() => assertInstructionSubmittable(data), (e) => e instanceof EncodingError && /does not decode as a XerisInstruction/.test(e.message) && re.test(e.message) && /network\.rs:180-187/.test(e.message), String(re));
    assert.throws(() => buildTransaction(H.GOLDEN_PUBKEY, [data], blockhashFromHex(H.GOLDEN_BLOCKHASH_HEX)), EncodingError, String(re));
  }
  // bincode::deserialize ignores trailing bytes; so does the SDK.
  assert.equal(assertInstructionSubmittable(Buffer.concat([validIx(), Buffer.from([1, 2, 3])])), 11);
});

test('buildTransaction refuses AgentExecute / ConditionalOrder payloads the block skips after the fee', () => {
  const kp = H.goldenKeypair();
  const bh = blockhashFromHex(H.GOLDEN_BLOCKHASH_HEX);
  const P = kp.publicKey;
  const O = H.OTHER_PUBKEY;
  const rejects = (ix, re) => assert.throws(() => buildTransaction(P, [ix], bh), (e) => e instanceof RangeError && re.test(e.message), String(re));
  const order = (type, inner) => Instructions.conditionalOrder('o', type, 's', 1, inner, 1000, 10n ** 9n);
  rejects(Instructions.agentExecute(P, Buffer.alloc(0)), /AgentExecute inner_instruction does not decode.*ledger\.rs:6399-6405/);
  rejects(Instructions.agentExecute(P, Buffer.from([11, 0, 0, 0])), /does not decode.*ledger\.rs:6399-6405/);
  rejects(Instructions.agentExecute(P, Instructions.tokenCreate('tok', 'N', 'S', 6, 1000, P)), /TokenCreate \(variant 3\) is not in the delegation allow-list.*ledger\.rs:6425-6484/);
  rejects(Instructions.agentExecute(P, Instructions.createIdentity(P, 'n', 'agent', '', '{}')), /CreateIdentity \(variant 18\) is not in the delegation allow-list/);
  rejects(Instructions.agentExecute(O, Instructions.contractCall('agent_registry_x', 'add_liquidity', { amount_a: 1 })), /may not call an agent registry.*ledger\.rs:6428-6431/);
  rejects(order('bogus', Instructions.wrapXrs(1)), /condition_type "bogus" is not one of.*ledger\.rs:6916-6921/);
  rejects(order('slot_reached', Buffer.from([11, 0, 0, 0])), /ConditionalOrder inner_instruction does not decode.*ledger\.rs:6923-6927/);
  rejects(order('slot_reached', Instructions.cancelConditionalOrder('x'.repeat(2100))), /2112 bytes, above the 2048-byte cap.*ledger\.rs:6941-6944/);
  // Accepted: a decodable, allow-listed inner instruction within the cap.
  assert.equal(buildTransaction(P, [order('slot_reached', Instructions.cancelConditionalOrder('x'.repeat(2036)))], bh).instructions.length, 1);
  assert.equal(buildTransaction(P, [Instructions.agentExecute(O, Instructions.wrapXrs(1))], bh).instructions.length, 1);
});

test('buildTransaction binds token-processor actor fields to the signer, and nested ones to the account they run as', () => {
  const kp = H.goldenKeypair();
  const bh = blockhashFromHex(H.GOLDEN_BLOCKHASH_HEX);
  const P = kp.publicKey;
  const O = H.OTHER_PUBKEY;
  const T = XerisKeypair.fromSeed(Buffer.alloc(32, 9)).publicKey;
  const build = (ix) => buildTransaction(P, [ix], bh);
  const rejects = (ix, re) => assert.throws(() => build(ix), (e) => e instanceof RangeError && re.test(e.message), String(re));
  const rwa = (authority) => Instructions.tokenCreateRWA('r', 'N', 'S', 0, 10, authority, 'real_estate', 'h', 'u', 'US', false, false, 1);
  rejects(Instructions.tokenTransfer('tok', O, P, 5), /TokenTransfer\.from .* is not the signer .*token\.rs:38-43, 1104/);
  rejects(Instructions.tokenBurn('tok', O, 5), /TokenBurn\.from .* is not the signer .*token\.rs:45-49, 1151/);
  rejects(Instructions.rwaTransfer('tok', O, P, 5), /RWATransfer\.from .* is not the signer .*token\.rs:118-123, 1306/);
  rejects(Instructions.tokenCreate('tok', 'N', 'S', 6, 1000, O), /TokenCreate\.mint_authority .* is not the signer .*token\.rs:51-58, 1036/);
  rejects(rwa(O), /TokenCreateRWA\.mint_authority .* is not the signer .*token\.rs:83-89, 1225/);
  // AgentExecute: the inner token instruction runs as the owner (ledger.rs:6522, 6648-6655).
  rejects(Instructions.agentExecute(O, Instructions.tokenTransfer('tok', T, P, 5)), /nested TokenTransfer\.from .* is not the AgentExecute owner .*ledger\.rs:6522, 6648-6655/);
  rejects(Instructions.agentExecute(O, Instructions.tokenBurn('tok', P, 5)), /nested TokenBurn\.from .* is not the AgentExecute owner/);
  // ConditionalOrder: the order owner is the signer (contracts.rs:3804-3806).
  const order = (inner) => Instructions.conditionalOrder('o', 'slot_reached', 's', 1, inner, 1000, 10n ** 9n);
  rejects(order(Instructions.tokenTransfer('tok', O, P, 5)), /nested TokenTransfer\.from .* is not the ConditionalOrder signer/);
  rejects(order(Instructions.tokenCreate('tok', 'N', 'S', 6, 1000, O)), /nested TokenCreate\.mint_authority .* is not the ConditionalOrder signer/);
  for (const ok of [
    Instructions.tokenTransfer('tok', P, O, 5),
    Instructions.tokenBurn('tok', P, 5),
    Instructions.rwaTransfer('tok', P, O, 5),
    Instructions.tokenCreate('tok', 'N', 'S', 6, 1000, P),
    rwa(P),
    Instructions.agentExecute(O, Instructions.tokenTransfer('tok', O, P, 5)),
    Instructions.agentExecute(O, Instructions.tokenBurn('tok', O, 5)),
    order(Instructions.tokenTransfer('tok', P, O, 5)),
  ]) {
    assert.equal(build(ok).instructions.length, 1);
  }
});
