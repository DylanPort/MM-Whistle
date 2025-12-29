/**
 * Pump.fun Direct Integration Constants
 * All program IDs, discriminators, and addresses needed for direct trading
 */

import { PublicKey } from '@solana/web3.js';

// ============================================================================
// PROGRAM IDs
// ============================================================================

// Pump.fun Bonding Curve Program
export const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMP_GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
export const PUMP_EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
export const PUMP_FEE = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');
export const PUMP_FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
export const PUMP_MINT_AUTHORITY = new PublicKey('TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM');

// PumpSwap AMM Program (for migrated tokens)
export const PUMP_AMM_PROGRAM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
export const PUMP_SWAP_GLOBAL_CONFIG = new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
export const PUMP_SWAP_EVENT_AUTHORITY = new PublicKey('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR');
export const STANDARD_PUMPSWAP_FEE_RECIPIENT = new PublicKey('7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ');

// Mayhem Mode Program
export const MAYHEM_PROGRAM = new PublicKey('MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e');
export const MAYHEM_GLOBAL_PARAMS = new PublicKey('13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ');
export const MAYHEM_SOL_VAULT = new PublicKey('BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s');

// MM Wallet Program (Trustless Market Maker)
export const MM_WALLET_PROGRAM = new PublicKey('4ZzKbBw9o1CuVgGVokLNWsgHy9Acnd4EzVH5N6nnbyf5');

// System Programs
export const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const RENT_PROGRAM = new PublicKey('SysvarRent111111111111111111111111111111111');
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

// ============================================================================
// INSTRUCTION DISCRIMINATORS
// ============================================================================

// Bonding Curve (pre-migration)
export const DISCRIMINATORS = {
    // Bonding Curve Instructions
    BONDING_CREATE: Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]),           // create (legacy)
    BONDING_CREATE_V2: Buffer.from([214, 144, 76, 236, 95, 139, 49, 180]),   // create_v2 (Token2022/Mayhem)
    BONDING_BUY: Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]),            // buy
    BONDING_SELL: Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]),        // sell
    BONDING_EXTEND: Buffer.from([234, 102, 194, 203, 150, 72, 62, 229]),     // extend_account
    BONDING_COLLECT_FEE: Buffer.from([20, 22, 86, 123, 198, 28, 219, 132]),  // collect_creator_fee
    
    // PumpSwap AMM Instructions
    PUMPSWAP_BUY: Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]),           // buy (same as bonding)
    PUMPSWAP_SELL: Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]),       // sell (same as bonding)
    PUMPSWAP_COLLECT_FEE: Buffer.from([160, 57, 89, 42, 181, 139, 43, 66]),  // collect_coin_creator_fee
};

// Bonding Curve State Discriminator (for parsing)
// Bonding curve discriminator: sha256("account:BondingCurve")[0..8]
// Python: struct.pack("<Q", 6966180631402821399)
export const BONDING_CURVE_DISCRIMINATOR = Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]);

// ============================================================================
// CONSTANTS
// ============================================================================

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const TOKEN_DECIMALS = 6;

// Initial bonding curve reserves (from pump.fun)
export const INITIAL_VIRTUAL_TOKEN_RESERVES = BigInt(1_073_000_000) * BigInt(10 ** TOKEN_DECIMALS);
export const INITIAL_VIRTUAL_SOL_RESERVES = BigInt(30) * BigInt(LAMPORTS_PER_SOL);
export const INITIAL_REAL_TOKEN_RESERVES = BigInt(793_100_000) * BigInt(10 ** TOKEN_DECIMALS);

// Pool structure offsets (for PumpSwap)
export const POOL_BASE_MINT_OFFSET = 43;
export const POOL_MAYHEM_MODE_OFFSET = 243;

// Global account offsets
export const RESERVED_FEE_RECIPIENT_OFFSET = 483;
export const GLOBALCONFIG_RESERVED_FEE_OFFSET = 72; // For PumpSwap

// Default compute budget
export const DEFAULT_COMPUTE_UNITS = 300_000;
export const DEFAULT_COMPUTE_PRICE = 50_000; // microlamports

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Pack a u64 as little-endian bytes
 */
export function packU64(value) {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(BigInt(value));
    return buffer;
}

/**
 * Unpack a u64 from little-endian bytes
 */
export function unpackU64(buffer, offset = 0) {
    return buffer.readBigUInt64LE(offset);
}

/**
 * Encode a string with length prefix
 */
export function encodeString(str) {
    const encoded = Buffer.from(str, 'utf-8');
    const length = Buffer.alloc(4);
    length.writeUInt32LE(encoded.length);
    return Buffer.concat([length, encoded]);
}

