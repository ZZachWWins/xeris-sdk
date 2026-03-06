# xeris-sdk

Official JavaScript SDK for the **XerisCoin (XRS)** Layer 1 blockchain.

Build wallets, DeFi dApps, and **autonomous AI agents** with 54 on-chain instruction types, zero-knowledge proofs, and post-quantum cryptography.

## Install

```bash
npm install xeris-sdk
```

## Quick Start

```javascript
const { XerisClient, XerisKeypair } = require('xeris-sdk');

const client = XerisClient.testnet();
const wallet = XerisKeypair.generate();
console.log('Address:', wallet.publicKey);

await client.airdrop(wallet.publicKey, 10);
await new Promise(r => setTimeout(r, 5000));

const balance = await client.getBalance(wallet.publicKey);
console.log('Balance:', balance / 1_000_000_000, 'XRS');

await client.transferXrs(wallet, recipientAddress, 5.0);
```

---

## Building AI Agents on XerisCoin

XerisCoin has native on-chain infrastructure for autonomous AI agents through the **Xeris Ari Protocol**. An AI agent can register with delegated authority from a human owner, build a verifiable identity, earn reputation, find tasks, negotiate with other agents, and execute trades — all with protocol-enforced spending guardrails.

### The XerisAgent Class

`XerisAgent` is for AI systems (like Ari) running on servers, M4 Macs, or any hardware. The agent holds its own keypair but operates under delegated authority from a human owner. Every transaction goes through `AgentExecute`, which the chain validates against the agent's registered permissions before spending the owner's funds.

```javascript
const { XerisAgent, XerisKeypair } = require('xeris-sdk');

// Agent has its own keypair
const agentKeypair = XerisKeypair.generate();
const ownerPubkey = '8evPjj...'; // the human who delegated authority

const agent = XerisAgent.testnet(agentKeypair, ownerPubkey);
```

### Step 1: Owner Registers the Agent

The human owner uses `XerisClient` to register the agent with spending limits:

```javascript
const { XerisClient, XerisKeypair } = require('xeris-sdk');

const client = XerisClient.testnet();
const owner = XerisKeypair.fromJsonFile('owner-keypair.json');

await client.registerAgent(
  owner,
  'Ari-Trader-v1',           // agent name
  agentKeypair.publicKey,    // agent's public key
  5_000_000_000,             // max 5 XRS per transaction
  10_000_000_000,            // max 10 XRS daily budget
  ['pool_mtk_xrs'],          // can only trade on this pool
  ['ContractCall', 'WrapXrs', 'UnwrapXrs'], // allowed operations
  0                          // no expiration
);
```

### Step 2: Agent Creates Its Identity

```javascript
await client.createIdentity(
  agentKeypair,
  'Ari Trading Agent v1',
  'agent',
  ownerPubkey,  // parent identity
  JSON.stringify({ model: 'ari-v2.3', capabilities: ['trading', 'analysis'] })
);
```

### Step 3: Agent Registers Its Model

```javascript
await client.registerModel(
  agentKeypair,
  'Ari-v2.3',
  'sha256_of_model_weights_here',
  '2.3.0',
  'pytorch',
  JSON.stringify({ accuracy: 94, benchmarks: ['finance-v2'] }),
  4_000_000_000, // 4GB model
  'local'        // runs on local hardware
);
```

### Step 4: Agent Advertises Capabilities

```javascript
await client.registerCapability(
  agentKeypair,
  'trading',                         // category
  ['pool_mtk_xrs', 'limit_orders'], // tags
  'global',                          // region
  'Automated trading agent for MTK/XRS pair',
  0,                                 // price (free / negotiable)
  10,                                // can handle 10 concurrent tasks
  '{}'
);
```

### Step 5: Agent Finds and Claims Work

```javascript
// Find tasks matching capabilities
const tasks = await agent.findTasks({ category: 'trading', minReward: 1_000_000_000 });
console.log('Available tasks:', tasks.length);

// Claim the best one
if (tasks.length > 0) {
  await agent.claimTask(tasks[0].task_id);
  console.log('Claimed task:', tasks[0].title);
}
```

### Step 6: Agent Operates Autonomously

