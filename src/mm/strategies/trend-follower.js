/**
 * TREND FOLLOWER BOT - MEME TOKEN EDITION
 * 
 * Meme tokens trend FAST. Traditional MAs are too slow.
 * Uses ultra-fast MAs (seconds, not minutes) to catch pumps.
 * 
 * Logic:
 * - Fast MA: 3 samples (~15 seconds)
 * - Slow MA: 8 samples (~40 seconds)
 * - Buys when fast crosses above slow (pump starting)
 * - Sells when fast crosses below slow (dump starting)
 * - Or sells on significant profit target
 */

import { buy, sell, getPrice } from '../../trading/index.js';
import { LAMPORTS_PER_SOL } from '../../constants.js';

export class TrendFollowerBot {
    static name = 'Trend Follower';
    static description = 'Ultra-fast MAs for meme pumps. Buys uptrend crossovers, sells on reversals or +25% profit.';
    static difficulty = 'Intermediate';
    
    constructor(connection, wallet, tokenMint, config = {}) {
        this.connection = connection;
        this.wallet = wallet;
        this.tokenMint = tokenMint;
        
        this.config = {
            // ULTRA-FAST MAs for meme tokens
            fastPeriod: config.fastPeriod || 3,        // 3 samples (~15 seconds)
            slowPeriod: config.slowPeriod || 8,        // 8 samples (~40 seconds)
            
            // Sampling - every 5 seconds
            sampleIntervalMs: config.sampleIntervalMs || 5000,
            
            // Trade sizing
            tradePercent: config.tradePercent || 0.25,      // 25% of balance per entry
            maxPositionPercent: config.maxPositionPercent || 0.50, // Max 50% in position
            
            // Profit/Loss targets
            takeProfitPercent: config.takeProfitPercent || 25,  // Take profit at +25%
            stopLossPercent: config.stopLossPercent || 20,      // Stop loss at -20%
            
            // Trend confirmation
            minCrossStrength: config.minCrossStrength || 2,     // Fast MA must be X% above slow
            
            // Scaling into positions
            allowScaleIn: config.allowScaleIn || true,          // Add to winning positions
            scaleInTrigger: config.scaleInTrigger || 10,        // Scale in after +10%
            
            slippage: config.slippage || 0.30,
        };
        
        this.isRunning = false;
        this.priceHistory = [];
        this.position = null; // { totalSOL, entries: [{amount, price}], avgPrice }
        this.trend = null; // 'up', 'down', null
        this.prevTrend = null;
        this.stats = { 
            buys: 0, 
            sells: 0, 
            trendChanges: 0,
            wins: 0,
            losses: 0,
            totalProfit: 0,
        };
        this.onLog = config.onLog || console.log;
        this.onTrade = config.onTrade || (() => {});
    }
    
    async start() {
        this.isRunning = true;
        this.onLog('[TrendFollower] Started - MEME MODE');
        this.onLog(`[TrendFollower] Fast MA: ${this.config.fastPeriod} | Slow MA: ${this.config.slowPeriod}`);
        this.onLog(`[TrendFollower] Take profit: +${this.config.takeProfitPercent}% | Stop loss: -${this.config.stopLossPercent}%`);
        
        this._loop();
        return true;
    }
    
    async stop() {
        this.isRunning = false;
        
        // Close any open position
        if (this.position) {
            this.onLog('[TrendFollower] Closing position on stop...');
            await this._closePosition('stop');
        }
        
        this.onLog(`[TrendFollower] Final: ${this.stats.wins} wins, ${this.stats.losses} losses, ${this.stats.totalProfit.toFixed(1)}% total`);
        return this.stats;
    }
    
