/**
 * XerisCoin JavaScript SDK
 *
 * Official client library for the XerisCoin (XRS) Layer 1 blockchain.
 * Handles bincode instruction encoding, Solana transaction wrapping,
 * Ed25519 signing, and all RPC communication.
 *
 * @example
 * const { XerisClient, XerisKeypair } = require('xeris-sdk');
 * const client = XerisClient.testnet();
 * const kp = XerisKeypair.generate();
 * await client.airdrop(kp.publicKey, 10);
 * await client.transferXrs(kp, recipientAddress, 5.0);
 *
 * @module xeris-sdk
 * @version 2.0.0
 * @license MIT
 * @author Xeris Technologies LLC
 * @see https://xerisweb.com
 */

'use strict';

const {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} = require('@solana/web3.js');
const bs58 = require('bs58');

// ============================================================================
// CONSTANTS
// ============================================================================

/** Number of lamports in 1 XRS. All on-chain amounts use lamports. */
const LAMPORTS_PER_XRS = 1_000_000_000;

/** Default RPC port for the XerisCoin node. */
const DEFAULT_RPC_PORT = 56001;

/** Default Explorer/JSON-RPC port for the XerisCoin node. */
const DEFAULT_EXPLORER_PORT = 50008;

/** Public testnet seed node IP address. */
const TESTNET_SEED = '138.197.116.81';

/**
 * XerisInstruction variant indices.
 * Each value corresponds to the u32 LE prefix of the bincode-encoded instruction.
 * These must match the enum order in the node's token.rs file.
 * @readonly
 * @enum {number}
 */
const Variant = Object.freeze({
  TokenMint:            0,
  TokenTransfer:        1,
  TokenBurn:            2,
  TokenCreate:          3,
  ContractCall:         4,
  ContractDeploy:       5,
  TokenCreateRWA:       6,
  RWAUpdateStatus:      7,
  RWATransfer:          8,
  Stake:                9,
  Unstake:              10,
  NativeTransfer:       11,
  ValidatorAttestation: 12,
  WrapXrs:              13,
  UnwrapXrs:            14,
  // Ari Protocol
  RegisterAgent:        15,
  UpdateAgent:          16,
  AgentExecute:         17,
  CreateIdentity:       18,
  UpdateIdentity:       19,
  AttestReputation:     20,
  AgentMessage:         21,
  SubDelegate:          22,
  ConditionalOrder:     23,
  CancelConditionalOrder: 24,
  RegisterOracle:       25,
  OracleSubmit:         26,
  HardwareAttest:       27,
  RegisterCapability:   28,
  UpdateCapability:     29,
  QueryCapabilities:    30,
  PostTask:             31,
  ClaimTask:            32,
  ResolveTask:          33,
  RegisterModel:        34,
  UpdateModel:          35,
  OpenDispute:          36,
  ResolveDispute:       37,
  SlashReport:          38,
  CreateProposal:       39,
  CastVote:             40,
  ExecuteProposal:      41,
  OpenChannel:          42,
  CloseChannel:         43,
  ForceCloseChannel:    44,
  AgentHeartbeat:       45,
  // ZKP + PQC
  ZkProofSubmit:        46,
  ZkProofVerify:        47,
  ZkPrivateTransfer:    48,
  ZkIdentityProof:      49,
  PqKeyRegister:        50,
  PqKeyRotate:          51,
  PqSignedTransfer:     52,
  PqAttest:             53,
});

/**
 * Encode a binary swap call: 8 bytes input_amount LE + 8 bytes min_output LE.
 * Used by DEX swap methods which expect raw bytes, not JSON.
 * @param {string} contractId
 * @param {string} method - "swap_a_to_b" or "swap_b_to_a"
 * @param {number|bigint} inputAmount
 * @param {number|bigint} minOutput
 * @returns {Buffer}
 */
function encodeSwapCall(contractId, method, inputAmount, minOutput) {
  const argsBuf = Buffer.alloc(16);
  argsBuf.writeBigUInt64LE(BigInt(inputAmount), 0);
  argsBuf.writeBigUInt64LE(BigInt(minOutput), 8);
  return Buffer.concat([
    encodeU32(Variant.ContractCall),
    encodeBincodeString(contractId),
    encodeBincodeString(method),
    encodeBincodeVec(argsBuf),
  ]);
}

// ============================================================================
// BINCODE ENCODING PRIMITIVES
// ============================================================================

/**
 * Encode a u32 as 4 bytes in little-endian byte order.
 * Used for the instruction variant index prefix.
 * @param {number} value - Unsigned 32-bit integer
 * @returns {Buffer} 4-byte buffer
 */
function encodeU32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

/**
 * Encode a u64 as 8 bytes in little-endian byte order.
 * Accepts both Number (safe up to 2^53) and BigInt for larger values.
 * @param {number|bigint} value - Unsigned 64-bit integer
 * @returns {Buffer} 8-byte buffer
 */
function encodeU64(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value), 0);
  return buf;
}

/**
 * Encode a string in bincode format: u64 length prefix followed by UTF-8 bytes.
 * This matches Rust's `bincode::serialize` for the String type exactly.
 * @param {string} str - The string to encode
 * @returns {Buffer} Length-prefixed UTF-8 bytes
 */
function encodeBincodeString(str) {
  const strBytes = Buffer.from(str, 'utf8');
  return Buffer.concat([encodeU64(strBytes.length), strBytes]);
}

/**
 * Encode a byte array in bincode format: u64 length prefix followed by raw bytes.
 * Used for Vec<u8> fields such as block_hash_prefix and contract args.
 * @param {Buffer|Uint8Array|number[]} bytes - Raw bytes to encode
 * @returns {Buffer} Length-prefixed bytes
 */
function encodeBincodeVec(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return Buffer.concat([encodeU64(buf.length), buf]);
}

/**
 * Encode a boolean as a single byte: 0x00 for false, 0x01 for true.
 * @param {boolean} value
 * @returns {Buffer} 1-byte buffer
 */
function encodeBool(value) {
  return Buffer.from([value ? 1 : 0]);
}

/**
 * Encode a u8 as a single byte.
 * @param {number} value - Unsigned 8-bit integer
 * @returns {Buffer} 1-byte buffer
 */
function encodeU8(value) {
  return Buffer.from([value & 0xFF]);
}

/**
 * Encode a bincode Option<T>.
 * None is encoded as a single 0x00 byte.
 * Some(value) is encoded as 0x01 followed by the encoded value.
 * @param {*} value - The value, or null/undefined for None
 * @param {function} encoder - Encoding function for the inner type
 * @returns {Buffer}
 */
function encodeOption(value, encoder) {
  if (value === null || value === undefined) {
    return Buffer.from([0]);
  }
  return Buffer.concat([Buffer.from([1]), encoder(value)]);
}

// ============================================================================
// INSTRUCTION BUILDERS
// ============================================================================

/**
 * Functions for building raw XerisInstruction byte arrays.
 * Each function returns a Buffer containing the bincode-encoded instruction
 * ready to be wrapped in a Solana Transaction.
 *
 * For most use cases, prefer the high-level methods on XerisClient
 * (e.g. client.transferXrs()) which handle the full sign-and-submit flow.
 * Use these builders directly only when you need custom transaction assembly.
 * @namespace
 */
