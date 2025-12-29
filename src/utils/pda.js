/**
 * PDA (Program Derived Address) Utilities
 * Derives all necessary addresses for Pump.fun trading
 */

import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import {
    PUMP_PROGRAM,
    PUMP_AMM_PROGRAM,
    PUMP_FEE_PROGRAM,
    MAYHEM_PROGRAM,
    TOKEN_PROGRAM,
    TOKEN_2022_PROGRAM,
    ASSOCIATED_TOKEN_PROGRAM,
    WSOL_MINT,
    MAYHEM_SOL_VAULT
} from '../constants.js';

// ============================================================================
// BONDING CURVE PDAs
// ============================================================================

/**
 * Derive bonding curve address for a mint
 */
export function getBondingCurveAddress(mint) {
    const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;
    const [address] = PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), mintPubkey.toBuffer()],
        PUMP_PROGRAM
    );
    return address;
}

/**
 * Derive associated bonding curve (token account for bonding curve)
 */
export function getAssociatedBondingCurve(mint, bondingCurve, tokenProgram = TOKEN_PROGRAM) {
    const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;
    const bcPubkey = typeof bondingCurve === 'string' ? new PublicKey(bondingCurve) : bondingCurve;
    const [address] = PublicKey.findProgramAddressSync(
        [bcPubkey.toBuffer(), tokenProgram.toBuffer(), mintPubkey.toBuffer()],
        ASSOCIATED_TOKEN_PROGRAM
    );
    return address;
}

/**
 * Derive creator vault address
 */
export function getCreatorVault(creator) {
    const [address] = PublicKey.findProgramAddressSync(
        [Buffer.from('creator-vault'), creator.toBuffer()],
        PUMP_PROGRAM
    );
    return address;
}

/**
 * Derive global volume accumulator
 */
export function getGlobalVolumeAccumulator() {
    const [address] = PublicKey.findProgramAddressSync(
        [Buffer.from('global_volume_accumulator')],
        PUMP_PROGRAM
    );
    return address;
}

/**
 * Derive user volume accumulator
 */
export function getUserVolumeAccumulator(user) {
    const [address] = PublicKey.findProgramAddressSync(
        [Buffer.from('user_volume_accumulator'), user.toBuffer()],
        PUMP_PROGRAM
    );
    return address;
}

/**
 * Derive fee config address
 */
export function getFeeConfig() {
    const [address] = PublicKey.findProgramAddressSync(
        [Buffer.from('fee_config'), PUMP_PROGRAM.toBuffer()],
        PUMP_FEE_PROGRAM
    );
    return address;
}

// ============================================================================
// PUMPSWAP AMM PDAs
// ============================================================================

/**
 * Derive coin creator vault authority (for PumpSwap)
 */
export function getCoinCreatorVaultAuthority(coinCreator) {
    const [address] = PublicKey.findProgramAddressSync(
        [Buffer.from('creator_vault'), coinCreator.toBuffer()],
        PUMP_AMM_PROGRAM
    );
    return address;
}

/**
 * Derive coin creator vault ATA (WSOL account)
 */
export async function getCoinCreatorVaultATA(coinCreator) {
    const authority = getCoinCreatorVaultAuthority(coinCreator);
    return await getAssociatedTokenAddress(WSOL_MINT, authority, true, TOKEN_PROGRAM);
}

/**
 * Derive global volume accumulator for PumpSwap
 */
export function getPumpSwapGlobalVolumeAccumulator() {
    const [address] = PublicKey.findProgramAddressSync(
        [Buffer.from('global_volume_accumulator')],
        PUMP_AMM_PROGRAM
    );
    return address;
}

/**
 * Derive user volume accumulator for PumpSwap
 */
export function getPumpSwapUserVolumeAccumulator(user) {
    const [address] = PublicKey.findProgramAddressSync(
        [Buffer.from('user_volume_accumulator'), user.toBuffer()],
        PUMP_AMM_PROGRAM
    );
    return address;
}

/**
 * Derive fee config for PumpSwap
 */
export function getPumpSwapFeeConfig() {
    const [address] = PublicKey.findProgramAddressSync(
        [Buffer.from('fee_config'), PUMP_AMM_PROGRAM.toBuffer()],
        PUMP_FEE_PROGRAM
    );
    return address;
}

