/**
 * GRID TRADING BOT - MEME TOKEN EDITION
 * 
 * Meme tokens swing HARD. Traditional 2% grids don't work.
 * This uses wide grids (10-15% spacing) to catch the swings.
 * 
 * Logic:
 * - Creates buy zones at 10%, 20%, 30% below entry
 * - Each zone triggers a buy when price enters
 * - Sells when price rebounds to entry or above
 * - Works great for tokens that pump/dump repeatedly
 */

import { buy, sell, getPrice } from '../../trading/index.js';
import { LAMPORTS_PER_SOL } from '../../constants.js';

export class GridBot {
    static name = 'Grid Trading';
    static description = 'Wide grid levels (10-15% spacing) for meme volatility. Buys dips at each level, sells on recovery.';
    static difficulty = 'Advanced';
    
    constructor(connection, wallet, tokenMint, config = {}) {
        this.connection = connection;
        this.wallet = wallet;
        this.tokenMint = tokenMint;
        
        this.config = {
            // MEME GRID SETTINGS - Wide levels for big swings
            gridLevels: config.gridLevels || 4,              // 4 buy levels
            gridSpacingPercent: config.gridSpacingPercent || 12, // 12% between each level
            
            // Profit taking
            takeProfitPercent: config.takeProfitPercent || 15,   // Sell when 15% above entry
            
            // Trade sizing - divide balance across grid levels
            balancePerLevel: config.balancePerLevel || 0.15,     // 15% of balance per level
            
            // Timing
            checkIntervalMs: config.checkIntervalMs || 5000,     // Check every 5s
            
            // Safety
            maxTotalInvested: config.maxTotalInvested || 0.60,   // Max 60% of balance in positions
            emergencyStopPercent: config.emergencyStopPercent || 50, // Emergency exit if down 50%
            
            slippage: config.slippage || 0.30,
        };
        
        this.isRunning = false;
        this.basePrice = null;
        this.lastPrice = null;
        this.grid = []; // { level, triggerPrice, filled, fillPrice, fillAmount }
        this.totalInvested = 0;
        this.stats = { 
            buys: 0, 
            sells: 0, 
            gridProfit: 0,
            levelsHit: 0,
        };
        this.onLog = config.onLog || console.log;
        this.onTrade = config.onTrade || (() => {});
    }
    
    async start() {
        this.isRunning = true;
        
        // Get current price as base (with retries)
        for (let i = 0; i < 3; i++) {
            this.basePrice = await getPrice(this.connection, this.tokenMint);
            if (this.basePrice && this.basePrice > 0) break;
            this.onLog(`[GridBot] Price fetch attempt ${i + 1}/3...`);
            await new Promise(r => setTimeout(r, 2000));
        }
        
        if (!this.basePrice || this.basePrice === 0) {
            this.onLog('[GridBot] Could not get initial price, will retry in loop...');
            this.basePrice = null;
        } else {
            this.lastPrice = this.basePrice;
            this._createGrid();
            this.onLog(`[GridBot] Started - MEME MODE`);
            this.onLog(`[GridBot] Base price: ${this.basePrice.toExponential(4)}`);
            this.onLog(`[GridBot] Grid: ${this.grid.length} levels, ${this.config.gridSpacingPercent}% spacing`);
            this.onLog(`[GridBot] Take profit at: +${this.config.takeProfitPercent}%`);
        }
        
        this._loop();
        return true;
    }
    
    async stop() {
        this.isRunning = false;
        
        // Sell all positions
        await this._sellAll('stop');
        
        this.onLog(`[GridBot] Stopped. Final profit: ${this.stats.gridProfit.toFixed(2)}%`);
        return this.stats;
    }
    
    _createGrid() {
        this.grid = [];
        const spacing = this.config.gridSpacingPercent / 100;
        
        // Create buy levels BELOW base price
        for (let i = 1; i <= this.config.gridLevels; i++) {
            const triggerPrice = this.basePrice * (1 - spacing * i);
            this.grid.push({
                level: i,
                triggerPrice,
                dropPercent: spacing * i * 100,
                filled: false,
                fillPrice: null,
                fillAmount: null,
            });
            
            this.onLog(`[GridBot] Level ${i}: Buy at ${triggerPrice.toExponential(4)} (-${(spacing * i * 100).toFixed(0)}%)`);
        }
    }
    
    async _loop() {
        while (this.isRunning) {
            try {
                const currentPrice = await getPrice(this.connection, this.tokenMint);
                if (!currentPrice || currentPrice === 0) {
                    await this._delay(this.config.checkIntervalMs);
                    continue;
                }
                
                // If we didn't have basePrice at start, set it now
                if (!this.basePrice) {
                    this.basePrice = currentPrice;
                    this.lastPrice = currentPrice;
                    this._createGrid();
                    this.onLog(`[GridBot] Base price set: ${this.basePrice.toExponential(4)}`);
                    this.onLog(`[GridBot] Grid: ${this.grid.length} levels, ${this.config.gridSpacingPercent}% spacing`);
                }
                
                const priceChangeFromBase = ((currentPrice - this.basePrice) / this.basePrice) * 100;
                
                this.onLog(`[GridBot] Price: ${currentPrice.toExponential(3)} | From base: ${priceChangeFromBase >= 0 ? '+' : ''}${priceChangeFromBase.toFixed(1)}%`);
                
                // Check for emergency stop (massive drop)
                if (priceChangeFromBase <= -this.config.emergencyStopPercent) {
                    this.onLog(`[GridBot] EMERGENCY STOP: Price down ${priceChangeFromBase.toFixed(1)}%`);
                    await this._sellAll('emergency');
                    this.isRunning = false;
                    break;
                }
                
                // Check each grid level
                await this._checkGridLevels(currentPrice);
                
                // Check for profit taking on filled levels
                await this._checkProfitTaking(currentPrice);
                
                this.lastPrice = currentPrice;
                await this._delay(this.config.checkIntervalMs);
                
            } catch (e) {
                this.onLog(`[GridBot] Error: ${e.message}`);
                await this._delay(this.config.checkIntervalMs);
            }
        }
    }
    
