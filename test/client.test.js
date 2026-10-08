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
  XerisClient, Instructions, RpcError, XerisError, EncodingError, FeatureDisabledError, checks, fromPlan, signatureOf,
  assembleSignedTransaction, blockhashFromHex,
  TESTNET_SEED, DEFAULT_RPC_PORT, DEFAULT_EXPLORER_PORT, MAINNET_HOST_ENV, LAMPORTS_PER_XRS, ORDER_STORAGE_BOND,
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

test('the constructor, testnet() and mainnet() refuse unknown or non-object options', () => {
  const f = async () => {};
  assert.throws(() => new XerisClient('http://1.2.3.4', { fetch: f, timeout: 5 }),
    (e) => e instanceof RangeError && /opts\.timeout: unknown option; use timeoutMs/.test(e.message));
  assert.throws(() => new XerisClient('http://1.2.3.4', { fetch: f, rpcport: 9 }),
    (e) => e instanceof RangeError && /opts\.rpcport: unknown option \(allowed: rpcPort, explorerPort, rpcUrl, explorerUrl, fetch, timeoutMs\)/.test(e.message));
  assert.throws(() => XerisClient.testnet({ fetch: f, timeout: 5 }), RangeError);
  assert.throws(() => XerisClient.mainnet('http://x', { fetch: f, explorerport: 1 }), RangeError);
  for (const bad of [null, 5, 'x', []]) assert.throws(() => new XerisClient('http://1.2.3.4', bad), TypeError, String(bad));
  const all = new XerisClient('http://1.2.3.4', { rpcPort: 1, explorerPort: 2, rpcUrl: 'http://a:3', explorerUrl: 'http://b:4', fetch: f, timeoutMs: 5 });
  assert.equal(all.timeoutMs, 5);
  assert.equal(all.rpcUrl, 'http://a:3');
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
    [() => c.getAccountInfo('addr'), `${EXP}/v2/account/addr`],
    [() => c.getStakeInfo('addr'), `${RPC}/stake/addr`],
    [() => c.getUnstaking('addr'), `${RPC}/account/addr/unstaking`],
    [() => c.getTokenBalance('addr', 'xUSDC'), `${RPC}/token/balance/addr/xUSDC`],
    [() => c.getContractQuote('p1', 'XRS', 5), `${RPC}/contract/p1/quote?input_token=XRS&amount=5`],
    [() => c.getLaunchpadQuote('lp', 7), `${RPC}/launchpad/lp/quote?xrs_amount=7`],
    [() => c.getPriceHistory('p1'), `${RPC}/price-history?pool_id=p1&limit=500`],
    [() => c.getTask('t-1'), `${RPC}/tasks/t-1`],
    [() => c.getTokenBalance('addr', 'USD:X'), `${RPC}/token/balance/addr/USD:X`],
    [() => c.getTokenHolders("a+b!$&'()*,;=@~._-"), `${EXP}/v2/token/a+b!$&'()*,;=@~._-/holders`],
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
  assert.throws(() => checks.agentInner(Instructions.stake(H.GOLDEN_PUBKEY, 1), H.GOLDEN_PUBKEY), FeatureDisabledError);
  assert.throws(() => checks.agentInner(Instructions.contractCall('pool1', 'swap_a_to_b', Buffer.alloc(16)), H.GOLDEN_PUBKEY), FeatureDisabledError);
  assert.equal(checks.agentInner(Instructions.nativeTransfer(H.GOLDEN_PUBKEY, BOB, 1), H.GOLDEN_PUBKEY), undefined);
  for (const text of ['{"amount_a":1e400}', '{"x":"\\ud800"}', '{"amount_a":-9223372036854775809}']) {
    assert.throws(() => checks.agentInner(Instructions.contractCall('pool', 'add_liquidity', Buffer.from(text)), H.GOLDEN_PUBKEY),
      (e) => e instanceof XerisError && /ledger\.rs:6436-6442/.test(e.message), text);
  }
  assert.equal(checks.agentInner(Instructions.contractCall('pool', 'add_liquidity', { amount_a: 1 }), H.GOLDEN_PUBKEY), undefined);
});

