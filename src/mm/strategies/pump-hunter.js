/**
 * PUMP HUNTER STRATEGY - PUMP.FUN SPECIFIC
 * 
 * Designed specifically for pump.fun token dynamics:
 * - Bonding curve phase (pre-migration)
 * - PumpSwap phase (post-migration)
 * 
 * Logic:
 * - During bonding curve: Accumulate on dips
 * - Watch for migration (usually at ~$69k market cap)
 * - After migration: More aggressive selling on pumps
 * - Auto-adjust strategy based on which DEX token is on
 */

import { buy, sell, getPrice, getTokenStatus } from '../../trading/index.js';
import { LAMPORTS_PER_SOL } from '../../constants.js';

export class PumpHunterBot {
    static name = 'Pump Hunter';
    static description = 'Pump.fun optimized: accumulates on bonding curve, aggressive exits on PumpSwap. Auto-detects migration.';
    static difficulty = 'Advanced';
    
    constructor(connection, wallet, tokenMint, config = {}) {
        this.connection = connection;
        this.wallet = wallet;
        this.tokenMint = tokenMint;
        
        this.config = {
            // Bonding curve settings (more conservative)
            bondingBuyDipPercent: config.bondingBuyDipPercent || 10,    // Buy 10% dips
            bondingTradePercent: config.bondingTradePercent || 0.10,    // 10% of balance
            bondingSellPumpPercent: config.bondingSellPumpPercent || 20, // Sell at +20%
            
            // PumpSwap settings (more aggressive - higher liquidity)
            swapBuyDipPercent: config.swapBuyDipPercent || 15,         // Buy 15% dips
            swapTradePercent: config.swapTradePercent || 0.20,         // 20% of balance
            swapSellPumpPercent: config.swapSellPumpPercent || 15,     // Sell at +15%
            
            // Common settings
            stopLossPercent: config.stopLossPercent || 30,             // Stop at -30%
            maxPositionPercent: config.maxPositionPercent || 0.50,     // Max 50% in position
            
            // Timing
            checkIntervalMs: config.checkIntervalMs || 5000,
            priceWindowSize: config.priceWindowSize || 12,
            
            slippage: config.slippage || 0.30,
        };
        
        this.isRunning = false;
        this.currentDex = null; // 'pump' or 'pumpswap'
        this.priceHistory = [];
        this.position = null;
        this.migrationDetected = false;
        this.stats = { 
            buys: 0, 
            sells: 0, 
            wins: 0,
            losses: 0,
            migrationTrades: 0,
        };
        this.onLog = config.onLog || console.log;
        this.onTrade = config.onTrade || (() => {});
    }
    
    async start() {
        this.isRunning = true;
        
        // Detect initial DEX
        const status = await getTokenStatus(this.connection, this.tokenMint);
        if (!status) {
            this.onLog('[PumpHunter] ERROR: Could not get token status');
            return false;
        }
        
        this.currentDex = status.dex;
        
        this.onLog('[PumpHunter] Started - PUMP.FUN OPTIMIZED');
        this.onLog(`[PumpHunter] Current DEX: ${this.currentDex}`);
        this.onLog(`[PumpHunter] Mode: ${this._getMode()}`);
        
        this._loop();
        return true;
    }
    
    async stop() {
        this.isRunning = false;
        
        if (this.position) {
            await this._sell('stop');
        }
        
        this.onLog(`[PumpHunter] Stopped. Migration trades: ${this.stats.migrationTrades}`);
        return this.stats;
    }
    
    _getMode() {
        return this.currentDex === 'pump' ? 'BONDING CURVE' : 'PUMPSWAP';
    }
    
    _getSettings() {
        if (this.currentDex === 'pump') {
            return {
                buyDipPercent: this.config.bondingBuyDipPercent,
                tradePercent: this.config.bondingTradePercent,
                sellPumpPercent: this.config.bondingSellPumpPercent,
            };
        } else {
            return {
                buyDipPercent: this.config.swapBuyDipPercent,
                tradePercent: this.config.swapTradePercent,
                sellPumpPercent: this.config.swapSellPumpPercent,
            };
        }
    }
    
