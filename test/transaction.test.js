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
/** A buffer of `len` bytes whose first four bytes are `u32le(variant)`. */
const sized = (variant, len) => Buffer.concat([encodeVariant(variant), Buffer.alloc(len - 4)]);

test('golden keypair and instruction', () => {
  const kp = H.goldenKeypair();
  assert.equal(kp.publicKey, H.GOLDEN_PUBKEY);
  assert.equal(Instructions.nativeTransfer('Alice', 'Bob', 5_000_000_000).toString('hex'), H.GOLDEN_IX_HEX);
});

test('assembleSignedTransaction reproduces the 206-byte golden transaction', () => {
  const kp = H.goldenKeypair();
  const out = assembleSignedTransaction(kp, ix(), blockhashFromHex(H.GOLDEN_BLOCKHASH_HEX));
  assert.equal(out.txBytes.toString('hex'), H.GOLDEN_TX_HEX);
  assert.equal(out.txBytes.length, 206);
  assert.equal(out.signature, H.GOLDEN_SIGNATURE);
  assert.equal(out.txBase64, out.txBytes.toString('base64'));
  const b = out.txBytes;
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
  const tx = buildTransaction(kp.publicKey, [ix()], blockhashFromHex(H.GOLDEN_BLOCKHASH_HEX));
  signTransaction(tx, kp);
  assert.equal(serializeTransaction(tx).toString('hex'), H.GOLDEN_TX_HEX);
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
  assert.equal(buildTransaction(kp.publicKey, Array(MAX_IX_PER_TX).fill(ix()), bh).instructions.length, MAX_IX_PER_TX);
  assert.throws(() => buildTransaction(kp.publicKey, Array(MAX_IX_PER_TX + 1).fill(ix()), bh), RangeError);
  assert.throws(() => buildTransaction(kp.publicKey, [], bh), RangeError);
  assert.throws(() => buildTransaction(kp.publicKey, [ix()], Buffer.alloc(31)));
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
  const unsigned = () => buildTransaction(kp.publicKey, [ix()], bh);
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
  for (const sizes of [[36], [4, 4], [127, 128, 129], [500, 400], Array(16).fill(20), [1000]]) {
    const ixs = sizes.map((n) => sized(11, n));
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
  for (const [name, ixs] of [['pqKeyRegister', [pqReg]], ['pqKeyRotate', [pqRot]], ['slashReport', [slash]], ['mixed', [pqReg, ix(), pqRot]]]) {
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
  const ixs = Array(MAX_IX_PER_TX).fill(sized(11, MAX_IX_DATA_SIZE));
  assert.throws(() => assembleSignedTransaction(kp, ixs, bh), RangeError);
});

test('serializeTransaction refuses an unsigned or wrongly signed SDK-shaped transaction', () => {
  const kp = H.goldenKeypair();
  const bh = blockhashFromHex(H.GOLDEN_BLOCKHASH_HEX);
  const tx = buildTransaction(kp.publicKey, [ix()], bh);
  assert.throws(() => serializeTransaction(tx), EncodingError);
  signTransaction(tx, kp);
  tx.signatures[0].signature = Buffer.alloc(64, 1);
  assert.throws(() => serializeTransaction(tx), EncodingError);
  const other = XerisKeypair.generate();
  assert.throws(() => signTransaction(buildTransaction(kp.publicKey, [ix()], bh), other), RangeError);
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