// ============================================================================
// MAYHEM MODE PDAs
// ============================================================================

/**
 * Derive mayhem state for a mint
 */
export function getMayhemState(mint) {
    const [address] = PublicKey.findProgramAddressSync(
        [Buffer.from('mayhem-state'), mint.toBuffer()],
        MAYHEM_PROGRAM
    );
    return address;
}

/**
 * Derive mayhem token vault (ATA for SOL_VAULT)
 */
export async function getMayhemTokenVault(mint) {
    return await getAssociatedTokenAddress(mint, MAYHEM_SOL_VAULT, true, TOKEN_2022_PROGRAM);
}

// ============================================================================
// TOKEN ACCOUNTS
// ============================================================================

/**
 * Get user's associated token account
 */
export async function getUserTokenAccount(user, mint, tokenProgram = TOKEN_PROGRAM) {
    return await getAssociatedTokenAddress(mint, user, false, tokenProgram);
}

/**
 * Get user's WSOL account
 */
export async function getUserWSOLAccount(user) {
    return await getAssociatedTokenAddress(WSOL_MINT, user, false, TOKEN_PROGRAM);
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Determine token program for a mint (Token vs Token2022)
 * Uses getMultipleAccountsInfo for better RPC compatibility
 */
export async function getTokenProgramForMint(connection, mint) {
    // Use getMultipleAccountsInfo for better RPC compatibility
    const accounts = await connection.getMultipleAccountsInfo([mint]);
    const mintInfo = accounts?.[0];
    const mintStr = typeof mint === 'string' ? mint : mint.toBase58();
    
    if (!mintInfo) {
        throw new Error(`Mint ${mintStr} not found`);
    }
    
    if (mintInfo.owner.equals(TOKEN_PROGRAM)) {
        return TOKEN_PROGRAM;
    } else if (mintInfo.owner.equals(TOKEN_2022_PROGRAM)) {
        return TOKEN_2022_PROGRAM;
    } else {
        throw new Error(`Unknown token program for mint: ${mintInfo.owner.toBase58()}`);
    }
}

/**
 * Check if a token has migrated (bonding curve complete)
 * Uses getMultipleAccountsInfo for better RPC compatibility
 */
export async function isTokenMigrated(connection, mint) {
    const bondingCurve = getBondingCurveAddress(mint);
    
    // Use getMultipleAccountsInfo for better RPC compatibility (some RPCs have issues with getAccountInfo)
    try {
        const accounts = await connection.getMultipleAccountsInfo([bondingCurve]);
        
        // Handle various response formats from different RPCs
        if (!accounts || !Array.isArray(accounts)) {
            console.log(`[PDA] Invalid accounts response, assuming not migrated`);
            return false;
        }
        
        const accountInfo = accounts[0];
        
        if (!accountInfo) {
            return true; // No bonding curve = migrated or doesn't exist
        }
        
        // Ensure data is a Buffer
        let data = accountInfo.data;
        if (data && typeof data === 'object' && !Buffer.isBuffer(data)) {
            // Some RPCs return data as an array or object
            if (Array.isArray(data)) {
                data = Buffer.from(data);
            } else if (data.data) {
                data = Buffer.from(data.data);
            }
        }
        
        if (!data || !data.length) {
            return true; // No data = migrated
        }
        
        // Check 'complete' flag at offset 8 + 40 = 48 (after discriminator + reserves)
        const completeOffset = 8 + 40;
        if (data.length > completeOffset) {
            return data[completeOffset] === 1;
        }
        
        return false;
    } catch (e) {
        // Don't log repetitive errors, just handle gracefully
        if (!e.message?.includes('union of')) {
            console.error(`[PDA] isTokenMigrated error:`, e.message);
        }
        // Fallback: assume not migrated (most common case for new tokens)
        return false;
    }
}

/**
 * Get multiple account infos - wrapper for better compatibility
 */
export async function getAccountInfoSafe(connection, pubkey) {
    try {
        const accounts = await connection.getMultipleAccountsInfo([pubkey]);
        return accounts?.[0] || null;
    } catch (e) {
        console.error(`[PDA] getAccountInfoSafe error:`, e.message);
        return null;
    }
}

