'use strict';

/** XerisDApp with fake wallet providers and a scripted fetch. No network, no browser. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Transaction } = require('@solana/web3.js');

const {
  XerisDApp, Instructions, XerisError, FeatureDisabledError, TESTNET_SEED, DEFAULT_RPC_PORT,
  assembleSignedTransaction, blockhashFromHex, signatureOf,
} = require('..');
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
  const ix = Instructions.nativeTransfer(H.GOLDEN_PUBKEY, H.OTHER_PUBKEY, 5_000_000_000);
  const res = await dapp.sendInstruction(ix);
  assert.equal(res.status, 'ok');
  const post = fetch.calls.find((c) => c.url.endsWith('/submit'));
  const expected = assembleSignedTransaction(H.goldenKeypair(), ix, blockhashFromHex(H.GOLDEN_BLOCKHASH_HEX));
  assert.equal(Buffer.from(post.body.tx_base64, 'base64').toString('hex'), expected.txBytes.toString('hex'));
});

test('sendInstruction refuses what the node semantic gate rejects before asking the wallet', async () => {
  const fetch = fetchMock();
  let asked = 0;
  const dapp = new XerisDApp({ provider: provider((tx, kp) => { asked += 1; return signedWeb3(tx, kp); }), fetch });
  await dapp.connect();
  // The golden instruction pays 'Bob', not a canonical key (ledger.rs:1417-1419, 1569-1577).
  await assert.rejects(dapp.sendInstruction(Buffer.from(H.GOLDEN_IX_HEX, 'hex')), RangeError);
  assert.equal(asked, 0);
  assert.equal(fetch.calls.filter((c) => c.url.endsWith('/submit')).length, 0);
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

// ---------------------------------------------------------------------------
// Node URL resolution, provider detection, uncertain submissions (review fixes)
// ---------------------------------------------------------------------------

test('getRpcUrl(): only a bare host:56001 derives the explorer; any other URL is kept and needs an explorer URL', async () => {
  const withUrl = (url, extra = {}) => provider(detached, { getRpcUrl: async () => url, ...extra });
  const noPort = new XerisDApp({ provider: withUrl('https://rpc.example.com'), fetch: fetchMock() });
  await assert.rejects(noPort.connect(), (e) => e instanceof XerisError && e.code === 'config' && /explorer/.test(e.message));
  const gw = new XerisDApp({ provider: withUrl('https://gw.example.com/xeris-rpc/'), fetch: fetchMock(), explorerUrl: 'https://gw.example.com/xeris-explorer' });
  await gw.connect();
  assert.equal(gw.client.rpcUrl, 'https://gw.example.com/xeris-rpc');
  assert.equal(gw.client.explorerUrl, 'https://gw.example.com/xeris-explorer');
  const fromProvider = new XerisDApp({
    provider: withUrl('https://rpc.example.com', { getExplorerUrl: async () => 'https://explorer.example.com' }),
    fetch: fetchMock(),
  });
  await fromProvider.connect();
  assert.equal(fromProvider.client.rpcUrl, 'https://rpc.example.com');
  assert.equal(fromProvider.client.explorerUrl, 'https://explorer.example.com');
  const otherPort = new XerisDApp({ provider: withUrl('http://10.0.0.5:8899'), fetch: fetchMock() });
  await assert.rejects(otherPort.connect(), (e) => e instanceof XerisError && e.code === 'config');
  const bare = new XerisDApp({ provider: withUrl('https://10.0.0.5:56001/'), fetch: fetchMock() });
  await bare.connect();
  assert.equal(bare.client.rpcUrl, 'https://10.0.0.5:56001');
  assert.equal(bare.client.explorerUrl, 'https://10.0.0.5:50008');
});

test('opts.rpcUrl alone derives the explorer only from a bare host:56001', async () => {
  const d = new XerisDApp({ rpcUrl: 'http://10.0.0.5:56001', fetch: fetchMock() });
  assert.equal(d.client.explorerUrl, 'http://10.0.0.5:50008');
  const gw = new XerisDApp({ provider: provider(detached), rpcUrl: 'https://gw.example.com/rpc', fetch: fetchMock() });
  assert.equal(gw.client, null);
  await assert.rejects(gw.connect(), (e) => e instanceof XerisError && e.code === 'config');
  const gw2 = new XerisDApp({
    provider: provider(detached, { getExplorerUrl: async () => 'https://gw.example.com/explorer' }),
    rpcUrl: 'https://gw.example.com/rpc',
    network: 'mainnet',
    fetch: fetchMock(),
  });
  await gw2.connect();
  assert.equal(gw2.client.rpcUrl, 'https://gw.example.com/rpc');
  assert.equal(gw2.client.explorerUrl, 'https://gw.example.com/explorer');
});

test('detectProvider ignores a window.solana that does not set isXeris', () => {
  const saved = globalThis.window;
  try {
    globalThis.window = { solana: { connect: async () => 'x' } };
    assert.equal(XerisDApp.detectProvider(), null);
    globalThis.window = { solana: { isXeris: true, connect: async () => 'x' } };
    assert.equal(XerisDApp.detectProvider(), globalThis.window.solana);
    globalThis.window = { xeris: { connect: async () => 'x' }, solana: {} };
    assert.equal(XerisDApp.detectProvider(), globalThis.window.xeris);
  } finally {
    if (saved === undefined) delete globalThis.window;
    else globalThis.window = saved;
  }
});

test('a lost /submit reply after the wallet signed carries signature and txBase64', async () => {
  const hang = (url, init) => (url.endsWith('/submit')
    ? Promise.reject(new Error('socket hang up'))
    : fetchMock()(url, init));
  const dapp = new XerisDApp({ provider: provider(detached), fetch: hang });
  await dapp.connect();
  const err = await dapp.transferLamports(BOB, 5).catch((e) => e);
  assert.equal(err.code, 'rpc_transport');
  assert.equal(typeof err.signature, 'string');
  assert.equal(err.signature, signatureOf(Buffer.from(err.txBase64, 'base64')));
});

test('contract JSON args from the dApp carry bigint exactly and refuse undefined', async () => {
  const fetch = fetchMock();
  const dapp = new XerisDApp({ provider: provider(detached), fetch });
  await dapp.connect();
  await dapp.buyOnLaunchpad('lp', 50_000_000_000n, 15488583466903808n);
  const post = fetch.calls.filter((c) => c.url.endsWith('/submit')).at(-1);
  const data = Buffer.from(Transaction.from(Buffer.from(post.body.tx_base64, 'base64')).instructions[0].data);
  assert.ok(data.toString('utf8').endsWith('{"xrs_amount":50000000000,"min_tokens_out":15488583466903808}'));
  await assert.rejects(dapp.callContract('lp', 'buy_tokens', { xrs_amount: 1, min_tokens_out: undefined }), TypeError);
});

test('the constructor refuses unknown or non-object options', () => {
  assert.throws(() => new XerisDApp({ netwrok: 'mainnet' }), (e) => e instanceof RangeError && /opts\.netwrok: unknown option \(allowed: rpcPort, explorerPort, rpcUrl, explorerUrl, fetch, timeoutMs, provider, host, network\)/.test(e.message));
  assert.throws(() => new XerisDApp({ timeout: 5, host: 'http://h' }), (e) => e instanceof RangeError && /use timeoutMs/.test(e.message));
  for (const bad of [null, 5, []]) assert.throws(() => new XerisDApp(bad), TypeError, String(bad));
  const dapp = new XerisDApp({
    provider: provider(signedWeb3), host: 'http://h', network: 'mainnet', rpcPort: 1, explorerPort: 2, fetch: fetchMock(), timeoutMs: 5,
  });
  assert.equal(dapp.client.rpcUrl, 'http://h:1');
});

test('a ContractCall to a protected protocol method is refused before the wallet is asked', async () => {
  const fetch = fetchMock();
  let asked = 0;
  const dapp = new XerisDApp({ provider: provider((tx, kp) => { asked += 1; return signedWeb3(tx, kp); }), fetch });
  await dapp.connect();
  await assert.rejects(dapp.callContract('xeris_channels', 'close', { channel_id: 'c' }), (e) => e instanceof RangeError && /protected protocol method .*ledger\.rs:2184-2320, 5833-5837/.test(e.message));
  await assert.rejects(dapp.sendInstruction(Instructions.conditionalOrder('o', 'slot_reached', 's', 1, Instructions.wrapXrs(1), 1000, 10n ** 9n)), /does nothing when the order fires/);
  assert.equal(asked, 0);
  assert.equal(fetch.calls.filter((c) => c.url.endsWith('/submit')).length, 0);
});

test('connect refuses unknown option keys before asking the wallet', async () => {
  let asked = 0;
  const p = provider(signedWeb3);
  const realConnect = p.connect;
  p.connect = async (...a) => { asked++; return realConnect.apply(p, a); };
  const dapp = new XerisDApp({ provider: p, fetch: fetchMock() });
  await assert.rejects(dapp.connect({ onlyiftrusted: true }), RangeError);
  assert.equal(asked, 0);
  assert.deepEqual(await dapp.connect({ onlyIfTrusted: false }), { publicKey: H.GOLDEN_PUBKEY });
});
