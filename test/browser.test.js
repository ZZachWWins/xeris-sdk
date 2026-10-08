'use strict';

/**
 * Browser build: bundles the package with esbuild for `platform: 'browser'`
 * (no Node built-ins available) and runs `XerisDApp` inside a `vm` context
 * that has only web-platform globals: no `require`, `process`, `Buffer`,
 * `global` or `node:*` modules. A wallet provider signs, the SDK verifies the
 * signature and posts `{tx_base64}`; the posted bytes must equal what the
 * Node build assembles for the same key, instruction and blockhash.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const { assembleSignedTransaction, blockhashFromHex, Instructions } = require('..');
const H = require('./_helpers');

let esbuild = null;
try {
  esbuild = require('esbuild');
} catch (_) {
  esbuild = null;
}

const SKIP = esbuild === null ? 'esbuild (devDependency) is not installed; run npm install' : false;

/** Bundles index.js for browsers; returns the IIFE source. */
function bundle() {
  const out = esbuild.buildSync({
    stdin: { contents: "globalThis.XerisSDK = require('./index.js');", resolveDir: path.join(__dirname, '..'), loader: 'js' },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
    logLevel: 'silent',
  });
  assert.equal(out.errors.length, 0);
  return out.outputFiles[0].text;
}

test('the package bundles for browsers without Node built-ins', { skip: SKIP }, () => {
  const code = bundle();
  assert.doesNotMatch(code, /require\(["']node:/);
});

test('XerisDApp signs and submits inside a context with only web-platform globals', { skip: SKIP }, async () => {
  const code = bundle();
  const posted = [];
  const fetchMock = async (url, init) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    posted.push({ url, body });
    let reply;
    if (body && body.method === 'getLatestBlockhash') {
      reply = { jsonrpc: '2.0', id: body.id, result: { context: { slot: 100 }, value: { blockhash: H.GOLDEN_BLOCKHASH_HEX, lastValidBlockHeight: 250 } } };
    } else if (url.endsWith('/submit')) {
      reply = { status: 'ok', signature: 'from-node' };
    } else {
      throw new Error(`unexpected request ${url}`);
    }
    const text = JSON.stringify(reply);
    return { ok: true, status: 200, statusText: '', text: async () => text };
  };
  const sandbox = {
    console, TextEncoder, TextDecoder, URL, URLSearchParams, AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    crypto: webcrypto, fetch: fetchMock, atob, btoa,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const name of ['require', 'process', 'Buffer', 'global', 'module']) {
    assert.equal(vm.runInContext(`typeof ${name}`, ctx), 'undefined', `${name} must be absent`);
  }
  vm.runInContext(code, ctx);
  const run = vm.runInContext(`(async (seedHex, otherKey) => {
    const sdk = globalThis.XerisSDK;
    const seed = new Uint8Array(seedHex.match(/../g).map((h) => parseInt(h, 16)));
    const kp = sdk.XerisKeypair.fromSeed(seed);
    const provider = {
      connect: async () => ({ publicKey: kp.publicKey }),
      signTransaction: async (tx) => ({ signature: kp.sign(tx.serializeMessage()) }),
    };
    const dapp = new sdk.XerisDApp({ provider, host: 'http://127.0.0.1' });
    await dapp.connect();
    const ix = sdk.Instructions.nativeTransfer(kp.publicKey, otherKey, 5000000000);
    const res = await dapp.sendInstruction(ix);
    let refused = null;
    try { await dapp.sendInstruction(sdk.Instructions.nativeTransfer(kp.publicKey, 'Bob', 1)); } catch (e) { refused = e.name; }
    const hash = sdk.dealTermsHash('ship 1 widget');
    return { status: res.status, publicKey: kp.publicKey, refused, hashHex: Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('') };
  })`, ctx);
  const out = await run(H.GOLDEN_SEED.toString('hex'), H.OTHER_PUBKEY);
  assert.equal(out.status, 'ok');
  assert.equal(out.publicKey, H.GOLDEN_PUBKEY);
  assert.equal(out.refused, 'RangeError');
  assert.equal(out.hashHex, '734c5fd1cd9fd0bb047abb8c90edf73dd1cc4584be43973dd64c92a8402fa65d');
  const submit = posted.filter((p) => p.url.endsWith('/submit'));
  assert.equal(submit.length, 1);
  const expected = assembleSignedTransaction(
    H.goldenKeypair(),
    Instructions.nativeTransfer(H.GOLDEN_PUBKEY, H.OTHER_PUBKEY, 5_000_000_000),
    blockhashFromHex(H.GOLDEN_BLOCKHASH_HEX),
  );
  assert.equal(submit[0].body.tx_base64, expected.txBase64);
});
