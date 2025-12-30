/**
 * MM Wallet SDK - Frontend Integration
 * Program ID: 4ZzKbBw9o1CuVgGVokLNWsgHy9Acnd4EzVH5N6nnbyf5
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  Keypair,
  SYSVAR_RENT_PUBKEY,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import * as crypto from 'crypto';

// ═══════════════════════════════════════════════════════════════
//                        CONSTANTS
// ═══════════════════════════════════════════════════════════════

export const MM_PROGRAM_ID = new PublicKey('4ZzKbBw9o1CuVgGVokLNWsgHy9Acnd4EzVH5N6nnbyf5');
export const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMP_GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
export const PUMP_FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');
export const PUMP_EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
export const MPL_TOKEN_METADATA = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

// Pump.fun instruction discriminators
export const PUMP_CREATE_DISCRIMINATOR = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]);
export const PUMP_BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
export const PUMP_SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

// ═══════════════════════════════════════════════════════════════
//                        TYPES
// ═══════════════════════════════════════════════════════════════

export enum Strategy {
  VolumeBot = 0,
  PriceReactive = 1,
  GridTrading = 2,
  TrendFollower = 3,
  SpreadMM = 4,
  PumpHunter = 5,
}

export interface StrategyConfig {
  strategy: Strategy;
  minTradeSize: bigint;    // u64
  maxTradeSize: bigint;    // u64
  targetSpread: number;    // u16
  maxSlippage: number;     // u16
  cooldownSeconds: number; // u32
  reserved: number[];      // [u8; 32]
}

export interface MmWalletAccount {
  owner: PublicKey;
  operator: PublicKey | null;
  tokenMint: PublicKey | null;
  nonce: bigint;
  vaultBump: number;
  totalDeposited: bigint;
  totalWithdrawn: bigint;
  totalBought: bigint;
  totalSold: bigint;
  totalFeesClaimed: bigint;
  tradeCount: bigint;
  lastTradeTimestamp: bigint;
  lockUntil: bigint;
  paused: boolean;
  isCreator: boolean;
  strategyConfig: StrategyConfig;
}

// ═══════════════════════════════════════════════════════════════
//                    DISCRIMINATORS
// ═══════════════════════════════════════════════════════════════

function getDiscriminator(name: string): Buffer {
  const hash = crypto.createHash('sha256').update(`global:${name}`).digest();
  return hash.slice(0, 8);
}

export const DISCRIMINATORS = {
  initialize: getDiscriminator('initialize'),
  deposit: getDiscriminator('deposit'),
  withdraw: getDiscriminator('withdraw'),
  withdrawTokens: getDiscriminator('withdraw_tokens'),
  executeBuy: getDiscriminator('execute_buy'),
  executeSell: getDiscriminator('execute_sell'),
  executeSwap: getDiscriminator('execute_swap'),
  claimFees: getDiscriminator('claim_fees'),
  createToken: getDiscriminator('create_token'),
  setTokenMint: getDiscriminator('set_token_mint'),
  updateStrategy: getDiscriminator('update_strategy'),
  setOperator: getDiscriminator('set_operator'),
  pause: getDiscriminator('pause'),
  resume: getDiscriminator('resume'),
  extendLock: getDiscriminator('extend_lock'),
};

// ═══════════════════════════════════════════════════════════════
//                    PDA DERIVATIONS
// ═══════════════════════════════════════════════════════════════

export function deriveMmWalletPDA(owner: PublicKey, nonce: bigint): [PublicKey, number] {
  const nonceBuffer = Buffer.alloc(8);
  nonceBuffer.writeBigUInt64LE(nonce);
  
  return PublicKey.findProgramAddressSync(
    [Buffer.from('mm_wallet'), owner.toBuffer(), nonceBuffer],
    MM_PROGRAM_ID
  );
}

export function deriveVaultPDA(owner: PublicKey, nonce: bigint): [PublicKey, number] {
  const nonceBuffer = Buffer.alloc(8);
  nonceBuffer.writeBigUInt64LE(nonce);
  
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), owner.toBuffer(), nonceBuffer],
    MM_PROGRAM_ID
  );
}

export function deriveBondingCurvePDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_FUN_PROGRAM
  );
}

export function deriveCreatorVaultPDA(creator: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('creator-vault'), creator.toBuffer()],
    PUMP_FUN_PROGRAM
  );
}

export function deriveMetadataPDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), MPL_TOKEN_METADATA.toBuffer(), mint.toBuffer()],
    MPL_TOKEN_METADATA
  );
}

// ═══════════════════════════════════════════════════════════════
//                    INSTRUCTION BUILDERS
// ═══════════════════════════════════════════════════════════════

export class MmWalletClient {
  connection: Connection;
  
  constructor(connection: Connection) {
    this.connection = connection;
  }

  // ─────────────────────────────────────────────────────────────
  // INITIALIZE - Create new MM Wallet
  // ─────────────────────────────────────────────────────────────
  buildInitializeIx(
    owner: PublicKey,
    nonce: bigint,
    lockDurationSeconds: bigint,
    strategyConfig: StrategyConfig
  ): TransactionInstruction {
    const [mmWallet] = deriveMmWalletPDA(owner, nonce);
    const [vault] = deriveVaultPDA(owner, nonce);
    
    // Serialize data
    const data = Buffer.alloc(8 + 8 + 8 + 1 + 8 + 8 + 2 + 2 + 4 + 32);
    let offset = 0;
    
    // Discriminator
    DISCRIMINATORS.initialize.copy(data, offset);
    offset += 8;
    
    // nonce: u64
    data.writeBigUInt64LE(nonce, offset);
    offset += 8;
    
    // lock_duration_seconds: i64
    data.writeBigInt64LE(lockDurationSeconds, offset);
    offset += 8;
    
    // strategy_config
    data.writeUInt8(strategyConfig.strategy, offset);
    offset += 1;
    data.writeBigUInt64LE(strategyConfig.minTradeSize, offset);
    offset += 8;
    data.writeBigUInt64LE(strategyConfig.maxTradeSize, offset);
    offset += 8;
    data.writeUInt16LE(strategyConfig.targetSpread, offset);
    offset += 2;
    data.writeUInt16LE(strategyConfig.maxSlippage, offset);
    offset += 2;
    data.writeUInt32LE(strategyConfig.cooldownSeconds, offset);
    offset += 4;
    // reserved [u8; 32]
    for (let i = 0; i < 32; i++) {
      data.writeUInt8(strategyConfig.reserved[i] || 0, offset + i);
    }
    
    return new TransactionInstruction({
      programId: MM_PROGRAM_ID,
      keys: [
        { pubkey: mmWallet, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // DEPOSIT - Add SOL to vault
  // ─────────────────────────────────────────────────────────────
  buildDepositIx(
    owner: PublicKey,
    mmWallet: PublicKey,
    vault: PublicKey,
    amount: bigint
  ): TransactionInstruction {
    const data = Buffer.alloc(16);
    DISCRIMINATORS.deposit.copy(data, 0);
    data.writeBigUInt64LE(amount, 8);
    
    return new TransactionInstruction({
      programId: MM_PROGRAM_ID,
      keys: [
        { pubkey: mmWallet, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // WITHDRAW - Remove SOL from vault
  // ─────────────────────────────────────────────────────────────
  buildWithdrawIx(
    owner: PublicKey,
    mmWallet: PublicKey,
    vault: PublicKey,
    amount: bigint
  ): TransactionInstruction {
    const data = Buffer.alloc(16);
    DISCRIMINATORS.withdraw.copy(data, 0);
    data.writeBigUInt64LE(amount, 8);
    
    return new TransactionInstruction({
      programId: MM_PROGRAM_ID,
      keys: [
        { pubkey: mmWallet, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // CREATE TOKEN - Create Pump.fun token with PDA as creator
  // ─────────────────────────────────────────────────────────────
  buildCreateTokenIx(
    owner: PublicKey,
    mmWallet: PublicKey,
    vault: PublicKey,
    mint: Keypair,
    name: string,
    symbol: string,
    uri: string
  ): { instruction: TransactionInstruction; mint: Keypair; accounts: PublicKey[] } {
    // Derive PDAs
    const [bondingCurve] = deriveBondingCurvePDA(mint.publicKey);
    const bondingCurveAta = getAssociatedTokenAddressSync(mint.publicKey, bondingCurve, true);
    const [metadata] = deriveMetadataPDA(mint.publicKey);
    const vaultAta = getAssociatedTokenAddressSync(mint.publicKey, vault, true);
    
    // Build Pump.fun create data
    const pumpCreateData = this.buildPumpCreateData(name, symbol, uri);
    
    // Build MM instruction data
    const numCreateAccounts = 14; // Pump.fun legacy create needs 14 accounts
    const data = Buffer.alloc(8 + 4 + pumpCreateData.length + 1);
    let offset = 0;
    
    DISCRIMINATORS.createToken.copy(data, offset);
    offset += 8;
    
    // Vec<u8> length prefix
    data.writeUInt32LE(pumpCreateData.length, offset);
    offset += 4;
    
    // pump_create_data
    pumpCreateData.copy(data, offset);
    offset += pumpCreateData.length;
    
    // num_create_accounts
    data.writeUInt8(numCreateAccounts, offset);
    
    // Pump.fun create accounts (14 total)
    const createAccounts: PublicKey[] = [
      mint.publicKey,              // 0: mint (signer)
      vault,                       // 1: mint_authority  
      bondingCurve,                // 2: bonding_curve
      bondingCurveAta,             // 3: bonding_curve_ata
      PUMP_GLOBAL,                 // 4: global
      MPL_TOKEN_METADATA,          // 5: mpl_token_metadata
      metadata,                    // 6: metadata
      vault,                       // 7: user (CREATOR - our vault PDA!)
      SystemProgram.programId,     // 8: system_program
      TOKEN_PROGRAM_ID,            // 9: token_program
      ASSOCIATED_TOKEN_PROGRAM_ID, // 10: associated_token_program
      SYSVAR_RENT_PUBKEY,          // 11: rent
      PUMP_EVENT_AUTHORITY,        // 12: event_authority
      PUMP_FUN_PROGRAM,            // 13: program
    ];
    
    const keys = [
      { pubkey: mmWallet, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: mint.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },
      // Remaining accounts for Pump.fun CPI
      ...createAccounts.map((pubkey, i) => ({
        pubkey,
        isSigner: i === 0, // Only mint is signer
        isWritable: [0, 2, 3, 6, 7].includes(i), // mint, bonding_curve, bonding_curve_ata, metadata, user
      })),
    ];
    
    return {
      instruction: new TransactionInstruction({
        programId: MM_PROGRAM_ID,
        keys,
        data,
      }),
      mint,
      accounts: createAccounts,
    };
  }

  private buildPumpCreateData(name: string, symbol: string, uri: string): Buffer {
    const nameBytes = Buffer.from(name, 'utf8');
    const symbolBytes = Buffer.from(symbol, 'utf8');
    const uriBytes = Buffer.from(uri, 'utf8');
    
    const data = Buffer.alloc(8 + 4 + nameBytes.length + 4 + symbolBytes.length + 4 + uriBytes.length);
    let offset = 0;
    
    // Discriminator
    PUMP_CREATE_DISCRIMINATOR.copy(data, offset);
    offset += 8;
    
    // name (String = 4 bytes length + bytes)
    data.writeUInt32LE(nameBytes.length, offset);
    offset += 4;
    nameBytes.copy(data, offset);
    offset += nameBytes.length;
    
    // symbol
    data.writeUInt32LE(symbolBytes.length, offset);
    offset += 4;
    symbolBytes.copy(data, offset);
    offset += symbolBytes.length;
    
    // uri
    data.writeUInt32LE(uriBytes.length, offset);
    offset += 4;
    uriBytes.copy(data, offset);
    
    return data;
  }

  // ─────────────────────────────────────────────────────────────
  // EXECUTE BUY - Buy tokens via Pump.fun
  // ─────────────────────────────────────────────────────────────
  buildExecuteBuyIx(
    caller: PublicKey,
    mmWallet: PublicKey,
    vault: PublicKey,
    mint: PublicKey,
    solAmount: bigint,
    minTokensOut: bigint
  ): TransactionInstruction {
    const [bondingCurve] = deriveBondingCurvePDA(mint);
    const bondingCurveAta = getAssociatedTokenAddressSync(mint, bondingCurve, true);
    const vaultAta = getAssociatedTokenAddressSync(mint, vault, true);
    
    // Build data
    const data = Buffer.alloc(8 + 8 + 8);
    let offset = 0;
    DISCRIMINATORS.executeBuy.copy(data, offset);
    offset += 8;
    data.writeBigUInt64LE(solAmount, offset);
    offset += 8;
    data.writeBigUInt64LE(minTokensOut, offset);
    
    // Pump.fun buy accounts
    const buyAccounts: PublicKey[] = [
      PUMP_GLOBAL,                 // 0: global
      PUMP_FEE_RECIPIENT,          // 1: fee_recipient
      mint,                        // 2: mint
      bondingCurve,                // 3: bonding_curve
      bondingCurveAta,             // 4: bonding_curve_ata
      vaultAta,                    // 5: user_ata (vault's ATA)
      vault,                       // 6: user (vault PDA)
      SystemProgram.programId,     // 7: system_program
      TOKEN_PROGRAM_ID,            // 8: token_program
      SYSVAR_RENT_PUBKEY,          // 9: rent
      PUMP_EVENT_AUTHORITY,        // 10: event_authority
      PUMP_FUN_PROGRAM,            // 11: program
    ];
    
    return new TransactionInstruction({
      programId: MM_PROGRAM_ID,
      keys: [
        { pubkey: mmWallet, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: caller, isSigner: true, isWritable: true },
        ...buyAccounts.map((pubkey, i) => ({
          pubkey,
          isSigner: false,
          isWritable: [3, 4, 5, 6].includes(i), // bonding_curve, bonding_curve_ata, user_ata, user
        })),
      ],
      data,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // EXECUTE SELL - Sell tokens via Pump.fun
  // ─────────────────────────────────────────────────────────────
  buildExecuteSellIx(
    caller: PublicKey,
    mmWallet: PublicKey,
    vault: PublicKey,
    mint: PublicKey,
    tokenAmount: bigint,
    minSolOut: bigint
  ): TransactionInstruction {
    const [bondingCurve] = deriveBondingCurvePDA(mint);
    const bondingCurveAta = getAssociatedTokenAddressSync(mint, bondingCurve, true);
    const vaultAta = getAssociatedTokenAddressSync(mint, vault, true);
    
    // Build data
    const data = Buffer.alloc(8 + 8 + 8);
    let offset = 0;
    DISCRIMINATORS.executeSell.copy(data, offset);
    offset += 8;
    data.writeBigUInt64LE(tokenAmount, offset);
    offset += 8;
    data.writeBigUInt64LE(minSolOut, offset);
    
    // Pump.fun sell accounts
    const sellAccounts: PublicKey[] = [
      PUMP_GLOBAL,                 // 0: global
      PUMP_FEE_RECIPIENT,          // 1: fee_recipient
      mint,                        // 2: mint
      bondingCurve,                // 3: bonding_curve
      bondingCurveAta,             // 4: bonding_curve_ata
      vaultAta,                    // 5: user_ata (vault's ATA)
      vault,                       // 6: user (vault PDA)
      SystemProgram.programId,     // 7: system_program
      ASSOCIATED_TOKEN_PROGRAM_ID, // 8: associated_token_program
      TOKEN_PROGRAM_ID,            // 9: token_program
      PUMP_EVENT_AUTHORITY,        // 10: event_authority
      PUMP_FUN_PROGRAM,            // 11: program
    ];
    
    return new TransactionInstruction({
      programId: MM_PROGRAM_ID,
      keys: [
        { pubkey: mmWallet, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: caller, isSigner: true, isWritable: true },
        ...sellAccounts.map((pubkey, i) => ({
          pubkey,
          isSigner: false,
          isWritable: [3, 4, 5, 6].includes(i),
        })),
      ],
      data,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // SET TOKEN MINT - Associate token with wallet
  // ─────────────────────────────────────────────────────────────
  buildSetTokenMintIx(
    owner: PublicKey,
    mmWallet: PublicKey,
    mint: PublicKey
  ): TransactionInstruction {
    const data = Buffer.alloc(8 + 32);
    DISCRIMINATORS.setTokenMint.copy(data, 0);
    mint.toBuffer().copy(data, 8);
    
    return new TransactionInstruction({
      programId: MM_PROGRAM_ID,
      keys: [
        { pubkey: mmWallet, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
      ],
      data,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // SET OPERATOR - Set authorized operator
  // ─────────────────────────────────────────────────────────────
  buildSetOperatorIx(
    owner: PublicKey,
    mmWallet: PublicKey,
    operator: PublicKey | null
  ): TransactionInstruction {
    const data = Buffer.alloc(8 + 1 + (operator ? 32 : 0));
    DISCRIMINATORS.setOperator.copy(data, 0);
    data.writeUInt8(operator ? 1 : 0, 8); // Option<Pubkey> tag
    if (operator) {
      operator.toBuffer().copy(data, 9);
    }
    
    return new TransactionInstruction({
      programId: MM_PROGRAM_ID,
      keys: [
        { pubkey: mmWallet, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
      ],
      data,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // PAUSE / RESUME
  // ─────────────────────────────────────────────────────────────
  buildPauseIx(owner: PublicKey, mmWallet: PublicKey): TransactionInstruction {
    return new TransactionInstruction({
      programId: MM_PROGRAM_ID,
      keys: [
        { pubkey: mmWallet, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
      ],
      data: DISCRIMINATORS.pause,
    });
  }

  buildResumeIx(owner: PublicKey, mmWallet: PublicKey): TransactionInstruction {
    return new TransactionInstruction({
      programId: MM_PROGRAM_ID,
      keys: [
        { pubkey: mmWallet, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
      ],
      data: DISCRIMINATORS.resume,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // HELPER: Create vault ATA before buying
  // ─────────────────────────────────────────────────────────────
  async ensureVaultAta(
    vault: PublicKey,
    mint: PublicKey,
    payer: PublicKey
  ): Promise<TransactionInstruction | null> {
    const ata = getAssociatedTokenAddressSync(mint, vault, true);
    const info = await this.connection.getAccountInfo(ata);
    
    if (!info) {
      // Need to create ATA
      const { createAssociatedTokenAccountInstruction } = await import('@solana/spl-token');
      return createAssociatedTokenAccountInstruction(
        payer,
        ata,
        vault,
        mint
      );
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────
  // HELPER: Get MM Wallet account data
  // ─────────────────────────────────────────────────────────────
  async getMmWallet(mmWallet: PublicKey): Promise<MmWalletAccount | null> {
    const info = await this.connection.getAccountInfo(mmWallet);
    if (!info) return null;
    
    const data = info.data;
    let offset = 8; // Skip discriminator
    
    const owner = new PublicKey(data.slice(offset, offset + 32));
    offset += 32;
    
    const hasOperator = data.readUInt8(offset) === 1;
    offset += 1;
    const operator = hasOperator ? new PublicKey(data.slice(offset, offset + 32)) : null;
    if (hasOperator) offset += 32;
    
    const hasTokenMint = data.readUInt8(offset) === 1;
    offset += 1;
    const tokenMint = hasTokenMint ? new PublicKey(data.slice(offset, offset + 32)) : null;
    if (hasTokenMint) offset += 32;
    
    const nonce = data.readBigUInt64LE(offset);
    offset += 8;
    
    const vaultBump = data.readUInt8(offset);
    offset += 1;
    
    const totalDeposited = data.readBigUInt64LE(offset);
    offset += 8;
    const totalWithdrawn = data.readBigUInt64LE(offset);
    offset += 8;
    const totalBought = data.readBigUInt64LE(offset);
    offset += 8;
    const totalSold = data.readBigUInt64LE(offset);
    offset += 8;
    const totalFeesClaimed = data.readBigUInt64LE(offset);
    offset += 8;
    const tradeCount = data.readBigUInt64LE(offset);
    offset += 8;
    const lastTradeTimestamp = data.readBigInt64LE(offset);
    offset += 8;
    const lockUntil = data.readBigInt64LE(offset);
    offset += 8;
    const paused = data.readUInt8(offset) === 1;
    offset += 1;
    const isCreator = data.readUInt8(offset) === 1;
    offset += 1;
    
    // Strategy config
    const strategy = data.readUInt8(offset) as Strategy;
    offset += 1;
    const minTradeSize = data.readBigUInt64LE(offset);
    offset += 8;
    const maxTradeSize = data.readBigUInt64LE(offset);
    offset += 8;
    const targetSpread = data.readUInt16LE(offset);
    offset += 2;
    const maxSlippage = data.readUInt16LE(offset);
    offset += 2;
    const cooldownSeconds = data.readUInt32LE(offset);
    offset += 4;
    const reserved = Array.from(data.slice(offset, offset + 32));
    
    return {
      owner,
      operator,
      tokenMint,
      nonce,
      vaultBump,
      totalDeposited,
      totalWithdrawn,
      totalBought,
      totalSold,
      totalFeesClaimed,
      tradeCount,
      lastTradeTimestamp,
      lockUntil,
      paused,
      isCreator,
      strategyConfig: {
        strategy,
        minTradeSize,
        maxTradeSize,
        targetSpread,
        maxSlippage,
        cooldownSeconds,
        reserved,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────
  // HELPER: Get bonding curve creator
  // ─────────────────────────────────────────────────────────────
  async getBondingCurveCreator(mint: PublicKey): Promise<PublicKey | null> {
    const [bondingCurve] = deriveBondingCurvePDA(mint);
    const info = await this.connection.getAccountInfo(bondingCurve);
    if (!info) return null;
    
    // Creator is at offset 49 in the bonding curve data
    return new PublicKey(info.data.slice(49, 81));
  }

  // ─────────────────────────────────────────────────────────────
  // HELPER: Get creator vault balance (accumulated fees)
  // ─────────────────────────────────────────────────────────────
  async getCreatorFees(vault: PublicKey): Promise<number> {
    const [creatorVault] = deriveCreatorVaultPDA(vault);
    const balance = await this.connection.getBalance(creatorVault);
    return balance / 1e9; // Return in SOL
  }
}

// ═══════════════════════════════════════════════════════════════
//                    HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

export function addComputeBudget(tx: Transaction, units: number = 300000, microLamports: number = 50000) {
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
}

export function lamportsToSol(lamports: bigint | number): number {
  return Number(lamports) / 1e9;
}

export function solToLamports(sol: number): bigint {
  return BigInt(Math.floor(sol * 1e9));
}

