# xeris-sdk. Latest OCT 7th, 2026

JavaScript SDK for the XerisCoin node (Node >= 18; CommonJS with named ES-module imports; bundles for browsers). Encodes `XerisInstruction` values in the node's bincode layout, signs and submits transactions, and queries the RPC and explorer ports. Citations are `file:line` in the node source (`xeriscointestnet/src/`). Type declarations: `index.d.ts`.

## Install

```sh
npm install xeris-sdk
```

## Classes

| Class | Who signs | Use |
|---|---|---|
| `XerisClient` | the `XerisKeypair` you pass to each call | servers, bots, scripts |
| `XerisDApp` | the browser wallet (`window.xeris`) | browser dApps |
| `XerisAgent` | the agent's own key; executes as the owner through `AgentExecute` (variant 17) | delegated agents |

## Quick start

```js
const { XerisClient, XerisKeypair, lamportsToXrs } = require('xeris-sdk');
// ES modules: import { XerisClient, XerisKeypair, lamportsToXrs } from 'xeris-sdk';

async function main() {
  const client = XerisClient.testnet();                       // http://138.197.116.81, ports 56001 / 50008
  const kp = XerisKeypair.fromJsonFile('keypair.json');        // JSON array of 64 bytes (bin/wallet.rs:96-105)

  const recipient = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB'; // any canonical base58 pubkey (ledger.rs:1569-1577)

  const lamports = await client.getBalance(kp.publicKey);      // number, or bigint above 2^53-1 (explorer.rs:1447-1457)
  console.log(lamportsToXrs(lamports), 'XRS');

  const { signature } = await client.transferXrs(kp, recipient, '0.25');  // NativeTransfer via POST /submit
  const tx = await client.waitForConfirmation(signature);      // polls GET /v2/tx/{signature}
  console.log(tx.status);                                      // 'confirmed' | 'failed' | 'partial' | 'included'
}

main().catch((e) => { console.error(e); process.exit(1); });
```

`status: 'ok'` from a write call means mempool admission, not confirmation (`network.rs:4847-4856`).

### Timeouts and retries

If a write call fails after the transaction was sent (`err.code` `timeout`, `rpc_transport`, `rpc_http` or `rpc_json`), the node may already hold it. The error carries `err.signature` and `err.txBase64`. Do not call the write method again: it signs a new transaction with a new signature, the node's duplicate check (by signature, `network.rs:4686-4692, 4772-4778`) does not catch it, and the transfer can execute twice. Instead:

```js
try {
  await client.transferXrs(kp, recipient, '0.25');
} catch (err) {
  if (err.signature) {
    // either wait for the original ...
    await client.waitForConfirmation(err.signature);
    // ... or resend the same bytes while the blockhash is valid (150 slots);
    // a copy the node already holds is an RpcError with code 'duplicate'.
    // await client.submitSignedTransaction(err.txBase64);
  } else {
    throw err;
  }
}
```

## Instructions

`Instructions.<builder>(...)` returns a `Buffer`: `u32le(variant index)` then the fields in `token.rs` declaration order (`token.rs:29-808`, bincode 1 fixint LE). Parameters are positional, named after the Rust fields, in Rust order, strict arity. `Option<T>` takes `null`; `0`, `''`, `[]` are `Some`. Builders encode; node rules are enforced by the class wrappers (`checks.*`).

```js
const { Instructions, Variant } = require('xeris-sdk');

// inside an async function, with `client` and `kp` from the Quick start
const ix = Instructions.nativeTransfer(kp.publicKey, recipient, 5_000_000_000n);   // variant 11
await client.sendInstruction(kp, ix);                                             // or an array of up to 16
Variant.NativeTransfer;                                                           // 11; 62 variants, 0..61
```

Four variants are refused by the node; their builders and wrappers throw `FeatureDisabledError` (`.replacement` names the live path). A fifth encodes but does nothing in a block, so the transaction layer refuses to submit it.

| idx | builder | node |
|---|---|---|
| 22 | `subDelegate` | rejected at ingress, `"SubDelegate is disabled (XWC-82)"` (`ledger.rs:1445-1450`) |
| 48 | `zkPrivateTransfer` | skipped by the block dispatcher after the fee is charged (`ledger.rs:8669-8685`) |
| 49 | `zkIdentityProof` | skipped (`ledger.rs:8687-8697`) |
| 52 | `pqSignedTransfer` | skipped (`ledger.rs:8809-8828`) |
| 30 | `queryCapabilities` | no-op in blocks, fee still charged (`ledger.rs:7460-7464`). The builder encodes; `sendInstruction` / `buildTransaction` throw `FeatureDisabledError`. Read with `client.searchCapabilities()` |

