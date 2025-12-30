/**
 * MM Wallet Constants
 */

import { PublicKey } from '@solana/web3.js';

// ═══════════════════════════════════════════════════════════════
//                    PROGRAM IDS
// ═══════════════════════════════════════════════════════════════

/** MM Wallet Program ID on Mainnet */
export const MM_PROGRAM_ID = new PublicKey('4ZzKbBw9o1CuVgGVokLNWsgHy9Acnd4EzVH5N6nnbyf5');

/** Pump.fun Program ID */
export const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

/** Pump.fun Global Account */
export const PUMP_GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');

/** Pump.fun Fee Recipient */
export const PUMP_FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');

/** Pump.fun Event Authority */
export const PUMP_EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');

/** Metaplex Token Metadata Program */
export const MPL_TOKEN_METADATA = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

/** SPL Token Program */
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

/** Associated Token Program */
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

// ═══════════════════════════════════════════════════════════════
//                    PDA SEEDS
// ═══════════════════════════════════════════════════════════════

export const SEEDS = {
  MM_WALLET: Buffer.from('mm_wallet'),
  VAULT: Buffer.from('vault'),
  BONDING_CURVE: Buffer.from('bonding-curve'),
  CREATOR_VAULT: Buffer.from('creator-vault'),
  METADATA: Buffer.from('metadata'),
};

// ═══════════════════════════════════════════════════════════════
//                    PUMP.FUN DISCRIMINATORS
// ═══════════════════════════════════════════════════════════════

/** Discriminator for Pump.fun legacy Create instruction */
export const PUMP_CREATE_DISCRIMINATOR = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]);

/** Discriminator for Pump.fun Buy instruction */
export const PUMP_BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);

/** Discriminator for Pump.fun Sell instruction */
export const PUMP_SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

// ═══════════════════════════════════════════════════════════════
//                    MM WALLET DISCRIMINATORS
// ═══════════════════════════════════════════════════════════════

import * as crypto from 'crypto';

function disc(name: string): Buffer {
  return crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

export const MM_DISCRIMINATORS = {
  initialize: disc('initialize'),
  deposit: disc('deposit'),
  withdraw: disc('withdraw'),
  withdrawTokens: disc('withdraw_tokens'),
  executeBuy: disc('execute_buy'),
  executeSell: disc('execute_sell'),
  executeSwap: disc('execute_swap'),
  claimFees: disc('claim_fees'),
  createToken: disc('create_token'),
  setTokenMint: disc('set_token_mint'),
  updateStrategy: disc('update_strategy'),
  setOperator: disc('set_operator'),
  pause: disc('pause'),
  resume: disc('resume'),
  extendLock: disc('extend_lock'),
};

// ═══════════════════════════════════════════════════════════════
//                    ACCOUNT SIZES
// ═══════════════════════════════════════════════════════════════

/** Size of MmWallet account in bytes */
export const MM_WALLET_SIZE = 8 + 32 + 33 + 33 + 8 + 1 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 8 + 8 + 2 + 2 + 4 + 32;

// ═══════════════════════════════════════════════════════════════
//                    DEPLOYED WALLET (TEST)
// ═══════════════════════════════════════════════════════════════

/** Test MM Wallet deployed on mainnet */
export const TEST_MM_WALLET = new PublicKey('5io1DKP2mkBsHPeNuhneJpLpke6U79t5V1MzcjnC4jGo');

/** Test Vault PDA */
export const TEST_VAULT = new PublicKey('76n7XMhUU8vY1Va3uUaEa5HjgDZkm6U6e7pseCq7rUYw');

/** Test Token created by PDA */
export const TEST_TOKEN = new PublicKey('63qivZsE9AL9yZib7KSx6CTmbvtbvz8e3zw4qJZwvocp');

/** Test Token Creator Vault (where fees accumulate) */
export const TEST_CREATOR_VAULT = new PublicKey('BdHJe2gnRssCBM5mJFz5ChR5RE12bt5VHaBFx8qfLFoQ');

