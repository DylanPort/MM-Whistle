/**
 * Unified Trading Interface
 * Automatically routes to bonding curve or PumpSwap based on token state
 * Now with real-time price tracking!
 */

import { buyOnBondingCurve, sellOnBondingCurve, getBondingCurvePrice } from './bonding-curve.js';
import { buyOnPumpSwap, sellOnPumpSwap, getPumpSwapPrice, findPumpSwapPool } from './pumpswap.js';
import { isTokenMigrated, getBondingCurveAddress } from '../utils/pda.js';
import { getPrice as getPriceFast, PriceTracker, updatePriceCache } from '../price/index.js';

// Store connection references
let _indexedConnection = null;
let _geyserConnection = null;

// Active price trackers for real-time updates
const priceTrackers = new Map();

/**
 * Set the indexed connection for getProgramAccounts calls
 */
export function setIndexedConnection(conn) {
    _indexedConnection = conn;
}

/**
 * Set the Geyser connection for real-time WebSocket subscriptions
 */
export function setGeyserConnection(conn) {
    _geyserConnection = conn;
    console.log('[Trading] Geyser connection set for real-time price tracking');
}

/**
 * Start real-time price tracking for a token (via Geyser WebSocket)
 */
export async function startPriceTracking(connection, mint, onPriceUpdate) {
    const mintStr = mint.toBase58 ? mint.toBase58() : mint;
    
    // Don't duplicate trackers
    if (priceTrackers.has(mintStr)) {
        return priceTrackers.get(mintStr);
    }
    
    const tracker = new PriceTracker(connection, mint, {
        geyserConnection: _geyserConnection, // Use Geyser for WebSocket
        pollIntervalMs: 1000,
        onPriceUpdate: (update) => {
            // Update cache
            updatePriceCache(mint, update.price, update.dex);
            // Call user callback
            if (onPriceUpdate) onPriceUpdate(update);
        },
    });
    
    await tracker.start();
    priceTrackers.set(mintStr, tracker);
    
    return tracker;
}

/**
 * Stop price tracking for a token
 */
export function stopPriceTracking(mint) {
    const mintStr = mint.toBase58 ? mint.toBase58() : mint;
    const tracker = priceTrackers.get(mintStr);
    if (tracker) {
        tracker.stop();
        priceTrackers.delete(mintStr);
    }
}

/**
 * Get price tracker for a token
 */
export function getPriceTracker(mint) {
    const mintStr = mint.toBase58 ? mint.toBase58() : mint;
    return priceTrackers.get(mintStr);
}

/**
 * Buy tokens - automatically routes to correct DEX
 */
export async function buy(connection, payer, mint, solAmount, slippage = 0.25) {
    const migrated = await isTokenMigrated(connection, mint);
    
    if (migrated) {
        console.log(`[Router] Token is migrated -> PumpSwap`);
        return await buyOnPumpSwap(connection, payer, mint, solAmount, slippage, _indexedConnection);
    } else {
        console.log(`[Router] Token on bonding curve`);
        return await buyOnBondingCurve(connection, payer, mint, solAmount, slippage);
    }
}

/**
 * Sell tokens - automatically routes to correct DEX
 */
export async function sell(connection, payer, mint, tokenAmount = null, slippage = 0.25) {
    const migrated = await isTokenMigrated(connection, mint);
    
    if (migrated) {
        console.log(`[Router] Token is migrated -> PumpSwap`);
        return await sellOnPumpSwap(connection, payer, mint, tokenAmount, slippage, _indexedConnection);
    } else {
        console.log(`[Router] Token on bonding curve`);
        return await sellOnBondingCurve(connection, payer, mint, tokenAmount, slippage);
    }
}

/**
 * Get current price from either DEX
 * Now uses caching for speed!
 * Falls back to Token Intelligence API if RPC fails
 */
