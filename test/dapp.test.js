'use strict';

/** XerisDApp with fake wallet providers and a scripted fetch. No network, no browser. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Transaction } = require('@solana/web3.js');

const { XerisDApp, Instructions, XerisError, FeatureDisabledError, TESTNET_SEED, DEFAULT_RPC_PORT } = require('..');
const H = require('./_helpers');

const BOB = '11111111111111111111111111111112';

function fetchMock(extra = []) {
  return H.mockFetch([
    ...extra,
    [H.rpc('getLatestBlockhash'), H.BLOCKHASH_REPLY],
    [H.route('POST', '/submit'), { body: { status: 'ok', signature: H.GOLDEN_SIGNATURE } }],
  ]);
}

/** A provider whose signTransaction returns `shape(tx)` after signing with the golden key. */
function provider(shape, extra = {}) {
  const kp = H.goldenKeypair();
  return {
    isXeris: true,
    connect: async () => ({ publicKey: kp.publicKey }),
    signTransaction: async (tx) => shape(tx, kp),
    ...extra,
  };
}

const signedWeb3 = (tx, kp) => { const t = Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })); t.sign(kp.solanaKeypair); return t; };
const detached = (tx, kp) => ({ signature: new Uint8Array(kp.sign(tx.serializeMessage())) });

test('signTransaction returning a signed web3 Transaction: the SDK submits the verified bytes to /submit', async () => {
  const fetch = fetchMock();
  const dapp = new XerisDApp({ provider: provider(signedWeb3), fetch });
  assert.deepEqual(await dapp.connect(), { publicKey: H.GOLDEN_PUBKEY });
  assert.equal(dapp.client.rpcUrl, `http://${TESTNET_SEED}:${DEFAULT_RPC_PORT}`);
  const res = await dapp.sendInstruction(Buffer.from(H.GOLDEN_IX_HEX, 'hex'));
  assert.equal(res.status, 'ok');
  const post = fetch.calls.find((c) => c.url.endsWith('/submit'));
  assert.equal(Buffer.from(post.body.tx_base64, 'base64').toString('hex'), H.GOLDEN_TX_HEX);
});

test('signTransaction returning {signature} gives the same bytes', async () => {
  const fetch = fetchMock();
  const dapp = new XerisDApp({ provider: provider(detached), fetch });
  await dapp.connect();
  await dapp.transferLamports(BOB, 5);
  const post = fetch.calls.find((c) => c.url.endsWith('/submit'));
  const tx = Transaction.from(Buffer.from(post.body.tx_base64, 'base64'));
  assert.ok(tx.verifySignatures());
  assert.deepEqual(Buffer.from(tx.instructions[0].data), Instructions.nativeTransfer(H.GOLDEN_PUBKEY, BOB, 5));
});

test('a wallet signature over a different message is refused before submission', async () => {
  const fetch = fetchMock();
  const bad = provider((tx, kp) => ({ signature: new Uint8Array(kp.sign(Buffer.from('something else'))) }));
  const dapp = new XerisDApp({ provider: bad, fetch });
  await dapp.connect();
  await assert.rejects(dapp.transferLamports(BOB, 5), (e) => e instanceof XerisError && e.code === 'provider');
  assert.equal(fetch.calls.filter((c) => c.url.endsWith('/submit')).length, 0);
});

test('signAndSendTransaction only: no /submit call, result normalised', async () => {
  const fetch = fetchMock();
  const p = { connect: async () => H.GOLDEN_PUBKEY, signAndSendTransaction: async () => ({ signature: 'abc' }) };
  const dapp = new XerisDApp({ provider: p, fetch });
  await dapp.connect();
  assert.deepEqual(await dapp.transferXrs(BOB, '0.5'), { status: 'ok', signature: 'abc' });
  assert.equal(fetch.calls.filter((c) => c.url.endsWith('/submit')).length, 0);
});

test('a provider with neither signing method is refused', async () => {
  const dapp = new XerisDApp({ provider: { connect: async () => H.GOLDEN_PUBKEY }, fetch: fetchMock() });
  await dapp.connect();
  await assert.rejects(dapp.transferLamports(BOB, 1), (e) => e instanceof XerisError && e.code === 'provider');
});

test('connect resolves the node from provider.getRpcUrl(); mainnet without a host is a config error', async () => {
  const p = provider(detached, { getRpcUrl: async () => 'http://10.0.0.5:56001' });
  const dapp = new XerisDApp({ provider: p, fetch: fetchMock(), network: 'mainnet' });
  await dapp.connect();
  assert.equal(dapp.client.rpcUrl, 'http://10.0.0.5:56001');
  const noHost = new XerisDApp({ provider: provider(detached), fetch: fetchMock(), network: 'mainnet' });
  await assert.rejects(noHost.connect(), (e) => e instanceof XerisError && e.code === 'config');
});

test('writes before connect() are refused', async () => {
  const dapp = new XerisDApp({ provider: provider(detached), fetch: fetchMock() });
  await assert.rejects(dapp.transferLamports(BOB, 1), XerisError);
});

test('addLiquidity / removeLiquidity / swapTokens send the pool field names', async () => {
  const pool = { body: { success: true, contract: { state: { Swap: { token_a: 'XRS', token_b: 'xUSDC' } } } } };
  const fetch = fetchMock([[H.route('GET', '/contract/p1'), pool]]);
  const dapp = new XerisDApp({ provider: provider(detached), fetch });
  await dapp.connect();
  const sent = () => {
    const post = fetch.calls.filter((c) => c.url.endsWith('/submit')).at(-1);
    return Buffer.from(Transaction.from(Buffer.from(post.body.tx_base64, 'base64')).instructions[0].data);
  };
  await dapp.addLiquidity('p1', 1, 2, 3, 4, 5);
  assert.deepEqual(sent(), Instructions.contractCall('p1', 'add_liquidity', { amount_a: 1, amount_b: 2, min_lp_shares: 3, min_amount_a: 4, min_amount_b: 5 }));
  await dapp.removeLiquidity('p1', 7, 8, 9);
  assert.deepEqual(sent(), Instructions.contractCall('p1', 'remove_liquidity', { shares: 7, min_amount_a: 8, min_amount_b: 9 }));
  await dapp.swapTokens('p1', 'xUSDC', 10, 1);
  assert.deepEqual(sent(), Instructions.contractCall('p1', 'swap_b_to_a', Buffer.from('0a000000000000000100000000000000', 'hex')));
  await assert.rejects(dapp.addLiquidity('p1', 1, 2, 3, 4), TypeError);
});

test('airdrop and sendZkPrivateTransfer throw FeatureDisabledError synchronously', () => {
  const dapp = new XerisDApp({ provider: provider(detached), fetch: fetchMock() });
  assert.throws(() => dapp.airdrop('x', 1), FeatureDisabledError);
  assert.throws(() => dapp.sendZkPrivateTransfer(), FeatureDisabledError);
});
