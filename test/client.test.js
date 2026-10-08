'use strict';

/**
 * XerisClient against a scripted fetch: URLs and ports, request bodies, the
 * error rule (every node error body becomes RpcError, blueprint D6), write
 * routes, preflight checks and throwing stubs. No network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Transaction } = require('@solana/web3.js');

const {
  XerisClient, Instructions, RpcError, XerisError, FeatureDisabledError, checks,
  TESTNET_SEED, DEFAULT_RPC_PORT, DEFAULT_EXPLORER_PORT, MAINNET_HOST_ENV, LAMPORTS_PER_XRS,
} = require('..');
const H = require('./_helpers');

const RPC = `http://${TESTNET_SEED}:${DEFAULT_RPC_PORT}`;
const EXP = `http://${TESTNET_SEED}:${DEFAULT_EXPLORER_PORT}`;
const SUBMIT_OK = { body: { status: 'ok', signature: 'sig' } };

/** Client with a scripted fetch; `routes` are tried before the blockhash and /submit defaults. */
function client(routes = []) {
  const fetch = H.mockFetch([
    ...routes,
    [H.rpc('getLatestBlockhash'), H.BLOCKHASH_REPLY],
    [H.route('POST', '/submit'), SUBMIT_OK],
  ]);
  return { c: XerisClient.testnet({ fetch }), fetch };
}

/** Instruction data of the single instruction in a submitted `{tx_base64}` body. */
function submittedIx(call) {
  const tx = Transaction.from(Buffer.from(call.body.tx_base64, 'base64'));
  assert.equal(tx.instructions.length, 1);
  assert.ok(tx.verifySignatures(), 'submitted transaction is correctly signed');
  return Buffer.from(tx.instructions[0].data);
}
const lastPost = (fetch) => fetch.calls.filter((c) => c.method === 'POST' && !c.body.jsonrpc).at(-1);

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

test('testnet() and explicit hosts derive the RPC and explorer URLs', () => {
  const c = XerisClient.testnet({ fetch: async () => {} });
  assert.equal(c.rpcUrl, RPC);
  assert.equal(c.explorerUrl, EXP);
  const d = new XerisClient('https://node.example/', { fetch: async () => {}, rpcPort: 1, explorerPort: 2 });
  assert.equal(d.rpcUrl, 'https://node.example:1');
  assert.equal(d.explorerUrl, 'https://node.example:2');
  const e = new XerisClient(null, { fetch: async () => {}, rpcUrl: 'http://a:1', explorerUrl: 'http://b:2' });
  assert.equal(e.rpcUrl, 'http://a:1');
  assert.equal(e.explorerUrl, 'http://b:2');
});

test('mainnet() needs a host or the environment variable; nothing is hard-coded', () => {
  const saved = process.env[MAINNET_HOST_ENV];
  delete process.env[MAINNET_HOST_ENV];
  try {
    assert.throws(() => XerisClient.mainnet(), (e) => e instanceof XerisError && e.code === 'config');
    assert.equal(XerisClient.mainnet('http://x', { fetch: async () => {} }).rpcUrl, `http://x:${DEFAULT_RPC_PORT}`);
    process.env[MAINNET_HOST_ENV] = 'http://env-host';
    assert.equal(XerisClient.mainnet(undefined, { fetch: async () => {} }).explorerUrl, `http://env-host:${DEFAULT_EXPLORER_PORT}`);
  } finally {
    if (saved === undefined) delete process.env[MAINNET_HOST_ENV];
    else process.env[MAINNET_HOST_ENV] = saved;
  }
});

// ---------------------------------------------------------------------------
// Transport and the error rule
// ---------------------------------------------------------------------------

test('JSON-RPC requests carry jsonrpc/id/method/params and go to the explorer root', async () => {
  const { c, fetch } = client([[H.rpc('getBalance'), { body: { jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: 1234 } } }]]);
  assert.equal(await c.getBalance(H.GOLDEN_PUBKEY), 1234);
  const call = fetch.calls[0];
  assert.equal(call.url, `${EXP}/`);
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.Accept, 'application/json');
  assert.equal(call.body.jsonrpc, '2.0');
  assert.equal(typeof call.body.id, 'number');
  assert.equal(call.body.method, 'getBalance');
  assert.deepEqual(call.body.params, [H.GOLDEN_PUBKEY]);
});