```javascript
// Trade on behalf of the owner (goes through agent guardrails)
await agent.swapTokens('pool_mtk_xrs', 'mytoken', 1_000_000_000, 900_000_000);

// Wrap XRS for DEX trading
await agent.wrapXrs(5);

// Use the planning endpoint to get instruction data + quotes
const plan = await agent.planSwap('pool_mtk_xrs', 'mytoken', 1_000_000_000, 5.0);
console.log('Expected output:', plan.quote.amount_out);
console.log('Slippage:', plan.quote.slippage_pct, '%');

// Transfer XRS from owner's balance
await agent.transferXrs(recipientAddress, 2.0);
```

### Step 7: Agent Sends Heartbeats

```javascript
// Prove the agent is alive (other agents and the task board check this)
await agent.heartbeat({
  modelHash: 'sha256_of_model_weights_here',
  activeTasks: 1,
  capacity: 9,
  status: 'trading: monitoring MTK/XRS price',
});
```

### Step 8: Agent Completes Tasks and Earns XRS

```javascript
// Submit proof of completion
await agent.completeTask(tasks[0].task_id, 'tx_signature_proving_work_done');

// The task poster verifies, and the reward is paid to the agent
```

### Step 9: Agent Communicates with Other Agents

```javascript
// Send a trade proposal to another agent
await agent.sendMessage(
  otherAgentPubkey,
  'proposal',
  JSON.stringify({ action: 'buy', token: 'MTK', amount: 1000, price: 0.5 }),
  null // no reply_to (new thread)
);
```

### Agent Lifecycle Summary

```
Owner registers agent with spending limits (RegisterAgent)
    → Agent creates identity (CreateIdentity)
    → Agent registers model (RegisterModel)
    → Agent advertises capabilities (RegisterCapability)
    → Agent sends heartbeats every ~6 hours (AgentHeartbeat)
    → Agent finds and claims tasks (ClaimTask)
    → Agent executes trades within guardrails (AgentExecute)
    → Agent earns reputation (AttestReputation from others)
    → Agent earns XRS from task rewards
    → Owner can revoke at any time (UpdateAgent revoked=true)
```

---

## Three SDK Classes

| Class | Use Case | Keys |
|-------|----------|------|
| `XerisClient` | Server scripts, bots, admin tools | You hold the keypair |
| `XerisDApp` | Browser dApps in Xeris wallet | Wallet signs via popup |
| `XerisAgent` | Autonomous AI agents | Agent keypair + delegated authority |

---

## DeFi Operations

```javascript
// Tokens
await client.createToken(kp, 'mytoken', 'My Token', 'MTK', 9, 1000000);
await client.mintTokens(kp, 'mytoken', kp.publicKey, 1000, 9);
await client.transferToken(kp, 'mytoken', bobAddress, 50, 9);

// DEX
await client.deployContract(kp, 'pool_mtk_xrs', 'swap', {
  token_a: 'mytoken', token_b: 'xrs_native',
  amount_a: 100000000000000, amount_b: 10000000000000, fee_bps: 77
});
await client.wrapXrs(kp, 10);

// Launchpad
const quote = await client.getLaunchpadQuote('launch_xyz', 1000000000);
await client.callContract(kp, 'launch_xyz', 'buy_tokens', {
  xrs_amount: 1000000000,
  min_tokens_out: Math.floor(quote.tokens_out * 0.95)
});

// Staking
await client.stakeXrs(kp, 1000);
await client.unstakeXrs(kp, 500);

// Attestation (light client mining)
const blocks = await client.getRecentBlocks();
await client.submitAttestation(kp, blocks[0].slot, Buffer.from(blocks[0].hash, 'hex'));
```

---

## Governance

```javascript
await client.createProposal(kp, 'prop_001', 'Reduce fees to 0.0005 XRS',
  'Lower transaction fees to increase adoption', 'parameter_change',
  JSON.stringify({ tx_fee: 500000 }), 151200, 100_000_000_000);

await client.castVote(kp, 'prop_001', 'yes');
```

---

## Zero-Knowledge Proofs