const Instructions = {
  /**
   * Build a NativeTransfer instruction (variant 11).
   * Transfers native XRS between two accounts.
   * @param {string} from - Sender address (base58 public key)
   * @param {string} to - Recipient address (base58 public key)
   * @param {number|bigint} lamports - Amount in lamports (1 XRS = 1,000,000,000)
   * @returns {Buffer} Encoded instruction data
   */
  nativeTransfer(from, to, lamports) {
    return Buffer.concat([
      encodeU32(Variant.NativeTransfer),
      encodeBincodeString(from),
      encodeBincodeString(to),
      encodeU64(lamports),
    ]);
  },

  /**
   * Build a Stake instruction (variant 9).
   * Stakes native XRS for Proof of Stake mining eligibility.
   * Minimum stake is 1,000 XRS (1,000,000,000,000 lamports).
   * @param {string} pubkey - Validator public key to stake for
   * @param {number|bigint} lamports - Amount to stake in lamports
   * @returns {Buffer}
   */
  stake(pubkey, lamports) {
    return Buffer.concat([
      encodeU32(Variant.Stake),
      encodeBincodeString(pubkey),
      encodeU64(lamports),
    ]);
  },

  /**
   * Build an Unstake instruction (variant 10).
   * Begins the unbonding period (approximately 7 days / 151,200 slots).
   * @param {string} pubkey - Validator public key to unstake from
   * @param {number|bigint} lamports - Amount to unstake in lamports
   * @returns {Buffer}
   */
  unstake(pubkey, lamports) {
    return Buffer.concat([
      encodeU32(Variant.Unstake),
      encodeBincodeString(pubkey),
      encodeU64(lamports),
    ]);
  },

  /**
   * Build a TokenCreate instruction (variant 3).
   * Registers a new token on the XerisCoin chain.
   * @param {string} tokenId - Unique token identifier
   * @param {string} name - Human-readable token name
   * @param {string} symbol - Token ticker symbol (e.g. "MTK")
   * @param {number} decimals - Decimal places (typically 9)
   * @param {number|bigint} maxSupply - Maximum supply in base units
   * @param {string} mintAuthority - Address authorized to mint this token
   * @returns {Buffer}
   */
  tokenCreate(tokenId, name, symbol, decimals, maxSupply, mintAuthority) {
    return Buffer.concat([
      encodeU32(Variant.TokenCreate),
      encodeBincodeString(tokenId),
      encodeBincodeString(name),
      encodeBincodeString(symbol),
      encodeU8(decimals),
      encodeU64(maxSupply),
      encodeBincodeString(mintAuthority),
    ]);
  },

  /**
   * Build a TokenMint instruction (variant 0).
   * Mints new tokens to a recipient address. Caller must be the mint authority.
   * @param {string} tokenId - Token to mint
   * @param {string} to - Recipient address
   * @param {number|bigint} amount - Amount in base units (accounting for decimals)
   * @returns {Buffer}
   */
  tokenMint(tokenId, to, amount) {
    return Buffer.concat([
      encodeU32(Variant.TokenMint),
      encodeBincodeString(tokenId),
      encodeBincodeString(to),
      encodeU64(amount),
    ]);
  },

  /**
   * Build a TokenTransfer instruction (variant 1).
   * Transfers tokens between two accounts.
   * @param {string} tokenId - Token to transfer
   * @param {string} from - Sender address
   * @param {string} to - Recipient address
   * @param {number|bigint} amount - Amount in base units
   * @returns {Buffer}
   */
  tokenTransfer(tokenId, from, to, amount) {
    return Buffer.concat([
      encodeU32(Variant.TokenTransfer),
      encodeBincodeString(tokenId),
      encodeBincodeString(from),
      encodeBincodeString(to),
      encodeU64(amount),
    ]);
  },

  /**
   * Build a TokenBurn instruction (variant 2).
   * Burns tokens from the signer's account, reducing current supply.
   * @param {string} tokenId - Token to burn
   * @param {string} from - Address to burn from
   * @param {number|bigint} amount - Amount in base units
   * @returns {Buffer}
   */
  tokenBurn(tokenId, from, amount) {
    return Buffer.concat([
      encodeU32(Variant.TokenBurn),
      encodeBincodeString(tokenId),
      encodeBincodeString(from),
      encodeU64(amount),
    ]);
  },

  /**
   * Build a ContractDeploy instruction (variant 5).
   * Deploys a new smart contract on-chain.
   * @param {string} contractId - Unique contract identifier
   * @param {string} contractType - One of: timelock, escrow, swap, vesting, multisig, rwa, launchpad
   * @param {object} params - Contract initialization parameters (JSON-serialized automatically)
   * @returns {Buffer}
   */
  contractDeploy(contractId, contractType, params) {
    return Buffer.concat([
      encodeU32(Variant.ContractDeploy),
      encodeBincodeString(contractId),
      encodeBincodeString(contractType),
      encodeBincodeString(JSON.stringify(params)),
    ]);
  },

  /**
   * Build a ContractCall instruction (variant 4).
   * Calls a method on a deployed smart contract.
   * @param {string} contractId - Contract to call
   * @param {string} method - Method name (e.g. "buy_tokens", "add_liquidity", "release")
   * @param {object} args - Method arguments (JSON-serialized automatically)
   * @returns {Buffer}
   */
  contractCall(contractId, method, args) {
    const argsBytes = Buffer.from(JSON.stringify(args), 'utf8');
    return Buffer.concat([
      encodeU32(Variant.ContractCall),
      encodeBincodeString(contractId),
      encodeBincodeString(method),
      encodeBincodeVec(argsBytes),
    ]);
  },

  /**
   * Build a ValidatorAttestation instruction (variant 12).
   * Submits proof that a light client verified a specific block.
   * Reward: 0.01 XRS per valid attestation, rate-limited to 1 per 10 blocks.
   * @param {string} validator - Validator/light client public key
   * @param {number} blockSlot - Slot number of the verified block
   * @param {Buffer} blockHash - Full 32-byte block hash
   * @returns {Buffer}
   */
  validatorAttestation(validator, blockSlot, blockHash) {
    return Buffer.concat([
      encodeU32(Variant.ValidatorAttestation),
      encodeBincodeString(validator),
      encodeU64(blockSlot),
      encodeBincodeVec(blockHash),
    ]);
  },

  /**
   * Build a WrapXrs instruction (variant 13).
   * Converts native XRS balance into the xrs_native token for DEX trading.
   * @param {number|bigint} lamports - Amount to wrap
   * @returns {Buffer}
   */
  wrapXrs(lamports) {
    return Buffer.concat([
      encodeU32(Variant.WrapXrs),
      encodeU64(lamports),
    ]);
  },

  /**
   * Build an UnwrapXrs instruction (variant 14).
   * Converts xrs_native token balance back into native XRS.
   * @param {number|bigint} lamports - Amount to unwrap
   * @returns {Buffer}
   */
  unwrapXrs(lamports) {
    return Buffer.concat([
      encodeU32(Variant.UnwrapXrs),
      encodeU64(lamports),
    ]);
  },

  /**
   * Build a TokenCreateRWA instruction (variant 6).
   * Creates a real-world asset backed token under the Alexandria Protocol.
   * @param {object} opts - RWA token configuration
   * @param {string} opts.tokenId - Unique token identifier
   * @param {string} opts.name - Token name
   * @param {string} opts.symbol - Token symbol
   * @param {number} opts.decimals - Decimal places
   * @param {number|bigint} opts.maxSupply - Maximum supply in base units
   * @param {string} opts.mintAuthority - Mint authority address
   * @param {string} opts.assetType - One of: real_estate, equity, debt, commodity, ip, collectible
   * @param {string} opts.legalDocHash - SHA-256 hash of the Ricardian contract document
   * @param {string} opts.legalDocUri - URI to the legal document (IPFS, Arweave, or HTTPS)
   * @param {string} opts.jurisdiction - Legal jurisdiction (e.g. "US-WY", "CH-ZG")
   * @param {boolean} opts.transferRestricted - Whether transfers require issuer approval
   * @param {boolean} opts.accreditedOnly - Whether only accredited investors may hold
   * @param {number|bigint} [opts.valuation=0] - Appraised value in USD cents
   * @returns {Buffer}
   */
  tokenCreateRWA(opts) {
    return Buffer.concat([
      encodeU32(Variant.TokenCreateRWA),
      encodeBincodeString(opts.tokenId),
      encodeBincodeString(opts.name),
      encodeBincodeString(opts.symbol),
      encodeU8(opts.decimals),
      encodeU64(opts.maxSupply),
      encodeBincodeString(opts.mintAuthority),
      encodeBincodeString(opts.assetType),
      encodeBincodeString(opts.legalDocHash),
      encodeBincodeString(opts.legalDocUri),
      encodeBincodeString(opts.jurisdiction),
      encodeBool(opts.transferRestricted),
      encodeBool(opts.accreditedOnly),
      encodeU64(opts.valuation || 0),
    ]);
  },

  /**
   * Build an RWAUpdateStatus instruction (variant 7).
   * Updates metadata on an existing Alexandria Protocol RWA token.
   * @param {string} tokenId - RWA token to update
   * @param {string} newStatus - New status string
   * @param {number|bigint|null} [newValuation=null] - Updated valuation in USD cents
   * @param {string|null} [newLegalDocHash=null] - Updated document hash
   * @param {string|null} [newLegalDocUri=null] - Updated document URI
   * @returns {Buffer}
   */
  rwaUpdateStatus(tokenId, newStatus, newValuation = null, newLegalDocHash = null, newLegalDocUri = null) {
    return Buffer.concat([
      encodeU32(Variant.RWAUpdateStatus),
      encodeBincodeString(tokenId),
      encodeBincodeString(newStatus),
      encodeOption(newValuation, encodeU64),
      encodeOption(newLegalDocHash, encodeBincodeString),
      encodeOption(newLegalDocUri, encodeBincodeString),
    ]);
  },

  /**
   * Build an RWATransfer instruction (variant 8).
   * Transfers RWA tokens with compliance enforcement.
   * @param {string} tokenId - RWA token to transfer
   * @param {string} from - Sender address
   * @param {string} to - Recipient address
   * @param {number|bigint} amount - Amount in base units
   * @returns {Buffer}
   */
  rwaTransfer(tokenId, from, to, amount) {
    return Buffer.concat([
      encodeU32(Variant.RWATransfer),
      encodeBincodeString(tokenId),
      encodeBincodeString(from),
      encodeBincodeString(to),
      encodeU64(amount),
    ]);
  },

  // ── Ari Protocol Instructions (15-53) ──

  registerAgent(agentName, agentPubkey, maxPerTx, maxDaily, allowedContracts, allowedOperations, expiresAtSlot) {
    return Buffer.concat([
      encodeU32(Variant.RegisterAgent),
      encodeBincodeString(agentName),
      encodeBincodeString(agentPubkey),
      encodeU64(maxPerTx),
      encodeU64(maxDaily),
      encodeBincodeVec(Buffer.from(JSON.stringify(allowedContracts || []))),
      encodeBincodeVec(Buffer.from(JSON.stringify(allowedOperations || []))),
      encodeU64(expiresAtSlot || 0),
    ]);
  },

  updateAgent(agentPubkey, opts = {}) {
    return Buffer.concat([
      encodeU32(Variant.UpdateAgent),
      encodeBincodeString(agentPubkey),
      encodeOption(opts.newMaxPerTx, encodeU64),
      encodeOption(opts.newMaxDaily, encodeU64),
      encodeOption(opts.newAllowedContracts, v => encodeBincodeVec(Buffer.from(JSON.stringify(v)))),
      encodeOption(opts.newAllowedOperations, v => encodeBincodeVec(Buffer.from(JSON.stringify(v)))),
      encodeOption(opts.newExpiresAtSlot, encodeU64),
      encodeBool(opts.revoked || false),
    ]);
  },

  agentExecute(ownerPubkey, innerInstruction) {
    return Buffer.concat([
      encodeU32(Variant.AgentExecute),
      encodeBincodeString(ownerPubkey),
      encodeBincodeVec(innerInstruction),
    ]);
  },

  createIdentity(identityPubkey, displayName, identityType, parentIdentity, metadataJson) {
    return Buffer.concat([
      encodeU32(Variant.CreateIdentity),
      encodeBincodeString(identityPubkey),
      encodeBincodeString(displayName),
      encodeBincodeString(identityType || 'agent'),
      encodeBincodeString(parentIdentity || ''),
      encodeBincodeString(metadataJson || '{}'),
    ]);
  },

  updateIdentity(identityPubkey, opts = {}) {
    return Buffer.concat([
      encodeU32(Variant.UpdateIdentity),
      encodeBincodeString(identityPubkey),
      encodeOption(opts.newDisplayName, encodeBincodeString),
      encodeOption(opts.newMetadata, encodeBincodeString),
      encodeBool(opts.deactivated || false),
    ]);
  },

  attestReputation(subjectPubkey, score, category, evidence) {
    return Buffer.concat([
      encodeU32(Variant.AttestReputation),
      encodeBincodeString(subjectPubkey),
      encodeU8(Math.min(100, Math.max(1, score))),
      encodeBincodeString(category),
      encodeBincodeString(evidence || ''),
    ]);
  },

  agentMessage(toIdentity, messageType, payloadJson, replyTo, expiresAtSlot) {
    return Buffer.concat([
      encodeU32(Variant.AgentMessage),
      encodeBincodeString(toIdentity),
      encodeBincodeString(messageType),
      encodeBincodeString(typeof payloadJson === 'string' ? payloadJson : JSON.stringify(payloadJson)),
      encodeBincodeString(replyTo || ''),
      encodeU64(expiresAtSlot || 0),
    ]);
  },

  subDelegate(subAgentPubkey, subAgentName, maxPerTx, maxDaily, allowedContracts, allowedOperations, expiresAtSlot, maxDepth) {
    return Buffer.concat([
      encodeU32(Variant.SubDelegate),
      encodeBincodeString(subAgentPubkey),
      encodeBincodeString(subAgentName),
      encodeU64(maxPerTx),
      encodeU64(maxDaily),
      encodeBincodeVec(Buffer.from(JSON.stringify(allowedContracts || []))),
      encodeBincodeVec(Buffer.from(JSON.stringify(allowedOperations || []))),
      encodeU64(expiresAtSlot || 0),
      encodeU8(maxDepth || 0),
    ]);
  },

  conditionalOrder(orderId, conditionType, conditionSource, conditionThreshold, innerInstruction, expiresAtSlot, lockedAmount) {
    return Buffer.concat([
      encodeU32(Variant.ConditionalOrder),
      encodeBincodeString(orderId),
      encodeBincodeString(conditionType),
      encodeBincodeString(conditionSource),
      encodeU64(conditionThreshold),
      encodeBincodeVec(innerInstruction),
      encodeU64(expiresAtSlot || 0),
      encodeU64(lockedAmount || 0),
    ]);
  },

  cancelConditionalOrder(orderId) {
    return Buffer.concat([encodeU32(Variant.CancelConditionalOrder), encodeBincodeString(orderId)]);
  },

  registerOracle(oracleId, description, feedType, updateIntervalSlots, stakeAmount) {
    return Buffer.concat([
      encodeU32(Variant.RegisterOracle),
      encodeBincodeString(oracleId),
      encodeBincodeString(description),
      encodeBincodeString(feedType),
      encodeU64(updateIntervalSlots || 100),
      encodeU64(stakeAmount),
    ]);
  },

  oracleSubmit(oracleId, value, metadata) {
    return Buffer.concat([
      encodeU32(Variant.OracleSubmit),
      encodeBincodeString(oracleId),
      encodeU64(value),
      encodeBincodeString(metadata || ''),
    ]);
  },

  hardwareAttest(devicePubkey, deviceType, manufacturer, model, firmwareVersion, attestationProof, boundIdentity) {
    return Buffer.concat([
      encodeU32(Variant.HardwareAttest),
      encodeBincodeString(devicePubkey),
      encodeBincodeString(deviceType),
      encodeBincodeString(manufacturer),
      encodeBincodeString(model),
      encodeBincodeString(firmwareVersion),
      encodeBincodeVec(attestationProof),
      encodeBincodeString(boundIdentity),
    ]);
  },

  registerCapability(providerIdentity, category, tags, region, description, pricePerUnit, maxConcurrent, metadataJson) {
    return Buffer.concat([
      encodeU32(Variant.RegisterCapability),
      encodeBincodeString(providerIdentity),
      encodeBincodeString(category),
      encodeBincodeVec(Buffer.from(JSON.stringify(tags || []))),
      encodeBincodeString(region || 'global'),
      encodeBincodeString(description || ''),
      encodeU64(pricePerUnit || 0),
      encodeU32(maxConcurrent || 0),
      encodeBincodeString(metadataJson || '{}'),
    ]);
  },

  postTask(taskId, title, description, requiredCategory, requiredTags, minReputation, reward, expiresAtSlot, maxClaimants, verification, verificationOracle, verificationThreshold) {
    return Buffer.concat([
      encodeU32(Variant.PostTask),
      encodeBincodeString(taskId),
      encodeBincodeString(title),
      encodeBincodeString(description || ''),
      encodeBincodeString(requiredCategory || ''),
      encodeBincodeVec(Buffer.from(JSON.stringify(requiredTags || []))),
      encodeU8(minReputation || 0),
      encodeU64(reward),
      encodeU64(expiresAtSlot || 0),
      encodeU32(maxClaimants || 1),
      encodeBincodeString(verification || 'poster_confirm'),
      encodeBincodeString(verificationOracle || ''),
      encodeU64(verificationThreshold || 0),
    ]);
  },

  claimTask(taskId, claimantIdentity) {
    return Buffer.concat([
      encodeU32(Variant.ClaimTask),
      encodeBincodeString(taskId),
      encodeBincodeString(claimantIdentity),
    ]);
  },

  resolveTask(taskId, resolution, proof) {
    return Buffer.concat([
      encodeU32(Variant.ResolveTask),
      encodeBincodeString(taskId),
      encodeBincodeString(resolution),
      encodeBincodeString(proof || ''),
    ]);
  },

  registerModel(identityPubkey, modelName, modelHash, modelVersion, framework, capabilitiesJson, modelSizeBytes, executionEnvironment) {
    return Buffer.concat([
      encodeU32(Variant.RegisterModel),
      encodeBincodeString(identityPubkey),
      encodeBincodeString(modelName),
      encodeBincodeString(modelHash),
      encodeBincodeString(modelVersion || '0.0.0'),
      encodeBincodeString(framework || 'custom'),
      encodeBincodeString(capabilitiesJson || '{}'),
      encodeU64(modelSizeBytes || 0),
      encodeBincodeString(executionEnvironment || 'local'),
    ]);
  },

  openDispute(disputeId, disputeType, subjectId, reason, evidence, bond) {
    return Buffer.concat([
      encodeU32(Variant.OpenDispute),
      encodeBincodeString(disputeId),
      encodeBincodeString(disputeType),
      encodeBincodeString(subjectId),
      encodeBincodeString(reason),
      encodeBincodeString(evidence || ''),
      encodeU64(bond || 0),
    ]);
  },

  resolveDispute(disputeId, action, data) {
    return Buffer.concat([
      encodeU32(Variant.ResolveDispute),
      encodeBincodeString(disputeId),
      encodeBincodeString(action),
      encodeBincodeString(data || ''),
    ]);
  },

  slashReport(agentPubkey, ownerPubkey, violationType, evidence, violationSlot) {
    return Buffer.concat([
      encodeU32(Variant.SlashReport),
      encodeBincodeString(agentPubkey),
      encodeBincodeString(ownerPubkey),
      encodeBincodeString(violationType),
      encodeBincodeString(evidence || ''),
      encodeU64(violationSlot || 0),
    ]);
  },

  createProposal(proposalId, title, description, proposalType, parameterJson, votingPeriodSlots, quorum) {
    return Buffer.concat([
      encodeU32(Variant.CreateProposal),
      encodeBincodeString(proposalId),
      encodeBincodeString(title),
      encodeBincodeString(description || ''),
      encodeBincodeString(proposalType || 'text'),
      encodeBincodeString(parameterJson || '{}'),
      encodeU64(votingPeriodSlots || 151200),
      encodeU64(quorum || 0),
    ]);
  },

  castVote(proposalId, vote) {
    return Buffer.concat([
      encodeU32(Variant.CastVote),
      encodeBincodeString(proposalId),
      encodeBincodeString(vote),
    ]);
  },

  executeProposal(proposalId) {
    return Buffer.concat([encodeU32(Variant.ExecuteProposal), encodeBincodeString(proposalId)]);
  },

  openChannel(channelId, counterparty, deposit, channelType, expiresAtSlot) {
    return Buffer.concat([
      encodeU32(Variant.OpenChannel),
      encodeBincodeString(channelId),
      encodeBincodeString(counterparty),
      encodeU64(deposit),
      encodeBincodeString(channelType || 'payment'),
      encodeU64(expiresAtSlot || 0),
    ]);
  },

  closeChannel(channelId, finalBalanceA, finalBalanceB, messageCount, counterpartySignature) {
    return Buffer.concat([
      encodeU32(Variant.CloseChannel),
      encodeBincodeString(channelId),
      encodeU64(finalBalanceA),
      encodeU64(finalBalanceB),
      encodeU64(messageCount || 0),
      encodeBincodeVec(counterpartySignature || Buffer.alloc(0)),
    ]);
  },

  agentHeartbeat(identityPubkey, currentModelHash, activeTasks, availableCapacity, statusMessage) {
    return Buffer.concat([
      encodeU32(Variant.AgentHeartbeat),
      encodeBincodeString(identityPubkey),
      encodeBincodeString(currentModelHash || ''),
      encodeU32(activeTasks || 0),
      encodeU32(availableCapacity || 0),
      encodeBincodeString(statusMessage || ''),
    ]);
  },

  zkProofSubmit(proofId, proofSystem, proofData, publicInputs, verificationKeyHash, proofType, metadataJson) {
    return Buffer.concat([
      encodeU32(Variant.ZkProofSubmit),
      encodeBincodeString(proofId),
      encodeBincodeString(proofSystem || 'groth16'),
      encodeBincodeVec(proofData),
      encodeBincodeVec(publicInputs),
      encodeBincodeString(verificationKeyHash),
      encodeBincodeString(proofType || 'custom'),
      encodeBincodeString(metadataJson || '{}'),
    ]);
  },

  zkProofVerify(proofId) {
    return Buffer.concat([encodeU32(Variant.ZkProofVerify), encodeBincodeString(proofId)]);
  },

  zkPrivateTransfer(tokenId, from, to, amountCommitment, rangeProof, balanceProof, nullifier) {
    return Buffer.concat([
      encodeU32(Variant.ZkPrivateTransfer),
      encodeBincodeString(tokenId),
      encodeBincodeString(from),
      encodeBincodeString(to),
      encodeBincodeVec(amountCommitment),
      encodeBincodeVec(rangeProof),
      encodeBincodeVec(balanceProof),
      encodeBincodeVec(nullifier),
    ]);
  },

  zkIdentityProof(identityPubkey, claimType, claimValue, proofData, publicInputs) {
    return Buffer.concat([
      encodeU32(Variant.ZkIdentityProof),
      encodeBincodeString(identityPubkey),
      encodeBincodeString(claimType),
      encodeU64(claimValue),
      encodeBincodeVec(proofData),
      encodeBincodeVec(publicInputs),
    ]);
  },

  pqKeyRegister(ed25519Pubkey, pqPublicKey, pqAlgorithm, securityLevel) {
    return Buffer.concat([
      encodeU32(Variant.PqKeyRegister),
      encodeBincodeString(ed25519Pubkey),
      encodeBincodeVec(pqPublicKey),
      encodeBincodeString(pqAlgorithm),
      encodeU8(securityLevel || 3),
    ]);
  },

  pqKeyRotate(ed25519Pubkey, newPqPublicKey, newPqAlgorithm, rotationProof) {
    return Buffer.concat([
      encodeU32(Variant.PqKeyRotate),
      encodeBincodeString(ed25519Pubkey),
      encodeBincodeVec(newPqPublicKey),
      encodeBincodeString(newPqAlgorithm),
      encodeBincodeVec(rotationProof),
    ]);
  },

  pqSignedTransfer(from, to, amount, pqSignature, pqAlgorithm) {
    return Buffer.concat([
      encodeU32(Variant.PqSignedTransfer),
      encodeBincodeString(from),
      encodeBincodeString(to),
      encodeU64(amount),
      encodeBincodeVec(pqSignature),
      encodeBincodeString(pqAlgorithm),
    ]);
  },

  pqAttest(attestationType, referenceId, pqAlgorithm, verified) {
    return Buffer.concat([
      encodeU32(Variant.PqAttest),
      encodeBincodeString(attestationType),
      encodeBincodeString(referenceId),
      encodeBincodeString(pqAlgorithm),
      encodeBool(verified),
    ]);
  },
};