    async _checkGridLevels(currentPrice) {
        for (const level of this.grid) {
            // Skip filled levels
            if (level.filled) continue;
            
            // Price dropped to this level - BUY
            if (currentPrice <= level.triggerPrice && this.lastPrice > level.triggerPrice) {
                this.onLog(`[GridBot] Level ${level.level} triggered at -${level.dropPercent.toFixed(0)}%`);
                await this._buyAtLevel(level, currentPrice);
            }
        }
    }
    
    async _checkProfitTaking(currentPrice) {
        for (const level of this.grid) {
            // Skip unfilled levels
            if (!level.filled || !level.fillPrice) continue;
            
            // Calculate profit from fill price
            const profitPercent = ((currentPrice - level.fillPrice) / level.fillPrice) * 100;
            
            // Take profit if target reached
            if (profitPercent >= this.config.takeProfitPercent) {
                this.onLog(`[GridBot] Level ${level.level} profit target hit: +${profitPercent.toFixed(1)}%`);
                await this._sellLevel(level, currentPrice, profitPercent);
            }
        }
    }
    
    async _buyAtLevel(level, price) {
        try {
            // Check if we've invested too much already
            const balance = await this.connection.getBalance(this.wallet.publicKey);
            const totalSOL = balance / LAMPORTS_PER_SOL;
            
            if (this.totalInvested / totalSOL >= this.config.maxTotalInvested) {
                this.onLog(`[GridBot] Max investment reached (${(this.config.maxTotalInvested * 100).toFixed(0)}%)`);
                return;
            }
            
            // Calculate buy amount
            const availableSOL = totalSOL - 0.005; // Gas reserve
            const buyAmount = Math.min(
                availableSOL * this.config.balancePerLevel,
                availableSOL - this.totalInvested
            );
            
            if (buyAmount < 0.005) {
                this.onLog('[GridBot] Buy amount too small');
                return;
            }
            
            this.onLog(`[GridBot] BUYING ${buyAmount.toFixed(4)} SOL at level ${level.level}`);
            
            const tx = await buy(
                this.connection, 
                this.wallet, 
                this.tokenMint, 
                buyAmount, 
                this.config.slippage
            );
            
            level.filled = true;
            level.fillPrice = price;
            level.fillAmount = buyAmount;
            this.totalInvested += buyAmount;
            this.stats.buys++;
            this.stats.levelsHit++;
            
            this.onTrade({ 
                type: 'buy', 
                amount: buyAmount, 
                level: level.level,
                price,
                signature: tx 
            });
            
        } catch (e) {
            this.onLog(`[GridBot] Buy at level ${level.level} failed: ${e.message}`);
        }
    }
    
    async _sellLevel(level, price, profitPercent) {
        try {
            this.onLog(`[GridBot] SELLING level ${level.level} position for +${profitPercent.toFixed(1)}%`);
            
            // Sell all tokens (we track by level but sell everything)
            const tx = await sell(
                this.connection, 
                this.wallet, 
                this.tokenMint, 
                null, // Sell all
                this.config.slippage
            );
            
            // Reset this level for re-entry
            level.filled = false;
            this.totalInvested -= level.fillAmount || 0;
            level.fillPrice = null;
            level.fillAmount = null;
            
            this.stats.sells++;
            this.stats.gridProfit += profitPercent;
            
            this.onTrade({ 
                type: 'sell', 
                level: level.level,
                profit: profitPercent,
                signature: tx 
            });
            
        } catch (e) {
            this.onLog(`[GridBot] Sell level ${level.level} failed: ${e.message}`);
        }
    }
    
    async _sellAll(reason) {
        const filledLevels = this.grid.filter(l => l.filled);
        if (filledLevels.length === 0) return;
        
        this.onLog(`[GridBot] Selling all ${filledLevels.length} positions (${reason})`);
        
        try {
            const tx = await sell(
                this.connection, 
                this.wallet, 
                this.tokenMint, 
                null,
                this.config.slippage
            );
            
            // Reset all levels
            for (const level of this.grid) {
                level.filled = false;
                level.fillPrice = null;
                level.fillAmount = null;
            }
            this.totalInvested = 0;
            this.stats.sells++;
            
            this.onTrade({ type: 'sell', reason, signature: tx });
            
        } catch (e) {
            this.onLog(`[GridBot] Sell all failed: ${e.message}`);
        }
    }
    
    _delay(ms) { return new Promise(r => setTimeout(r, ms)); }
    
    getStatus() {
        const filledLevels = this.grid.filter(g => g.filled).length;
        return { 
            strategy: 'grid',
            ...this.stats, 
            isRunning: this.isRunning,
            basePrice: this.basePrice,
            currentPrice: this.lastPrice,
            filledLevels,
            totalLevels: this.config.gridLevels,
            totalInvested: this.totalInvested,
        };
    }
}

export default GridBot;