test('conditionalOrder refuses an inner ContractCall whose args the node cannot parse', async () => {
  const { c, fetch } = client();
  const kp = H.goldenKeypair();
  const inner = Instructions.contractCall('pool', 'add_liquidity', Buffer.from('{"amount_a":1e400,"x":"\\ud800"}'));
  await assert.rejects(c.conditionalOrder(kp, 'o1', 'slot_reached', 'x', 5, inner, 1000, 1_000_000_000),
    (e) => e instanceof RangeError && /ConditionalOrder args must be a JSON object/.test(e.message));
  assert.equal(fetch.calls.filter((x) => x.url.endsWith('/submit')).length, 0);
});

test('conditionalOrder refuses an inner instruction that does not decode (ledger.rs:6923-6927)', async () => {
  const { c, fetch } = client();
  const kp = H.goldenKeypair();
  const badContract = Buffer.concat([Buffer.from([4, 0, 0, 0]), Buffer.from('0100000000000000ff', 'hex'),
    Buffer.from('0100000000000000', 'hex'), Buffer.from('m'), Buffer.from('0200000000000000', 'hex'), Buffer.from('{}')]);
  for (const inner of [Buffer.from([11, 0, 0, 0]), badContract]) {
    await assert.rejects(c.conditionalOrder(kp, 'o', 'slot_reached', 's', 1, inner, 1000, 10n ** 9n),
      (e) => e instanceof EncodingError && /innerInstruction: does not decode as a XerisInstruction.*ledger\.rs:6923-6927/.test(e.message));
  }
  assert.equal(fetch.calls.length, 0);
});

test('raw sendInstruction refuses token instructions whose actor field is not the signer, before any I/O', async () => {
  const { c, fetch } = client();
  const kp = H.goldenKeypair();
  const third = H.OTHER_PUBKEY;
  await assert.rejects(c.sendInstruction(kp, Instructions.tokenTransfer('tok', third, kp.publicKey, 5)), (e) => e instanceof RangeError && /TokenTransfer\.from .* is not the signer/.test(e.message));
  await assert.rejects(c.sendInstruction(kp, Instructions.tokenCreate('tok', 'N', 'S', 6, 1000, third)), (e) => e instanceof RangeError && /TokenCreate\.mint_authority .* is not the signer/.test(e.message));
  await assert.rejects(c.sendInstruction(kp, Instructions.agentExecute(third, Buffer.from([11, 0, 0, 0]))), (e) => e instanceof RangeError && /AgentExecute inner_instruction does not decode/.test(e.message));
  assert.equal(fetch.calls.filter((x) => x.method === 'POST' && !x.body.jsonrpc).length, 0);
});

test('path parameters are sent unencoded; anything the node could not receive unchanged throws RangeError', async () => {
  const { c, fetch } = client([[() => true, { body: { success: true } }]]);
  for (const bad of ['a b', 'a/b', 'a#b', 'a%b', 'a?b', '..', '.', '\u6c60', 'a\\b', 'a"b', 'a`b', 'a{b}', 'a|b', 'a^b', 'a[0]', 'a<b>', '\u00e9', 'a\nb']) {
    await assert.rejects(c.getTokenBalance('addr', bad), RangeError, JSON.stringify(bad));
    await assert.rejects(c.getTask(bad), RangeError, JSON.stringify(bad));
    await assert.rejects(c.getContract(bad), RangeError, JSON.stringify(bad));
  }
  await assert.rejects(c.getTokenHolders(''), RangeError);
  assert.equal(fetch.calls.length, 0);
  await c.getTokenBalance('addr', 'USD:X');
  assert.equal(fetch.calls.at(-1).url, `${RPC}/token/balance/addr/USD:X`);
});

// ---------------------------------------------------------------------------
// u64 values in JSON: exact in both directions (review findings P1)
// ---------------------------------------------------------------------------

/** The JSON args text of the ContractCall carried by a submitted transaction. */
function submittedArgsText(call) {
  const data = submittedIx(call);
  let o = 4;
  const field = () => { const n = Number(data.readBigUInt64LE(o)); o += 8; const b = data.subarray(o, o + n); o += n; return b; };
  field(); field();
  return field().toString('utf8');
}