export async function getPrice(connection, mint) {
    const mintStr = mint.toBase58 ? mint.toBase58() : mint;
    
    // Check for active tracker first (fastest - WebSocket updated)
    const tracker = getPriceTracker(mint);
    if (tracker) {
        const price = tracker.getPrice();
        if (price) return price;
    }
    
    // Try RPC-based price fetch
    try {
        const price = await getPriceFast(connection, mint);
        if (price && price > 0) return price;
    } catch (e) {
        console.log(`[Price] RPC failed: ${e.message}, trying Token Intelligence API...`);
    }
    
    // Fallback: Token Intelligence API
    try {
        const response = await fetch(`https://tokens.whistle.ninja/token/${mintStr}`);
        if (response.ok) {
            const data = await response.json();
            if (data.price && data.price > 0) {
                console.log(`[Price] Got price from Token Intelligence API: ${data.price}`);
                return data.price;
            }
        }
    } catch (e) {
        console.log(`[Price] Token Intelligence API failed: ${e.message}`);
    }
    
    return null;
}

/**
 * Get token status with extended data
 * Uses getMultipleAccountsInfo for better RPC compatibility
 */
export async function getTokenStatus(connection, mint) {
    const migrated = await isTokenMigrated(connection, mint);
    const price = await getPrice(connection, mint);
    
    // Try to get bonding curve data for liquidity/market cap
    let liquiditySOL = 0;
    let marketCapSOL = 0;
    let totalSupply = 1_000_000_000; // Default 1B tokens
    let creator = null;
    
    if (!migrated) {
        // Get bonding curve data using getMultipleAccountsInfo
        try {
            const bondingCurvePDA = getBondingCurveAddress(mint);
            const accounts = await connection.getMultipleAccountsInfo([bondingCurvePDA]);
            
            if (!accounts || !Array.isArray(accounts)) {
                throw new Error('Invalid RPC response');
            }
            
            const bondingCurveAccount = accounts[0];
            
            if (bondingCurveAccount) {
                // Ensure data is a Buffer
                let data = bondingCurveAccount.data;
                if (data && typeof data === 'object' && !Buffer.isBuffer(data)) {
                    if (Array.isArray(data)) {
                        data = Buffer.from(data);
                    } else if (data.data) {
                        data = Buffer.from(data.data);
                    }
                }
                
                if (data && data.length >= 73) {
                    // virtualTokenReserves at offset 8 (8 bytes)
                    // virtualSolReserves at offset 16 (8 bytes)
                    // realTokenReserves at offset 24 (8 bytes)
                    // realSolReserves at offset 32 (8 bytes)
                    const virtualSolReserves = Number(data.readBigUInt64LE(16)) / 1e9;
                    const realSolReserves = Number(data.readBigUInt64LE(32)) / 1e9;
                    
                    liquiditySOL = realSolReserves;
                    // Market cap = price * total supply (rough estimate)
                    if (price && price > 0) {
                        marketCapSOL = price * totalSupply;
                    }
                    
                    // Parse creator if available (offset 49 = 8 discriminator + 8*5 reserves + 1 complete)
                    if (data.length >= 49 + 32) {
                        const { PublicKey } = await import('@solana/web3.js');
                        creator = new PublicKey(data.slice(49, 49 + 32)).toBase58();
                    }
                }
            }
        } catch (e) {
            // Suppress repetitive type errors
            if (!e.message?.includes('union of')) {
                console.log('[TokenStatus] Could not get bonding curve data:', e.message);
            }
        }
    }
    
    const mintStr = typeof mint === 'string' ? mint : mint.toBase58();
    return {
        mint: mintStr,
        migrated,
        dex: migrated ? 'pumpswap' : 'pump',
        price: price || 0,
        priceUSD: price ? price * 200 : 0, // Rough SOL price estimate
        liquiditySOL,
        marketCapSOL,
        marketCapUSD: marketCapSOL * 200, // Rough estimate
        totalSupply,
        creator  // Token creator (for creator vault fees)
    };
}

// Re-export individual modules for direct access
export * from './bonding-curve.js';
export * from './pumpswap.js';

