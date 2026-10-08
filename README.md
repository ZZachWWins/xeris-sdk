# xeris-sdk. Latest OCT 7th, 2026

JavaScript SDK for the XerisCoin node (Node >= 18, CommonJS). Encodes `XerisInstruction` values in the node's bincode layout, signs and submits transactions, and queries the RPC and explorer ports. Citations are `file:line` in the node source (`xeriscointestnet/src/`). Type declarations: `index.d.ts`.

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

const client = XerisClient.testnet();                       // http://138.197.116.81, ports 56001 / 50008
const kp = XerisKeypair.fromJsonFile('keypair.json');        // JSON array of 64 bytes (bin/wallet.rs:96-105)

const recipient = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB'; // any canonical base58 pubkey (ledger.rs:1569-1577)

const lamports = await client.getBalance(kp.publicKey);      // JSON-RPC getBalance (explorer.rs:1447-1457)
console.log(lamportsToXrs(lamports), 'XRS');

const { signature } = await client.transferXrs(kp, recipient, '0.25');  // NativeTransfer via POST /submit
const tx = await client.waitForConfirmation(signature);      // polls GET /v2/tx/{signature}
console.log(tx.status);                                      // 'confirmed' | 'failed' | 'partial' | 'included'
```

`status: 'ok'` from a write call means mempool admission, not confirmation (`network.rs:4847-4856`).

## Instructions

`Instructions.<builder>(...)` returns a `Buffer`: `u32le(variant index)` then the fields in `token.rs` declaration order (`token.rs:29-808`, bincode 1 fixint LE). Parameters are positional, named after the Rust fields, in Rust order, strict arity. `Option<T>` takes `null`; `0`, `''`, `[]` are `Some`. Builders encode; node rules are enforced by the class wrappers (`checks.*`).

```js
const { Instructions, Variant } = require('xeris-sdk');
const ix = Instructions.nativeTransfer(from, to, 5_000_000_000n);   // variant 11
await client.sendInstruction(kp, ix);                              // or an array of up to 16
Variant.NativeTransfer;                                            // 11; 62 variants, 0..61
```

Four variants are refused by the node; their builders and wrappers throw `FeatureDisabledError` (`.replacement` names the live path). One encodes but does nothing in a block.

| idx | builder | node |
|---|---|---|
| 22 | `subDelegate` | rejected at ingress, `"SubDelegate is disabled (XWC-82)"` (`ledger.rs:1445-1450`) |
| 48 | `zkPrivateTransfer` | skipped by the block dispatcher after the fee is charged (`ledger.rs:8669-8685`) |
| 49 | `zkIdentityProof` | skipped (`ledger.rs:8687-8697`) |
| 52 | `pqSignedTransfer` | skipped (`ledger.rs:8809-8828`) |
| 30 | `queryCapabilities` | no-op in blocks, fee still charged (`ledger.rs:7460-7464`); read with `client.searchCapabilities()` |

## Amounts

- Wrapper parameters whose name ends in `Xrs` (`transferXrs`, `stakeXrs`, `wrapXrs`, ...) take XRS as a `number` or decimal `string` and convert exactly: `xrsToLamports('0.29') === 290000000n`, at most 9 fractional digits (`LAMPORTS_PER_XRS = 1_000_000_000`, `token.rs:901`).
- Every other amount is base units: `number` up to 2^53-1, or `bigint` up to 2^64-1. Nothing is rounded, clamped or defaulted; an unusable value throws.

## Errors

| class | thrown for | `.code` |
|---|---|---|
| `TypeError` | wrong JavaScript type (`true` for a u64, `number[]` for bytes, `'5'` for a number) | — |
| `RangeError` | right type, outside the domain (u8 256, negative u64, number > 2^53-1, lone surrogate, unknown enum string) | — |
| `EncodingError` | wrong argument count, unknown variant, oversize instruction, malformed hex | `encoding`, `arity` |
| `FeatureDisabledError` | anything the node refuses; `.feature`, `.replacement`, `.citation` | `feature_disabled` |
| `RpcError` | any node or transport failure, including HTTP 200 bodies with an `error` key; `.route`, `.httpStatus`, `.body`, `.nodeStatus`, `.hint` | `rpc`, `rpc_http`, `rpc_transport`, `rpc_json` |
| `XerisError` | misconfiguration, timeouts, unsupported wallet provider | `xeris`, `config`, `timeout`, `provider` |

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
- Resulting stake must be >= 1,000 XRS (`ledger.rs:232, 5713-5718`); unbonding 151,200 slots (`ledger.rs:201`); 7% APY paid every 900 blocks to the liquid balance (`ledger.rs:5138-5145, 9372-9438`).

## ZK / PQ

- Live: `zkVkRegister` (signer stake >= 1,000 XRS, `ledger.rs:8480-8491`); `zkProofSubmit` (`proofSystem` must be `'groth16'`, `verificationKeyHash` a registered `vk_id`, `ledger.rs:8566-8573`); `zkProofVerify`.
- Live: `pqKeyRegister` via `POST /pq-register` (`'dilithium3'`, 1952-byte key, level 3: `crypto.rs:924`, `contracts.rs:6199-6208`); `pqKeyRotate` (sign `buildPqRotationMessage(chainId, oldPk, newPk, rotationCount)` with the currently registered key, `crypto.rs:851-870`); `pqAttest` (stored as self-asserted, `verified = false`, `ledger.rs:8830-8871`).
- Not live: `ZkPrivateTransfer` (48), `ZkIdentityProof` (49), `PqSignedTransfer` (52). Builders and wrappers throw `FeatureDisabledError`.

## Wallet provider

`XerisDApp` uses `window.xeris` (else `window.solana` with `isXeris`). `connect` and one of `signTransaction` / `signAndSendTransaction` are required; with `signTransaction` the SDK posts `{ tx_base64 }` to `POST /submit` itself.

```ts
interface XerisWalletProvider {
  isXeris?: boolean;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PublicKey | string } | string>;
  signTransaction?(tx: Transaction): Promise<Transaction | Uint8Array | { signature: Uint8Array | number[] | string } | { signedTransaction: string | Uint8Array }>;
  signAndSendTransaction?(tx: Transaction): Promise<{ signature: string }>;  // used only without signTransaction
  signMessage?(message: Uint8Array): Promise<{ signature: Uint8Array }>;
  disconnect?(): Promise<void>;
  getRpcUrl?(): Promise<string>;
  on?(event: 'disconnect' | 'accountChanged', handler: (arg: unknown) => void): void;
  off?(event: string, handler: Function): void;
}
```

## Test vectors

```sh
npm test               # node --test test/*.test.js   (no network)
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