test('responses keep integers above 2^53-1 exact (bigint); smaller ones stay numbers', async () => {
  const big = '{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":1},"value":9007199254740993}}';
  const { c } = client([
    [H.rpc('getBalance'), { body: big }],
    [H.route('GET', '/launchpad/lp_x/quote?xrs_amount=50000000000'), { body: '{"xrs_amount":50000000000,"tokens_out":15488583466903808,"price_impact_pct":0.5}' }],
  ]);
  assert.equal(await c.getBalance(H.GOLDEN_PUBKEY), 9007199254740993n);
  const q = await c.getLaunchpadQuote('lp_x', 50_000_000_000n);
  assert.equal(q.tokens_out, 15488583466903808n);
  assert.equal(q.xrs_amount, 50000000000);
  assert.equal(q.price_impact_pct, 0.5);
});

test('launchpad, liquidity and deploy wrappers carry bigint u64 values exactly', async () => {
  const kp = H.goldenKeypair();
  const { c, fetch } = client();
  await c.buyOnLaunchpad(kp, 'lp_x', 50_000_000_000n, 15488583466903808n);
  assert.equal(submittedArgsText(lastPost(fetch)), '{"xrs_amount":50000000000,"min_tokens_out":15488583466903808}');
  await c.sellOnLaunchpad(kp, 'lp_x', 10n ** 16n, 0);
  assert.equal(submittedArgsText(lastPost(fetch)), '{"token_amount":10000000000000000,"min_xrs_out":0}');
  await c.addLiquidity(kp, 'pool', 10n ** 16n, 18446744073709551615n, 1, 1, 1);
  assert.equal(submittedArgsText(lastPost(fetch)), '{"amount_a":10000000000000000,"amount_b":18446744073709551615,"min_lp_shares":1,"min_amount_a":1,"min_amount_b":1}');
  await c.removeLiquidity(kp, 'pool', 10n ** 16n, 1n, 2);
  assert.equal(submittedArgsText(lastPost(fetch)), '{"shares":10000000000000000,"min_amount_a":1,"min_amount_b":2}');
  await c.deployContract(kp, 'mylp', 'launchpad', { total_supply: 10n ** 18n, name: 'M' });
  const deploy = submittedIx(lastPost(fetch));
  assert.ok(deploy.toString('utf8').endsWith('{"total_supply":1000000000000000000,"name":"M"}'));
  // A number above 2^53-1 has already lost precision: refused, not rounded.
  await assert.rejects(c.buyOnLaunchpad(kp, 'lp_x', 50_000_000_000, 15488583466903809), RangeError);
  await assert.rejects(c.sellOnLaunchpad(kp, 'lp_x', 2 ** 64, 0), RangeError);
});

test('callContract refuses values JSON.stringify would change, before any network call', async () => {
  const kp = H.goldenKeypair();
  const { c, fetch } = client();
  for (const [args, E] of [
    [{ xrs_amount: 1000, min_tokens_out: undefined }, TypeError],
    [{ xrs_amount: 1000, min_tokens_out: NaN }, RangeError],
    [{ xrs_amount: 9007199254740993, min_tokens_out: 1 }, RangeError],
    [{ xrs_amount: 2 ** 64, min_tokens_out: 1 }, RangeError],
    [{ note: '\uD800' }, RangeError],
    [{ nested: { f() {} } }, TypeError],
  ]) {
    await assert.rejects(c.callContract(kp, 'lp', 'buy_tokens', args), E);
  }
  assert.equal(fetch.calls.length, 0);
  await c.callContract(kp, 'lp', 'buy_tokens', { xrs_amount: 1000n, min_tokens_out: 2n ** 60n + 1n });
  assert.equal(submittedArgsText(lastPost(fetch)), '{"xrs_amount":1000,"min_tokens_out":1152921504606846977}');
});

