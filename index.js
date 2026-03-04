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
 * @version 1.3.0
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
});

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
    const hexStr = result.value.blockhash;
    return Buffer.from(hexStr, 'hex');
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
// EXPORTS
// ============================================================================

module.exports = {
  // Core classes
  XerisClient,
  XerisKeypair,

  // Instruction building
  Instructions,
  Variant,

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
