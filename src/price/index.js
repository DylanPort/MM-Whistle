/**
 * PRICE MODULE
 * 
 * Provides fast, accurate price data for market making.
 * Uses WebSocket for real-time updates + caching.
 */

import { PriceTracker, MultiPriceTracker } from './tracker.js';
import { getBondingCurveAddress } from '../utils/pda.js';
import { isTokenMigrated } from '../utils/pda.js';
import {
    LAMPORTS_PER_SOL,
    TOKEN_DECIMALS,
    BONDING_CURVE_DISCRIMINATOR,
} from '../constants.js';

// Global price cache
const priceCache = new Map(); // mint -> { price, timestamp, dex }
const CACHE_TTL_MS = 500; // 500ms cache TTL

/**
 * Get cached price (fast, may be up to 500ms stale)
 */
export function getCachedPrice(mint) {
    const mintStr = mint.toBase58 ? mint.toBase58() : mint;
    const cached = priceCache.get(mintStr);
    
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return cached.price;
    }
    
    return null;
}

/**
 * Update price cache
 */
export function updatePriceCache(mint, price, dex) {
    const mintStr = mint.toBase58 ? mint.toBase58() : mint;
    priceCache.set(mintStr, {
        price,
        timestamp: Date.now(),
        dex,
    });
}

/**
 * Get fresh price (makes RPC call)
 * Uses getMultipleAccountsInfo for better RPC compatibility
 */
export async function getFreshPrice(connection, mint) {
    try {
        // Check migration status
        const migrated = await isTokenMigrated(connection, mint);
        
        if (migrated) {
            // PumpSwap price
            const { getPumpSwapPrice } = await import('../trading/pumpswap.js');
            const result = await getPumpSwapPrice(connection, mint);
            if (result) {
                updatePriceCache(mint, result.price, 'pumpswap');
                return result.price;
            }
        } else {
            // Bonding curve price - use getMultipleAccountsInfo for better RPC compatibility
            const bondingCurve = getBondingCurveAddress(mint);
            const accounts = await connection.getMultipleAccountsInfo([bondingCurve]);
            const info = accounts?.[0];
            
            if (info) {
                const price = parseBondingCurvePrice(info.data);
                if (price) {
                    updatePriceCache(mint, price, 'pump');
                    return price;
                }
            }
        }
        
        return null;
    } catch (e) {
        console.error('[Price] Fetch error:', e.message);
        return null;
    }
}

/**
 * Get price (cached if available, fresh otherwise)
 */
export async function getPrice(connection, mint) {
    // Try cache first
    const cached = getCachedPrice(mint);
    if (cached !== null) {
        return cached;
    }
    
    // Fetch fresh
    return await getFreshPrice(connection, mint);
}

/**
 * Parse price directly from bonding curve data (fast)
 */
export function parseBondingCurvePrice(data) {
    try {
        if (!data || data.length < 40) return null;
        
        // Check discriminator
        if (!data.slice(0, 8).equals(BONDING_CURVE_DISCRIMINATOR)) {
            return null;
        }
        
        const virtualTokenReserves = data.readBigUInt64LE(8);
        const virtualSolReserves = data.readBigUInt64LE(16);
        
        if (virtualTokenReserves <= 0n || virtualSolReserves <= 0n) {
            return null;
        }
        
        const solReserves = Number(virtualSolReserves) / LAMPORTS_PER_SOL;
        const tokenReserves = Number(virtualTokenReserves) / (10 ** TOKEN_DECIMALS);
        
        return solReserves / tokenReserves;
    } catch (e) {
        return null;
    }
}

// Re-export tracker classes
export { PriceTracker, MultiPriceTracker };