test('planBuyLaunchpad + fromPlan sign the node\'s min_tokens_out exactly', async () => {
  const kp = H.goldenKeypair();
  const plan = '{"action":"buy_launchpad","variant_index":4,"variant_name":"ContractCall","params":{"contract_id":"lp_x","method":"buy_tokens","args":{"xrs_amount":50000000000,"min_tokens_out":15488583466903809}},"quote":{"tokens_out":16303771965161904,"min_tokens_out":15488583466903809}}';
  const { c, fetch } = client([[H.route('POST', '/agent/plan'), { body: plan }]]);
  const p = await c.planBuyLaunchpad('lp_x', 50_000_000_000n, 5);
  assert.equal(fetch.calls[0].rawBody, '{"action":"buy_launchpad","launchpad_id":"lp_x","xrs_amount":50000000000,"slippage_pct":5}');
  assert.equal(p.params.args.min_tokens_out, 15488583466903809n);
  await c.sendInstruction(kp, fromPlan(p));
  assert.equal(submittedArgsText(lastPost(fetch)), '{"xrs_amount":50000000000,"min_tokens_out":15488583466903809}');
  // The same plan parsed with JSON.parse has already rounded min_tokens_out.
  assert.throws(() => fromPlan(JSON.parse(plan)), (e) => e instanceof RangeError && /params\.args\.min_tokens_out/.test(e.message));
  const extra = JSON.parse(plan);
  extra.params.args = { xrs_amount: 1, min_tokens_out: 1, current_slot: 9 };
  assert.throws(() => fromPlan(extra), TypeError);
  const noFloor = JSON.parse(plan);
  noFloor.params.args = { xrs_amount: 1 };
  assert.throws(() => fromPlan(noFloor), TypeError);
});

test('planSwap and planBuyLaunchpad require slippagePct and always send it', async () => {
  const { c, fetch } = client([[H.route('POST', '/agent/plan'), { body: { action: 'swap', variant_index: 4, params: {} } }]]);
  await assert.rejects(c.planSwap('p', 't', 5), TypeError);
  await assert.rejects(c.planBuyLaunchpad('lp', 5), TypeError);
  await assert.rejects(c.planSwap('p', 't', 5, undefined), TypeError);
  await assert.rejects(c.planSwap('p', 't', 5, 101), RangeError);
  assert.equal(fetch.calls.length, 0);
  await c.planSwap('p', 't', 5, 0.5);
  assert.equal(fetch.calls[0].rawBody, '{"action":"swap","pool_id":"p","token_in":"t","amount_in":5,"slippage_pct":0.5}');
});

// ---------------------------------------------------------------------------
// Option objects: no silent drops, no silent clamps
// ---------------------------------------------------------------------------

test('getAccountTransactions takes an options object, refuses 4.x positional calls and clamped values', async () => {
  const page = { body: { success: true, data: [], pagination: { total: 0, page: 1, page_size: 20, total_pages: 1 }, cursor: null } };
  const { c, fetch } = client([[(url) => url.includes('/transactions'), page]]);
  await assert.rejects(c.getAccountTransactions('addr', 2, 50), TypeError);
  await assert.rejects(c.getAccountTransactions('addr', { page: 51 }), (e) => e instanceof RangeError && /before/.test(e.message));
  await assert.rejects(c.getAccountTransactions('addr', { pageSize: 201 }), RangeError);
  await assert.rejects(c.getAccountTransactions('addr', { page_size: 100 }), (e) => e instanceof RangeError && /pageSize/.test(e.message));
  assert.equal(fetch.calls.length, 0);
  // explorer.rs:1321-1322: with `before` the node ignores `page`.
  await assert.rejects(c.getAccountTransactions('addr', { page: 3, before: 10 }), (e) => e instanceof RangeError && /page or before/.test(e.message));
  assert.equal(fetch.calls.length, 0);
  await c.getAccountTransactions('addr', { pageSize: 200, before: 7 });
  assert.equal(fetch.calls[0].url, `${EXP}/v2/account/addr/transactions?page_size=200&before=7`);
  await c.getAccountTransactions('addr');
  assert.equal(fetch.calls[1].url, `${EXP}/v2/account/addr/transactions?page=1&page_size=20`);
  await c.getAccountTransactions('addr', { page: 50, pageSize: 200 });
  assert.equal(fetch.calls[2].url, `${EXP}/v2/account/addr/transactions?page=50&page_size=200`);
});

