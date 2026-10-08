'use strict';

/** Node-derived constants, each checked against the cited Rust line. */

const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('..');

test('values match the node source', () => {
  const expected = {
    BASE_TX_FEE: 1_000_000, // ledger.rs:58
    MAX_IX_DATA_SIZE: 8192, // ledger.rs:93
    MAX_IX_PER_TX: 16, // ledger.rs:94
    MAX_ACCOUNTS_PER_TX: 64, // ledger.rs:95
    MAX_SLASH_IX_DATA_SIZE: 65_535, // ledger.rs:119
    UNBONDING_PERIOD_SLOTS: 151_200, // ledger.rs:201
    MIN_STAKE_LAMPORTS: 1_000_000_000_000, // ledger.rs:232
    BLOCKHASH_EXPIRY_WINDOW: 150, // ledger.rs:239
    ORDER_STORAGE_BOND: 10_000_000, // ledger.rs:1290
    MAX_ORDER_LIFETIME_SLOTS: 650_000, // ledger.rs:1295
    BASE_BLOCK_REWARD_LAMPORTS: 10_000_000_000, // ledger.rs:70
    HALVING_INTERVAL_BLOCKS: 25_000_000, // ledger.rs:75
    MIN_DEAL_DISPUTE_BOND: 1_000_000_000, // contracts.rs:1008
    DEAL_TIMEOUT_SLOTS: 648_000, // contracts.rs:1079
    MAX_TX_BYTES: 128 * 1024, // tx_pool.rs:183
    DEFAULT_RPC_PORT: 56001, // main.rs:831
    DEFAULT_EXPLORER_PORT: 50008, // main.rs:832
    CHAIN_ID_MAINNET: 'xeris-mainnet-v1', // ledger.rs:286
    CHAIN_ID_TESTNET: 'xeris-testnet-v1', // ledger.rs:287
    INSTRUCTION_COUNT: 62, // token.rs:30-808
    XRS_DECIMALS: 9,
    LAMPORTS_PER_XRS: 1_000_000_000,
  };
  for (const [k, v] of Object.entries(expected)) assert.equal(C[k], v, k);
  assert.equal(C.MAX_EMISSION_SUPPLY_LAMPORTS, 500_000_000n * 1_000_000_000n); // ledger.rs:65
  assert.equal(typeof C.MAX_EMISSION_SUPPLY_LAMPORTS, 'bigint');
});

test('tables are frozen and consistent', () => {
  assert.deepEqual([...C.DISABLED_VARIANTS], [22, 48, 49, 52]);
  for (const v of C.DISABLED_VARIANTS) assert.ok(v >= 0 && v < C.INSTRUCTION_COUNT);
  assert.equal(C.AGENT_OPERATIONS.length, 9);
  for (const name of ['DISABLED_VARIANTS', 'AGENT_OPERATIONS', 'AGENT_INNER_VARIANTS', 'CONTRACT_TYPE_ALIASES', 'STRING_LIMITS', 'DISABLED_FEATURES']) {
    assert.ok(Object.isFrozen(C[name]), name);
  }
  for (const v of Object.values(C.CONTRACT_TYPE_ALIASES)) assert.equal(typeof v, 'string');
  for (const t of C.PROTOCOL_MANAGED_CONTRACT_TYPES) assert.ok(Object.values(C.CONTRACT_TYPE_ALIASES).includes(t), t);
});