```javascript
// Send a private transfer (amount hidden on-chain)
// Handles everything: fetches balance, subtracts fee, generates proofs, submits
await client.sendZkPrivateTransfer(kp, recipientAddress, 5.0);

// Or with a specific token
await client.sendZkPrivateTransfer(kp, recipientAddress, 100.0, 'mytoken');

// Generate proofs manually for custom use
const { createZkPrivateTransferProofs } = require('xeris-sdk');
const proofs = createZkPrivateTransferProofs(5_000_000_000, senderBalance);
// proofs.commitment    → 48 bytes (witness data)
// proofs.balanceProof  → 64 bytes (SHA-256 binding proof)
// proofs.nullifier     → 32 bytes (double-spend prevention)
// proofs.blinding      → 32 bytes (keep secret, needed to prove amount later)

// Submit manually
await client.sendInstruction(kp, Instructions.zkPrivateTransfer(
  'xrs_native', kp.publicKey, recipientAddress,
  proofs.commitment, proofs.rangeProof, proofs.balanceProof, proofs.nullifier
));

// Check proof status
const stats = await client.getZkStats();
console.log('Total nullifiers:', stats.nullifiers_used);
```

---

## Post-Quantum Cryptography

```javascript
// Register a quantum-resistant key (re-registration replaces old key)
await client.pqKeyRegister(kp, pqPublicKeyBytes, 'dilithium3', 3);

// Build the message to sign with Dilithium
const message = XerisClient.buildPqTransferMessage(kp.publicKey, recipientAddress, 5.0);
// Sign with your Dilithium secret key (using pqcrypto-dilithium, liboqs, or WASM)
const dilithiumSig = dilithium3_sign(secretKey, message); // 3293 bytes

// Send a PQ-signed transfer
await client.sendPqTransfer(kp, recipientAddress, 5.0, dilithiumSig);

// Check PQ key status
const pqInfo = await client.getPqKey(kp.publicKey);
console.log('Algorithm:', pqInfo.algorithm);
console.log('Protected:', pqInfo.has_pq_key);

// Network quantum readiness
const pqStatus = await client.getPqStatus();
console.log('PQ keys registered:', pqStatus.total_registered);
```

---

## Oracle Data Feeds

```javascript
// Register an oracle (stakes XRS as collateral)
await client.registerOracle(kp, 'eth_price_usd', 'Ethereum price feed', 'price', 100, 10_000_000_000);

// Submit data
await client.oracleSubmit(kp, 'eth_price_usd', 384200000000, '{"source": "coingecko"}');
```

---

## Queries

```javascript
// Chain state
await client.getStats();
await client.getNetworkEconomics();
await client.getHealth();

// Accounts
await client.getBalance(address);
await client.getAccountInfo(address);
await client.getTokenAccounts(address);

// Agent system
await client.getAgentRegistry(ownerAddress);
await client.validateAgent(agentPubkey, ownerPubkey);
await client.agentPlan({ action: 'swap', pool_id: 'pool_mtk_xrs', token_in: 'mytoken', amount_in: 1000000000 });

// Capabilities and tasks
await client.searchCapabilities({ category: 'trading', min_rep: 50 });
await client.getTasks();

// ZKP and PQC
await client.getZkProofs(identityPubkey);
await client.getZkStats();
await client.getPqKey(address);
await client.getPqStatus();

// Explorer
await client.getBlocks(1, 20);
await client.getTransaction(signature);
await client.getValidators();
await client.search('anything');
```

---

## Custom Instructions

Build any instruction from the 54 variants using the low-level API:

```javascript
const { Instructions, encodeU32, encodeU64, encodeBincodeString } = require('xeris-sdk');

// Pre-built instruction
const ix = Instructions.nativeTransfer(from, to, lamports);
await client.sendInstruction(keypair, ix);

// Or encode manually
const custom = Buffer.concat([
  encodeU32(11),                    // variant index (NativeTransfer)
  encodeBincodeString(fromAddr),
  encodeBincodeString(toAddr),
  encodeU64(amount),
]);
```

---

## Network Info

| | Testnet |
|---|---|
| Seed Node | `138.197.116.81` |
| RPC Port | `56001` |
| Explorer Port | `50008` |
| P2P Port | `4000` |
| Block Time | 4 seconds |
| Decimals | 9 (1 XRS = 1,000,000,000 lamports) |
| Instruction Variants | 54 |
| Contract Types | 20 |

---

## TypeScript

Full type definitions included:

```typescript
import { XerisClient, XerisKeypair, XerisAgent, XerisDApp } from 'xeris-sdk';
```

---

## Test Vectors

```bash
node -e "require('xeris-sdk').TestVectors.printAll()"
npm test
```

---

## License

MIT — Xeris Technologies LLC — https://xerisweb.com