test('list, signature and price-history reads refuse values the node clamps or rewrites', async () => {
  const list = { body: { success: true, data: [], pagination: { total: 0, page: 1, page_size: 100, total_pages: 1 } } };
  const { c, fetch } = client([
    [(url) => url.includes('/v2/blocks') || url.includes('/v2/transactions'), list],
    [(url) => url.includes('/price-history'), { body: { pair: 'XRS-xUSDC', count: 0, history: [] } }],
    [H.rpc('getSignaturesForAddress'), { body: { jsonrpc: '2.0', id: 1, result: [] } }],
  ]);
  // explorer.rs:280, 1020 and 1114-1125 clamp page_size to 1..100.
  await assert.rejects(c.getBlocks(1, 101), (e) => e instanceof RangeError && /pageSize: 101 is above 100/.test(e.message));
  await assert.rejects(c.getTransactions(1, 500), (e) => e instanceof RangeError && /pageSize: 500 is above 100/.test(e.message));
  await assert.rejects(c.getBlocks(1, 0), RangeError);
  // tx_store.rs:57, 351 clamps limit to 1..200.
  await assert.rejects(c.getSignaturesForAddress('a', 201), (e) => e instanceof RangeError && /limit: 201 is above 200/.test(e.message));
  // network.rs:6030-6033 caps limit at 10,080; 6036-6039 strips pool_id characters.
  await assert.rejects(c.getPriceHistory('pool', 10081), (e) => e instanceof RangeError && /limit: 10081 is above 10080/.test(e.message));
  await assert.rejects(c.getPriceHistory('a.b', 10), (e) => e instanceof RangeError && /network\.rs:6036-6039/.test(e.message));
  await assert.rejects(c.getPriceHistory('', 10), RangeError);
  assert.equal(fetch.calls.length, 0);
  await c.getBlocks(1, 100);
  assert.equal(fetch.calls[0].url, `${EXP}/v2/blocks?page=1&page_size=100`);
  await c.getTransactions(2, 100);
  assert.equal(fetch.calls[1].url, `${EXP}/v2/transactions?page=2&page_size=100`);
  await c.getPriceHistory('pool_x-1', 10080);
  assert.equal(fetch.calls[2].url, `${RPC}/price-history?pool_id=pool_x-1&limit=10080`);
  await c.getSignaturesForAddress('a', 200);
  assert.deepEqual(fetch.calls[3].body.params, ['a', { limit: 200 }]);
});

test('searchCapabilities names the camelCase key for 4.x snake_case and refuses tags the node would split', async () => {
  const { c, fetch } = client([[(url) => url.includes('/capabilities/search'), { body: { success: true, data: [] } }]]);
  await assert.rejects(c.searchCapabilities({ min_rep: 50 }), (e) => e instanceof RangeError && /minRep/.test(e.message));
  await assert.rejects(c.searchCapabilities({ max_price: 10 }), (e) => e instanceof RangeError && /maxPrice/.test(e.message));
  await assert.rejects(c.searchCapabilities({ tags: ['a,b'] }), RangeError);
  await assert.rejects(c.searchCapabilities({ tags: [' a'] }), RangeError);
  await assert.rejects(c.searchCapabilities({ tags: [''] }), RangeError);
  await assert.rejects(c.searchCapabilities({ tags: 'a,b' }), TypeError);
  assert.equal(fetch.calls.length, 0);
  await c.searchCapabilities({ minRep: 50, maxPrice: 10n, tags: ['gpu', 'ml'] });
  assert.equal(fetch.calls[0].url, `${RPC}/capabilities/search?tags=gpu%2Cml&min_rep=50&max_price=10`);
});