Before signing, every send path (`buildTransaction`) checks that each instruction decodes as the node's `bincode::deserialize::<XerisInstruction>` would (no truncated field, valid UTF-8 strings, `Option` and `bool` bytes 0 or 1; trailing bytes are ignored, as on the node); the node's ingress rejects anything else with "Instruction data is not a recognized type" (`network.rs:180-187`), and the SDK throws `EncodingError`. It then applies the node's stateless semantic gate (`validate_tx_semantics`, `ledger.rs:1382-1455`): NativeTransfer amount > 0 to a canonical, non-`__` key; TokenMint and RWATransfer amount > 0 (RWATransfer `from != to`); ValidatorAttestation hash of 32 bytes signed by the validator itself; the same rules inside AgentExecute / ConditionalOrder, which cannot nest. It also refuses payloads the node admits but skips in the block after charging the fee (`ledger.rs:5516-5546`): ContractCall args that are not a JSON object the node can parse, at the top level and inside AgentExecute or ConditionalOrder (the 16-byte swap payload is exempt except inside AgentExecute, `ledger.rs:2359-2371, 6436-6442, 9181`); ContractDeploy params that are not JSON text of an object (the node would deploy from `{}`, `ledger.rs:6187`); an AgentExecute or ConditionalOrder inner instruction that does not decode (`ledger.rs:6399-6405, 6923-6927`), an AgentExecute inner variant outside `AGENT_INNER_VARIANTS` (`ledger.rs:6478-6484`), a ConditionalOrder `condition_type` outside `CONDITION_TYPES` (`ledger.rs:6916-6921`) or an inner instruction above 2048 bytes (`ledger.rs:6941-6944`); an AgentExecute inner ContractCall to an `agent_registry_` contract (`ledger.rs:6428-6431`); an AgentExecute inner TokenTransfer or TokenBurn whose `from` is not the owner it runs as (`ledger.rs:6522, 6648-6655`), and a ConditionalOrder inner token instruction whose `from` / `mint_authority` is not the signer (the order is cancelled when it fires, `ledger.rs:9270-9272`); and an actor field that is not the signer (TokenTransfer, TokenBurn, RWATransfer and NativeTransfer `from`, TokenCreate and TokenCreateRWA `mint_authority` (`token.rs:1036, 1104, 1151, 1225, 1306`), Stake/Unstake `pubkey`, CreateIdentity, RegisterModel and AgentHeartbeat `identity_pubkey`, Register/UpdateCapability `provider_identity`, ClaimTask `claimant_identity`, PqKeyRotate `ed25519_pubkey`, HardwareAttest `bound_identity` or, when that is empty, `device_pubkey`). Violations throw `RangeError` quoting the node's message or naming the block-level check.

## Amounts

- Wrapper parameters whose name ends in `Xrs` (`transferXrs`, `stakeXrs`, `wrapXrs`, ...) take XRS as a decimal `string` or a `number` and convert without floating-point arithmetic: `xrsToLamports('0.29') === 290000000n`, at most 9 fractional digits (`LAMPORTS_PER_XRS = 1_000_000_000`, `token.rs:901`). A `number` is accepted only when it is certainly what you wrote: a safe integer, or a non-integer with at most 15 significant digits. JavaScript reads `9999999.999999999` as the double that prints as `9999999.999999998`, so it throws `RangeError`; pass `'9999999.999999999'`.
- Every other amount is base units: `number` up to 2^53-1, or `bigint` up to 2^64-1. That holds inside JSON contract arguments too (`buyOnLaunchpad`, `sellOnLaunchpad`, `addLiquidity`, `removeLiquidity`, `callContract`, `deployContract`): a `bigint` is written as an exact JSON integer, which the node reads with `as_u64` (`contracts.rs:2218-2224, 2847-2850, 2944-2946`). Default launchpad tokens have 10^18 base units (`contracts.rs:1602-1604`), so token amounts above 2^53-1 are common there.
- JSON the SDK writes (`stringifyJson`) refuses what `JSON.stringify` would change: `NaN`/`Infinity` (written as `null`), `undefined` and functions (dropped), integer numbers above 2^53-1 (rounded), lone surrogates. A missing or `null` slippage field reads as 0 on the node (`contracts.rs:2849-2850, 2946-2947`), so these throw instead.
- Responses are parsed with `parseJson`: an integer above 2^53-1 (a large balance, a token supply, a quote's `tokens_out`, a plan's `min_tokens_out`) arrives as a `bigint` with its exact value, anything smaller as a `number`. Code that does arithmetic on such fields must handle both types; every SDK function that takes a u64 accepts either.
- Nothing is rounded, clamped or defaulted; an unusable value throws.

