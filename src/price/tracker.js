/**
 * REAL-TIME PRICE TRACKER
 * 
 * Uses WebSocket subscriptions for instant price updates.
 * Falls back to polling if WebSocket fails.
 * 
 * Features:
 * - WebSocket subscription to bonding curve account changes
 * - Sub-second price updates when trades happen
 * - Price history with timestamps
 * - Volatility calculation
 * - Price change callbacks
 */

import { PublicKey } from '@solana/web3.js';
import {
    PUMP_PROGRAM,
    LAMPORTS_PER_SOL,
    TOKEN_DECIMALS,
    BONDING_CURVE_DISCRIMINATOR,
} from '../constants.js';
import { getBondingCurveAddress, getAssociatedBondingCurve } from '../utils/pda.js';
import { isTokenMigrated } from '../utils/pda.js';

// ============================================================================
// PRICE TRACKER CLASS
// ============================================================================

export class PriceTracker {
    constructor(connection, mint, options = {}) {
        this.connection = connection;
        // Use separate Geyser connection for WebSocket if provided
        this.wsConnection = options.geyserConnection || connection;
        this.mint = mint;
        
        this.options = {
            historySize: options.historySize || 100,     // Keep last 100 prices
            pollIntervalMs: options.pollIntervalMs || 1000, // 1 second fallback polling
            onPriceUpdate: options.onPriceUpdate || null,
            onMigration: options.onMigration || null,
        };
        
        // State
        this.currentPrice = null;
        this.priceHistory = [];  // { price, timestamp, source }
        this.isTracking = false;
        this.subscriptionId = null;
        this.pollInterval = null;
        this.dex = null;
        this.lastUpdate = null;
        
        // Derived addresses
        this.bondingCurve = null;
        this.poolAddress = null;
    }
    
    /**
     * Start tracking price
     */
    async start() {
        if (this.isTracking) return;
        
        console.log(`[PriceTracker] Starting for ${this.mint.toBase58()}`);
        
        // Check if migrated
        const migrated = await isTokenMigrated(this.connection, this.mint);
        this.dex = migrated ? 'pumpswap' : 'pump';
        
        // Get initial price
        await this._fetchPrice();
        
        // Start WebSocket subscription
        await this._startWebSocket();
        
        // Start backup polling (in case WebSocket misses updates)
        this._startPolling();
        
        this.isTracking = true;
        console.log(`[PriceTracker] Tracking ${this.dex} - Initial price: ${this.currentPrice?.toExponential(4)}`);
        
        return this.currentPrice;
    }
    
    /**
     * Stop tracking
     */
    stop() {
        console.log('[PriceTracker] Stopping...');
        
        // Unsubscribe Geyser WebSocket
        if (this.subscriptionId !== null) {
            this.wsConnection.removeAccountChangeListener(this.subscriptionId);
            this.subscriptionId = null;
        }
        
        // Stop polling
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        
        this.isTracking = false;
    }
    
    /**
     * Get current price
     */
    getPrice() {
        return this.currentPrice;
    }
    
    /**
     * Get price history
     */
    getHistory(count = 20) {
        return this.priceHistory.slice(-count);
    }
    
    /**
     * Get price change over time window
     */
    getPriceChange(windowMs = 60000) {
        const now = Date.now();
        const windowStart = now - windowMs;
        
        const recentPrices = this.priceHistory.filter(p => p.timestamp >= windowStart);
        if (recentPrices.length < 2) return { change: 0, percent: 0 };
        
        const oldPrice = recentPrices[0].price;
        const newPrice = recentPrices[recentPrices.length - 1].price;
        
        return {
            change: newPrice - oldPrice,
            percent: ((newPrice - oldPrice) / oldPrice) * 100,
            high: Math.max(...recentPrices.map(p => p.price)),
            low: Math.min(...recentPrices.map(p => p.price)),
        };
    }
    