// ============================================================================
// KEYPAIR
// ============================================================================

/**
 * XerisCoin keypair wrapper.
 * Wraps a Solana Ed25519 keypair with convenience methods for XerisCoin.
 * Keypair files are JSON arrays of 64 bytes (same format as the Rust CLI wallet).
 */
class XerisKeypair {
  /**
   * Create a keypair from a Solana Keypair instance.
   * @param {Keypair} solanaKeypair
   */
  constructor(solanaKeypair) {
    this._keypair = solanaKeypair;
  }

  /**
   * Generate a new random keypair.
   * @returns {XerisKeypair}
   */
  static generate() {
    return new XerisKeypair(Keypair.generate());
  }

  /**
   * Load a keypair from a JSON file.
   * The file should contain a JSON array of 64 bytes (the Ed25519 secret key).
   * This is the same format produced by the Rust CLI wallet's keygen command.
   * @param {string} path - Path to the keypair JSON file
   * @returns {XerisKeypair}
   */
  static fromJsonFile(path) {
    const fs = require('fs');
    const bytes = JSON.parse(fs.readFileSync(path, 'utf8'));
    return new XerisKeypair(Keypair.fromSecretKey(Uint8Array.from(bytes)));
  }

  /**
   * Load a keypair from raw 64-byte secret key bytes.
   * @param {Uint8Array|number[]} secretKey - 64-byte Ed25519 secret key
   * @returns {XerisKeypair}
   */
  static fromSecretKey(secretKey) {
    return new XerisKeypair(Keypair.fromSecretKey(Uint8Array.from(secretKey)));
  }

