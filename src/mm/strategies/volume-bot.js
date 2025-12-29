/**
 * VOLUME BOT STRATEGY - MEME TOKEN EDITION
 * 
 * Purpose: Generate organic-looking trading volume
 * 
 * Improvements over basic version:
 * - Variable trade sizes (looks more natural)
 * - Random delays (not predictable)
 * - Tracks tokens held to avoid overselling
 * - Adjusts to balance (doesn't drain wallet)
 */

import { buy, sell, getPrice } from '../../trading/index.js';
import { LAMPORTS_PER_SOL } from '../../constants.js';

export class VolumeBot {
    static name = 'Volume Bot';
    static description = 'Creates natural-looking trading volume with variable sizes and random delays. Simple buy/sell cycles.';
    static difficulty = 'Beginner';
    
    constructor(connection, wallet, tokenMint, config = {}) {
        this.connection = connection;
        this.wallet = wallet;
        this.tokenMint = tokenMint;
        
        this.config = {
            // Trade sizing - percentage of balance
            tradePercentMin: config.tradePercentMin || 0.05,  // 5% minimum
            tradePercentMax: config.tradePercentMax || 0.15,  // 15% maximum
            
            // Or fixed amounts (if provided, uses these instead)
            tradeAmountMin: config.tradeAmountMin || null,
            tradeAmountMax: config.tradeAmountMax || null,
            
            // Timing - randomized for natural look
            delayMinMs: config.delayMinMs || 5000,     // 5 sec min
            delayMaxMs: config.delayMaxMs || 20000,    // 20 sec max
            
            // Safety
            minBalanceSOL: config.minBalanceSOL || 0.01,  // Keep this much for gas
            maxCyclesPerHour: config.maxCyclesPerHour || 60, // Rate limit
            
            slippage: config.slippage || 0.25,
        };
        
        this.isRunning = false;
        this.cycleCount = 0;
        this.hourStartTime = Date.now();
        this.stats = { 
            cycles: 0, 
            volume: 0,
            failed: 0,
        };
        this.hasTokens = false; // Track if we're holding tokens
        this.onLog = config.onLog || console.log;
        this.onTrade = config.onTrade || (() => {});
    }
    
    async start() {
        this.isRunning = true;
        this.hourStartTime = Date.now();
        this.cycleCount = 0;
        
        this.onLog('[VolumeBot] Started - MEME MODE');
        this.onLog(`[VolumeBot] Trade size: ${this.config.tradePercentMin * 100}-${this.config.tradePercentMax * 100}% of balance`);
        
        this._loop();
        return true;
    }
    
    async stop() {
        this.isRunning = false;
        
        // Sell any remaining tokens
        if (this.hasTokens) {
            this.onLog('[VolumeBot] Selling remaining tokens...');
            try {
                await sell(this.connection, this.wallet, this.tokenMint, null, this.config.slippage);
                this.hasTokens = false;
            } catch (e) {
                this.onLog(`[VolumeBot] Final sell failed: ${e.message}`);
            }
        }
        
        this.onLog(`[VolumeBot] Stopped. Total volume: ${this.stats.volume.toFixed(2)} SOL`);
        return this.stats;
    }
    
    async _loop() {
        while (this.isRunning) {
            try {
                // Rate limiting
                if (this._isRateLimited()) {
                    this.onLog('[VolumeBot] Rate limited, waiting...');
                    await this._delay(60000); // Wait 1 minute
                    continue;
                }
                
                // Get balance
                const balance = await this.connection.getBalance(this.wallet.publicKey);
                const availableSOL = (balance / LAMPORTS_PER_SOL) - this.config.minBalanceSOL;
                
                if (availableSOL < 0.005) {
                    this.onLog(`[VolumeBot] Low balance (${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL), waiting...`);
                    await this._delay(30000);
                    continue;
                }
                
                // Calculate trade amount
                let tradeAmount;
                if (this.config.tradeAmountMin && this.config.tradeAmountMax) {
                    // Use fixed amounts
                    tradeAmount = this._random(this.config.tradeAmountMin, this.config.tradeAmountMax);
                } else {
                    // Use percentage of balance
                    const percent = this._random(this.config.tradePercentMin, this.config.tradePercentMax);
                    tradeAmount = availableSOL * percent;
                }
                
                // Cap at available
                tradeAmount = Math.min(tradeAmount, availableSOL * 0.9);
                tradeAmount = Math.max(0.005, tradeAmount); // Minimum trade
                
                // Execute cycle
                await this._executeCycle(tradeAmount);
                
                // Random delay
                const delay = this._random(this.config.delayMinMs, this.config.delayMaxMs);
                await this._delay(delay);
                
            } catch (e) {
                this.onLog(`[VolumeBot] Loop error: ${e.message}`);
                this.stats.failed++;
                await this._delay(10000);
            }
        }
    }
    
    async _executeCycle(amountSOL) {
        this.onLog(`[VolumeBot] Cycle ${this.stats.cycles + 1}: ${amountSOL.toFixed(4)} SOL`);
        
        // BUY
        try {
            this.onLog(`[VolumeBot] BUY ${amountSOL.toFixed(4)} SOL`);
            const buyTx = await buy(
                this.connection, 
                this.wallet, 
                this.tokenMint, 
                amountSOL, 
                this.config.slippage
            );
            this.hasTokens = true;
            this.onTrade({ type: 'buy', amount: amountSOL, signature: buyTx });
        } catch (e) {
            this.onLog(`[VolumeBot] Buy failed: ${e.message}`);
            this.stats.failed++;
            return;
        }
        
        // Small delay between buy and sell (looks more natural)
        await this._delay(this._random(2000, 5000));
        
        // SELL
        try {
            this.onLog(`[VolumeBot] SELL all tokens`);
            const sellTx = await sell(
                this.connection, 
                this.wallet, 
                this.tokenMint, 
                null, // Sell all
                this.config.slippage
            );
            this.hasTokens = false;
            this.onTrade({ type: 'sell', amount: amountSOL, signature: sellTx });
        } catch (e) {
            this.onLog(`[VolumeBot] Sell failed: ${e.message}`);
            this.stats.failed++;
            // Keep hasTokens = true so we can try to sell later
            return;
        }
        
        // Update stats
        this.stats.cycles++;
        this.stats.volume += amountSOL * 2; // Buy + Sell
        this.cycleCount++;
        
        this.onLog(`[VolumeBot] Cycle complete. Total volume: ${this.stats.volume.toFixed(2)} SOL`);
    }
    
    _isRateLimited() {
        const now = Date.now();
        
        // Reset counter every hour
        if (now - this.hourStartTime > 3600000) {
            this.hourStartTime = now;
            this.cycleCount = 0;
        }
        
        return this.cycleCount >= this.config.maxCyclesPerHour;
    }
    
    _random(min, max) { 
        return Math.random() * (max - min) + min; 
    }
    
    _delay(ms) { 
        return new Promise(r => setTimeout(r, ms)); 
    }
    
    getStatus() {
        return { 
            strategy: 'volume',
            ...this.stats, 
            isRunning: this.isRunning,
            hasTokens: this.hasTokens,
            cyclesThisHour: this.cycleCount,
        };
    }
}

export default VolumeBot;