    /**
     * Get volatility (standard deviation of returns)
     */
    getVolatility(windowMs = 60000) {
        const now = Date.now();
        const windowStart = now - windowMs;
        
        const recentPrices = this.priceHistory
            .filter(p => p.timestamp >= windowStart)
            .map(p => p.price);
        
        if (recentPrices.length < 3) return 0;
        
        // Calculate returns
        const returns = [];
        for (let i = 1; i < recentPrices.length; i++) {
            returns.push((recentPrices[i] - recentPrices[i-1]) / recentPrices[i-1]);
        }
        
        // Standard deviation
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const squaredDiffs = returns.map(r => Math.pow(r - mean, 2));
        const variance = squaredDiffs.reduce((a, b) => a + b, 0) / returns.length;
        
        return Math.sqrt(variance) * 100; // As percentage
    }
    
    // ========================================================================
    // WEBSOCKET SUBSCRIPTION
    // ========================================================================
    
    async _startWebSocket() {
        try {
            if (this.dex === 'pump') {
                // Subscribe to bonding curve account via Geyser
                this.bondingCurve = getBondingCurveAddress(this.mint);
                
                // Use Geyser connection for WebSocket (real-time updates)
                this.subscriptionId = this.wsConnection.onAccountChange(
                    this.bondingCurve,
                    (accountInfo, context) => {
                        this._handleAccountUpdate(accountInfo, 'geyser');
                    },
                    'confirmed'
                );
                
                console.log(`[PriceTracker] Geyser WebSocket subscribed to bonding curve`);
            } else {
                // For PumpSwap, we'd subscribe to the pool account
                // This requires knowing the pool address
                console.log(`[PriceTracker] PumpSwap Geyser not implemented - using polling`);
            }
        } catch (e) {
            console.error(`[PriceTracker] Geyser WebSocket failed:`, e.message);
        }
    }
    
    _handleAccountUpdate(accountInfo, source) {
        try {
            if (!accountInfo || !accountInfo.data) return;
            
            const data = accountInfo.data;
            
            // Parse bonding curve state
            if (!data.slice(0, 8).equals(BONDING_CURVE_DISCRIMINATOR)) {
                return;
            }
            
            let offset = 8;
            const virtualTokenReserves = data.readBigUInt64LE(offset); offset += 8;
            const virtualSolReserves = data.readBigUInt64LE(offset); offset += 8;
            
            // Skip to complete flag
            offset += 24; // realTokenReserves + realSolReserves + tokenTotalSupply
            const complete = data[offset] === 1;
            
            // Check for migration
            if (complete && this.dex === 'pump') {
                console.log('[PriceTracker] Token migrated!');
                this.dex = 'pumpswap';
                if (this.options.onMigration) {
                    this.options.onMigration();
                }
                return;
            }
            
            // Calculate price
            const solReserves = Number(virtualSolReserves) / LAMPORTS_PER_SOL;
            const tokenReserves = Number(virtualTokenReserves) / (10 ** TOKEN_DECIMALS);
            const newPrice = solReserves / tokenReserves;
            
            this._updatePrice(newPrice, source);
            
        } catch (e) {
            console.error(`[PriceTracker] Parse error:`, e.message);
        }
    }
    
    // ========================================================================
    // POLLING FALLBACK
    // ========================================================================
    
    _startPolling() {
        this.pollInterval = setInterval(async () => {
            // Only poll if WebSocket hasn't updated recently
            const msSinceUpdate = this.lastUpdate ? Date.now() - this.lastUpdate : Infinity;
            
            if (msSinceUpdate > this.options.pollIntervalMs * 2) {
                await this._fetchPrice();
            }
        }, this.options.pollIntervalMs);
    }
    
    async _fetchPrice() {
        try {
            if (this.dex === 'pump') {
                await this._fetchBondingCurvePrice();
            } else {
                await this._fetchPumpSwapPrice();
            }
        } catch (e) {
            console.error(`[PriceTracker] Fetch error:`, e.message);
        }
    }
    