  /** @returns {string} The public key as a base58 string */
  get publicKey() {
    return this._keypair.publicKey.toBase58();
  }

  /** @returns {Keypair} The underlying Solana Keypair instance */
  get solanaKeypair() {
    return this._keypair;
  }

  /**
   * Export the secret key as a JSON-compatible byte array.
   * @returns {number[]} 64-byte array suitable for JSON.stringify
   */
  toJsonBytes() {
    return Array.from(this._keypair.secretKey);
  }

  /**
   * Save the keypair to a JSON file (same format as the Rust CLI wallet).
   * @param {string} path - File path to write
   */
  saveToFile(path) {
    const fs = require('fs');
    fs.writeFileSync(path, JSON.stringify(this.toJsonBytes()));
  }
}

// ============================================================================
// CLIENT
// ============================================================================

/**
 * XerisCoin RPC client.
 * Provides high-level methods for every on-chain operation and query endpoint.
 * Handles blockhash fetching, instruction encoding, transaction signing,
 * and submission automatically.
 */
class XerisClient {
  /**
   * Create a new client connected to a XerisCoin node.
   * @param {string} host - Node URL with protocol (e.g. "http://138.197.116.81")
   * @param {object} [opts={}] - Configuration options
   * @param {number} [opts.rpcPort=56001] - RPC server port
   * @param {number} [opts.explorerPort=50008] - Explorer/JSON-RPC port
   */
  constructor(host, opts = {}) {
    this.host = host.replace(/\/$/, '');
    this.rpcPort = opts.rpcPort || DEFAULT_RPC_PORT;
    this.explorerPort = opts.explorerPort || DEFAULT_EXPLORER_PORT;
    this.rpcUrl = `${this.host}:${this.rpcPort}`;
    this.explorerUrl = `${this.host}:${this.explorerPort}`;
  }

  /**
   * Create a client pointing at the public XerisCoin testnet.
   * @returns {XerisClient}
   */
  static testnet() {
    return new XerisClient(`http://${TESTNET_SEED}`);
  }

  // --------------------------------------------------------------------------
  // Internal HTTP helpers
  // --------------------------------------------------------------------------

  /** @private */
  async _get(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    return resp.json();
  }