test('cursor, registry-page and confirmation options refuse unknown keys and clamped values', async () => {
  const { c, fetch } = client();
  await assert.rejects(c.getTokens({ after: 'x', page_size: 5 }), (e) => e instanceof RangeError && /limit/.test(e.message));
  await assert.rejects(c.getTokens({ limit: 33 }), RangeError);
  await assert.rejects(c.getTokens({ limit: 0 }), RangeError);
  await assert.rejects(c.getContractV2('xeris_models', { page_size: 5 }), RangeError);
  await assert.rejects(c.getContractV2('xeris_models', { pageSize: 33 }), RangeError);
  await assert.rejects(c.waitForConfirmation('sig', { timeout: 5 }), RangeError);
  await assert.rejects(c.sendInstruction(H.goldenKeypair(), Instructions.wrapXrs(1), { rout: '/submit' }), RangeError);
  assert.equal(fetch.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Submission outcome unknown: the signature travels with the error
// ---------------------------------------------------------------------------

test('a timeout or transport failure after sending carries signature and txBase64', async () => {
  const kp = H.goldenKeypair();
  const posted = [];
  const hangOnSubmit = (url, init) => {
    if (url.endsWith('/submit')) {
      posted.push(JSON.parse(init.body).tx_base64);
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    return H.mockFetch([[H.rpc('getLatestBlockhash'), H.BLOCKHASH_REPLY]])(url, init);
  };
  const c = XerisClient.testnet({ fetch: hangOnSubmit, timeoutMs: 50 });
  const err = await c.transferLamports(kp, BOB, 5).catch((e) => e);
  assert.ok(err instanceof XerisError && err.code === 'timeout', String(err));
  assert.equal(err.txBase64, posted[0]);
  assert.equal(err.signature, signatureOf(Buffer.from(posted[0], 'base64')));
  assert.match(err.message, /do not sign again/);

  const refused = XerisClient.testnet({
    fetch: (url, init) => (url.endsWith('/submit') ? Promise.reject(new Error('ECONNRESET')) : hangOnSubmit(url, init)),
  });
  const err2 = await refused.transferLamports(kp, BOB, 5).catch((e) => e);
  assert.ok(err2 instanceof RpcError && err2.code === 'rpc_transport');
  assert.equal(typeof err2.signature, 'string');
  assert.equal(signatureOf(Buffer.from(err2.txBase64, 'base64')), err2.signature);
});

test('resending bytes the node already holds raises code duplicate with the signature', async () => {
  const kp = H.goldenKeypair();
  const { c } = client([[H.route('POST', '/submit'), (url, init, body) => ({
    body: { error: 'Transaction already in mempool', signature: signatureOf(Buffer.from(body.tx_base64, 'base64')) },
  })]]);
  const { txBase64, signature } = assembleSignedTransaction(kp, Instructions.nativeTransfer(kp.publicKey, BOB, 5), blockhashFromHex(H.GOLDEN_BLOCKHASH_HEX));
  const err = await c.submitSignedTransaction(txBase64).catch((e) => e);
  assert.ok(err instanceof RpcError);
  assert.equal(err.code, 'duplicate');
  assert.equal(err.message, 'Transaction already in mempool');
  assert.equal(err.signature, signature);
  assert.equal(err.txBase64, txBase64);
  const err2 = await c.transferLamports(kp, BOB, 5).catch((e) => e);
  assert.equal(err2.code, 'duplicate');
});

test('QueryCapabilities and semantic-gate violations are refused before signing', async () => {
  const kp = H.goldenKeypair();
  const { c, fetch } = client();
  await assert.rejects(c.sendInstruction(kp, Instructions.queryCapabilities('c', [], 'r', 0, 1)), (e) => e instanceof FeatureDisabledError && e.feature === 'QueryCapabilities');
  await assert.rejects(c.sendInstruction(kp, Instructions.validatorAttestation(BOB, 5, Buffer.alloc(32))), RangeError);
  await assert.rejects(c.sendInstruction(kp, Instructions.nativeTransfer(kp.publicKey, BOB, 0)), RangeError);
  await assert.rejects(c.sendInstruction(kp, Instructions.contractDeploy('c1', 'swap', 'not json')), RangeError);
  assert.equal(fetch.calls.filter((x) => x.url.endsWith('/submit')).length, 0);
});

test('callContract and sendInstruction refuse a protected protocol method (ledger.rs:2184-2320, 5833-5837)', async () => {
  const kp = H.goldenKeypair();
  const { c, fetch } = client();
  const top = /ContractCall \S+ is a protected protocol method .*\(ledger\.rs:2184-2320, 5833-5837\)/;
  for (const [id, m] of [['xeris_channels', 'close'], ['xeris_deals', 'settle'], ['xeris_tasks', 'claim'], ['xeris_governance', 'vote'], ['identity_abc', 'attest']]) {
    await assert.rejects(c.callContract(kp, id, m, {}), (e) => e instanceof RangeError && top.test(e.message), `${id}.${m}`);
  }
  assert.equal(fetch.calls.length, 0);
  await assert.rejects(c.sendInstruction(kp, Instructions.contractCall('xeris_channels', 'close', {})), (e) => e instanceof RangeError && top.test(e.message));
  await assert.rejects(c.sendInstruction(kp, Instructions.contractCall('identity_x', 'attest', {})), (e) => e instanceof RangeError && top.test(e.message));
  assert.equal(fetch.calls.filter((x) => x.url.endsWith('/submit')).length, 0);
  await c.callContract(kp, 'xeris_channels', 'challenge_update', { channel_id: 'c' });
  assert.deepEqual(submittedIx(lastPost(fetch)), Instructions.contractCall('xeris_channels', 'challenge_update', { channel_id: 'c' }));
});

test('conditionalOrder refuses inner instructions the order would not run, before any I/O', async () => {
  const kp = H.goldenKeypair();
  const { c, fetch } = client();
  const place = (inner, locked = 10n ** 9n) => c.conditionalOrder(kp, 'o', 'slot_reached', 's', 1, inner, 1000, locked);
  const noop = /innerInstruction: \w+ \(variant \d+\) does nothing when a conditional order fires; the node marks the order executed without running it \(ledger\.rs:9257-9272, 9301; token\.rs:1183-1199, 1333\)\. Allowed: TokenMint, TokenTransfer, TokenBurn, TokenCreate, ContractCall, TokenCreateRWA, RWAUpdateStatus, RWATransfer, NativeTransfer$/;
  for (const inner of [
    Instructions.wrapXrs(5),
    Instructions.stake(kp.publicKey, 10n ** 12n),
    Instructions.createDeal('d1', BOB, 10n ** 9n, 'terms'),
    Instructions.cancelConditionalOrder('o0'),
    Instructions.contractDeploy('cid', 'Swap', '{}'),
  ]) {
    await assert.rejects(place(inner), (e) => e instanceof RangeError && noop.test(e.message), inner.readUInt32LE(0).toString());
  }
  await assert.rejects(place(Instructions.contractCall('xeris_channels', 'close', {})),
    (e) => e instanceof RangeError && /innerInstruction: nested ContractCall xeris_channels\.close is a protected protocol method .*\(ledger\.rs:2184-2320, 9163-9166\)/.test(e.message));
  await assert.rejects(place(Instructions.contractCall('xeris_deals', 'settle', {})), /9163-9166/);
  await assert.rejects(place(Instructions.nativeTransfer(kp.publicKey, BOB, 5_000_000_000n), 10_000_000),
    (e) => e instanceof RangeError && /lockedAmount: 10000000 does not cover the inner NativeTransfer amount 5000000000; .*\(ledger\.rs:7008-7018\)/.test(e.message));
  await assert.rejects(place(Instructions.nativeTransfer(kp.publicKey, BOB, 1), ORDER_STORAGE_BOND - 1), /below the storage bond/);
  assert.equal(fetch.calls.length, 0);
  for (const inner of [
    Instructions.nativeTransfer(kp.publicKey, BOB, 5_000_000_000n),
    Instructions.tokenTransfer('tok', kp.publicKey, BOB, 5),
    Instructions.contractCall('pool', 'add_liquidity', { amount_a: 1 }),
    Instructions.contractCall('xeris_channels', 'challenge_update', { channel_id: 'c' }),
  ]) {
    await place(inner, 5_000_000_000n);
    assert.deepEqual(submittedIx(lastPost(fetch)), Instructions.conditionalOrder('o', 'slot_reached', 's', 1, inner, 1000, 5_000_000_000n));
  }
});
