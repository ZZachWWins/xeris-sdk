# Changelog

## 5.0.0 — 2026-10-07

Rebuilt against the node source (`xeriscointestnet`, crate `xrs-node` 0.1.1). Every builder is checked against reference vectors that were verified byte-identical with the `bincode` 1.3.3 crate. The package now ships `index.js` (re-exports) plus `src/`.

### Breaking

- `Instructions.*` take positional parameters in Rust field order with strict arity (`EncodingError`, code `arity`, on a wrong count). The option-object forms `updateAgent(pk, opts)`, `updateIdentity(pk, opts)`, `updateCapability(provider, category, opts)`, `updateModel(pk, hash, opts)` and `tokenCreateRWA(opts)` are gone. `Option<T>` fields take `null`; `0`, `''` and `[]` are `Some`.
- `openDispute` has 7 parameters (`defendant` inserted after `subjectId`, `token.rs:499-509`); `forceCloseChannel` has 5 (`counterpartySignature` appended, `token.rs:581-587`). 4.x bytes for both were undecodable by the node.
- No builder or wrapper substitutes a default for a falsy value. 4.x encoded `'agent'`, `'{}'`, `'global'`, `'poster_confirm'`, `100`, `1`, `3`, `151200`, `'payment'`, `'groth16'`, `'custom'`, `'0.0.0'`, `'local'` and `'text'` when given `''` or `0`.
- `encodeU8` / `encodeU32` / `encodeU64` throw `RangeError` on out-of-range, non-integer or negative values and on numbers above 2^53-1 (pass a `bigint`), and `TypeError` on booleans and strings; strings with a lone UTF-16 surrogate throw `RangeError`; `encodeBytes` rejects `number[]` (`TypeError`).
- `contractCall(contractId, method, args)`: `args` is a `Buffer`/`Uint8Array` (sent raw) or a plain object (JSON-encoded). A Buffer is no longer JSON-encoded as `{"type":"Buffer",...}`.
- Token amounts on `createToken`, `mintTokens`, `transferToken` and `burnTokens` are base units; the trailing `decimals` parameter is removed.
- `addLiquidity(poolId, amountA, amountB, minLpShares, minAmountA, minAmountB)` and `removeLiquidity(poolId, shares, minAmountA, minAmountB)` send the five / three fields the node requires (`contracts.rs:2214-2231, 2378-2384`).
- `stakeXrs` posts to `POST /stake`, `unstakeXrs` to `POST /unstake`, `pqKeyRegister` to `POST /pq-register` by default (`opts.route = '/submit'` overrides); their responses carry `status: 'queued'`.
- Removed as working methods and replaced by synchronous `FeatureDisabledError` stubs: `airdrop` (both classes), `sendZkPrivateTransfer` (both), `zkPrivateTransfer`, `zkIdentityProof`, `pqSignedTransfer`, `sendPqTransfer`, `subDelegate` (client). `XerisAgent.swapTokens` and `buyOnLaunchpad` throw (the node refuses delegated swaps and launchpad calls, `ledger.rs:6436-6469, 6554-6556`). Removed without replacement: `buildPqTransferMessage`, `createZkPrivateTransferProofs`, `domainHash`.
- `Instructions.subDelegate`, `zkPrivateTransfer`, `zkIdentityProof` and `pqSignedTransfer` throw `FeatureDisabledError` (variants 22, 48, 49, 52: `ledger.rs:1445-1450, 8669-8685, 8687-8697, 8809-8828`).
- Every node error body throws `RpcError`, including HTTP 200 bodies with an `error` key and JSON-RPC results of the form `{ error }`. 4.x returned `{ error }` objects from read methods, and `XerisDApp._get` ignored the HTTP status.
- `XerisDApp` default network is `testnet`; mainnet needs `opts.host` / `opts.rpcUrl` or a provider `getRpcUrl()`. `XerisClient.mainnet(host)` and `XerisAgent.mainnet(kp, owner, host)` throw without a host or `XERIS_MAINNET_HOST`.
- `XerisAgent` constructor requires `host`; `heartbeat(currentModelHash, activeTasks, availableCapacity, statusMessage)` takes four positional arguments.
- `getAccountInfo` keeps the explorer `GET /v2/account/{address}` shape; the JSON-RPC `getAccountInfo` is `getAccountInfoRpc`.
- `TestVectors.<entry>()` now returns `{ name, variant, index, description, inputs, hex, bytes, length, expectedHex }`; `bytes` is a `Buffer` (was `number[]`). `description` and `hex` are unchanged.
- Node >= 18 (global `fetch`, `AbortController`, `crypto.sign(null, ...)`). `test.js` is replaced by `test/` (`npm test` runs `node --test test/*.test.js`).

### Added

