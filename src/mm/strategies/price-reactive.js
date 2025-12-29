/**
 * PRICE REACTIVE STRATEGY - MEME TOKEN EDITION
 * 
 * Meme tokens on Solana can swing 50%+ in minutes.
 * This strategy is tuned for extreme volatility.
 * 
 * Logic:
 * - Tracks price over short windows (not minutes, SECONDS)
 * - Buys on significant dips (10-20% down)
 * - Sells on pumps (15-30% up) or cuts losses (-25%)
 * - Fast reaction time - meme tokens don't wait
 */

import { buy, sell, getPrice, startPriceTracking, stopPriceTracking } from '../../trading/index.js';
import { LAMPORTS_PER_SOL } from '../../constants.js';

export class PriceReactiveBot {
    static name = 'Price Reactive';
    static description = 'Buys dips (10-20%), sells pumps (15-30%). Tuned for meme token volatility with fast 5-second checks.';
    static difficulty = 'Intermediate';
    
    constructor(connection, wallet, tokenMint, config = {}) {
        this.connection = connection;
        this.wallet = wallet;
        this.tokenMint = tokenMint;
        
        this.config = {
            // MEME TOKEN SETTINGS - Much wider than traditional
            buyDipPercent: config.buyDipPercent || 15,       // Buy when price drops 15%
            sellPumpPercent: config.sellPumpPercent || 20,   // Sell when price rises 20%
            stopLossPercent: config.stopLossPercent || 25,   // Cut losses at -25%
            
            // Trade sizing - percentage of available balance
            tradePercent: config.tradePercent || 0.20,       // Use 20% of balance per trade
            maxPositionPercent: config.maxPositionPercent || 0.50, // Max 50% in position
            
            // Fast timing for meme volatility
            checkIntervalMs: config.checkIntervalMs || 5000,  // Check every 5 seconds!
            priceWindowSize: config.priceWindowSize || 12,    // ~1 minute of data at 5s intervals
            
            // Minimum price movement to consider (filter noise)
            minMovePercent: config.minMovePercent || 2,       // Ignore moves under 2%
            
            slippage: config.slippage || 0.30,               // 30% slippage for meme tokens
        };
        
        this.isRunning = false;
        this.priceHistory = [];
        this.position = null; // { solAmount, entryPrice, tokens }
        this.tracker = null; // Real-time price tracker
        this.stats = { 
            buys: 0, 
            sells: 0, 
            wins: 0,
            losses: 0,
            totalProfit: 0,
            biggestWin: 0,
            biggestLoss: 0,
        };
        this.onLog = config.onLog || console.log;
        this.onTrade = config.onTrade || (() => {});
    }
    
    async start() {
        this.isRunning = true;
        this.onLog('[PriceReactive] Started - MEME MODE with REAL-TIME TRACKING');
        this.onLog(`[PriceReactive] Buy dips: -${this.config.buyDipPercent}% | Sell pumps: +${this.config.sellPumpPercent}%`);
        this.onLog(`[PriceReactive] Stop loss: -${this.config.stopLossPercent}%`);
        
        // Start real-time price tracking via WebSocket
        try {
            this.tracker = await startPriceTracking(this.connection, this.tokenMint, (update) => {
                // Real-time price update callback
                this._onRealtimePrice(update);
            });
            this.onLog('[PriceReactive] WebSocket price tracking ACTIVE');
        } catch (e) {
            this.onLog(`[PriceReactive] WebSocket failed, using polling: ${e.message}`);
        }
        
        // Try to get initial price (but don't fail if it doesn't work)
        let initialPrice = null;
        for (let i = 0; i < 3; i++) {
            initialPrice = await getPrice(this.connection, this.tokenMint);
            if (initialPrice && initialPrice > 0) break;
            this.onLog(`[PriceReactive] Price fetch attempt ${i + 1}/3...`);
            await this._delay(2000);
        }
        
        if (initialPrice && initialPrice > 0) {
            this.priceHistory.push({ price: initialPrice, time: Date.now() });
            this.onLog(`[PriceReactive] Initial price: ${initialPrice.toExponential(4)}`);
        } else {
            this.onLog('[PriceReactive] Could not get initial price, will retry in loop...');
        }
        
        this._loop();
        return true;
    }
    
    /**
     * Handle real-time price updates from WebSocket
     */
    _onRealtimePrice(update) {
        // Add to history immediately (sub-second updates)
        this._updatePriceHistory(update.price);
        
        // Log significant moves
        if (Math.abs(update.change) >= 1) {
            this.onLog(`[PriceReactive] REAL-TIME: ${update.change >= 0 ? '+' : ''}${update.change.toFixed(2)}% (${update.source})`);
        }
    }
    
