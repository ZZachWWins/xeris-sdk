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
- Node >= 18 (global `fetch`, `AbortController`). `test.js` is replaced by `test/` (`npm test` runs `node --test test/*.test.js`).
- Read-method signatures changed (see Migration): `getContractQuote(id, inputToken, amount)`, `XerisDApp.getSwapQuote(poolId, inputToken, amount)`, `getAccountTransactions(address, { page, pageSize, before })` (a positional page number throws `TypeError`), `searchCapabilities({ category, tags, region, minRep, maxPrice, limit })` with camelCase keys and `tags` as an array.
- Option objects reject unknown keys with `RangeError` (`searchCapabilities`, `getAccountTransactions`, `getTokens`/`getTokenHolders`/`getRwaTokens`/`getRwa`/`getContractsV2`/`getPools`, `getContractV2`, `waitForConfirmation`, `sendInstruction`); 4.x snake_case names such as `min_rep`, `max_price`, `page_size` are named in the message with their replacement. Values the node would clamp or rewrite throw instead: `page` > 50 and `pageSize` > 200 on account history (`explorer.rs:1305-1307`), `page` together with `before` on account history (the node ignores `page`, `explorer.rs:1321-1322`), `limit` / `pageSize` > 32 on registry pages (`explorer.rs:126, 1855-1856`), `pageSize` > 100 on `getBlocks` / `getTransactions` (`explorer.rs:280, 1020, 1114-1125`), `limit` > 200 on `getSignaturesForAddress` (`tx_store.rs:57, 351`), `limit` > 10,080 on `getPriceHistory` and a `poolId` outside `[A-Za-z0-9_-]` (the node strips those characters, `network.rs:6030-6039`). A capability tag that is empty, contains `,` or has surrounding whitespace throws (`network.rs:5593-5594`).
- `fromPlan` applies the u64 range to every plan amount, including `params.args.xrs_amount` / `min_tokens_out` of a buy plan: a negative `min_tokens_out` would read as `None` and remove the slippage floor (`contracts.rs:2849-2850`).
- `planSwap` and `planBuyLaunchpad` require `slippagePct` (the node would apply 5%, `network.rs:5421, 5485`).
- `createIdentity(keypair, displayName, identityType, metadataJson)` no longer takes `parentIdentity` (a non-empty parent must co-sign, which this path cannot do); `postTask` takes all 13 fields; `XerisAgent.sendMessage` takes `expiresAtSlot`; `XerisClient` has no `rpcPort`/`explorerPort` properties and `host`/`rpcUrl`/`explorerUrl` are read-only.
- Responses are parsed losslessly: an integer above 2^53-1 (balances, token supplies, quotes, a plan's `min_tokens_out`) is a `bigint`; everything smaller stays a `number`. `getBalance` returns `number | bigint`. In `index.d.ts` these fields are `U64Output` (`number | bigint`), including the `AgentPlan` amounts and quotes, `RpcAccountInfo.value.lamports` / `stake` and `RpcTransaction.transaction.amount`.
- `xrsToLamports` / `toBaseUnits` refuse a `number` that is an integer above 2^53-1 or a non-integer with more than 15 significant digits (`9999999.999999999` reads as the double printed `9999999.999999998`); pass a decimal string.
- `buildTransaction` (and so every send path, including raw `sendInstruction`) applies the node's stateless semantic gate (`ledger.rs:1382-1455`) for the payer and refuses ContractCall args the block cannot parse, at the top level and inside AgentExecute / ConditionalOrder (`ledger.rs:2359-2371, 6436-6442, 9181`), ContractDeploy params that are not a JSON object (`ledger.rs:6187`), and instructions whose actor field (`from`, `pubkey`, `identity_pubkey`, `provider_identity`, `claimant_identity`, `ed25519_pubkey`, HardwareAttest `device_pubkey` / `bound_identity`) is not the signer, which the block skips after charging the fee. QueryCapabilities (variant 30, a paid no-op, `ledger.rs:7460-7464`) is refused with `FeatureDisabledError`; its builder still encodes.
- `XerisDApp.detectProvider()` no longer falls back to a `window.solana` without `isXeris`. A `getRpcUrl()` that is not a bare `scheme://host:56001` is used unchanged as the RPC URL and needs `opts.explorerUrl` or `provider.getExplorerUrl()`; 4.x appended `:56001` and dropped any path.
- Read methods send path parameters unencoded and throw `RangeError` for a value the node cannot receive unchanged: empty, `.` / `..`, or containing a character outside RFC 3986 `pchar` (space, `/`, `?`, `#`, `%`, non-ASCII, ...). The node's router (warp 0.3.7 `path::param`) does not percent-decode, so an encoded id was looked up under its encoded spelling and returned the node's empty or not-found answer. Read such records from a list route (`getTokens`, `getTasks`, `getRwaTokens`).
- `assertInstructionSubmittable` (and so every send path) requires the whole instruction to decode as a `XerisInstruction` (`network.rs:180-187`); `XerisAgent.execute` and `XerisClient.conditionalOrder` require the same of the inner instruction (`ledger.rs:6399-6405, 6923-6927`). Otherwise `EncodingError`.
- `buildTransaction` also refuses: TokenTransfer / TokenBurn / RWATransfer `from` and TokenCreate / TokenCreateRWA `mint_authority` other than the signer (`token.rs:1036, 1104, 1151, 1225, 1306`); an AgentExecute inner instruction that does not decode or is outside `AGENT_INNER_VARIANTS` (`ledger.rs:6399-6405, 6478-6484`), an inner ContractCall to an `agent_registry_` contract (`ledger.rs:6428-6431`), or an inner TokenTransfer / TokenBurn whose `from` is not the owner (`ledger.rs:6522, 6648-6655`); a ConditionalOrder whose `condition_type` is not in `CONDITION_TYPES`, whose inner instruction does not decode or exceeds 2048 bytes (`ledger.rs:6916-6944`), or whose inner token instruction's `from` / `mint_authority` is not the signer (`ledger.rs:9270-9272`).
- `checks.agentInner(innerData, ownerPubkey)` takes the owner as a second, required argument.

### Added

- Builders 54-61 (`createDeal`, `acceptDeal`, `confirmDeal`, `cancelDeal`, `disputeDeal`, `settleDeal`, `reclaimDeal`, `zkVkRegister`) and `queryCapabilities` (30); `Variant` has 62 entries; `VARIANT_NAMES`, `BUILDER_NAMES`, `isDisabledVariant`, `fromPlan` (converts a `POST /agent/plan` response to instruction bytes).
- Encoding: `encodeString`, `encodeBytes`, `encodeStringVec` (the `encodeBincode*` names remain as aliases), `encodeFixedBytes`, `encodeVariant`, `readVariant`, `normalizeU64` / `normalizeU32` / `normalizeU8`, `xrsToLamports`, `lamportsToXrs`, `toBaseUnits`, `fromBaseUnits`.
- Message helpers: `dealTermsHash`, `buildPqRotationMessage`, `channelStateMessage`, `channelCloseMessage`.
- `XerisKeypair.sign` / `verify` / `fromSeed` / `publicKeyBytes`; `isCanonicalPubkey`, `pubkeyBytes`.
- Transaction layer: `blockhashFromHex`, `buildTransaction`, `signTransaction`, `serializeTransaction`, `assembleSignedTransaction`, `assertInstructionSubmittable`, `parseSubmitResponse`, `signatureOf`. For the single-signer layout `buildTransaction` produces, the SDK encodes the message and wire bytes itself instead of calling web3.js `serialize()`, whose 1.x message buffer is fixed at 1232 bytes. The node admits instruction data up to 8192 bytes (65,535 for SlashReport) and transactions up to 128 KiB (`network.rs:145-189`, `tx_pool.rs:183`), so `pqKeyRegister` (a 2035-byte instruction), `pqKeyRotate` (5351 bytes) and large `slashReport` / `zkVkRegister` / `contractDeploy` payloads can now be sent. The bytes equal web3.js output below 1232 bytes and were checked against `solana-transaction` 2.2.3 (the node's version) with `sanitize()`, `verify()` and byte-exact re-serialization up to 123 KB.
- `XerisClient`: `mainnet`, `getLatestBlockhashInfo`, `submitSignedTransaction`, `waitForConfirmation`, `isRateLimited`, `transferLamports`, `swap`, `swapByToken`, `createRwaToken`, `rwaUpdateStatus`, `rwaTransfer`, `updateIdentity`, `updateModel`, `forceCloseChannel`, `zkVkRegister`, seven deal wrappers, `getUnstaking`, `getVestingStatus`, `getGovernanceProposals`, `getGovernanceLock`, `getPriceHistory`, `getAllPoolPriceHistory`, `getTokens`, `getTokenHolders`, `getRwaTokens`, `getRwa`, `getContractsV2`, `getContractV2`, `getPools`, `getAccountInfoRpc`, `getBlockRpc`, `getTransactionRpc`, `getHealthRpc`, `getVersion`, `planStake` / `planWrap` / `planUnwrap`.
- `XerisAgent.mainnet`; `checks` (node business rules as pure functions); error classes `XerisError`, `EncodingError`, `FeatureDisabledError`, `RpcError` and the `DISABLED_FEATURES` table; the node constants in `src/constants.js` (each cited to the node source); `index.d.ts`; `TestVectors.all` / `verify` (20 vectors).
- `stringifyJson` / `parseJson`: the JSON writer and reader every class uses. Contract-call args, deploy params and request bodies write `bigint` as exact integers (u64 up to 2^64-1, which the node reads exactly with `as_u64`) and throw on what `JSON.stringify` would change (`NaN`, `undefined`, functions, integers above 2^53-1, lone surrogates). Responses keep integers above 2^53-1 exact as `bigint`.
- `hardwareAttestChallenge(devicePubkey, boundIdentity, deviceType, manufacturer, model, firmwareVersion, slot)` (`ledger.rs:5299-5319`).
- Errors after a signed transaction was sent (`timeout`, `rpc_transport`, `rpc_http`, `rpc_json`) carry `err.signature` and `err.txBase64`; a write route answering `Transaction already processed` / `already in mempool` raises `RpcError` with code `duplicate`. Recover with `waitForConfirmation(err.signature)` or `submitSignedTransaction(err.txBase64)`, never by signing again.
- Named ES-module imports (`import { Instructions } from 'xeris-sdk'`) for every export.
- Browser support: Ed25519 and SHA-256 via `@noble/curves` / `@noble/hashes`, `Buffer` from the `buffer` package, `fs` loaded only by the keypair file helpers and mapped to an empty module through `package.json` `browser`. New dependencies: `@noble/curves`, `@noble/hashes`, `buffer` (all already installed by `@solana/web3.js`); dev dependency `esbuild` for the browser test.

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
| `client.getContractQuote(id, { input_token, amount })` | `getContractQuote(id, inputToken, amount)` |
| `dapp.getSwapQuote(contractId, { input_token, amount })` | `getSwapQuote(poolId, inputToken, amount)` |
| `client.getAccountTransactions(addr, page, size)` | `getAccountTransactions(addr, { page, pageSize, before })`; past page 50 use `before: previous.cursor` |
| `client.searchCapabilities({ min_rep, max_price, tags: 'a,b' })` | `searchCapabilities({ minRep, maxPrice, tags: ['a', 'b'] })` |
| `client.getTokens({ after, page_size })` | `getTokens({ after, limit })` (`limit` 1..32) |
| `client.planSwap(pool, tokenIn, amountIn)` | `planSwap(pool, tokenIn, amountIn, slippagePct)` (same for `planBuyLaunchpad`) |
| `client.createIdentity(kp, name, type, parentIdentity, metadata)` | `createIdentity(kp, name, type, metadataJson)` |
| `client.postTask(kp, id, title, desc, category, tags, minRep, reward, expires, maxClaim, verification)` | `postTask(..., verification, verificationOracle, verificationThreshold)` (13 parameters) |
| `agent.sendMessage(to, type, payload, replyTo)` | `sendMessage(to, type, payloadJson, replyTo, expiresAtSlot)` |
| `client.rpcPort`, `client.explorerPort` | read `client.rpcUrl` / `client.explorerUrl` (read-only) |
| `const lamports = await client.getBalance(a); lamports + 1` | `getBalance` may return a `bigint` above 2^53-1; convert with `BigInt(lamports)` before arithmetic |
| `buyOnLaunchpad(kp, lp, xrs, Number(minTokensOut))` | pass the `bigint` from the quote or plan unchanged |
| `xrsToLamports(12345678.123456789)` | `xrsToLamports('12345678.123456789')` |
| a `window.solana` wallet without `isXeris` picked up automatically | pass it as `new XerisDApp({ provider })` if intended |
| `client.getTask(id)`, `getTokenBalance(addr, id)` with an id containing a space, `/`, `?`, `#`, `%` or a non-ASCII character (the URL parser escaped or split it, and the node does not decode path segments) | throws `RangeError`; find the record through `getTasks()` / `getTokens()` |

## 4.0.0

Previous release: single-file `index.js`, 54 `Variant` entries, `test.js`.