- Builders 54-61 (`createDeal`, `acceptDeal`, `confirmDeal`, `cancelDeal`, `disputeDeal`, `settleDeal`, `reclaimDeal`, `zkVkRegister`) and `queryCapabilities` (30); `Variant` has 62 entries; `VARIANT_NAMES`, `BUILDER_NAMES`, `isDisabledVariant`, `fromPlan` (converts a `POST /agent/plan` response to instruction bytes).
- Encoding: `encodeString`, `encodeBytes`, `encodeStringVec` (the `encodeBincode*` names remain as aliases), `encodeFixedBytes`, `encodeVariant`, `readVariant`, `normalizeU64` / `normalizeU32` / `normalizeU8`, `xrsToLamports`, `lamportsToXrs`, `toBaseUnits`, `fromBaseUnits`.
- Message helpers: `dealTermsHash`, `buildPqRotationMessage`, `channelStateMessage`, `channelCloseMessage`.
- `XerisKeypair.sign` / `verify` / `fromSeed` / `publicKeyBytes`; `isCanonicalPubkey`, `pubkeyBytes`.
- Transaction layer: `blockhashFromHex`, `buildTransaction`, `signTransaction`, `serializeTransaction`, `assembleSignedTransaction`, `assertInstructionSubmittable`, `parseSubmitResponse`, `signatureOf`. For the single-signer layout `buildTransaction` produces, the SDK encodes the message and wire bytes itself instead of calling web3.js `serialize()`, whose 1.x message buffer is fixed at 1232 bytes. The node admits instruction data up to 8192 bytes (65,535 for SlashReport) and transactions up to 128 KiB (`network.rs:145-189`, `tx_pool.rs:183`), so `pqKeyRegister` (a 2035-byte instruction), `pqKeyRotate` (5351 bytes) and large `slashReport` / `zkVkRegister` / `contractDeploy` payloads can now be sent. The bytes equal web3.js output below 1232 bytes and were checked against `solana-transaction` 2.2.3 (the node's version) with `sanitize()`, `verify()` and byte-exact re-serialization up to 123 KB.
- `XerisClient`: `mainnet`, `getLatestBlockhashInfo`, `submitSignedTransaction`, `waitForConfirmation`, `isRateLimited`, `transferLamports`, `swap`, `swapByToken`, `createRwaToken`, `rwaUpdateStatus`, `rwaTransfer`, `updateIdentity`, `updateModel`, `forceCloseChannel`, `zkVkRegister`, seven deal wrappers, `getUnstaking`, `getVestingStatus`, `getGovernanceProposals`, `getGovernanceLock`, `getPriceHistory`, `getAllPoolPriceHistory`, `getTokens`, `getTokenHolders`, `getRwaTokens`, `getRwa`, `getContractsV2`, `getContractV2`, `getPools`, `getAccountInfoRpc`, `getBlockRpc`, `getTransactionRpc`, `getHealthRpc`, `getVersion`, `planStake` / `planWrap` / `planUnwrap`.
- `XerisAgent.mainnet`; `checks` (node business rules as pure functions); error classes `XerisError`, `EncodingError`, `FeatureDisabledError`, `RpcError` and the `DISABLED_FEATURES` table; the node constants in `src/constants.js` (each cited to the node source); `index.d.ts`; `TestVectors.all` / `verify` (20 vectors).

### Known limitations

- `XerisDApp` hands the unsigned web3.js `Transaction` to the wallet's `signTransaction`. A wallet that serializes it with web3.js 1.x cannot sign a message above 1232 bytes (for example a raw `PqKeyRegister` through `sendInstruction`); send those with `XerisClient` and a keypair, or through a wallet that serializes the message without that limit.

### Migration

| 4.x | 5.0 |
|---|---|
| `client.airdrop(address, xrs)` | `client.transferXrs(fundedKp, address, xrs)` |
| `client.sendZkPrivateTransfer(...)`, `client.sendPqTransfer(...)` | none; the node skips those variants |
| `client.createToken(kp, id, name, symbol, decimals, wholeUnits)` | `createToken(kp, id, name, symbol, decimals, maxSupplyBaseUnits)` |
| `client.mintTokens(kp, id, to, amount, decimals)` | `mintTokens(kp, id, to, baseUnits)` (same for `transferToken`, `burnTokens`) |
| `client.stakeXrs(kp, 1000)` via `/submit` | same call; goes to `POST /stake`, returns `status: 'queued'` |
| `dapp.addLiquidity(pool, a, b)` | `addLiquidity(pool, a, b, minLpShares, minA, minB)` |
| `dapp.removeLiquidity(pool, lpAmount)` | `removeLiquidity(pool, shares, minA, minB)` |
| `Instructions.updateAgent(pk, { newMaxDaily: 7 })` | `updateAgent(pk, null, 7, null, null, null, false)` |
| `Instructions.openDispute(id, type, subject, reason, evidence, bond)` | `openDispute(id, type, subject, defendant, reason, evidence, bond)` |
| `Instructions.forceCloseChannel(id, self, other, seq)` | `forceCloseChannel(id, self, other, seq, counterpartySignature)` |
| `Instructions.contractCall(id, method, buffer)` (JSON-encoded the Buffer) | same call; the Buffer is sent raw |
| `agent.heartbeat({ modelHash, activeTasks, capacity, status })` | `heartbeat(modelHash, activeTasks, capacity, status)` |
| `agent.swapTokens(...)`, `agent.buyOnLaunchpad(...)` | the owner signs: `client.swap(...)`, `client.buyOnLaunchpad(...)` |
| `new XerisAgent(kp, owner)` | `new XerisAgent(kp, owner, host)` or `XerisAgent.testnet(kp, owner)` |
| `if (result.error) ...` after a read | catch `RpcError` |

## 4.0.0

Previous release: single-file `index.js`, 54 `Variant` entries, `test.js`.