## Errors

| class | thrown for | `.code` |
|---|---|---|
| `TypeError` | wrong JavaScript type (`true` for a u64, `number[]` for bytes, `'5'` for a number, a positional page number where an options object is expected) | `'type'` when raised by an encoder; otherwise unset |
| `RangeError` | right type, outside the domain (u8 256, negative u64, number > 2^53-1, lone surrogate, unknown enum string, unknown option key, oversize instruction, an instruction the node's semantic gate rejects, a read-method path parameter the node cannot receive unchanged: empty, `.` / `..`, or containing a character outside RFC 3986 `pchar` or a `%`, because the node does not percent-decode path segments) | `'range'` when raised by an encoder; otherwise unset |
| `SyntaxError` | malformed JSON text passed to `parseJson` | `'syntax'` |
| `EncodingError` | wrong argument count, unknown variant, instruction bytes that do not decode as a `XerisInstruction` (top level, or the inner instruction of `XerisAgent.execute` / `XerisClient.conditionalOrder`), malformed hex, unreadable transaction bytes | `encoding`, `arity` |
| `FeatureDisabledError` | anything the node refuses; `.feature`, `.replacement`, `.citation` | `feature_disabled` |
| `RpcError` | any node or transport failure, including HTTP 200 bodies with an `error` key; `.route`, `.httpStatus`, `.body`, `.nodeStatus`, `.hint` | `rpc`, `rpc_http`, `rpc_transport`, `rpc_json`, `duplicate` |
| `XerisError` | misconfiguration, timeouts, unsupported wallet provider | `xeris`, `config`, `timeout`, `provider` |

After a signed transaction was sent, `timeout`, `rpc_transport`, `rpc_http`, `rpc_json` and `duplicate` errors also carry `.signature` and `.txBase64` (see Timeouts and retries).

Messages name the parameter. The write rate limit is `RpcError` `Rate limited. Max 30 write RPCs per minute per IP.`; `XerisClient.isRateLimited(err)` detects it.

## Routes the node refuses

| route | node | SDK |
|---|---|---|
| `GET /airdrop/{address}/{amount}` | HTTP 200 `{"error": ..., "status": 501}` (`network.rs:4314-4327`) | `airdrop()` throws; fund with `transferXrs` from a funded key |
| `POST /stake/claim` | HTTP 501 (`network.rs:5705-5740`) | `claimStakingReward()` throws; rewards are paid to the liquid balance every 900 blocks (`ledger.rs:9372-9438`) |
| `POST /governance/vote`, `/governance/propose` | HTTP 501 (`network.rs:5788-5817`) | `createProposal` / `castVote` / `executeProposal` (variants 39-41 via `POST /submit`) |
| `POST /governance/lock`, `/governance/delegate` | HTTP 501 (`network.rs:5838-5867`) | `governanceLock()` / `governanceDelegate()` throw; `getGovernanceLock(address)` reads |

## Networks

| | Testnet | Mainnet |
|---|---|---|
| host | `138.197.116.81` — `XerisClient.testnet()` | `XerisClient.mainnet(host)` or `XERIS_MAINNET_HOST`; no built-in host (`network.rs:282-300`) |
| chain id | `xeris-testnet-v1` | `xeris-mainnet-v1` (`ledger.rs:286-287`) |

Both: RPC port 56001, explorer port 50008, P2P port 4000 (`main.rs:830-832`); slot 4 s (`main.rs:33`); fee 0.001 XRS per transaction (`ledger.rs:58`); 9 decimals; blockhash valid for 150 slots (`ledger.rs:239`); 30 write requests per minute per IP on `/submit`, `/stake`, `/unstake`, `/pq-register` (`network.rs:4308`).

## Staking

- `stakeXrs` posts to `POST /stake` and `unstakeXrs` to `POST /unstake` (node pre-checks, `status: 'queued'`); pass `{ route: '/submit' }` to use the generic route.
- On a federated node `Stake` is accepted only from roster keys (`network.rs:2407-2417`).
- Resulting stake must be >= 1,000 XRS (`ledger.rs:232, 5713-5718`); unbonding 151,200 slots (`ledger.rs:201`); 7% APR paid every 900 blocks to the liquid balance (`ledger.rs:5138-5145, 9372-9438`).

## ZK / PQ

- Live: `zkVkRegister` (signer stake >= 1,000 XRS, `ledger.rs:8480-8491`); `zkProofSubmit` (`proofSystem` must be `'groth16'`, `verificationKeyHash` a registered `vk_id`, `ledger.rs:8566-8573`); `zkProofVerify`.
- Live: `pqKeyRegister` via `POST /pq-register` (`'dilithium3'`, 1952-byte key, level 3: `crypto.rs:924`, `contracts.rs:6199-6208`); `pqKeyRotate` (sign `buildPqRotationMessage(chainId, oldPk, newPk, rotationCount)` with the currently registered key, `crypto.rs:851-870`); `pqAttest` (stored as self-asserted, `verified = false`, `ledger.rs:8830-8871`).
- Not live: `ZkPrivateTransfer` (48), `ZkIdentityProof` (49), `PqSignedTransfer` (52). Builders and wrappers throw `FeatureDisabledError`.

## Hardware attestation

`hardwareAttest` needs the device key's signature over `hardwareAttestChallenge(devicePubkey, boundIdentity, deviceType, manufacturer, model, firmwareVersion, slot)` (`ledger.rs:5299-5319`). The node rebuilds the challenge with the slot of the block that includes the transaction (`ledger.rs:7320-7322`) and allows no window, so a proof only succeeds if the transaction lands in exactly the block it was signed for. Otherwise the instruction is skipped after the fee is charged; check the outcome with `waitForConfirmation` and retry with a proof for a later slot.

## Wallet provider

`XerisDApp` uses `window.xeris`, else `window.solana` only when it sets `isXeris: true`; any other wallet (for example a Solana-only `window.solana`) is ignored unless passed as `opts.provider`. `connect` and one of `signTransaction` / `signAndSendTransaction` are required; with `signTransaction` the SDK verifies the wallet's signature and posts `{ tx_base64 }` to `POST /submit` itself.

An RPC URL (`opts.rpcUrl`, or `getRpcUrl()` from the wallet) of the form `scheme://host:56001` names the node host (explorer at `host:50008`). Any other URL (no port, another port, a gateway path) is used unchanged as the RPC URL, and the explorer URL must come from `opts.explorerUrl` or `getExplorerUrl()`; otherwise `connect` throws `XerisError` `config`.

The package runs in browsers: signing and hashing use `@noble/curves` / `@noble/hashes`, `Buffer` comes from the `buffer` package, and `fs` (used only by `XerisKeypair.fromJsonFile` / `saveToFile`) is mapped to an empty module through the `browser` field. `test/browser.test.js` bundles the package with esbuild for `platform: 'browser'` and runs `XerisDApp` without Node globals.

```ts
interface XerisWalletProvider {
  isXeris?: boolean;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PublicKey | string } | string>;
  signTransaction?(tx: Transaction): Promise<Transaction | Uint8Array | { signature: Uint8Array | number[] | string } | { signedTransaction: string | Uint8Array }>;
  signAndSendTransaction?(tx: Transaction): Promise<{ signature: string }>;  // used only without signTransaction
  signMessage?(message: Uint8Array): Promise<{ signature: Uint8Array }>;
  disconnect?(): Promise<void>;
  getRpcUrl?(): Promise<string>;
  getExplorerUrl?(): Promise<string>;      // consulted when getRpcUrl() is not a bare host:56001
  on?(event: 'disconnect' | 'accountChanged', handler: (arg: unknown) => void): void;
  off?(event: string, handler: Function): void;
}
```

## Test vectors

```sh
npm test               # node --test test/*.test.js   (no network; the browser test needs the esbuild devDependency)
npm run test:vectors   # TestVectors.printAll(): 20 builders against reference bytes
```

`TestVectors.verify()` returns `{ ok, failures }`; `TestVectors.all()` returns the 20 entries. The reference bytes were checked against the `bincode` 1.3.3 crate.

```
nativeTransfer  stake  tokenMint  tokenTransfer  wrapXrs
createDeal  acceptDeal  confirmDeal  disputeDeal  zkVkRegister
agentExecuteNativeTransfer  contractCallSwap  openDispute  forceCloseChannel
updateAgent  registerAgent  rwaUpdateStatus  agentHeartbeat  postTask  validatorAttestation
```

## License

MIT — see `LICENSE`.