    async stop() {
        this.isRunning = false;
        
        // Stop price tracking
        stopPriceTracking(this.tokenMint);
        
        // Close any open position
        if (this.position) {
            this.onLog('[PriceReactive] Closing position on stop...');
            await this._sell('stop');
        }
        
        this.onLog(`[PriceReactive] Final stats: ${this.stats.wins} wins, ${this.stats.losses} losses`);
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
                
                // Need at least 3 data points
                if (this.priceHistory.length < 3) {
                    await this._delay(this.config.checkIntervalMs);
                    continue;
                }
                
                const recentHigh = this._getRecentHigh();
                const recentLow = this._getRecentLow();
                const avgPrice = this._getAveragePrice();
                
                // Calculate price movements
                const dropFromHigh = ((recentHigh - currentPrice) / recentHigh) * 100;
                const riseFromLow = ((currentPrice - recentLow) / recentLow) * 100;
                const changeFromAvg = ((currentPrice - avgPrice) / avgPrice) * 100;
                
                // Log current state
                this.onLog(`[PriceReactive] Price: ${currentPrice.toExponential(3)} | High: ${recentHigh.toExponential(3)} | Low: ${recentLow.toExponential(3)}`);
                this.onLog(`[PriceReactive] Drop: -${dropFromHigh.toFixed(1)}% | Rise: +${riseFromLow.toFixed(1)}%`);
                
                // === NO POSITION - Look for buy ===
                if (!this.position) {
                    // BUY on significant dip from recent high
                    if (dropFromHigh >= this.config.buyDipPercent) {
                        this.onLog(`[PriceReactive] DIP DETECTED: -${dropFromHigh.toFixed(1)}% from high`);
                        await this._buy(currentPrice);
                    }
                }
                // === HAVE POSITION - Look for exit ===
                else {
                    const positionChange = ((currentPrice - this.position.entryPrice) / this.position.entryPrice) * 100;
                    this.onLog(`[PriceReactive] Position P/L: ${positionChange >= 0 ? '+' : ''}${positionChange.toFixed(1)}%`);
                    
                    // TAKE PROFIT
                    if (positionChange >= this.config.sellPumpPercent) {
                        this.onLog(`[PriceReactive] TAKE PROFIT: +${positionChange.toFixed(1)}%`);
                        await this._sell('profit', positionChange);
                    }
                    // STOP LOSS
                    else if (positionChange <= -this.config.stopLossPercent) {
                        this.onLog(`[PriceReactive] STOP LOSS: ${positionChange.toFixed(1)}%`);
                        await this._sell('loss', positionChange);
                    }
                    // Also sell if price is pumping hard from recent low (momentum exit)
                    else if (riseFromLow >= this.config.sellPumpPercent * 1.5 && positionChange > 0) {
                        this.onLog(`[PriceReactive] MOMENTUM EXIT: +${riseFromLow.toFixed(1)}% pump`);
                        await this._sell('momentum', positionChange);
                    }
                }
                
                await this._delay(this.config.checkIntervalMs);
                
            } catch (e) {
                this.onLog(`[PriceReactive] Error: ${e.message}`);
                await this._delay(this.config.checkIntervalMs);
            }
        }
    }
    
    async _buy(price) {
        try {
            // Get balance
            const balance = await this.connection.getBalance(this.wallet.publicKey);
            const availableSOL = (balance / LAMPORTS_PER_SOL) - 0.005; // Keep gas reserve
            
            if (availableSOL <= 0.01) {
                this.onLog('[PriceReactive] Insufficient balance for buy');
                return;
            }
            
            // Calculate trade size
            const tradeAmount = Math.min(
                availableSOL * this.config.tradePercent,
                availableSOL * this.config.maxPositionPercent
            );
            
            if (tradeAmount < 0.005) {
                this.onLog('[PriceReactive] Trade amount too small');
                return;
            }
            
            this.onLog(`[PriceReactive] BUYING ${tradeAmount.toFixed(4)} SOL @ ${price.toExponential(4)}`);
            
            const tx = await buy(this.connection, this.wallet, this.tokenMint, tradeAmount, this.config.slippage);
            
            this.position = { 
                solAmount: tradeAmount, 
                entryPrice: price, 
                time: Date.now() 
            };
            this.stats.buys++;
            
            this.onTrade({ type: 'buy', amount: tradeAmount, price, signature: tx });
            
        } catch (e) {
            this.onLog(`[PriceReactive] Buy failed: ${e.message}`);
        }
    }
    
    async _sell(reason, percentChange = 0) {
        if (!this.position) return;
        
        try {
            this.onLog(`[PriceReactive] SELLING (${reason}) position of ${this.position.solAmount.toFixed(4)} SOL`);
            
            const tx = await sell(this.connection, this.wallet, this.tokenMint, null, this.config.slippage);
            
            // Track stats
            this.stats.sells++;
            if (percentChange > 0) {
                this.stats.wins++;
                this.stats.totalProfit += percentChange;
                if (percentChange > this.stats.biggestWin) this.stats.biggestWin = percentChange;
            } else if (percentChange < 0) {
                this.stats.losses++;
                this.stats.totalProfit += percentChange;
                if (percentChange < this.stats.biggestLoss) this.stats.biggestLoss = percentChange;
            }
            
            this.onTrade({ 
                type: 'sell', 
                amount: this.position.solAmount, 
                reason,
                profit: percentChange,
                signature: tx 
            });
            
            this.position = null;
            
        } catch (e) {
            this.onLog(`[PriceReactive] Sell failed: ${e.message}`);
        }
    }
    
    _updatePriceHistory(price) {
        this.priceHistory.push({ price, time: Date.now() });
        if (this.priceHistory.length > this.config.priceWindowSize) {
            this.priceHistory.shift();
        }
    }
    
    _getAveragePrice() {
        if (this.priceHistory.length === 0) return 0;
        return this.priceHistory.reduce((acc, p) => acc + p.price, 0) / this.priceHistory.length;
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
            strategy: 'price-reactive',
            ...this.stats, 
            isRunning: this.isRunning,
            position: this.position,
            winRate: this.stats.sells > 0 ? ((this.stats.wins / this.stats.sells) * 100).toFixed(1) + '%' : 'N/A',
        };
    }
}

export default PriceReactiveBot;