  /** @private */
  async _post(url, body) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    return resp.json();
  }

  /** @private */
  async _jsonRpc(method, params = []) {
    const data = await this._post(this.explorerUrl, {
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    });
    if (data.error) {
      const msg = typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error));
      throw new Error(`JSON-RPC error: ${msg}`);
    }
    return data.result;
  }

  // --------------------------------------------------------------------------
  // Transaction building and submission
  // --------------------------------------------------------------------------

  /**
   * Fetch the latest blockhash from the chain.
   * @returns {Promise<Buffer>} 32-byte blockhash
   */
  async getLatestBlockhash() {
    const result = await this._jsonRpc('getLatestBlockhash');
    const raw = result.value.blockhash;
    // BUG FIX: The node may return the blockhash as either a 64-char hex string
    // or a base58-encoded string. Detect and handle both formats.
    if (/^[0-9a-f]{64}$/i.test(raw)) {
      // Hex string — decode to bytes
      return Buffer.from(raw, 'hex');
    } else {
      // Already base58 — decode to bytes
      return Buffer.from(bs58.decode(raw));
    }
  }

  /**
   * Build, sign, and submit a transaction from raw instruction data.
   * This is the low-level method that all high-level transaction methods use.
   *
   * @param {XerisKeypair} keypair - Signing keypair
   * @param {Buffer} instructionData - Bincode-encoded XerisInstruction bytes
   * @returns {Promise<object>} Node response (includes `signature` on success)
   * @throws {Error} On network or signing failure
   */
  async sendInstruction(keypair, instructionData) {
    const blockhashBuf = await this.getLatestBlockhash();
    const blockhash = bs58.encode(blockhashBuf);

    const instruction = new TransactionInstruction({
      keys: [{ pubkey: keypair.solanaKeypair.publicKey, isSigner: true, isWritable: true }],
      programId: new PublicKey(Buffer.alloc(32)),
      data: instructionData,
    });

    const tx = new Transaction();
    tx.recentBlockhash = blockhash;
    tx.feePayer = keypair.solanaKeypair.publicKey;
    tx.add(instruction);
    tx.sign(keypair.solanaKeypair);

    const txBytes = tx.serialize();
    const txBase64 = txBytes.toString('base64');

    const result = await this._post(`${this.rpcUrl}/submit`, { tx_base64: txBase64 });
    if (result.error) throw new Error(result.error);
    return result;
  }

  // --------------------------------------------------------------------------
  // High-level transaction methods
  // --------------------------------------------------------------------------

  /**
   * Transfer native XRS to another address.
   * @param {XerisKeypair} keypair - Sender keypair
   * @param {string} to - Recipient address (base58)
   * @param {number} amountXrs - Amount in XRS (e.g. 5.0 for five XRS)
   * @returns {Promise<object>} Submission response with `signature` field
   */
  async transferXrs(keypair, to, amountXrs) {
    const lamports = Math.round(amountXrs * LAMPORTS_PER_XRS);
    return this.sendInstruction(keypair, Instructions.nativeTransfer(keypair.publicKey, to, lamports));
  }

  /**
   * Stake XRS for Proof of Stake mining eligibility.
   * @param {XerisKeypair} keypair - Staker keypair
   * @param {number} amountXrs - Amount to stake (minimum 1,000 XRS)
   * @returns {Promise<object>}
   */
  async stakeXrs(keypair, amountXrs) {
    const lamports = Math.round(amountXrs * LAMPORTS_PER_XRS);
    return this.sendInstruction(keypair, Instructions.stake(keypair.publicKey, lamports));
  }

  /**
   * Begin unstaking XRS. Funds enter a 7-day unbonding period.
   * @param {XerisKeypair} keypair - Staker keypair
   * @param {number} amountXrs - Amount to unstake
   * @returns {Promise<object>}
   */
  async unstakeXrs(keypair, amountXrs) {
    const lamports = Math.round(amountXrs * LAMPORTS_PER_XRS);
    return this.sendInstruction(keypair, Instructions.unstake(keypair.publicKey, lamports));
  }

  /**
   * Register a new token on-chain.
   * @param {XerisKeypair} keypair - Creator keypair (becomes mint authority)
   * @param {string} tokenId - Unique token ID
   * @param {string} name - Token name
   * @param {string} symbol - Token ticker symbol
   * @param {number} decimals - Decimal places (typically 9)
   * @param {number} maxSupply - Maximum supply in whole tokens
   * @returns {Promise<object>}
   */
  async createToken(keypair, tokenId, name, symbol, decimals, maxSupply) {
    const maxSupplyBase = BigInt(maxSupply) * BigInt(10 ** decimals);
    return this.sendInstruction(keypair, Instructions.tokenCreate(tokenId, name, symbol, decimals, maxSupplyBase, keypair.publicKey));
  }

  /**
   * Mint tokens to an address. Caller must be the token's mint authority.
   * @param {XerisKeypair} keypair - Mint authority keypair
   * @param {string} tokenId - Token to mint
   * @param {string} to - Recipient address
   * @param {number} amount - Amount in whole tokens
   * @param {number} decimals - Token's decimal places
   * @returns {Promise<object>}
   */
  async mintTokens(keypair, tokenId, to, amount, decimals) {
    const amountBase = BigInt(amount) * BigInt(10 ** decimals);
    return this.sendInstruction(keypair, Instructions.tokenMint(tokenId, to, amountBase));
  }

  /**
   * Transfer tokens between accounts.
   * @param {XerisKeypair} keypair - Sender keypair
   * @param {string} tokenId - Token to transfer
   * @param {string} to - Recipient address
   * @param {number} amount - Amount in whole tokens
   * @param {number} decimals - Token's decimal places
   * @returns {Promise<object>}
   */
  async transferToken(keypair, tokenId, to, amount, decimals) {
    const amountBase = BigInt(amount) * BigInt(10 ** decimals);
    return this.sendInstruction(keypair, Instructions.tokenTransfer(tokenId, keypair.publicKey, to, amountBase));
  }

  /**
   * Burn tokens from your account.
   * @param {XerisKeypair} keypair - Token holder keypair
   * @param {string} tokenId - Token to burn
   * @param {number} amount - Amount in whole tokens
   * @param {number} decimals - Token's decimal places
   * @returns {Promise<object>}
   */
  async burnTokens(keypair, tokenId, amount, decimals) {
    const amountBase = BigInt(amount) * BigInt(10 ** decimals);
    return this.sendInstruction(keypair, Instructions.tokenBurn(tokenId, keypair.publicKey, amountBase));
  }

  /**
   * Deploy a smart contract.
   * @param {XerisKeypair} keypair - Deployer keypair
   * @param {string} contractId - Unique contract ID
   * @param {string} contractType - One of: swap, escrow, timelock, vesting, multisig, rwa, launchpad
   * @param {object} params - Initialization parameters
   * @returns {Promise<object>}
   */
  async deployContract(keypair, contractId, contractType, params) {
    return this.sendInstruction(keypair, Instructions.contractDeploy(contractId, contractType, params));
  }

  /**
   * Call a method on a deployed contract.
   * @param {XerisKeypair} keypair - Caller keypair
   * @param {string} contractId - Contract to call
   * @param {string} method - Method name
   * @param {object} args - Method arguments
   * @returns {Promise<object>}
   */
  async callContract(keypair, contractId, method, args) {
    return this.sendInstruction(keypair, Instructions.contractCall(contractId, method, args));
  }

  /**
   * Wrap native XRS into the xrs_native token for DEX trading.
   * @param {XerisKeypair} keypair - Account keypair
   * @param {number} amountXrs - Amount in XRS
   * @returns {Promise<object>}
   */
  async wrapXrs(keypair, amountXrs) {
    const lamports = Math.round(amountXrs * LAMPORTS_PER_XRS);
    return this.sendInstruction(keypair, Instructions.wrapXrs(lamports));
  }

  /**
   * Unwrap xrs_native token back to native XRS.
   * @param {XerisKeypair} keypair - Account keypair
   * @param {number} amountXrs - Amount in XRS
   * @returns {Promise<object>}
   */
  async unwrapXrs(keypair, amountXrs) {
    const lamports = Math.round(amountXrs * LAMPORTS_PER_XRS);
    return this.sendInstruction(keypair, Instructions.unwrapXrs(lamports));
  }

  /**
   * Submit a block attestation for light client mining rewards.
   * @param {XerisKeypair} keypair - Light client keypair
   * @param {number} blockSlot - Slot of the block that was verified
   * @param {Buffer} blockHash - Full 32-byte block hash
   * @returns {Promise<object>} Includes `attestation_accepted` or `status: "rate_limited"`
   */
  async submitAttestation(keypair, blockSlot, blockHash) {
    return this.sendInstruction(keypair, Instructions.validatorAttestation(keypair.publicKey, blockSlot, blockHash));
  }

  // --------------------------------------------------------------------------
  // Read-only queries: RPC port (56001)
  // --------------------------------------------------------------------------

  /** Check node health. @returns {Promise<{status: string}>} */
  async getHealth() { return this._get(`${this.rpcUrl}/health`); }

  /** Get the last 50 blocks. @returns {Promise<object[]>} */
  async getRecentBlocks() { return this._get(`${this.rpcUrl}/blocks`); }

  /** Get stake info for an address. @returns {Promise<object>} */
  async getStakeInfo(address) { return this._get(`${this.rpcUrl}/stake/${address}`); }

  /** Get the network economics dashboard. @returns {Promise<object>} */
  async getNetworkEconomics() { return this._get(`${this.rpcUrl}/network/economics`); }

  /** List all registered tokens. @returns {Promise<object[]>} */
  async getTokenList() { return this._get(`${this.rpcUrl}/tokens`); }

  /** Get balance for a specific token. @returns {Promise<object>} */
  async getTokenBalance(address, tokenId) { return this._get(`${this.rpcUrl}/token/balance/${address}/${tokenId}`); }

  /** Get all token balances for an address (including native XRS). @returns {Promise<object>} */
  async getTokenAccounts(address) { return this._get(`${this.rpcUrl}/token/accounts/${address}`); }

  /** List all deployed contracts. @returns {Promise<object[]>} */
  async getContracts() { return this._get(`${this.rpcUrl}/contracts`); }

  /** Get a specific contract's full state. @returns {Promise<object>} */
  async getContract(contractId) { return this._get(`${this.rpcUrl}/contract/${contractId}`); }

  /** Get a swap/contract quote. @returns {Promise<object>} */
  async getContractQuote(contractId, params) {
    const qs = new URLSearchParams(params).toString();
    return this._get(`${this.rpcUrl}/contract/${contractId}/quote?${qs}`);
  }

  /** List all active launchpad bonding curves. @returns {Promise<object[]>} */
  async getLaunchpads() { return this._get(`${this.rpcUrl}/launchpads`); }

  /** Get a buy quote for a launchpad token. @returns {Promise<object>} */
  async getLaunchpadQuote(contractId, xrsAmountLamports) {
    return this._get(`${this.rpcUrl}/launchpad/${contractId}/quote?xrs_amount=${xrsAmountLamports}`);
  }

  /**
   * Request testnet XRS from the faucet.
   * Rate-limited to 1 request per 10 seconds per IP.
   * @param {string} address - Recipient address
   * @param {number} amountXrs - Amount in XRS (e.g. 100)
   * @returns {Promise<object>}
   */
  async airdrop(address, amountXrs) {
    return this._get(`${this.rpcUrl}/airdrop/${address}/${Math.round(amountXrs)}`);
  }

  // --------------------------------------------------------------------------
  // Read-only queries: Explorer port (50008)
  // --------------------------------------------------------------------------

  /** Get network stats overview. @returns {Promise<object>} */
  async getStats() { return this._get(`${this.explorerUrl}/v2/stats`); }

  /** Get paginated block list. @returns {Promise<object>} */
  async getBlocks(page = 1, pageSize = 20) { return this._get(`${this.explorerUrl}/v2/blocks?page=${page}&page_size=${pageSize}`); }

  /** Get a block by slot number. @returns {Promise<object>} */
  async getBlockBySlot(slot) { return this._get(`${this.explorerUrl}/v2/block/slot/${slot}`); }

  /** Get a block by hash (hex string). @returns {Promise<object>} */
  async getBlockByHash(hash) { return this._get(`${this.explorerUrl}/v2/block/hash/${hash}`); }

  /** Get paginated recent transactions. @returns {Promise<object>} */
  async getTransactions(page = 1, pageSize = 20) { return this._get(`${this.explorerUrl}/v2/transactions?page=${page}&page_size=${pageSize}`); }

  /** Get full transaction detail by signature. @returns {Promise<object>} */
  async getTransaction(signature) { return this._get(`${this.explorerUrl}/v2/tx/${signature}`); }

  /** Get account info. @returns {Promise<object>} */
  async getAccountInfo(address) { return this._get(`${this.explorerUrl}/v2/account/${address}`); }

  /** Get transaction history filtered by address. @returns {Promise<object>} */
  async getAccountTransactions(address, page = 1, pageSize = 20) {
    return this._get(`${this.explorerUrl}/v2/account/${address}/transactions?page=${page}&page_size=${pageSize}`);
  }

  /** Get all validators with stake info. @returns {Promise<object>} */
  async getValidators() { return this._get(`${this.explorerUrl}/v2/validators`); }

  /** Search by address, signature, slot, or hash. @returns {Promise<object>} */
  async search(query) { return this._get(`${this.explorerUrl}/v2/search?q=${encodeURIComponent(query)}`); }

  // --------------------------------------------------------------------------
  // JSON-RPC (Solana-compatible, Explorer port)
  // --------------------------------------------------------------------------

  /** Get balance in lamports. @returns {Promise<number>} */
  async getBalance(address) {
    const result = await this._jsonRpc('getBalance', [address]);
    return result.value;
  }

  /** Get current slot number. @returns {Promise<number>} */
  async getSlot() { return this._jsonRpc('getSlot'); }

  /** Get current block height. @returns {Promise<number>} */
  async getBlockHeight() { return this._jsonRpc('getBlockHeight'); }

  /** Get recent signatures for an address. @returns {Promise<object[]>} */
  async getSignaturesForAddress(address, limit = 20) {
    return this._jsonRpc('getSignaturesForAddress', [address, { limit }]);
  }

  // --------------------------------------------------------------------------
  // Ari Protocol queries
  // --------------------------------------------------------------------------

  /** Get all agents registered by an owner. */
  async getAgentRegistry(owner) { return this._get(`${this.rpcUrl}/agent/registry/${owner}`); }

  /** Check if an agent is currently authorized. */
  async validateAgent(agentPubkey, owner) { return this._get(`${this.rpcUrl}/agent/validate/${agentPubkey}/${owner}`); }

  /** Convert an intent to instruction data (for AI agents). */
  async agentPlan(action) { return this._post(`${this.rpcUrl}/agent/plan`, action); }

  /** Search capabilities by category, tags, region, reputation. */
  async searchCapabilities(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this._get(`${this.rpcUrl}/capabilities/search?${qs}`);
  }

  /** Get all active capability listings. */
  async getCapabilities() { return this._get(`${this.rpcUrl}/capabilities`); }

  /** Get all open tasks. */
  async getTasks() { return this._get(`${this.rpcUrl}/tasks`); }

  /** Get a specific task. */
  async getTask(taskId) { return this._get(`${this.rpcUrl}/tasks/${taskId}`); }

  /** Get ZK proofs for an identity. */
  async getZkProofs(identity) { return this._get(`${this.rpcUrl}/zk/proofs/${identity}`); }

  /** Get ZK proof verification status. */
  async getZkProofStatus(proofId) { return this._get(`${this.rpcUrl}/zk/verify/${proofId}`); }

  /** Get global ZKP statistics. */
  async getZkStats() { return this._get(`${this.rpcUrl}/zk/stats`); }

  /** Get PQ key info for an address. */
  async getPqKey(address) { return this._get(`${this.rpcUrl}/pq/keys/${address}`); }

  /** Get network PQ adoption status. */
  async getPqStatus() { return this._get(`${this.rpcUrl}/pq/status`); }

  // --------------------------------------------------------------------------
  // Ari Protocol transaction methods
  // --------------------------------------------------------------------------

  async registerAgent(keypair, agentName, agentPubkey, maxPerTx, maxDaily, allowedContracts, allowedOps, expiresAt) {
    return this.sendInstruction(keypair, Instructions.registerAgent(agentName, agentPubkey, maxPerTx, maxDaily, allowedContracts, allowedOps, expiresAt));
  }

  async updateAgent(keypair, agentPubkey, opts) {
    return this.sendInstruction(keypair, Instructions.updateAgent(agentPubkey, opts));
  }

  async createIdentity(keypair, displayName, identityType, parentIdentity, metadata) {
    return this.sendInstruction(keypair, Instructions.createIdentity(keypair.publicKey, displayName, identityType, parentIdentity, metadata));
  }

  async attestReputation(keypair, subjectPubkey, score, category, evidence) {
    return this.sendInstruction(keypair, Instructions.attestReputation(subjectPubkey, score, category, evidence));
  }

  async sendAgentMessage(keypair, toIdentity, messageType, payload, replyTo, expiresAt) {
    return this.sendInstruction(keypair, Instructions.agentMessage(toIdentity, messageType, payload, replyTo, expiresAt));
  }

  async postTask(keypair, taskId, title, desc, category, tags, minRep, reward, expires, maxClaim, verification) {
    return this.sendInstruction(keypair, Instructions.postTask(taskId, title, desc, category, tags, minRep, reward, expires, maxClaim, verification));
  }

  async claimTask(keypair, taskId) {
    return this.sendInstruction(keypair, Instructions.claimTask(taskId, keypair.publicKey));
  }

  async resolveTask(keypair, taskId, resolution, proof) {
    return this.sendInstruction(keypair, Instructions.resolveTask(taskId, resolution, proof));
  }

  async registerOracle(keypair, oracleId, description, feedType, intervalSlots, stakeAmount) {
    return this.sendInstruction(keypair, Instructions.registerOracle(oracleId, description, feedType, intervalSlots, stakeAmount));
  }

  async oracleSubmit(keypair, oracleId, value, metadata) {
    return this.sendInstruction(keypair, Instructions.oracleSubmit(oracleId, value, metadata));
  }

  async registerModel(keypair, modelName, modelHash, version, framework, capabilities, sizeBytes, environment) {
    return this.sendInstruction(keypair, Instructions.registerModel(keypair.publicKey, modelName, modelHash, version, framework, capabilities, sizeBytes, environment));
  }

  async agentHeartbeat(keypair, modelHash, activeTasks, capacity, status) {
    return this.sendInstruction(keypair, Instructions.agentHeartbeat(keypair.publicKey, modelHash, activeTasks, capacity, status));
  }

  async registerCapability(keypair, category, tags, region, description, price, maxConcurrent, metadata) {
    return this.sendInstruction(keypair, Instructions.registerCapability(keypair.publicKey, category, tags, region, description, price, maxConcurrent, metadata));
  }

  async createProposal(keypair, proposalId, title, description, proposalType, parameterJson, votingPeriod, quorum) {
    return this.sendInstruction(keypair, Instructions.createProposal(proposalId, title, description, proposalType, parameterJson, votingPeriod, quorum));
  }

  async castVote(keypair, proposalId, vote) {
    return this.sendInstruction(keypair, Instructions.castVote(proposalId, vote));
  }

  async pqKeyRegister(keypair, pqPublicKey, algorithm, securityLevel) {
    return this.sendInstruction(keypair, Instructions.pqKeyRegister(keypair.publicKey, pqPublicKey, algorithm, securityLevel));
  }
}