test('HTTP 200 {"error"} bodies become RpcError (D6)', async () => {
  const { c } = client([[H.route('GET', '/contract/nope'), { body: { error: 'Contract not found' } }]]);
  await assert.rejects(c.getContract('nope'), (e) => {
    assert.ok(e instanceof RpcError);
    assert.equal(e.message, 'Contract not found');
    assert.equal(e.httpStatus, 200);
    return true;
  });
});

test('non-2xx and non-JSON responses become RpcError with rpc_http / rpc_json', async () => {
  const { c } = client([
    [H.route('GET', '/health'), { status: 404, body: 'not found' }],
    [H.route('GET', '/tokens'), { body: '<html>' }],
  ]);
  await assert.rejects(c.getHealth(), (e) => e instanceof RpcError && e.code === 'rpc_http' && e.httpStatus === 404);
  await assert.rejects(c.getTokenList(), (e) => e instanceof RpcError && e.code === 'rpc_json');
});

test('JSON-RPC {result:{error}} becomes RpcError; {result:null} is returned as null', async () => {
  const { c } = client([
    [H.rpc('getVersion'), { body: { jsonrpc: '2.0', id: 1, result: { error: 'Unknown method: getVersion' } } }],
    [H.rpc('getTransaction'), { body: { jsonrpc: '2.0', id: 1, result: null } }],
  ]);
  await assert.rejects(c.getVersion(), (e) => e instanceof RpcError && /Unknown method/.test(e.message));
  assert.equal(await c.getTransactionRpc('sig'), null);
});

