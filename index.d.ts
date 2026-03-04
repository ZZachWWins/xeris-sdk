/**
 * XerisCoin JavaScript SDK - TypeScript Definitions
 * @module xeris-sdk
 */

import { Keypair } from '@solana/web3.js';

export declare const LAMPORTS_PER_XRS: number;
export declare const DEFAULT_RPC_PORT: number;
export declare const DEFAULT_EXPLORER_PORT: number;
export declare const TESTNET_SEED: string;

export declare const Variant: Readonly<{
  TokenMint: 0;
  TokenTransfer: 1;
  TokenBurn: 2;
  TokenCreate: 3;
  ContractCall: 4;
  ContractDeploy: 5;
  TokenCreateRWA: 6;
  RWAUpdateStatus: 7;
  RWATransfer: 8;
  Stake: 9;
  Unstake: 10;
  NativeTransfer: 11;
  ValidatorAttestation: 12;
  WrapXrs: 13;
  UnwrapXrs: 14;
}>;

export declare function encodeU32(value: number): Buffer;
export declare function encodeU64(value: number | bigint): Buffer;
export declare function encodeBincodeString(str: string): Buffer;
export declare function encodeBincodeVec(bytes: Buffer | Uint8Array | number[]): Buffer;
export declare function encodeBool(value: boolean): Buffer;
export declare function encodeU8(value: number): Buffer;
export declare function encodeOption<T>(value: T | null | undefined, encoder: (val: T) => Buffer): Buffer;

export interface RWACreateOpts {
  tokenId: string;
  name: string;
  symbol: string;
  decimals: number;
  maxSupply: number | bigint;
  mintAuthority: string;
  assetType: string;
  legalDocHash: string;
  legalDocUri: string;
  jurisdiction: string;
  transferRestricted: boolean;
  accreditedOnly: boolean;
  valuation?: number | bigint;
}

export declare namespace Instructions {
  function nativeTransfer(from: string, to: string, lamports: number | bigint): Buffer;
  function stake(pubkey: string, lamports: number | bigint): Buffer;
  function unstake(pubkey: string, lamports: number | bigint): Buffer;
  function tokenCreate(tokenId: string, name: string, symbol: string, decimals: number, maxSupply: number | bigint, mintAuthority: string): Buffer;
  function tokenMint(tokenId: string, to: string, amount: number | bigint): Buffer;
  function tokenTransfer(tokenId: string, from: string, to: string, amount: number | bigint): Buffer;
  function tokenBurn(tokenId: string, from: string, amount: number | bigint): Buffer;
  function contractDeploy(contractId: string, contractType: string, params: object): Buffer;
  function contractCall(contractId: string, method: string, args: object): Buffer;
  function validatorAttestation(validator: string, blockSlot: number, blockHash: Buffer): Buffer;
  function wrapXrs(lamports: number | bigint): Buffer;
  function unwrapXrs(lamports: number | bigint): Buffer;
  function tokenCreateRWA(opts: RWACreateOpts): Buffer;
  function rwaUpdateStatus(tokenId: string, newStatus: string, newValuation?: number | bigint | null, newLegalDocHash?: string | null, newLegalDocUri?: string | null): Buffer;
  function rwaTransfer(tokenId: string, from: string, to: string, amount: number | bigint): Buffer;
}

export declare class XerisKeypair {
  constructor(solanaKeypair: Keypair);
  static generate(): XerisKeypair;
  static fromJsonFile(path: string): XerisKeypair;
  static fromSecretKey(secretKey: Uint8Array | number[]): XerisKeypair;
  get publicKey(): string;
  get solanaKeypair(): Keypair;
  toJsonBytes(): number[];
  saveToFile(path: string): void;
}

export declare class XerisClient {
  constructor(host: string, opts?: { rpcPort?: number; explorerPort?: number });
  static testnet(): XerisClient;

  // Transaction methods
  getLatestBlockhash(): Promise<Buffer>;
  sendInstruction(keypair: XerisKeypair, instructionData: Buffer): Promise<any>;
  transferXrs(keypair: XerisKeypair, to: string, amountXrs: number): Promise<any>;
  stakeXrs(keypair: XerisKeypair, amountXrs: number): Promise<any>;
  unstakeXrs(keypair: XerisKeypair, amountXrs: number): Promise<any>;
  createToken(keypair: XerisKeypair, tokenId: string, name: string, symbol: string, decimals: number, maxSupply: number): Promise<any>;
  mintTokens(keypair: XerisKeypair, tokenId: string, to: string, amount: number, decimals: number): Promise<any>;
  transferToken(keypair: XerisKeypair, tokenId: string, to: string, amount: number, decimals: number): Promise<any>;
  burnTokens(keypair: XerisKeypair, tokenId: string, amount: number, decimals: number): Promise<any>;
  deployContract(keypair: XerisKeypair, contractId: string, contractType: string, params: object): Promise<any>;
  callContract(keypair: XerisKeypair, contractId: string, method: string, args: object): Promise<any>;
  wrapXrs(keypair: XerisKeypair, amountXrs: number): Promise<any>;
  unwrapXrs(keypair: XerisKeypair, amountXrs: number): Promise<any>;
  submitAttestation(keypair: XerisKeypair, blockSlot: number, blockHash: Buffer): Promise<any>;

  // RPC queries (port 56001)
  getHealth(): Promise<any>;
  getRecentBlocks(): Promise<any[]>;
  getStakeInfo(address: string): Promise<any>;
  getNetworkEconomics(): Promise<any>;
  getTokenList(): Promise<any[]>;
  getTokenBalance(address: string, tokenId: string): Promise<any>;
  getTokenAccounts(address: string): Promise<any>;
  getContracts(): Promise<any[]>;
  getContract(contractId: string): Promise<any>;
  getContractQuote(contractId: string, params: Record<string, string>): Promise<any>;
  getLaunchpads(): Promise<any[]>;
  getLaunchpadQuote(contractId: string, xrsAmountLamports: number): Promise<any>;
  airdrop(address: string, amountXrs: number): Promise<any>;

  // Explorer queries (port 50008)
  getStats(): Promise<any>;
  getBlocks(page?: number, pageSize?: number): Promise<any>;
  getBlockBySlot(slot: number): Promise<any>;
  getBlockByHash(hash: string): Promise<any>;
  getTransactions(page?: number, pageSize?: number): Promise<any>;
  getTransaction(signature: string): Promise<any>;
  getAccountInfo(address: string): Promise<any>;
  getAccountTransactions(address: string, page?: number, pageSize?: number): Promise<any>;
  getValidators(): Promise<any>;
  search(query: string): Promise<any>;

  // JSON-RPC
  getBalance(address: string): Promise<number>;
  getSlot(): Promise<number>;
  getBlockHeight(): Promise<number>;
  getSignaturesForAddress(address: string, limit?: number): Promise<any[]>;
}

export declare namespace TestVectors {
  function nativeTransfer(): { description: string; hex: string; bytes: number[] };
  function stake(): { description: string; hex: string; bytes: number[] };
  function tokenMint(): { description: string; hex: string; bytes: number[] };
  function tokenTransfer(): { description: string; hex: string; bytes: number[] };
  function wrapXrs(): { description: string; hex: string; bytes: number[] };
  function printAll(): void;
}
