/**
 * SPREAD MARKET MAKER - MEME TOKEN EDITION
 * 
 * Traditional spread MM doesn't work on meme tokens (no order books).
 * This version focuses on ACCUMULATION and DISTRIBUTION phases.
 * 
 * Logic:
 * - Accumulate small amounts during quiet periods
 * - Sell chunks during pump phases
 * - Track average cost basis
 * - Goal: Sell higher than average buy price
 */

import { buy, sell, getPrice } from '../../trading/index.js';
import { LAMPORTS_PER_SOL } from '../../constants.js';

export class SpreadMarketMaker {
    static name = 'Accumulate & Distribute';
    static description = 'Accumulates during quiet periods, distributes during pumps. Tracks cost basis for profit.';
    static difficulty = 'Advanced';
    
    constructor(connection, wallet, tokenMint, config = {}) {
        this.connection = connection;
        this.wallet = wallet;
        this.tokenMint = tokenMint;
        
        this.config = {
            // Accumulation settings
            buyAmount: config.buyAmount || 0.02,           // Buy small amounts
            buyIntervalMs: config.buyIntervalMs || 30000,  // Every 30 seconds
            maxAccumulation: config.maxAccumulation || 0.3, // Max 30% of balance in position
            
            // Distribution settings
            sellTriggerPercent: config.sellTriggerPercent || 15, // Start selling at +15%
            sellChunkPercent: config.sellChunkPercent || 0.25,   // Sell 25% of position at a time
            
            // Profit target
            targetProfitPercent: config.targetProfitPercent || 20, // Overall target +20%
            
            // Safety
            stopLossPercent: config.stopLossPercent || 30,  // Emergency exit at -30%
            
            // Price monitoring
            checkIntervalMs: config.checkIntervalMs || 5000,
            volatilityWindow: config.volatilityWindow || 20, // Track last 20 prices
            
            slippage: config.slippage || 0.30,
        };
        
        this.isRunning = false;
        this.phase = 'accumulate'; // 'accumulate' or 'distribute'
        this.position = {
            totalSOL: 0,
            totalCost: 0,
            avgPrice: 0,
            buys: [],
        };
        this.priceHistory = [];
        this.lastBuyTime = 0;
        this.stats = { 
            buys: 0, 
            sells: 0, 
            totalBought: 0,
            totalSold: 0,
            realizedProfit: 0,
        };
        this.onLog = config.onLog || console.log;
        this.onTrade = config.onTrade || (() => {});
    }
    
    async start() {
        this.isRunning = true;
        this.onLog('[SpreadMM] Started - ACCUMULATE & DISTRIBUTE MODE');
        this.onLog(`[SpreadMM] Buy: ${this.config.buyAmount} SOL every ${this.config.buyIntervalMs/1000}s`);
        this.onLog(`[SpreadMM] Sell trigger: +${this.config.sellTriggerPercent}%`);
        
        this._loop();
        return true;
    }
    
    async stop() {
        this.isRunning = false;
        
        // Sell remaining position
        if (this.position.totalSOL > 0) {
            await this._sellAll('stop');
        }
        
        this.onLog(`[SpreadMM] Final P/L: ${this.stats.realizedProfit.toFixed(2)}%`);
        return this.stats;
    }
    
    async _loop() {
        while (this.isRunning) {
            try {
                const currentPrice = await getPrice(this.connection, this.tokenMint);
                if (!currentPrice || currentPrice === 0) {
                    await this._delay(this.config.checkIntervalMs);
                    continue;
                }
                
                this._updatePriceHistory(currentPrice);
                
                // Calculate current P/L if we have a position
                let currentPL = 0;
                if (this.position.avgPrice > 0) {
                    currentPL = ((currentPrice - this.position.avgPrice) / this.position.avgPrice) * 100;
                }
                
                // Log status
                this.onLog(`[SpreadMM] Price: ${currentPrice.toExponential(3)} | Phase: ${this.phase.toUpperCase()}`);
                if (this.position.totalSOL > 0) {
                    this.onLog(`[SpreadMM] Position: ${this.position.totalSOL.toFixed(4)} SOL | Avg: ${this.position.avgPrice.toExponential(3)} | P/L: ${currentPL >= 0 ? '+' : ''}${currentPL.toFixed(1)}%`);
                }
                
                // Check stop loss
                if (currentPL <= -this.config.stopLossPercent && this.position.totalSOL > 0) {
                    this.onLog(`[SpreadMM] STOP LOSS triggered at ${currentPL.toFixed(1)}%`);
                    await this._sellAll('stoploss');
                    continue;
                }
                
                // Determine phase based on profit
                if (currentPL >= this.config.sellTriggerPercent && this.position.totalSOL > 0) {
                    this.phase = 'distribute';
                } else if (currentPL < this.config.sellTriggerPercent * 0.5) {
                    this.phase = 'accumulate';
                }
                
                // Execute based on phase
                if (this.phase === 'accumulate') {
                    await this._accumulate(currentPrice);
                } else {
                    await this._distribute(currentPrice, currentPL);
                }
                
                await this._delay(this.config.checkIntervalMs);
                
            } catch (e) {
                this.onLog(`[SpreadMM] Error: ${e.message}`);
                await this._delay(this.config.checkIntervalMs);
            }
        }
    }
    
