# xeris-sdk

Official JavaScript SDK for the **XerisCoin (XRS)** Layer 1 blockchain.

Build wallets, submit transactions, query chain state, and interact with tokens, smart contracts, launchpads, and the Alexandria RWA protocol.

## Install

```bash
npm install xeris-sdk
```

## Quick Start

```javascript
const { XerisClient, XerisKeypair } = require('xeris-sdk');

// Connect to testnet
const client = XerisClient.testnet();

// Generate a new keypair
const alice = XerisKeypair.generate();
console.log('Address:', alice.publicKey);

// Request testnet XRS
await client.airdrop(alice.publicKey, 100);

// Check balance
const balance = await client.getBalance(alice.publicKey);
console.log('Balance:', balance / 1_000_000_000, 'XRS');

// Send XRS
const result = await client.transferXrs(alice, recipientAddress, 5.0);
console.log('Signature:', result.signature);
```

## Building DeFi dApps

If you're building a web dApp that runs inside the Xeris Command Center wallet browser, use `XerisDApp` instead of `XerisClient`. It connects to the user's wallet through the injected provider (`window.xeris`), so you never handle private keys. The wallet shows an approval popup for every transaction.

```javascript
const { XerisDApp } = require('xeris-sdk');

const dapp = new XerisDApp();
await dapp.connect();
console.log('User wallet:', dapp.publicKey);

// Transfer XRS (wallet signs it)
await dapp.transferXrs(recipientAddress, 5.0);

// Swap tokens on a DEX pool
const quote = await dapp.getSwapQuote('pool_mtk_xrs', {
  token_in: 'mytoken', amount_in: '1000000000000'
});
await dapp.swapTokens('pool_mtk_xrs', 'mytoken', 1000000000000, quote.min_out);

// Buy on a launchpad
const lq = await dapp.getLaunchpadQuote('launch_xyz', 1000000000);
await dapp.buyOnLaunchpad('launch_xyz', 1000000000, Math.floor(lq.tokens_out * 0.95));

// Add/remove liquidity
await dapp.addLiquidity('pool_mtk_xrs', 100000000000, 50000000000);
await dapp.removeLiquidity('pool_mtk_xrs', lpTokenAmount);

// Wrap XRS for DEX trading
await dapp.wrapXrs(10);

// Read data (no wallet approval needed)
const balance = await dapp.getBalance();
const tokens = await dapp.getTokenAccounts();
const pools = await dapp.getContracts();
```

**XerisClient vs XerisDApp:**

| | XerisClient | XerisDApp |
|---|---|---|
| **Use case** | Server-side, bots, scripts | Browser dApps, DeFi frontends |
| **Keys** | You provide a keypair | Wallet manages keys |
| **Signing** | SDK signs directly | Wallet popup approves |
| **Install** | `npm install xeris-sdk` | Same package |
| **Runs in** | Node.js | Browser (WebView) |

## Features

**Transactions** — Every XerisCoin instruction type is supported through a single method call. The SDK handles blockhash fetching, bincode encoding, Solana transaction wrapping, Ed25519 signing, and submission.

```javascript
// Native XRS transfer
await client.transferXrs(alice, bobAddress, 5.0);

// Stake for mining
await client.stakeXrs(alice, 1000);

// Create a token
await client.createToken(alice, 'mytoken', 'My Token', 'MTK', 9, 1000000);

// Mint tokens
await client.mintTokens(alice, 'mytoken', alice.publicKey, 1000, 9);

// Transfer tokens
await client.transferToken(alice, 'mytoken', bobAddress, 50, 9);

// Deploy a liquidity pool
await client.deployContract(alice, 'pool_mtk_xrs', 'swap', {
  token_a: 'mytoken', token_b: 'xrs_native',
  amount_a: 100000000000000, amount_b: 10000000000000, fee_bps: 77
});

// Buy on a launchpad
const quote = await client.getLaunchpadQuote('launch_xyz', 1000000000);
await client.callContract(alice, 'launch_xyz', 'buy_tokens', {
  xrs_amount: 1000000000,
  min_tokens_out: Math.floor(quote.tokens_out * 0.95)
});

// Wrap XRS for DEX trading
await client.wrapXrs(alice, 10);

// Light client attestation
const blocks = await client.getRecentBlocks();
const hash = Buffer.from(blocks[0].hash, 'hex');
await client.submitAttestation(alice, blocks[0].slot, hash);
```

**Queries** — Full read access to the chain through both REST and Solana-compatible JSON-RPC endpoints.

```javascript
// Chain state
await client.getStats();
await client.getNetworkEconomics();
await client.getHealth();

// Accounts
await client.getBalance(address);
await client.getAccountInfo(address);
await client.getTokenAccounts(address);
await client.getStakeInfo(address);

// Blocks and transactions
await client.getBlocks(1, 20);
await client.getBlockBySlot(1133754);
await client.getTransaction(signature);
await client.getAccountTransactions(address);

// Tokens and contracts
await client.getTokenList();
await client.getContracts();
await client.getLaunchpads();
await client.getValidators();
await client.search('anything');
```

**Keypair management** — Generate, save, and load Ed25519 keypairs. The file format is a JSON array of 64 bytes, compatible with the Rust CLI wallet.

```javascript
const kp = XerisKeypair.generate();
kp.saveToFile('keypair.json');

const loaded = XerisKeypair.fromJsonFile('keypair.json');
console.log(loaded.publicKey);
```

## Advanced: Custom Instructions

For custom transaction assembly, use the low-level `Instructions` namespace and `sendInstruction`:

```javascript
const { Instructions } = require('xeris-sdk');

// Build raw instruction bytes
const ixData = Instructions.nativeTransfer(from, to, lamports);

// Sign and submit
const result = await client.sendInstruction(keypair, ixData);
```

For completely custom encoding, use the bincode primitives directly:

```javascript
const { encodeU32, encodeU64, encodeBincodeString } = require('xeris-sdk');

const customIx = Buffer.concat([
  encodeU32(11),                    // variant index
  encodeBincodeString(fromAddr),    // u64 len + UTF-8 bytes
  encodeBincodeString(toAddr),
  encodeU64(amount),                // u64 little-endian
]);
```

## Test Vectors

Verify your encoding against pre-computed test vectors:

```bash
node -e "require('xeris-sdk').TestVectors.printAll()"
```

Run the full test suite:

```bash
npm test
```

## Network Info

| | Testnet |
|---|---|
| Seed Node | `138.197.116.81` |
| RPC Port | `56001` |
| Explorer Port | `50008` |
| P2P Port | `4000` |
| Block Time | 4 seconds |
| Decimals | 9 (1 XRS = 1,000,000,000 lamports) |

## TypeScript

TypeScript definitions are included. Import normally:

```typescript
import { XerisClient, XerisKeypair } from 'xeris-sdk';
```

## License

MIT — Xeris Technologies LLC
