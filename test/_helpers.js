'use strict';

/**
 * @file Shared fixtures for the `node --test` suite. Not a test file (the
 * `npm test` glob is `test/*.test.js`).
 */

const { XerisKeypair } = require('../src/keypair');

/** Seed of the golden transaction vector (blueprint §9.4): 32 bytes of 0x07. */
const GOLDEN_SEED = Buffer.alloc(32, 7);
/** Base58 public key for `GOLDEN_SEED`. */
const GOLDEN_PUBKEY = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
/** `NativeTransfer('Alice','Bob',5_000_000_000)`. */
const GOLDEN_IX_HEX = '0b0000000500000000000000416c6963650300000000000000426f6200f2052a01000000';
/** Blockhash of the golden vector as hex (64 x '1'). */
const GOLDEN_BLOCKHASH_HEX = '11'.repeat(32);
/** The 206-byte signed transaction, `bincode::serialize(&Transaction)`. */
const GOLDEN_TX_HEX = '01cbe4f7f2216b82d5b85dd4dabda7434e4e3d9a3741ab46ca820899d7f18624526b00f7ce5cdb15421bb99f397106e7d2dcc40f644dc8d2998d26170100bd680e01000102ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c0000000000000000000000000000000000000000000000000000000000000000111111111111111111111111111111111111111111111111111111111111111101010100240b0000000500000000000000416c6963650300000000000000426f6200f2052a01000000';
/** Base58 of the golden transaction's first signature. */
const GOLDEN_SIGNATURE = '55SMWqY4kr42cvjikRXTxywqsJ3hHMSiSYXn3RCAoAo66BSGjsgADW3qvJX4sbfJauATxqQupgvGmLxSjEE23cwf';

/** @returns {XerisKeypair} the golden keypair */
function goldenKeypair() {
  return XerisKeypair.fromSeed(GOLDEN_SEED);
}

/**
 * Scripted `fetch` replacement. `routes` maps a matcher to a responder:
 * the first entry whose matcher returns true for `(url, init, parsedBody)`
 * answers. A responder returns `{ status?, body }` (`body` is JSON-encoded
 * unless it is a string) or a function result of the same shape. Every call
 * is recorded in `fetch.calls` as `{ url, method, headers, body }`.
 * @param {Array<[(url: string, init: object, body: any) => boolean, any]>} routes
 * @returns {Function & { calls: object[] }}
 */
function mockFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ url, method: init.method, headers: init.headers, body });
    for (const [match, respond] of routes) {
      if (match(url, init, body)) {
        const r = typeof respond === 'function' ? respond(url, init, body) : respond;
        const status = r.status ?? 200;
        const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
        return { ok: status >= 200 && status < 300, status, statusText: '', text: async () => text };
      }
    }
    throw new Error(`mockFetch: no route for ${init.method} ${url} ${init.body ?? ''}`);
  };
  fn.calls = calls;
  return fn;
}

/** Matcher for a JSON-RPC call to `method`. */
const rpc = (method) => (url, init, body) => init.method === 'POST' && body && body.jsonrpc === '2.0' && body.method === method;
/** Matcher for `METHOD` on a URL ending with `suffix` (query included). */
const route = (method, suffix) => (url, init) => init.method === method && url.endsWith(suffix);

/** JSON-RPC `getLatestBlockhash` reply carrying the golden blockhash. */
const BLOCKHASH_REPLY = {
  body: { jsonrpc: '2.0', id: 1, result: { context: { slot: 100 }, value: { blockhash: GOLDEN_BLOCKHASH_HEX, lastValidBlockHeight: 250 } } },
};

module.exports = {
  GOLDEN_SEED,
  GOLDEN_PUBKEY,
  GOLDEN_IX_HEX,
  GOLDEN_BLOCKHASH_HEX,
  GOLDEN_TX_HEX,
  GOLDEN_SIGNATURE,
  goldenKeypair,
  mockFetch,
  rpc,
  route,
  BLOCKHASH_REPLY,
};