    async _loop() {
        while (this.isRunning) {
            try {
                // Check for migration
                const status = await getTokenStatus(this.connection, this.tokenMint);
                if (status && status.dex !== this.currentDex) {
                    this.onLog(`[PumpHunter] MIGRATION DETECTED: ${this.currentDex} -> ${status.dex}`);
                    this.migrationDetected = true;
                    this.currentDex = status.dex;
                    this.stats.migrationTrades++;
                    
                    // On migration, consider selling position for profit
                    if (this.position) {
                        this.onLog('[PumpHunter] Migration pump - checking position...');
                    }
                }
                
                const currentPrice = await getPrice(this.connection, this.tokenMint);
                if (!currentPrice || currentPrice === 0) {
                    await this._delay(this.config.checkIntervalMs);
                    continue;
                }
                
                this._updatePriceHistory(currentPrice);
                
                if (this.priceHistory.length < 3) {
                    await this._delay(this.config.checkIntervalMs);
                    continue;
                }
                
                const settings = this._getSettings();
                const recentHigh = this._getRecentHigh();
                const recentLow = this._getRecentLow();
                const dropFromHigh = ((recentHigh - currentPrice) / recentHigh) * 100;
                const riseFromLow = ((currentPrice - recentLow) / recentLow) * 100;
                
                this.onLog(`[PumpHunter] [${this._getMode()}] Price: ${currentPrice.toExponential(3)}`);
                this.onLog(`[PumpHunter] Drop: -${dropFromHigh.toFixed(1)}% | Rise: +${riseFromLow.toFixed(1)}%`);
                
                // Position management
                if (this.position) {
                    const pl = ((currentPrice - this.position.entryPrice) / this.position.entryPrice) * 100;
                    this.onLog(`[PumpHunter] Position P/L: ${pl >= 0 ? '+' : ''}${pl.toFixed(1)}%`);
                    
                    // Migration bonus - more aggressive exit
                    const sellTarget = this.migrationDetected && this.currentDex === 'pumpswap' 
                        ? settings.sellPumpPercent * 0.7  // Lower target post-migration
                        : settings.sellPumpPercent;
                    
                    if (pl >= sellTarget) {
                        this.onLog(`[PumpHunter] TAKE PROFIT at +${pl.toFixed(1)}%`);
                        await this._sell('profit', pl);
                    } else if (pl <= -this.config.stopLossPercent) {
                        this.onLog(`[PumpHunter] STOP LOSS at ${pl.toFixed(1)}%`);
                        await this._sell('loss', pl);
                    }
                    // Also exit on massive pump (momentum)
                    else if (riseFromLow >= 30 && pl > 5) {
                        this.onLog(`[PumpHunter] MOMENTUM EXIT on +${riseFromLow.toFixed(1)}% pump`);
                        await this._sell('momentum', pl);
                    }
                } else {
                    // Look for entry on dip
                    if (dropFromHigh >= settings.buyDipPercent) {
                        this.onLog(`[PumpHunter] DIP ENTRY at -${dropFromHigh.toFixed(1)}%`);
                        await this._buy(currentPrice, settings.tradePercent);
                    }
                }
                
                await this._delay(this.config.checkIntervalMs);
                
            } catch (e) {
                this.onLog(`[PumpHunter] Error: ${e.message}`);
                await this._delay(this.config.checkIntervalMs);
            }
        }
    }
    
    async _buy(price, tradePercent) {
        try {
            const balance = await this.connection.getBalance(this.wallet.publicKey);
            const availableSOL = (balance / LAMPORTS_PER_SOL) - 0.005;
            
            // Check position limits
            const currentPosition = this.position ? this.position.amount : 0;
            const totalBalance = availableSOL + currentPosition;
            
            if (currentPosition / totalBalance >= this.config.maxPositionPercent) {
                this.onLog('[PumpHunter] Max position reached');
                return;
            }
            
            const tradeAmount = Math.min(
                availableSOL * tradePercent,
                availableSOL * (this.config.maxPositionPercent - currentPosition / totalBalance)
            );
            
            if (tradeAmount < 0.005) return;
            
            this.onLog(`[PumpHunter] BUYING ${tradeAmount.toFixed(4)} SOL @ ${price.toExponential(4)}`);
            
            const tx = await buy(this.connection, this.wallet, this.tokenMint, tradeAmount, this.config.slippage);
            
            if (this.position) {
                // Average into existing position
                const newTotal = this.position.amount + tradeAmount;
                const newAvg = (this.position.amount * this.position.entryPrice + tradeAmount * price) / newTotal;
                this.position.amount = newTotal;
                this.position.entryPrice = newAvg;
            } else {
                this.position = { amount: tradeAmount, entryPrice: price, dex: this.currentDex };
            }
            
            this.stats.buys++;
            this.onTrade({ type: 'buy', amount: tradeAmount, price, dex: this.currentDex, signature: tx });
            
        } catch (e) {
            this.onLog(`[PumpHunter] Buy failed: ${e.message}`);
        }
    }
    
    async _sell(reason, pl = 0) {
        if (!this.position) return;
        
        try {
            this.onLog(`[PumpHunter] SELLING (${reason}) @ ${pl >= 0 ? '+' : ''}${pl.toFixed(1)}%`);
            
            const tx = await sell(this.connection, this.wallet, this.tokenMint, null, this.config.slippage);
            
            if (pl > 0) this.stats.wins++;
            else if (pl < 0) this.stats.losses++;
            
            this.stats.sells++;
            this.onTrade({ 
                type: 'sell', 
                amount: this.position.amount, 
                reason, 
                profit: pl,
                entryDex: this.position.dex,
                exitDex: this.currentDex,
                signature: tx 
            });
            
            this.position = null;
            this.migrationDetected = false;
            
        } catch (e) {
            this.onLog(`[PumpHunter] Sell failed: ${e.message}`);
        }
    }
    
    _updatePriceHistory(price) {
        this.priceHistory.push({ price, time: Date.now() });
        if (this.priceHistory.length > this.config.priceWindowSize) {
            this.priceHistory.shift();
        }
    }
    
    _getRecentHigh() {
        return Math.max(...this.priceHistory.map(p => p.price));
    }
    
    _getRecentLow() {
        return Math.min(...this.priceHistory.map(p => p.price));
    }
    
    _delay(ms) { return new Promise(r => setTimeout(r, ms)); }
    
    getStatus() {
        return { 
            strategy: 'pump-hunter',
            dex: this.currentDex,
            mode: this._getMode(),
            ...this.stats, 
            isRunning: this.isRunning,
            position: this.position,
            migrationDetected: this.migrationDetected,
            winRate: this.stats.sells > 0 ? ((this.stats.wins / this.stats.sells) * 100).toFixed(1) + '%' : 'N/A',
        };
    }
}

export default PumpHunterBot;


