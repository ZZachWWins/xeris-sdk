'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const util = require('node:util');

const { XerisKeypair, isCanonicalPubkey, pubkeyBytes, EncodingError } = require('..');
const H = require('./_helpers');

test('fromSeed / publicKey / publicKeyBytes', () => {
  const kp = H.goldenKeypair();
  assert.equal(kp.publicKey, H.GOLDEN_PUBKEY);
  assert.equal(kp.publicKeyBytes.length, 32);
  assert.deepEqual(kp.publicKeyBytes, pubkeyBytes(H.GOLDEN_PUBKEY));
  assert.throws(() => XerisKeypair.fromSeed(Buffer.alloc(31)));
});

test('fromSecretKey(toJsonBytes()) round-trips; secretKey is a copy', () => {
  const kp = XerisKeypair.generate();
  const bytes = kp.toJsonBytes();
  assert.equal(bytes.length, 64);
  assert.equal(XerisKeypair.fromSecretKey(bytes).publicKey, kp.publicKey);
  assert.equal(XerisKeypair.fromSecretKey(Uint8Array.from(bytes)).publicKey, kp.publicKey);
  const sk = kp.secretKey;
  sk.fill(0);
  assert.equal(XerisKeypair.fromSecretKey(kp.secretKey).publicKey, kp.publicKey);
  assert.throws(() => XerisKeypair.fromSecretKey(bytes.slice(0, 63)));
  assert.throws(() => XerisKeypair.fromSecretKey([...bytes.slice(0, 63), 256]), RangeError);
});

test('fromJsonFile / saveToFile use the node wallet format (JSON array of 64 ints, mode 0600)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xeris-kp-'));
  try {
    const kp = H.goldenKeypair();
    const file = path.join(dir, 'id.json');
    kp.saveToFile(file);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), kp.toJsonBytes());
    assert.equal(XerisKeypair.fromJsonFile(file).publicKey, H.GOLDEN_PUBKEY);
    const short = path.join(dir, 'short.json');
    fs.writeFileSync(short, JSON.stringify(kp.toJsonBytes().slice(0, 63)));
    assert.throws(() => XerisKeypair.fromJsonFile(short), EncodingError);
    const obj = path.join(dir, 'obj.json');
    fs.writeFileSync(obj, JSON.stringify({ secretKey: kp.toJsonBytes() }));
    assert.throws(() => XerisKeypair.fromJsonFile(obj), EncodingError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sign reproduces the web3.js signature of the golden transaction; verify checks it', () => {
  const kp = H.goldenKeypair();
  const tx = Buffer.from(H.GOLDEN_TX_HEX, 'hex');
  // Ed25519 is deterministic: signing the message bytes tx[65..] must give tx[1..65].
  assert.deepEqual(kp.sign(tx.subarray(65)), tx.subarray(1, 65));
  const msg = Buffer.from('xeris');
  const sig = kp.sign(msg);
  assert.equal(sig.length, 64);
  assert.ok(XerisKeypair.verify(kp.publicKey, msg, sig));
  assert.ok(XerisKeypair.verify(kp.publicKeyBytes, msg, sig));
  assert.equal(XerisKeypair.verify(kp.publicKey, Buffer.from('xeriz'), sig), false);
});

test('secret bytes never appear in JSON or inspect output', () => {
  const kp = H.goldenKeypair();
  const secretHex = Buffer.from(kp.secretKey).toString('hex').slice(0, 16);
  const secretList = kp.toJsonBytes().slice(0, 8).join(',');
  for (const text of [JSON.stringify(kp), util.inspect(kp, { depth: 5 }), String(kp)]) {
    assert.ok(!text.includes(secretHex), text);
    assert.ok(!text.includes(secretList), text);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(kp)), { publicKey: H.GOLDEN_PUBKEY });
});

test('isCanonicalPubkey mirrors the base58 round-trip rule (ledger.rs:1569-1577)', () => {
  assert.equal(isCanonicalPubkey(H.GOLDEN_PUBKEY), true);
  assert.equal(isCanonicalPubkey('11111111111111111111111111111111'), true);
  assert.equal(isCanonicalPubkey('0x00'), false);
  assert.equal(isCanonicalPubkey('__escrow'), false);
  assert.equal(isCanonicalPubkey('Alice'), false);
  assert.equal(isCanonicalPubkey(`1${H.GOLDEN_PUBKEY}`), false, 'leading 1 changes the decoded length');
  assert.throws(() => pubkeyBytes('Alice'), EncodingError);
});