    async _accumulate(price) {
        // Check if enough time since last buy
        const now = Date.now();
        if (now - this.lastBuyTime < this.config.buyIntervalMs) {
            return;
        }
        
        // Check if we've accumulated enough
        const balance = await this.connection.getBalance(this.wallet.publicKey);
        const totalSOL = balance / LAMPORTS_PER_SOL;
        
        if (this.position.totalSOL >= totalSOL * this.config.maxAccumulation) {
            this.onLog('[SpreadMM] Max accumulation reached, waiting for pump');
            return;
        }
        
        const availableSOL = totalSOL - 0.005;
        const buyAmount = Math.min(this.config.buyAmount, availableSOL * 0.1);
        
        if (buyAmount < 0.005) return;
        
        try {
            this.onLog(`[SpreadMM] ACCUMULATING ${buyAmount.toFixed(4)} SOL @ ${price.toExponential(4)}`);
            
            const tx = await buy(this.connection, this.wallet, this.tokenMint, buyAmount, this.config.slippage);
            
            // Update position
            this.position.totalSOL += buyAmount;
            this.position.totalCost += buyAmount;
            this.position.buys.push({ amount: buyAmount, price });
            this.position.avgPrice = this._calcAvgPrice();
            
            this.lastBuyTime = now;
            this.stats.buys++;
            this.stats.totalBought += buyAmount;
            
            this.onTrade({ type: 'buy', amount: buyAmount, price, phase: 'accumulate', signature: tx });
            
        } catch (e) {
            this.onLog(`[SpreadMM] Accumulate failed: ${e.message}`);
        }
    }
    
    async _distribute(price, currentPL) {
        // Take profit if we hit target
        if (currentPL >= this.config.targetProfitPercent) {
            this.onLog(`[SpreadMM] TARGET PROFIT reached: +${currentPL.toFixed(1)}%`);
            await this._sellAll('profit');
            return;
        }
        
        // Sell a chunk
        try {
            const sellSOL = this.position.totalSOL * this.config.sellChunkPercent;
            
            if (sellSOL < 0.005) {
                // Position too small, sell all
                await this._sellAll('small');
                return;
            }
            
            this.onLog(`[SpreadMM] DISTRIBUTING chunk @ +${currentPL.toFixed(1)}%`);
            
            const tx = await sell(this.connection, this.wallet, this.tokenMint, null, this.config.slippage);
            
            // Update position (we sold everything in this tx, but track as if partial)
            const soldValue = this.position.totalSOL * (1 + currentPL / 100);
            const profit = soldValue - this.position.totalSOL;
            
            this.stats.sells++;
            this.stats.totalSold += this.position.totalSOL;
            this.stats.realizedProfit = currentPL;
            
            // Reset position
            this.position = {
                totalSOL: 0,
                totalCost: 0,
                avgPrice: 0,
                buys: [],
            };
            this.phase = 'accumulate';
            
            this.onTrade({ type: 'sell', profit: currentPL, phase: 'distribute', signature: tx });
            
        } catch (e) {
            this.onLog(`[SpreadMM] Distribute failed: ${e.message}`);
        }
    }
    
    async _sellAll(reason) {
        if (this.position.totalSOL <= 0) return;
        
        try {
            this.onLog(`[SpreadMM] SELLING ALL (${reason}): ${this.position.totalSOL.toFixed(4)} SOL`);
            
            const tx = await sell(this.connection, this.wallet, this.tokenMint, null, this.config.slippage);
            
            this.stats.sells++;
            this.stats.totalSold += this.position.totalSOL;
            
            // Reset
            this.position = {
                totalSOL: 0,
                totalCost: 0,
                avgPrice: 0,
                buys: [],
            };
            this.phase = 'accumulate';
            
            this.onTrade({ type: 'sell', reason, signature: tx });
            
        } catch (e) {
            this.onLog(`[SpreadMM] Sell all failed: ${e.message}`);
        }
    }
    
    _calcAvgPrice() {
        if (this.position.buys.length === 0) return 0;
        
        let totalValue = 0;
        let totalAmount = 0;
        
        for (const buy of this.position.buys) {
            totalValue += buy.amount * buy.price;
            totalAmount += buy.amount;
        }
        
        return totalAmount > 0 ? totalValue / totalAmount : 0;
    }
    
    _updatePriceHistory(price) {
        this.priceHistory.push({ price, time: Date.now() });
        if (this.priceHistory.length > this.config.volatilityWindow) {
            this.priceHistory.shift();
        }
    }
    
    _delay(ms) { return new Promise(r => setTimeout(r, ms)); }
    
    getStatus() {
        return { 
            strategy: 'spread-mm',
            ...this.stats, 
            isRunning: this.isRunning,
            phase: this.phase,
            position: this.position.totalSOL > 0 ? {
                totalSOL: this.position.totalSOL,
                avgPrice: this.position.avgPrice,
                numBuys: this.position.buys.length,
            } : null,
        };
    }
}

export default SpreadMarketMaker;