// ============================================================================
// TEST VECTORS
// ============================================================================

/**
 * Pre-computed test vectors for validating bincode encoding.
 * Use these to verify that your implementation produces identical byte sequences.
 * Run with: node -e "require('xeris-sdk').TestVectors.printAll()"
 * @namespace
 */
const TestVectors = {
  /** NativeTransfer: 5 XRS from "Alice" to "Bob" */
  nativeTransfer() {
    const ix = Instructions.nativeTransfer('Alice', 'Bob', 5_000_000_000);
    return { description: 'NativeTransfer: 5 XRS from "Alice" to "Bob"', hex: ix.toString('hex'), bytes: Array.from(ix) };
  },
  /** Stake: 1000 XRS for "TestVal" */
  stake() {
    const ix = Instructions.stake('TestVal', 1_000_000_000_000);
    return { description: 'Stake: 1000 XRS for "TestVal"', hex: ix.toString('hex'), bytes: Array.from(ix) };
  },
  /** TokenMint: 1 xUSDC to "Bob" */
  tokenMint() {
    const ix = Instructions.tokenMint('xUSDC', 'Bob', 1_000_000_000);
    return { description: 'TokenMint: 1 xUSDC to "Bob"', hex: ix.toString('hex'), bytes: Array.from(ix) };
  },
  /** TokenTransfer: 0.5 xUSDC from "Alice" to "Bob" */
  tokenTransfer() {
    const ix = Instructions.tokenTransfer('xUSDC', 'Alice', 'Bob', 500_000_000);
    return { description: 'TokenTransfer: 0.5 xUSDC from "Alice" to "Bob"', hex: ix.toString('hex'), bytes: Array.from(ix) };
  },
  /** WrapXrs: 10 XRS */
  wrapXrs() {
    const ix = Instructions.wrapXrs(10_000_000_000);
    return { description: 'WrapXrs: 10 XRS', hex: ix.toString('hex'), bytes: Array.from(ix) };
  },
  /** Print all vectors to stdout */
  printAll() {
    const vectors = [this.nativeTransfer(), this.stake(), this.tokenMint(), this.tokenTransfer(), this.wrapXrs()];
    for (const v of vectors) {
      console.log(`\n${v.description}`);
      console.log(`  hex: ${v.hex}`);
      console.log(`  len: ${v.bytes.length} bytes`);
    }
  },
};

// ============================================================================
// DAPP WALLET ADAPTER
// ============================================================================

/**
 * XerisDApp connects to the Xeris wallet provider injected by the
 * Xeris Command Center (or any compatible wallet).
 *
 * This is the class dApp developers use in the browser. It detects
 * window.xeris (or window.solana), connects to the user's wallet,
 * and provides high-level methods for building and submitting
 * transactions that the wallet signs on the user's behalf.
 *
 * Unlike XerisClient (which holds private keys and signs directly),
 * XerisDApp never touches private keys. All signing goes through
 * the wallet provider's approval popup.
 *
 * @example
 * // In a browser dApp (React, Vue, plain HTML, etc.)
 * import { XerisDApp } from 'xeris-sdk';
 *
 * const dapp = new XerisDApp();
 * await dapp.connect();
 * console.log("User wallet:", dapp.publicKey);
 *
 * await dapp.transferXrs(recipientAddress, 5.0);
 * await dapp.swapTokens("pool_mtk_xrs", "mytoken", 1000, 90);
 */
class XerisDApp {
  /**
   * Create a new dApp adapter.
   * @param {object} [opts={}] - Configuration
   * @param {string} [opts.rpcUrl] - Override RPC URL (otherwise fetched from wallet)
   * @param {string} [opts.explorerUrl] - Override Explorer URL
   * @param {string} [opts.network='mainnet'] - Network name
   */
  constructor(opts = {}) {
    this._provider = null;
    this._publicKey = null;
    this._rpcUrl = opts.rpcUrl || null;
    this._explorerUrl = opts.explorerUrl || null;
    this._connected = false;
    this._listeners = {};
  }

  /** @returns {string|null} The connected wallet's public key (base58) */
  get publicKey() {
    return this._publicKey ? this._publicKey.toString() : null;
  }

  /** @returns {boolean} Whether a wallet is connected */
  get connected() {
    return this._connected;
  }

  /** @returns {object|null} The raw wallet provider (window.xeris) */
  get provider() {
    return this._provider;
  }

  // --------------------------------------------------------------------------
  // Wallet detection and connection
  // --------------------------------------------------------------------------

  /**
   * Detect the wallet provider. Checks window.xeris first, then window.solana.
   * @returns {object|null} The provider, or null if no wallet found
   */
  static detectProvider() {
    if (typeof window === 'undefined') return null;
    if (window.xeris) return window.xeris;
    if (window.solana && window.solana.isXeris) return window.solana;
    if (window.solana) return window.solana;
    return null;
  }

  /**
   * Wait for the wallet provider to become available.
   * Useful when your script loads before the provider is injected.
   * @param {number} [timeoutMs=3000] - How long to wait
   * @returns {Promise<object|null>} The provider, or null on timeout
   */
  static waitForProvider(timeoutMs = 3000) {
    return new Promise((resolve) => {
      const provider = XerisDApp.detectProvider();
      if (provider) return resolve(provider);

      const start = Date.now();
      const interval = setInterval(() => {
        const p = XerisDApp.detectProvider();
        if (p) {
          clearInterval(interval);
          resolve(p);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(interval);
          resolve(null);
        }
      }, 100);

      // Also listen for the wallet-standard event
      try {
        window.addEventListener('wallet-standard:app-ready', () => {
          const p = XerisDApp.detectProvider();
          if (p) {
            clearInterval(interval);
            resolve(p);
          }
        }, { once: true });
      } catch (e) { /* ignore in non-browser */ }
    });
  }