test('transport failures and timeouts', async () => {
  const failing = new XerisClient('http://h', { fetch: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(failing.getHealth(), (e) => e instanceof RpcError && e.code === 'rpc_transport');
  const hanging = new XerisClient('http://h', {
    timeoutMs: 20,
    fetch: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
  });
  await assert.rejects(hanging.getHealth(), (e) => e instanceof XerisError && e.code === 'timeout');
});

test('isRateLimited detects the node limiter message', async () => {
  const msg = 'Rate limited. Max 30 write RPCs per minute per IP.';
  const { c } = client([[H.route('POST', '/submit'), { body: { error: msg } }]]);
  const err = await c.transferXrs(H.goldenKeypair(), H.GOLDEN_PUBKEY.replace('G', 'H'), 1).catch((e) => e);
  assert.ok(err instanceof RpcError, String(err));
  assert.equal(XerisClient.isRateLimited(err), true);
  assert.equal(XerisClient.isRateLimited(new RpcError('other')), false);
  assert.equal(XerisClient.isRateLimited(new Error(msg)), false);
});

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

const BOB = '11111111111111111111111111111112';

test('transferXrs converts XRS exactly and signs a NativeTransfer from the keypair', async () => {
  const kp = H.goldenKeypair();
  const { c, fetch } = client();
  const res = await c.transferXrs(kp, BOB, '0.29');
  assert.deepEqual(res, { status: 'ok', signature: 'sig' });
  const call = lastPost(fetch);
  assert.equal(call.url, `${RPC}/submit`);
  assert.deepEqual(Object.keys(call.body), ['tx_base64']);
  assert.deepEqual(submittedIx(call), Instructions.nativeTransfer(kp.publicKey, BOB, 290_000_000));
  await c.transferXrs(kp, BOB, 0.1 + 0.2 === 0.3 ? 1 : '0.3');
  assert.deepEqual(submittedIx(lastPost(fetch)), Instructions.nativeTransfer(kp.publicKey, BOB, 300_000_000));
});

test('transferXrs preflight refuses before any network call', async () => {
  const kp = H.goldenKeypair();
  const { c, fetch } = client();
  await assert.rejects(c.transferXrs(kp, '__escrow', 1), RangeError);
  await assert.rejects(c.transferXrs(kp, 'Alice', 1), RangeError);
  await assert.rejects(c.transferXrs(kp, BOB, 0), RangeError);
  await assert.rejects(c.transferXrs(kp, BOB, '0.0000000001'), RangeError);
  await assert.rejects(c.transferXrs(kp, BOB, -1), RangeError);
  await assert.rejects(c.transferXrs({ publicKey: kp.publicKey }, BOB, 1), TypeError);
  assert.equal(fetch.calls.length, 0);
});

test('stakeXrs / unstakeXrs / pqKeyRegister use their dedicated routes by default', async () => {
  const kp = H.goldenKeypair();
  const queued = { body: { status: 'queued', signature: 's' } };
  const { c, fetch } = client([
    [H.route('POST', '/stake'), queued], [H.route('POST', '/unstake'), queued], [H.route('POST', '/pq-register'), queued],
  ]);
  await c.stakeXrs(kp, 1000);
  assert.equal(lastPost(fetch).url, `${RPC}/stake`);
  assert.deepEqual(submittedIx(lastPost(fetch)), Instructions.stake(kp.publicKey, 1000 * LAMPORTS_PER_XRS));
  await c.stakeXrs(kp, 1000, { route: '/submit' });
  assert.equal(lastPost(fetch).url, `${RPC}/submit`);
  await c.unstakeXrs(kp, '1.5');
  assert.equal(lastPost(fetch).url, `${RPC}/unstake`);
  assert.deepEqual(submittedIx(lastPost(fetch)), Instructions.unstake(kp.publicKey, 1_500_000_000));
  await c.pqKeyRegister(kp, Buffer.alloc(1952, 0xab), 'dilithium3', 3);
  assert.equal(lastPost(fetch).url, `${RPC}/pq-register`);
  await assert.rejects(c.sendInstruction(kp, Instructions.wrapXrs(1), { route: '/airdrop' }), RangeError);
});

test('sendInstruction refuses disabled variants before signing', async () => {
  const { c, fetch } = client();
  const data = Buffer.concat([Buffer.from([22, 0, 0, 0]), Buffer.alloc(8)]);
  await assert.rejects(c.sendInstruction(H.goldenKeypair(), data), FeatureDisabledError);
  assert.equal(fetch.calls.length, 0);
});

test('postTask passes all 12 fields through unchanged', async () => {
  const kp = H.goldenKeypair();
  const { c, fetch } = client();
  const args = ['t1', 'Title', 'Desc', 'compute', ['gpu'], 0, 1_000_000_000, 5000, 3, 'oracle', 'oracle-1', 42];
  await c.postTask(kp, ...args);
  assert.deepEqual(submittedIx(lastPost(fetch)), Instructions.postTask(...args));
});

test('openDispute and forceCloseChannel send every Rust field', async () => {
  const kp = H.goldenKeypair();
  const { c, fetch } = client();
  await c.openDispute(kp, 'd1', 'task', 't1', BOB, 'late', 'ev', 1_000_000_000);
  assert.deepEqual(submittedIx(lastPost(fetch)), Instructions.openDispute('d1', 'task', 't1', BOB, 'late', 'ev', 1_000_000_000));
  await c.forceCloseChannel(kp, 'ch1', 100, 200, 0, Buffer.alloc(0));
  assert.deepEqual(submittedIx(lastPost(fetch)), Instructions.forceCloseChannel('ch1', 100, 200, 0, Buffer.alloc(0)));
  await assert.rejects(c.forceCloseChannel(kp, 'ch1', 100, 200, 1, Buffer.alloc(0)), RangeError);
});

test('swapByToken picks the direction from the pool state', async () => {
  const kp = H.goldenKeypair();
  const pool = { body: { success: true, contract: { contract_id: 'p1', state: { Swap: { token_a: 'XRS', token_b: 'xUSDC' } } } } };
  const { c, fetch } = client([[H.route('GET', '/contract/p1'), pool]]);
  await c.swapByToken(kp, 'p1', 'xUSDC', 10, 1);
  assert.deepEqual(submittedIx(lastPost(fetch)), Instructions.contractCall('p1', 'swap_b_to_a', Buffer.concat([Buffer.from('0a00000000000000', 'hex'), Buffer.from('0100000000000000', 'hex')])));
  await c.swapByToken(kp, 'p1', 'XRS', 10, 1);
  assert.equal(readMethod(submittedIx(lastPost(fetch))), 'swap_a_to_b');
  await assert.rejects(c.swapByToken(kp, 'p1', 'OTHER', 10, 1), RangeError);
  await assert.rejects(c.swap(kp, 'p1', 'swap_a_to_b', 10, 0), RangeError, 'explicit min_output required');
});

/** Method string of an encoded ContractCall. */
function readMethod(data) {
  let o = 4;
  const idLen = Number(data.readBigUInt64LE(o)); o += 8 + idLen;
  const mLen = Number(data.readBigUInt64LE(o)); o += 8;
  return data.subarray(o, o + mLen).toString('utf8');
}

test('addLiquidity / removeLiquidity send the JSON field names the pool reads', async () => {
  const kp = H.goldenKeypair();
  const { c, fetch } = client();
  await c.addLiquidity(kp, 'p1', 1, 2, 3, 4, 5);
  assert.deepEqual(submittedIx(lastPost(fetch)), Instructions.contractCall('p1', 'add_liquidity', { amount_a: 1, amount_b: 2, min_lp_shares: 3, min_amount_a: 4, min_amount_b: 5 }));
  await c.removeLiquidity(kp, 'p1', 7, 8, 9);
  assert.deepEqual(submittedIx(lastPost(fetch)), Instructions.contractCall('p1', 'remove_liquidity', { shares: 7, min_amount_a: 8, min_amount_b: 9 }));
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

test('read routes hit the documented paths; query parameters appear only when supplied', async () => {
  const ok = { body: { success: true } };
  const { c, fetch } = client([[() => true, ok]]);
  const cases = [
    [() => c.getTokens(), `${EXP}/v2/tokens`],
    [() => c.getTokens({ limit: 5 }), `${EXP}/v2/tokens?limit=5`],
    [() => c.getBlocks(), `${EXP}/v2/blocks?page=1&page_size=20`],
    [() => c.getAccountInfo('a b'), `${EXP}/v2/account/a%20b`],
    [() => c.getStakeInfo('addr'), `${RPC}/stake/addr`],
    [() => c.getUnstaking('addr'), `${RPC}/account/addr/unstaking`],
    [() => c.getTokenBalance('addr', 'xUSDC'), `${RPC}/token/balance/addr/xUSDC`],
    [() => c.getContractQuote('p1', 'XRS', 5), `${RPC}/contract/p1/quote?input_token=XRS&amount=5`],
    [() => c.getLaunchpadQuote('lp', 7), `${RPC}/launchpad/lp/quote?xrs_amount=7`],
    [() => c.getPriceHistory('p1'), `${RPC}/price-history?pool_id=p1&limit=500`],
    [() => c.getTask('t/1'), `${RPC}/tasks/t%2F1`],
  ];
  for (const [call, url] of cases) {
    await call();
    assert.equal(fetch.calls.at(-1).url, url);
    assert.equal(fetch.calls.at(-1).method, 'GET');
  }
});

test('getLatestBlockhashInfo decodes the hex blockhash', async () => {
  const { c } = client();
  assert.deepEqual(await c.getLatestBlockhashInfo(), { slot: 100, blockhash: H.GOLDEN_BLOCKHASH_HEX, lastValidBlockHeight: 250 });
  assert.equal((await c.getLatestBlockhash()).toString('hex'), H.GOLDEN_BLOCKHASH_HEX);
});

test('waitForConfirmation polls through "Transaction not found" and times out with XerisError', async () => {
  let n = 0;
  const detail = { status: 'confirmed', signature: 's' };
  const { c } = client([[H.route('GET', '/v2/tx/s'), () => (++n < 3 ? { body: { success: false, error: 'Transaction not found' } } : { body: { success: true, data: detail } })]]);
  const got = await c.waitForConfirmation('s', { intervalMs: 1, timeoutMs: 5000 });
  assert.equal(n, 3);
  assert.equal(got.status ?? got.data?.status, 'confirmed');
  const { c: c2 } = client([[H.route('GET', '/v2/tx/z'), { body: { success: false, error: 'Transaction not found' } }]]);
  await assert.rejects(c2.waitForConfirmation('z', { intervalMs: 1, timeoutMs: 0 }), (e) => e instanceof XerisError && e.code === 'timeout');
});

// ---------------------------------------------------------------------------
// Disabled features and checks
// ---------------------------------------------------------------------------

test('every throwing stub throws FeatureDisabledError synchronously without I/O', () => {
  const { c, fetch } = client();
  for (const name of ['subDelegate', 'zkPrivateTransfer', 'zkIdentityProof', 'pqSignedTransfer', 'sendZkPrivateTransfer',
    'sendPqTransfer', 'airdrop', 'claimStakingReward', 'governanceLock', 'governanceDelegate']) {
    assert.throws(() => c[name](H.goldenKeypair(), 'x', 1), (e) => e instanceof FeatureDisabledError && typeof e.citation === 'string' && e.citation.length > 0, name);
  }
  assert.equal(fetch.calls.length, 0);
});

test('checks: representative positive and negative cases', () => {
  assert.equal(checks.pubkey(H.GOLDEN_PUBKEY), undefined);
  assert.throws(() => checks.pubkey('Alice'), RangeError);
  assert.throws(() => checks.positive(0), RangeError);
  assert.equal(checks.positive(1n), undefined);
  assert.throws(() => checks.attestation(Buffer.alloc(31), 'a', 'a'), RangeError);
  assert.throws(() => checks.attestation(Buffer.alloc(32), 'a', 'b'), RangeError);
  assert.equal(checks.contractId('my_pool'), undefined);
  for (const id of ['xeris_pool', 'agent_registry_x', '__x', 'p_xrs_pool']) assert.throws(() => checks.contractId(id), RangeError, id);
  assert.equal(checks.contractType('swap'), undefined);
  assert.throws(() => checks.contractType('dealregistry_unknown'), RangeError);
  assert.throws(() => checks.contractType('deal'), (e) => e instanceof RangeError || e instanceof FeatureDisabledError || e instanceof XerisError, 'protocol-managed type');
  assert.throws(() => checks.noPqClaim('a Post-Quantum proof'), RangeError);
  assert.throws(() => checks.pqRegister(Buffer.alloc(1951), 'dilithium3', 3), RangeError);
  assert.equal(checks.pqRegister(Buffer.alloc(1952), 'dilithium3', 3), undefined);
  assert.throws(() => checks.dealBond(999_999_999), RangeError);
  assert.throws(() => checks.disputeId('deal_1'), RangeError);
  assert.throws(() => checks.votingPeriod(21_599), RangeError);
  assert.throws(() => checks.channelSignature(0, Buffer.alloc(64)), RangeError);
  assert.equal(checks.channelSignature(0n, Buffer.alloc(0)), undefined);
  assert.throws(() => checks.taskPost(1, 'poster_confirm', '', 't', 'd', 1), RangeError);
  assert.throws(() => checks.taskPost(0, 'oracle', '', 't', 'd', 1), RangeError);
  assert.throws(() => checks.agentOperations(['Stake2']), RangeError);
  assert.throws(() => checks.agentInner(Instructions.stake(H.GOLDEN_PUBKEY, 1)), FeatureDisabledError);
  assert.throws(() => checks.agentInner(Instructions.contractCall('pool1', 'swap_a_to_b', Buffer.alloc(16))), FeatureDisabledError);
  assert.equal(checks.agentInner(Instructions.nativeTransfer(H.GOLDEN_PUBKEY, BOB, 1)), undefined);
});