    async _fetchBondingCurvePrice() {
        const bondingCurve = getBondingCurveAddress(this.mint);
        
        // Use getMultipleAccountsInfo for better RPC compatibility
        const accounts = await this.connection.getMultipleAccountsInfo([bondingCurve]);
        const info = accounts?.[0];
        
        if (!info) {
            // Might have migrated
            const migrated = await isTokenMigrated(this.connection, this.mint);
            if (migrated && this.dex === 'pump') {
                this.dex = 'pumpswap';
                if (this.options.onMigration) {
                    this.options.onMigration();
                }
            }
            return;
        }
        
        this._handleAccountUpdate(info, 'poll');
    }
    
    async _fetchPumpSwapPrice() {
        // For PumpSwap, we need to read the pool reserves
        // This is more complex - using the pumpswap module
        try {
            const { getPumpSwapPrice } = await import('../trading/pumpswap.js');
            const result = await getPumpSwapPrice(this.connection, this.mint);
            if (result && result.price) {
                this._updatePrice(result.price, 'poll');
            }
        } catch (e) {
            console.error(`[PriceTracker] PumpSwap fetch error:`, e.message);
        }
    }
    
    // ========================================================================
    // PRICE UPDATE HANDLING
    // ========================================================================
    
    _updatePrice(newPrice, source) {
        const now = Date.now();
        
        // Check if price actually changed
        if (this.currentPrice && Math.abs(newPrice - this.currentPrice) / this.currentPrice < 0.0001) {
            // Less than 0.01% change - ignore noise
            return;
        }
        
        const oldPrice = this.currentPrice;
        this.currentPrice = newPrice;
        this.lastUpdate = now;
        
        // Add to history
        this.priceHistory.push({
            price: newPrice,
            timestamp: now,
            source,
        });
        
        // Trim history
        if (this.priceHistory.length > this.options.historySize) {
            this.priceHistory.shift();
        }
        
        // Callback
        if (this.options.onPriceUpdate && oldPrice !== null) {
            const change = ((newPrice - oldPrice) / oldPrice) * 100;
            this.options.onPriceUpdate({
                price: newPrice,
                previousPrice: oldPrice,
                change,
                timestamp: now,
                source,
                dex: this.dex,
            });
        }
    }
}

// ============================================================================
// MULTI-TOKEN PRICE TRACKER
// ============================================================================

export class MultiPriceTracker {
    constructor(connection) {
        this.connection = connection;
        this.trackers = new Map(); // mint -> PriceTracker
    }
    
    /**
     * Start tracking a token
     */
    async track(mint, options = {}) {
        const mintStr = mint.toBase58 ? mint.toBase58() : mint;
        
        if (this.trackers.has(mintStr)) {
            return this.trackers.get(mintStr).getPrice();
        }
        
        const tracker = new PriceTracker(
            this.connection,
            typeof mint === 'string' ? new PublicKey(mint) : mint,
            options
        );
        
        await tracker.start();
        this.trackers.set(mintStr, tracker);
        
        return tracker.getPrice();
    }
    
    /**
     * Stop tracking a token
     */
    untrack(mint) {
        const mintStr = mint.toBase58 ? mint.toBase58() : mint;
        
        const tracker = this.trackers.get(mintStr);
        if (tracker) {
            tracker.stop();
            this.trackers.delete(mintStr);
        }
    }
    
    /**
     * Get tracker for a mint
     */
    get(mint) {
        const mintStr = mint.toBase58 ? mint.toBase58() : mint;
        return this.trackers.get(mintStr);
    }
    
    /**
     * Get price for a mint
     */
    getPrice(mint) {
        const tracker = this.get(mint);
        return tracker ? tracker.getPrice() : null;
    }
    
    /**
     * Stop all trackers
     */
    stopAll() {
        for (const tracker of this.trackers.values()) {
            tracker.stop();
        }
        this.trackers.clear();
    }
}

export default PriceTracker;