  /**
   * Connect to the user's wallet. Shows an approval popup in the wallet
   * if this is the first connection.
   *
   * @param {object} [opts={}]
   * @param {boolean} [opts.onlyIfTrusted=false] - Only connect if previously approved
   * @returns {Promise<{publicKey: string}>}
   * @throws {Error} If no wallet found or user rejects
   */
  async connect(opts = {}) {
    this._provider = XerisDApp.detectProvider();
    if (!this._provider) {
      // Wait briefly in case injection is delayed
      this._provider = await XerisDApp.waitForProvider(2000);
    }
    if (!this._provider) {
      throw new Error(
        'Xeris wallet not found. Make sure you are using the Xeris Command Center browser or have a compatible wallet installed.'
      );
    }

    const result = await this._provider.connect({
      onlyIfTrusted: opts.onlyIfTrusted || false,
    });

    this._publicKey = result.publicKey;
    this._connected = true;

    // Fetch RPC URL from wallet if not set
    if (!this._rpcUrl && this._provider.getRpcUrl) {
      try {
        this._rpcUrl = await this._provider.getRpcUrl();
      } catch (e) {
        this._rpcUrl = `http://${TESTNET_SEED}:${DEFAULT_RPC_PORT}`;
      }
    }
    if (!this._explorerUrl) {
      // Derive explorer URL from RPC URL
      const base = this._rpcUrl ? this._rpcUrl.replace(`:${DEFAULT_RPC_PORT}`, '') : `http://${TESTNET_SEED}`;
      this._explorerUrl = `${base}:${DEFAULT_EXPLORER_PORT}`;
    }

    // Forward wallet events
    if (this._provider.on) {
      this._provider.on('disconnect', () => {
        this._connected = false;
        this._publicKey = null;
        this._emit('disconnect');
      });
      this._provider.on('accountChanged', (pk) => {
        this._publicKey = pk;
        this._emit('accountChanged', pk ? pk.toString() : null);
      });
    }

    this._emit('connect', { publicKey: this.publicKey });
    return { publicKey: this.publicKey };
  }

  /**
   * Disconnect from the wallet.
   */
  async disconnect() {
    if (this._provider && this._provider.disconnect) {
      await this._provider.disconnect();
    }
    this._connected = false;
    this._publicKey = null;
    this._emit('disconnect');
  }

  // --------------------------------------------------------------------------
  // Event system
  // --------------------------------------------------------------------------

  /** @param {string} event - 'connect', 'disconnect', 'accountChanged' */
  on(event, callback) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(callback);
  }

  off(event, callback) {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter(cb => cb !== callback);
  }

  /** @private */
  _emit(event, data) {
    if (!this._listeners[event]) return;
    this._listeners[event].forEach(cb => { try { cb(data); } catch (e) {} });
  }

  // --------------------------------------------------------------------------
  // Internal: build + sign through wallet
  // --------------------------------------------------------------------------

  /** @private */
  _requireConnected() {
    if (!this._connected || !this._provider) {
      throw new Error('Wallet not connected. Call dapp.connect() first.');
    }
  }

  /** @private - Fetch from RPC */
  async _get(url) {
    const resp = await fetch(url);
    return resp.json();
  }

  /** @private - Post to RPC */
  async _post(url, body) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return resp.json();
  }

  /** @private - JSON-RPC call */
  async _jsonRpc(method, params = []) {
    const data = await this._post(this._explorerUrl, {
      jsonrpc: '2.0', id: 1, method, params,
    });
    if (data.error) throw new Error(JSON.stringify(data.error));
    return data.result;
  }

  /**
   * Build a transaction from instruction data, have the wallet sign it,
   * and submit it to the network.
   *
   * This is the core method that all high-level transaction methods use.
   * The wallet shows an approval popup before signing.
   *
   * @param {Buffer|Uint8Array} instructionData - Encoded XerisInstruction
   * @returns {Promise<{signature: string}>}
   */
  async sendInstruction(instructionData) {
    this._requireConnected();

    // 1. Get blockhash (handles both hex and base58 from node)
    const result = await this._jsonRpc('getLatestBlockhash');
    const raw = result.value.blockhash;
    let blockhashBytes;
    if (/^[0-9a-f]{64}$/i.test(raw)) {
      blockhashBytes = new Uint8Array(raw.match(/.{2}/g).map(b => parseInt(b, 16)));
    } else {
      blockhashBytes = bs58.decode(raw);
    }
    const blockhash = bs58.encode(blockhashBytes);

    // 2. Build unsigned Solana transaction
    const pubkey = new PublicKey(this.publicKey);
    const instruction = new TransactionInstruction({
      keys: [{ pubkey, isSigner: true, isWritable: true }],
      programId: new PublicKey(Buffer.alloc(32)),
      data: Buffer.from(instructionData),
    });

    const tx = new Transaction();
    tx.recentBlockhash = blockhash;
    tx.feePayer = pubkey;
    tx.add(instruction);

    // 3. Send to wallet for signing and submission
    const resp = await this._provider.signAndSendTransaction(tx);
    return { signature: resp.signature };
  }

  // --------------------------------------------------------------------------
  // High-level transaction methods (wallet signs, no keys needed)
  // --------------------------------------------------------------------------

  /**
   * Transfer native XRS. The wallet will show an approval popup.
   * @param {string} to - Recipient address
   * @param {number} amountXrs - Amount in XRS (e.g. 5.0)
   */
  async transferXrs(to, amountXrs) {
    const lamports = Math.round(amountXrs * LAMPORTS_PER_XRS);
    return this.sendInstruction(Instructions.nativeTransfer(this.publicKey, to, lamports));
  }

  /**
   * Stake XRS for mining eligibility.
   * @param {number} amountXrs - Amount to stake (minimum 1,000 XRS)
   */
  async stakeXrs(amountXrs) {
    const lamports = Math.round(amountXrs * LAMPORTS_PER_XRS);
    return this.sendInstruction(Instructions.stake(this.publicKey, lamports));
  }

  /**
   * Begin unstaking XRS.
   * @param {number} amountXrs - Amount to unstake
   */
  async unstakeXrs(amountXrs) {
    const lamports = Math.round(amountXrs * LAMPORTS_PER_XRS);
    return this.sendInstruction(Instructions.unstake(this.publicKey, lamports));
  }

  /**
   * Transfer tokens.
   * @param {string} tokenId - Token to transfer
   * @param {string} to - Recipient
   * @param {number} amount - Whole tokens
   * @param {number} decimals - Token decimals
   */
  async transferToken(tokenId, to, amount, decimals) {
    const amountBase = BigInt(amount) * BigInt(10 ** decimals);
    return this.sendInstruction(Instructions.tokenTransfer(tokenId, this.publicKey, to, amountBase));
  }

  /**
   * Swap tokens through a liquidity pool.
   * @param {string} poolId - Pool contract ID
   * @param {string} tokenIn - Token you're selling
   * @param {number} amountIn - Amount in base units (lamports)
   * @param {number} minAmountOut - Minimum output (slippage protection)
   */
  /**
   * Swap tokens through a liquidity pool.
   * BUG FIX: Uses binary args (16 bytes LE) and correct method name
   * (swap_a_to_b or swap_b_to_a) instead of JSON encoding.
   * @param {string} poolId - Pool contract ID
   * @param {string} tokenIn - Token you're selling
   * @param {number} amountIn - Amount in base units (lamports)
   * @param {number} minAmountOut - Minimum output (slippage protection)
   */
  async swapTokens(poolId, tokenIn, amountIn, minAmountOut) {
    // Determine swap direction by checking which token the pool has as token_a
    let method = 'swap_a_to_b';
    try {
      const pool = await this.getContract(poolId);
      if (pool && pool.state) {
        const state = pool.state.Swap || pool.state;
        if (state.token_b === tokenIn) method = 'swap_b_to_a';
      }
    } catch (e) { /* default to a_to_b */ }
    return this.sendInstruction(encodeSwapCall(poolId, method, amountIn, minAmountOut));
  }

  /**
   * Buy tokens on a launchpad bonding curve.
   * @param {string} launchpadId - Launchpad contract ID
   * @param {number} xrsAmountLamports - XRS to spend (in lamports)
   * @param {number} minTokensOut - Minimum tokens to receive
   */
  async buyOnLaunchpad(launchpadId, xrsAmountLamports, minTokensOut) {
    return this.sendInstruction(Instructions.contractCall(launchpadId, 'buy_tokens', {
      xrs_amount: xrsAmountLamports,
      min_tokens_out: minTokensOut,
    }));
  }

  /**
   * Sell tokens on a launchpad bonding curve.
   * @param {string} launchpadId - Launchpad contract ID
   * @param {number} tokenAmount - Tokens to sell (in base units)
   * @param {number} minXrsOut - Minimum XRS to receive (in lamports)
   */
  async sellOnLaunchpad(launchpadId, tokenAmount, minXrsOut) {
    return this.sendInstruction(Instructions.contractCall(launchpadId, 'sell_tokens', {
      token_amount: tokenAmount,
      min_xrs_out: minXrsOut,
    }));
  }

  /**
   * Add liquidity to a pool.
   * @param {string} poolId - Pool contract ID
   * @param {number} amountA - Amount of token A (base units)
   * @param {number} amountB - Amount of token B (base units)
   */
  async addLiquidity(poolId, amountA, amountB) {
    return this.sendInstruction(Instructions.contractCall(poolId, 'add_liquidity', {
      amount_a: amountA,
      amount_b: amountB,
    }));
  }

  /**
   * Remove liquidity from a pool.
   * @param {string} poolId - Pool contract ID
   * @param {number} lpAmount - LP token amount to burn
   */
  async removeLiquidity(poolId, lpAmount) {
    return this.sendInstruction(Instructions.contractCall(poolId, 'remove_liquidity', {
      lp_amount: lpAmount,
    }));
  }

  /**
   * Wrap native XRS into xrs_native token for DEX trading.
   * @param {number} amountXrs - Amount in XRS
   */
  async wrapXrs(amountXrs) {
    const lamports = Math.round(amountXrs * LAMPORTS_PER_XRS);
    return this.sendInstruction(Instructions.wrapXrs(lamports));
  }

  /**
   * Unwrap xrs_native token back to native XRS.
   * @param {number} amountXrs - Amount in XRS
   */
  async unwrapXrs(amountXrs) {
    const lamports = Math.round(amountXrs * LAMPORTS_PER_XRS);
    return this.sendInstruction(Instructions.unwrapXrs(lamports));
  }

  /**
   * Call any contract method.
   * @param {string} contractId - Contract ID
   * @param {string} method - Method name
   * @param {object} args - Method arguments
   */
  async callContract(contractId, method, args) {
    return this.sendInstruction(Instructions.contractCall(contractId, method, args));
  }

  /**
   * Sign an arbitrary message (for authentication, proof of ownership, etc.)
   * @param {string|Uint8Array} message - Message to sign
   * @returns {Promise<{signature: Uint8Array}>}
   */
  async signMessage(message) {
    this._requireConnected();
    return this._provider.signMessage(
      typeof message === 'string' ? new TextEncoder().encode(message) : message
    );
  }

  // --------------------------------------------------------------------------
  // Read-only queries (no wallet needed, but uses the wallet's RPC)
  // --------------------------------------------------------------------------

  /** Get balance in lamports. */
  async getBalance(address) {
    const addr = address || this.publicKey;
    const result = await this._jsonRpc('getBalance', [addr]);
    return result.value;
  }

  /** Get all token balances for the connected wallet. */
  async getTokenAccounts(address) {
    const addr = address || this.publicKey;
    return this._get(`${this._rpcUrl}/token/accounts/${addr}`);
  }

  /** Get account info. */
  async getAccountInfo(address) {
    const addr = address || this.publicKey;
    return this._get(`${this._explorerUrl}/v2/account/${addr}`);
  }

  /** Get all active launchpads. */
  async getLaunchpads() {
    return this._get(`${this._rpcUrl}/launchpads`);
  }

  /** Get a buy quote for a launchpad. */
  async getLaunchpadQuote(launchpadId, xrsAmountLamports) {
    return this._get(`${this._rpcUrl}/launchpad/${launchpadId}/quote?xrs_amount=${xrsAmountLamports}`);
  }

  /** Get all deployed contracts. */
  async getContracts() {
    return this._get(`${this._rpcUrl}/contracts`);
  }

  /** Get a specific contract's state. */
  async getContract(contractId) {
    return this._get(`${this._rpcUrl}/contract/${contractId}`);
  }

  /** Get a swap quote. */
  async getSwapQuote(contractId, params) {
    const qs = new URLSearchParams(params).toString();
    return this._get(`${this._rpcUrl}/contract/${contractId}/quote?${qs}`);
  }

  /** Get all tokens. */
  async getTokenList() {
    return this._get(`${this._rpcUrl}/tokens`);
  }

  /** Get network stats. */
  async getStats() {
    return this._get(`${this._explorerUrl}/v2/stats`);
  }

  /** Get transaction detail. */
  async getTransaction(signature) {
    return this._get(`${this._explorerUrl}/v2/tx/${signature}`);
  }

  /** Request testnet airdrop. */
  async airdrop(amountXrs) {
    this._requireConnected();
    return this._get(`${this._rpcUrl}/airdrop/${this.publicKey}/${Math.round(amountXrs)}`);
  }
}

