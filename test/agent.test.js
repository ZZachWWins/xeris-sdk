'use strict';

/** XerisAgent: AgentExecute allow-list (ledger.rs:6425-6485), stubs, plans. Scripted fetch. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Transaction } = require('@solana/web3.js');

const { XerisAgent, XerisKeypair, Instructions, FeatureDisabledError, XerisError, AGENT_INNER_VARIANTS } = require('..');
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