    async _loop() {
        while (this.isRunning) {
            try {
                const price = await getPrice(this.connection, this.tokenMint);
                if (!price || price === 0) {
                    await this._delay(this.config.sampleIntervalMs);
                    continue;
                }
                
                this._addPrice(price);
                
                // Need enough data for slow MA
                if (this.priceHistory.length < this.config.slowPeriod) {
                    this.onLog(`[TrendFollower] Collecting: ${this.priceHistory.length}/${this.config.slowPeriod}`);
                    await this._delay(this.config.sampleIntervalMs);
                    continue;
                }
                
                // Calculate MAs
                const fastMA = this._getMA(this.config.fastPeriod);
                const slowMA = this._getMA(this.config.slowPeriod);
                const crossStrength = ((fastMA - slowMA) / slowMA) * 100;
                
                // Determine trend
                this.prevTrend = this.trend;
                
                if (crossStrength >= this.config.minCrossStrength) {
                    this.trend = 'up';
                } else if (crossStrength <= -this.config.minCrossStrength) {
                    this.trend = 'down';
                }
                // If between thresholds, keep current trend (avoid whipsaws)
                
                // Log status
                this.onLog(`[TrendFollower] Price: ${price.toExponential(3)} | Fast: ${fastMA.toExponential(3)} | Slow: ${slowMA.toExponential(3)}`);
                this.onLog(`[TrendFollower] Cross: ${crossStrength >= 0 ? '+' : ''}${crossStrength.toFixed(2)}% | Trend: ${this.trend?.toUpperCase() || 'NEUTRAL'}`);
                
                // === POSITION MANAGEMENT ===
                if (this.position) {
                    const currentPL = ((price - this.position.avgPrice) / this.position.avgPrice) * 100;
                    this.onLog(`[TrendFollower] Position P/L: ${currentPL >= 0 ? '+' : ''}${currentPL.toFixed(1)}%`);
                    
                    // Take profit
                    if (currentPL >= this.config.takeProfitPercent) {
                        this.onLog(`[TrendFollower] TAKE PROFIT at +${currentPL.toFixed(1)}%`);
                        await this._closePosition('profit', currentPL);
                    }
                    // Stop loss
                    else if (currentPL <= -this.config.stopLossPercent) {
                        this.onLog(`[TrendFollower] STOP LOSS at ${currentPL.toFixed(1)}%`);
                        await this._closePosition('loss', currentPL);
                    }
                    // Trend reversal - exit
                    else if (this.trend === 'down' && this.prevTrend === 'up') {
                        this.onLog(`[TrendFollower] TREND REVERSAL - exiting`);
                        await this._closePosition('reversal', currentPL);
                    }
                    // Scale in on winners
                    else if (this.config.allowScaleIn && 
                             currentPL >= this.config.scaleInTrigger && 
                             this.trend === 'up') {
                        await this._scaleIn(price);
                    }
                }
                // === NO POSITION - Look for entry ===
                else {
                    // Enter on bullish crossover
                    if (this.trend === 'up' && this.prevTrend !== 'up') {
                        this.stats.trendChanges++;
                        this.onLog(`[TrendFollower] BULLISH CROSSOVER detected`);
                        await this._enterPosition(price);
                    }
                }
                
                await this._delay(this.config.sampleIntervalMs);
                
            } catch (e) {
                this.onLog(`[TrendFollower] Error: ${e.message}`);
                await this._delay(this.config.sampleIntervalMs);
            }
        }
    }
    
    async _enterPosition(price) {
        try {
            const balance = await this.connection.getBalance(this.wallet.publicKey);
            const availableSOL = (balance / LAMPORTS_PER_SOL) - 0.005;
            
            if (availableSOL <= 0.01) {
                this.onLog('[TrendFollower] Insufficient balance');
                return;
            }
            
            const tradeAmount = availableSOL * this.config.tradePercent;
            
            if (tradeAmount < 0.005) return;
            
            this.onLog(`[TrendFollower] ENTERING ${tradeAmount.toFixed(4)} SOL @ ${price.toExponential(4)}`);
            
            const tx = await buy(this.connection, this.wallet, this.tokenMint, tradeAmount, this.config.slippage);
            
            this.position = {
                totalSOL: tradeAmount,
                entries: [{ amount: tradeAmount, price }],
                avgPrice: price,
            };
            this.stats.buys++;
            
            this.onTrade({ type: 'buy', amount: tradeAmount, price, signature: tx });
            
        } catch (e) {
            this.onLog(`[TrendFollower] Entry failed: ${e.message}`);
        }
    }
    