// ============================================================================
// AI AGENT CLASS
// ============================================================================

/**
 * XerisAgent — Autonomous AI agent that operates on XerisCoin.
 *
 * Designed for AI systems (like Ari) running on servers or local hardware.
 * The agent holds its own keypair but operates under delegated authority
 * from a human owner. All transactions go through AgentExecute, which
 * the ledger validates against the agent's registered permissions.
 *
 * @example
 * const agent = new XerisAgent(agentKeypair, ownerPubkey);
 * await agent.connect();
 * const tasks = await agent.findTasks({ category: 'trading' });
 * await agent.claimTask(tasks[0].task_id);
 * await agent.heartbeat({ status: 'working on task' });
 */
class XerisAgent {
  constructor(keypair, ownerPubkey, host, opts = {}) {
    this._keypair = keypair;
    this._ownerPubkey = ownerPubkey;
    this._client = new XerisClient(host || `http://${TESTNET_SEED}`, opts);
  }

  static testnet(keypair, ownerPubkey) {
    return new XerisAgent(keypair, ownerPubkey, `http://${TESTNET_SEED}`);
  }

  get publicKey() { return this._keypair.publicKey; }
  get ownerPubkey() { return this._ownerPubkey; }
  get client() { return this._client; }

  // --------------------------------------------------------------------------
  // Agent identity and status
  // --------------------------------------------------------------------------

  /** Check this agent's permissions and status. */
  async getPermissions() {
    return this._client.validateAgent(this.publicKey, this._ownerPubkey);
  }

  /** Get the full agent registry for the owner. */
  async getRegistry() {
    return this._client.getAgentRegistry(this._ownerPubkey);
  }

  /** Send a heartbeat proving this agent is alive. */
  async heartbeat(opts = {}) {
    return this._client.sendInstruction(
      this._keypair,
      Instructions.agentHeartbeat(
        this.publicKey,
        opts.modelHash || '',
        opts.activeTasks || 0,
        opts.capacity || 10,
        opts.status || 'online',
      )
    );
  }

  // --------------------------------------------------------------------------
  // Delegated operations (runs as owner via AgentExecute)
  // --------------------------------------------------------------------------

  /** Execute any instruction as the owner (goes through agent guardrails). */
  async execute(innerInstructionData) {
    const agentExecIx = Instructions.agentExecute(this._ownerPubkey, innerInstructionData);
    return this._client.sendInstruction(this._keypair, agentExecIx);
  }

  /** Transfer XRS from owner's balance. */
  async transferXrs(to, amountXrs) {
    const lamports = Math.round(amountXrs * LAMPORTS_PER_XRS);
    const inner = Instructions.nativeTransfer(this._ownerPubkey, to, lamports);
    return this.execute(inner);
  }

  /** Swap tokens on a DEX pool (uses binary encoding). */
  async swapTokens(poolId, tokenIn, amountIn, minAmountOut) {
    let method = 'swap_a_to_b';
    try {
      const pool = await this._client.getContract(poolId);
      if (pool && pool.state) {
        const state = pool.state.Swap || pool.state;
        if (state.token_b === tokenIn) method = 'swap_b_to_a';
      }
    } catch (e) { /* default */ }
    const inner = encodeSwapCall(poolId, method, amountIn, minAmountOut);
    return this.execute(inner);
  }

  /** Wrap XRS for DEX trading. */
  async wrapXrs(amountXrs) {
    return this.execute(Instructions.wrapXrs(Math.round(amountXrs * LAMPORTS_PER_XRS)));
  }

  /** Unwrap XRS from DEX. */
  async unwrapXrs(amountXrs) {
    return this.execute(Instructions.unwrapXrs(Math.round(amountXrs * LAMPORTS_PER_XRS)));
  }

  /** Call any contract method. */
  async callContract(contractId, method, args) {
    return this.execute(Instructions.contractCall(contractId, method, args));
  }

  /** Buy on a launchpad. */
  async buyOnLaunchpad(launchpadId, xrsAmount, minTokensOut) {
    return this.execute(Instructions.contractCall(launchpadId, 'buy_tokens', {
      xrs_amount: xrsAmount, min_tokens_out: minTokensOut,
    }));
  }

  // --------------------------------------------------------------------------
  // Task economy
  // --------------------------------------------------------------------------

  /** Find tasks matching criteria. */
  async findTasks(filters = {}) {
    const tasks = await this._client.getTasks();
    if (!tasks.data) return [];
    return tasks.data.filter(t => {
      if (filters.category && t.required_category !== filters.category) return false;
      if (filters.minReward && t.reward < filters.minReward) return false;
      return true;
    });
  }

  /** Claim a task. */
  async claimTask(taskId) {
    return this._client.sendInstruction(
      this._keypair,
      Instructions.claimTask(taskId, this.publicKey),
    );
  }

  /** Submit proof of task completion. */
  async completeTask(taskId, proof) {
    return this._client.sendInstruction(
      this._keypair,
      Instructions.resolveTask(taskId, 'complete', proof),
    );
  }

  // --------------------------------------------------------------------------
  // Inter-agent communication
  // --------------------------------------------------------------------------

  /** Send a message to another agent. */
  async sendMessage(toIdentity, messageType, payload, replyTo) {
    return this._client.sendInstruction(
      this._keypair,
      Instructions.agentMessage(toIdentity, messageType, payload, replyTo),
    );
  }

  // --------------------------------------------------------------------------
  // Agent planning (uses /agent/plan endpoint)
  // --------------------------------------------------------------------------

  /** Plan a transfer and get instruction data + balance check. */
  async planTransfer(to, amountXrs) {
    return this._client.agentPlan({ action: 'transfer', from: this._ownerPubkey, to, amount_xrs: amountXrs });
  }

  /** Plan a swap and get a quote. */
  async planSwap(poolId, tokenIn, amountIn, slippagePct) {
    return this._client.agentPlan({ action: 'swap', pool_id: poolId, token_in: tokenIn, amount_in: amountIn, slippage_pct: slippagePct || 5 });
  }

  /** Plan a launchpad buy and get a quote. */
  async planBuy(launchpadId, xrsAmount, slippagePct) {
    return this._client.agentPlan({ action: 'buy_launchpad', launchpad_id: launchpadId, xrs_amount: xrsAmount, slippage_pct: slippagePct || 5 });
  }

  // --------------------------------------------------------------------------
  // Read-only queries (convenience wrappers)
  // --------------------------------------------------------------------------

  async getBalance() { return this._client.getBalance(this._ownerPubkey); }
  async getTokenAccounts() { return this._client.getTokenAccounts(this._ownerPubkey); }
  async getCapabilities() { return this._client.getCapabilities(); }
  async searchCapabilities(params) { return this._client.searchCapabilities(params); }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Core classes
  XerisClient,
  XerisKeypair,

  // dApp adapter (browser, wallet-connected)
  XerisDApp,

  // AI Agent class
  XerisAgent,

  // Instruction building
  Instructions,
  Variant,

  // Swap helper (binary encoding for DEX)
  encodeSwapCall,

  // Test vectors
  TestVectors,

  // Constants
  LAMPORTS_PER_XRS,
  DEFAULT_RPC_PORT,
  DEFAULT_EXPLORER_PORT,
  TESTNET_SEED,

  // Low-level encoding primitives (for custom instruction building)
  encodeU32,
  encodeU64,
  encodeBincodeString,
  encodeBincodeVec,
  encodeBool,
  encodeU8,
  encodeOption,
};
