'use strict';

/** XerisAgent: AgentExecute allow-list (ledger.rs:6425-6485), stubs, plans. Scripted fetch. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Transaction } = require('@solana/web3.js');

const { XerisAgent, XerisKeypair, Instructions, FeatureDisabledError, XerisError, EncodingError, AGENT_INNER_VARIANTS, checks } = require('..');
const H = require('./_helpers');

const BOB = '11111111111111111111111111111112';
const OWNER = H.GOLDEN_PUBKEY;

function make(extra = []) {
  const fetch = H.mockFetch([
    ...extra,
    [H.rpc('getLatestBlockhash'), H.BLOCKHASH_REPLY],
    [H.route('POST', '/submit'), { body: { status: 'ok', signature: 's' } }],
  ]);
  const kp = XerisKeypair.generate();
  return { agent: new XerisAgent(kp, OWNER, 'http://127.0.0.1', { fetch }), fetch, kp };
}
const sentIx = (fetch) => {
  const post = fetch.calls.filter((c) => c.url.endsWith('/submit')).at(-1);
  return Buffer.from(Transaction.from(Buffer.from(post.body.tx_base64, 'base64')).instructions[0].data);
};

test('the constructor requires a host; testnet()/mainnet() name the network', () => {
  const kp = XerisKeypair.generate();
  assert.throws(() => new XerisAgent(kp, OWNER), TypeError);
  assert.throws(() => new XerisAgent(kp, 'Alice', 'http://h'), RangeError);
  assert.ok(XerisAgent.testnet(kp, OWNER, { fetch: async () => {} }) instanceof XerisAgent);
  // Options go to XerisClient, which refuses unknown keys.
  assert.throws(() => new XerisAgent(kp, OWNER, 'http://h', { fetch: async () => {}, timeout: 5 }), (e) => e instanceof RangeError && /opts\.timeout: unknown option; use timeoutMs/.test(e.message));
  assert.throws(() => XerisAgent.testnet(kp, OWNER, { timeout: 5 }), RangeError);
  assert.throws(() => XerisAgent.mainnet(kp, OWNER, 'http://h', { rpcport: 1 }), RangeError);
});

test('execute wraps an allowed inner instruction in AgentExecute for the owner', async () => {
  const { agent, fetch } = make();
  const inner = Instructions.nativeTransfer(OWNER, BOB, 5);
  await agent.execute(inner);
  assert.deepEqual(sentIx(fetch), Instructions.agentExecute(OWNER, inner));
  await agent.transferXrs(BOB, '0.000000005');
  assert.deepEqual(sentIx(fetch), Instructions.agentExecute(OWNER, Instructions.nativeTransfer(OWNER, BOB, 5)));
});

test('execute rejects inner variants outside the allow-list and the no-op stake path', async () => {
  const { agent, fetch } = make();
  assert.deepEqual([...AGENT_INNER_VARIANTS].sort((a, b) => a - b), [0, 1, 2, 4, 9, 10, 11, 13, 14]);
  await assert.rejects(agent.execute(Instructions.stake(OWNER, 1)), FeatureDisabledError);
  await assert.rejects(agent.execute(Instructions.unstake(OWNER, 1)), FeatureDisabledError);
  await assert.rejects(agent.execute(Instructions.agentExecute(OWNER, Instructions.wrapXrs(1))), RangeError);
  await assert.rejects(agent.execute(Instructions.cancelConditionalOrder('o')), RangeError);
  await assert.rejects(agent.execute(Instructions.openDispute('d', 't', 's', BOB, 'r', 'e', 1)), RangeError);
  await assert.rejects(agent.execute(Instructions.contractCall('pool1', 'swap_a_to_b', Buffer.alloc(16))), FeatureDisabledError);
  await assert.rejects(agent.execute(Instructions.contractCall('esc', 'confirm', { a: 1 })), FeatureDisabledError);
  await assert.rejects(agent.execute(Instructions.contractCall('agent_registry_x', 'add_liquidity', { a: 1 })), (e) => e instanceof RangeError || e instanceof XerisError);
  assert.equal(fetch.calls.length, 0);
});

test('execute refuses delegated ContractCall args serde_json rejects (ledger.rs:6436-6442)', async () => {
  const { agent, fetch } = make();
  for (const text of ['{"amount_a":1e400}', '{"amount_a":1,"x":"\\ud800"}', '{"amount_a":18446744073709551616}']) {
    const inner = Instructions.contractCall('pool', 'add_liquidity', Buffer.from(text));
    await assert.rejects(agent.execute(inner), (e) => e instanceof XerisError && /ledger\.rs:6436-6442/.test(e.message), text);
  }
  assert.equal(fetch.calls.length, 0);
});

test('stubs throw FeatureDisabledError synchronously', () => {
  const { agent, fetch } = make();
  for (const name of ['swapTokens', 'buyOnLaunchpad', 'sellOnLaunchpad', 'stakeXrs', 'unstakeXrs', 'subDelegate']) {
    assert.throws(() => agent[name]('x', 1, 1), FeatureDisabledError, name);
  }
  assert.equal(fetch.calls.length, 0);
});

test('heartbeat takes exactly four arguments and signs as the agent', async () => {
  const { agent, fetch, kp } = make();
  await assert.rejects(agent.heartbeat('h', 1, 2), TypeError);
  await agent.heartbeat('h', 1, 2, 'ok');
  assert.deepEqual(sentIx(fetch), Instructions.agentHeartbeat(kp.publicKey, 'h', 1, 2, 'ok'));
});

test('planStake posts the owner key; findTasks filters the task list', async () => {
  const tasks = { body: { success: true, data: [
    { task_id: 'a', required_category: 'x', required_tags: ['gpu'], status: 'Open' },
    { task_id: 'b', required_category: 'y', required_tags: [], status: 'Open' },
  ] } };
  const plan = { body: { action: 'stake', variant_index: 9, variant_name: 'Stake', params: { pubkey: OWNER, amount: 1 } } };
  const { agent, fetch } = make([[H.route('GET', '/tasks'), tasks], [H.route('POST', '/agent/plan'), plan]]);
  await agent.planStake(1000);
  assert.deepEqual(fetch.calls.at(-1).body, { action: 'stake', pubkey: OWNER, amount_xrs: 1000 });
  assert.deepEqual((await agent.findTasks({ category: 'x' })).map((t) => t.task_id), ['a']);
  assert.deepEqual((await agent.findTasks({ tag: 'gpu' })).map((t) => t.task_id), ['a']);
  await assert.rejects(agent.findTasks({ colour: 'x' }), RangeError);
});

test('delegated JSON args carry bigint exactly and refuse values JSON.stringify would change', async () => {
  const { agent, fetch } = make();
  await agent.addLiquidity('pool1', 10n ** 16n, 2n ** 63n, 1, 1, 1);
  const inner = Instructions.contractCall('pool1', 'add_liquidity', {
    amount_a: 10n ** 16n, amount_b: 2n ** 63n, min_lp_shares: 1, min_amount_a: 1, min_amount_b: 1,
  });
  assert.deepEqual(sentIx(fetch), Instructions.agentExecute(OWNER, inner));
  assert.ok(inner.toString('utf8').endsWith('{"amount_a":10000000000000000,"amount_b":9223372036854775808,"min_lp_shares":1,"min_amount_a":1,"min_amount_b":1}'));
  await assert.rejects(agent.callContract('pool1', 'remove_liquidity', { shares: 1, min_amount_a: undefined, min_amount_b: 1 }), TypeError);
  await assert.rejects(agent.callContract('pool1', 'remove_liquidity', { shares: 2 ** 60, min_amount_a: 1, min_amount_b: 1 }), RangeError);
});

test('execute refuses inner bytes that do not decode, before any I/O (ledger.rs:6399-6405)', async () => {
  const { agent, fetch } = make();
  const badTo = Buffer.concat([Buffer.from([11, 0, 0, 0]), Buffer.from('0100000000000000', 'hex'), Buffer.from('a'),
    Buffer.from('0100000000000000ff', 'hex'), Buffer.alloc(8)]);
  for (const inner of [Buffer.from([11, 0, 0, 0]), Buffer.from([13, 0, 0, 0, 1, 2]), badTo, Buffer.alloc(0)]) {
    await assert.rejects(agent.execute(inner), (e) => e instanceof EncodingError && /does not decode as a XerisInstruction.*ledger\.rs:6399-6405/.test(e.message), inner.toString('hex'));
  }
  const badContract = Buffer.concat([Buffer.from([4, 0, 0, 0]), Buffer.from('0100000000000000ff', 'hex'),
    Buffer.from('0d00000000000000', 'hex'), Buffer.from('add_liquidity'), Buffer.from('0200000000000000', 'hex'), Buffer.from('{}')]);
  await assert.rejects(agent.execute(badContract), (e) => e instanceof EncodingError && /ContractCall\.contract_id: String is not valid UTF-8/.test(e.message));
  assert.equal(fetch.calls.length, 0);
});

test('execute refuses an inner TokenTransfer/TokenBurn whose from is not the owner (ledger.rs:6522, 6648-6655)', async () => {
  const { agent, fetch } = make();
  const third = XerisKeypair.generate().publicKey;
  await assert.rejects(agent.execute(Instructions.tokenTransfer('tok', third, BOB, 5)), (e) => e instanceof RangeError && /nested TokenTransfer\.from .* is not the AgentExecute owner .*token\.rs:1104/.test(e.message));
  await assert.rejects(agent.execute(Instructions.tokenBurn('tok', third, 5)), (e) => e instanceof RangeError && /nested TokenBurn\.from .* is not the AgentExecute owner .*token\.rs:1151/.test(e.message));
  assert.equal(fetch.calls.length, 0);
  await agent.execute(Instructions.tokenBurn('tok', OWNER, 5));
  assert.deepEqual(sentIx(fetch), Instructions.agentExecute(OWNER, Instructions.tokenBurn('tok', OWNER, 5)));
});

test('execute / callContract refuse a protected protocol method before any I/O (ledger.rs:2184-2320, 6432-6435)', async () => {
  const { agent, fetch } = make();
  const sealed = /innerInstruction: nested ContractCall \S+ is a protected protocol method .*\(ledger\.rs:2184-2320, 6432-6435\)/;
  // `create`, `open`, `post`, `place_order`, `cancel` are in DELEGATED_CALL_METHODS, so only the deny list catches them.
  await assert.rejects(agent.execute(Instructions.contractCall('xeris_deals', 'cancel', {})), (e) => e instanceof RangeError && sealed.test(e.message));
  await assert.rejects(agent.execute(Instructions.contractCall('xeris_deals', 'create', { amount: 5 })), (e) => e instanceof RangeError && sealed.test(e.message));
  await assert.rejects(agent.execute(Instructions.contractCall('xeris_conditional_orders', 'place_order', { order_id: 'o' })), (e) => e instanceof RangeError && sealed.test(e.message));
  await assert.rejects(agent.callContract('xeris_channels', 'open', { channel_id: 'c' }), (e) => e instanceof RangeError && sealed.test(e.message));
  await assert.rejects(agent.callContract('xeris_tasks', 'post', { task_id: 't' }), (e) => e instanceof RangeError && sealed.test(e.message));
  assert.equal(fetch.calls.length, 0);
  assert.throws(() => checks.agentInner(Instructions.contractCall('xeris_deals', 'create', { amount: 5 }), OWNER), (e) => e instanceof RangeError && sealed.test(e.message));
  assert.equal(checks.agentInner(Instructions.contractCall('xeris_channels', 'cancel', { channel_id: 'c' }), OWNER), undefined);
  await agent.callContract('pool1', 'cancel', { order_id: 'o' });
  assert.deepEqual(sentIx(fetch), Instructions.agentExecute(OWNER, Instructions.contractCall('pool1', 'cancel', { order_id: 'o' })));
});