    async _scaleIn(price) {
        if (!this.position) return;
        
        try {
            const balance = await this.connection.getBalance(this.wallet.publicKey);
            const availableSOL = (balance / LAMPORTS_PER_SOL) - 0.005;
            const totalBalance = availableSOL + this.position.totalSOL;
            
            // Check max position
            if (this.position.totalSOL / totalBalance >= this.config.maxPositionPercent) {
                return;
            }
            
            // Add half of initial size
            const scaleAmount = Math.min(
                this.position.entries[0].amount * 0.5,
                availableSOL * 0.5
            );
            
            if (scaleAmount < 0.005) return;
            
            this.onLog(`[TrendFollower] SCALING IN ${scaleAmount.toFixed(4)} SOL @ ${price.toExponential(4)}`);
            
            const tx = await buy(this.connection, this.wallet, this.tokenMint, scaleAmount, this.config.slippage);
            
            this.position.entries.push({ amount: scaleAmount, price });
            this.position.totalSOL += scaleAmount;
            this.position.avgPrice = this._calcAvgPrice();
            this.stats.buys++;
            
            this.onTrade({ type: 'buy', amount: scaleAmount, price, action: 'scale-in', signature: tx });
            
        } catch (e) {
            this.onLog(`[TrendFollower] Scale in failed: ${e.message}`);
        }
    }
    
    async _closePosition(reason, percentPL = 0) {
        if (!this.position) return;
        
        try {
            this.onLog(`[TrendFollower] CLOSING position (${reason}): ${this.position.totalSOL.toFixed(4)} SOL`);
            
            const tx = await sell(this.connection, this.wallet, this.tokenMint, null, this.config.slippage);
            
            // Track stats
            this.stats.sells++;
            if (percentPL > 0) {
                this.stats.wins++;
            } else if (percentPL < 0) {
                this.stats.losses++;
            }
            this.stats.totalProfit += percentPL;
            
            this.onTrade({ 
                type: 'sell', 
                amount: this.position.totalSOL, 
                reason,
                profit: percentPL,
                signature: tx 
            });
            
            this.position = null;
            
        } catch (e) {
            this.onLog(`[TrendFollower] Close failed: ${e.message}`);
        }
    }
    
    _calcAvgPrice() {
        if (!this.position || this.position.entries.length === 0) return 0;
        
        let totalValue = 0;
        let totalAmount = 0;
        
        for (const entry of this.position.entries) {
            totalValue += entry.amount * entry.price;
            totalAmount += entry.amount;
        }
        
        return totalValue / totalAmount;
    }
    
    _addPrice(price) {
        this.priceHistory.push(price);
        const maxNeeded = Math.max(this.config.fastPeriod, this.config.slowPeriod) + 2;
        if (this.priceHistory.length > maxNeeded) {
            this.priceHistory.shift();
        }
    }
    
    _getMA(period) {
        const prices = this.priceHistory.slice(-period);
        return prices.reduce((a, b) => a + b, 0) / prices.length;
    }
    
    _delay(ms) { return new Promise(r => setTimeout(r, ms)); }
    
    getStatus() {
        return { 
            strategy: 'trend-follower',
            ...this.stats, 
            isRunning: this.isRunning,
            trend: this.trend,
            position: this.position ? {
                totalSOL: this.position.totalSOL,
                avgPrice: this.position.avgPrice,
                entries: this.position.entries.length,
            } : null,
            winRate: this.stats.sells > 0 ? ((this.stats.wins / this.stats.sells) * 100).toFixed(1) + '%' : 'N/A',
        };
    }
}

export default TrendFollowerBot;
