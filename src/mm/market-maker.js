/**
 * Market Maker Module
 * Automated volume generation for Pump.fun tokens
 */

import { buy, sell, getPrice, getTokenStatus } from '../trading/index.js';
import { checkAllFees, claimAllFees, startAutoClaimScheduler } from '../fees/claim.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { getTokenProgramForMint } from '../utils/pda.js';
import { TOKEN_DECIMALS, LAMPORTS_PER_SOL } from '../constants.js';

// ============================================================================
// VOLUME BOT
// ============================================================================

/**
 * Volume Bot - Creates trading volume through buy/sell cycles
 */
export class VolumeBot {
    constructor(connection, payer, mint, config = {}) {
        this.connection = connection;
        this.payer = payer;
        this.mint = mint;
        
        // Configuration
        this.config = {
            minTradeSOL: config.minTradeSOL || 0.01,
            maxTradeSOL: config.maxTradeSOL || 0.1,
            minDelayMs: config.minDelayMs || 5000,
            maxDelayMs: config.maxDelayMs || 30000,
            slippage: config.slippage || 0.25,
            autoClaimFees: config.autoClaimFees !== false,
            claimIntervalMinutes: config.claimIntervalMinutes || 60,
            targetVolumeSOL: config.targetVolumeSOL || Infinity,
        };
        
        this.isRunning = false;
        this.totalVolume = 0;
        this.trades = [];
        this.autoClaimScheduler = null;
        this.onTrade = config.onTrade || (() => {});
        this.onError = config.onError || console.error;
        this.onStatusUpdate = config.onStatusUpdate || (() => {});
    }
    
    /**
     * Start the volume bot
     */
    async start() {
        if (this.isRunning) {
            console.log(`[VolumeBot] Already running`);
            return;
        }
        
        console.log(`[VolumeBot] Starting volume bot for ${this.mint.toBase58()}`);
        this.isRunning = true;
        
        // Start auto-claim scheduler if enabled
        if (this.config.autoClaimFees) {
            this.autoClaimScheduler = startAutoClaimScheduler(
                this.connection,
                this.payer,
                this.config.claimIntervalMinutes,
                0.01
            );
        }
        
        // Start trading loop
        this._runLoop();
        
        return { status: 'started', mint: this.mint.toBase58() };
    }
    
    /**
     * Stop the volume bot
     */
    stop() {
        console.log(`[VolumeBot] Stopping...`);
        this.isRunning = false;
        
        if (this.autoClaimScheduler) {
            this.autoClaimScheduler.stop();
            this.autoClaimScheduler = null;
        }
        
        return {
            status: 'stopped',
            totalVolume: this.totalVolume,
            totalTrades: this.trades.length,
        };
    }
    
    /**
     * Get bot status
     */
    async getStatus() {
        const tokenStatus = await getTokenStatus(this.connection, this.mint);
        const fees = await checkAllFees(this.connection, this.payer.publicKey);
        const balance = await this.connection.getBalance(this.payer.publicKey);
        
        let tokenBalance = 0;
        try {
            const tokenProgram = await getTokenProgramForMint(this.connection, this.mint);
            const ata = await getAssociatedTokenAddress(this.mint, this.payer.publicKey, false, tokenProgram);
            const balanceInfo = await this.connection.getTokenAccountBalance(ata);
            tokenBalance = parseFloat(balanceInfo.value.uiAmount);
        } catch (e) {
            // No token account yet
        }
        
        return {
            isRunning: this.isRunning,
            mint: this.mint.toBase58(),
            dex: tokenStatus.dex,
            price: tokenStatus.price,
            walletBalanceSOL: balance / LAMPORTS_PER_SOL,
            tokenBalance,
            totalVolume: this.totalVolume,
            totalTrades: this.trades.length,
            claimableFees: fees.totalSOL,
            lastTrade: this.trades[this.trades.length - 1] || null,
        };
    }
    
    /**
     * Main trading loop
     */
    async _runLoop() {
        while (this.isRunning) {
            try {
                // Check if we've reached target volume
                if (this.totalVolume >= this.config.targetVolumeSOL) {
                    console.log(`[VolumeBot] Target volume reached: ${this.totalVolume} SOL`);
                    this.stop();
                    break;
                }
                
                // Random trade amount
                const tradeAmount = this._randomBetween(
                    this.config.minTradeSOL,
                    this.config.maxTradeSOL
                );
                
                // Check wallet balance
                const balance = await this.connection.getBalance(this.payer.publicKey);
                const requiredBalance = (tradeAmount * 1.5) * LAMPORTS_PER_SOL; // Buffer for fees
                
                if (balance < requiredBalance) {
                    console.log(`[VolumeBot] Insufficient balance: ${balance / LAMPORTS_PER_SOL} SOL`);
                    
                    // Try to claim fees
                    await claimAllFees(this.connection, this.payer);
                    
                    // Wait and continue
                    await this._delay(10000);
                    continue;
                }
                
                // Execute buy
                console.log(`[VolumeBot] Buying ${tradeAmount} SOL worth...`);
                const buyTx = await buy(
                    this.connection,
                    this.payer,
                    this.mint,
                    tradeAmount,
                    this.config.slippage
                );
                
                this._recordTrade('buy', tradeAmount, buyTx);
                this.onTrade({ type: 'buy', amount: tradeAmount, signature: buyTx });
                
                // Small delay between buy and sell
                await this._delay(this._randomBetween(1000, 3000));
                
                // Execute sell (all tokens)
                console.log(`[VolumeBot] Selling all tokens...`);
                const sellTx = await sell(
                    this.connection,
                    this.payer,
                    this.mint,
                    null, // Sell all
                    this.config.slippage
                );
                
                this._recordTrade('sell', tradeAmount, sellTx);
                this.onTrade({ type: 'sell', amount: tradeAmount, signature: sellTx });
                
                // Update status
                this.onStatusUpdate(await this.getStatus());
                
                // Random delay before next cycle
                const delay = this._randomBetween(
                    this.config.minDelayMs,
                    this.config.maxDelayMs
                );
                console.log(`[VolumeBot] Waiting ${delay / 1000}s before next trade...`);
                await this._delay(delay);
                
            } catch (error) {
                console.error(`[VolumeBot] Error in trading loop:`, error.message);
                this.onError(error);
                
                // Wait before retrying
                await this._delay(5000);
            }
        }
    }
    
    _recordTrade(type, amount, signature) {
        const trade = {
            type,
            amount,
            signature,
            timestamp: new Date().toISOString(),
        };
        this.trades.push(trade);
        this.totalVolume += amount;
    }
    
    _randomBetween(min, max) {
        return Math.random() * (max - min) + min;
    }
    
    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// ============================================================================
// GRID BOT
// ============================================================================

/**
 * Grid Bot - Places buy/sell orders at price levels
 */
export class GridBot {
    constructor(connection, payer, mint, config = {}) {
        this.connection = connection;
        this.payer = payer;
        this.mint = mint;
        
        this.config = {
            gridLevels: config.gridLevels || 5,
            gridSpacing: config.gridSpacing || 0.05, // 5% between levels
            tradeAmountSOL: config.tradeAmountSOL || 0.01,
            slippage: config.slippage || 0.1,
            checkIntervalMs: config.checkIntervalMs || 5000,
            autoClaimFees: config.autoClaimFees !== false,
        };
        
        this.isRunning = false;
        this.basePrice = null;
        this.gridOrders = [];
        this.executedOrders = [];
        this.onOrder = config.onOrder || (() => {});
        this.onError = config.onError || console.error;
    }
    
    async start() {
        if (this.isRunning) return;
        
        console.log(`[GridBot] Starting for ${this.mint.toBase58()}`);
        this.isRunning = true;
        
        // Get current price as base
        const priceInfo = await getPrice(this.connection, this.mint);
        if (!priceInfo) {
            throw new Error('Could not get price - token may not exist');
        }
        
        this.basePrice = priceInfo.price;
        console.log(`[GridBot] Base price: ${this.basePrice}`);
        
        // Create grid levels
        this._createGridLevels();
        
        // Start monitoring loop
        this._runLoop();
        
        return { status: 'started', basePrice: this.basePrice, levels: this.gridOrders };
    }
    
    stop() {
        this.isRunning = false;
        return {
            status: 'stopped',
            executedOrders: this.executedOrders.length,
        };
    }
    
    _createGridLevels() {
        this.gridOrders = [];
        
        for (let i = 1; i <= this.config.gridLevels; i++) {
            // Buy levels below base price
            const buyPrice = this.basePrice * (1 - this.config.gridSpacing * i);
            this.gridOrders.push({
                type: 'buy',
                price: buyPrice,
                amount: this.config.tradeAmountSOL,
                executed: false,
            });
            
            // Sell levels above base price
            const sellPrice = this.basePrice * (1 + this.config.gridSpacing * i);
            this.gridOrders.push({
                type: 'sell',
                price: sellPrice,
                amount: this.config.tradeAmountSOL,
                executed: false,
            });
        }
        
        console.log(`[GridBot] Created ${this.gridOrders.length} grid orders`);
    }
    
    async _runLoop() {
        while (this.isRunning) {
            try {
                const priceInfo = await getPrice(this.connection, this.mint);
                if (!priceInfo) {
                    await this._delay(this.config.checkIntervalMs);
                    continue;
                }
                
                const currentPrice = priceInfo.price;
                
                // Check grid orders
                for (const order of this.gridOrders) {
                    if (order.executed) continue;
                    
                    const shouldExecute = order.type === 'buy'
                        ? currentPrice <= order.price
                        : currentPrice >= order.price;
                    
                    if (shouldExecute) {
                        console.log(`[GridBot] Executing ${order.type} at ${currentPrice}`);
                        
                        try {
                            if (order.type === 'buy') {
                                await buy(
                                    this.connection,
                                    this.payer,
                                    this.mint,
                                    order.amount,
                                    this.config.slippage
                                );
                            } else {
                                await sell(
                                    this.connection,
                                    this.payer,
                                    this.mint,
                                    null, // Sell proportional amount
                                    this.config.slippage
                                );
                            }
                            
                            order.executed = true;
                            this.executedOrders.push({ ...order, executedAt: Date.now() });
                            this.onOrder(order);
                        } catch (e) {
                            console.error(`[GridBot] Order execution failed:`, e.message);
                        }
                    }
                }
                
                await this._delay(this.config.checkIntervalMs);
                
            } catch (error) {
                console.error(`[GridBot] Error:`, error.message);
                await this._delay(5000);
            }
        }
    }
    
    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// ============================================================================
// SIMPLE MM (Buy Low, Sell High)
// ============================================================================

/**
 * Simple Market Maker - Buys when price drops, sells when price rises
 */
export class SimpleMarketMaker {
    constructor(connection, payer, mint, config = {}) {
        this.connection = connection;
        this.payer = payer;
        this.mint = mint;
        
        this.config = {
            targetProfitPercent: config.targetProfitPercent || 0.05, // 5%
            stopLossPercent: config.stopLossPercent || 0.1, // 10%
            tradeAmountSOL: config.tradeAmountSOL || 0.01,
            slippage: config.slippage || 0.15,
            checkIntervalMs: config.checkIntervalMs || 3000,
        };
        
        this.isRunning = false;
        this.position = null; // { entryPrice, amount, entryTime }
        this.trades = [];
        this.onTrade = config.onTrade || (() => {});
    }
    
    async start() {
        if (this.isRunning) return;
        
        console.log(`[SimpleMM] Starting for ${this.mint.toBase58()}`);
        this.isRunning = true;
        
        this._runLoop();
        
        return { status: 'started' };
    }
    
    stop() {
        this.isRunning = false;
        return { status: 'stopped', trades: this.trades };
    }
    
    async _runLoop() {
        while (this.isRunning) {
            try {
                const priceInfo = await getPrice(this.connection, this.mint);
                if (!priceInfo) {
                    await this._delay(this.config.checkIntervalMs);
                    continue;
                }
                
                const currentPrice = priceInfo.price;
                
                if (this.position) {
                    // We have a position - check for profit/loss
                    const pnlPercent = (currentPrice - this.position.entryPrice) / this.position.entryPrice;
                    
                    if (pnlPercent >= this.config.targetProfitPercent) {
                        // Take profit
                        console.log(`[SimpleMM] Taking profit: ${(pnlPercent * 100).toFixed(2)}%`);
                        await this._closePosition(currentPrice, 'profit');
                    } else if (pnlPercent <= -this.config.stopLossPercent) {
                        // Stop loss
                        console.log(`[SimpleMM] Stop loss: ${(pnlPercent * 100).toFixed(2)}%`);
                        await this._closePosition(currentPrice, 'loss');
                    }
                } else {
                    // No position - check balance and enter
                    const balance = await this.connection.getBalance(this.payer.publicKey);
                    const requiredBalance = this.config.tradeAmountSOL * 1.5 * LAMPORTS_PER_SOL;
                    
                    if (balance >= requiredBalance) {
                        console.log(`[SimpleMM] Opening position at ${currentPrice}`);
                        await this._openPosition(currentPrice);
                    }
                }
                
                await this._delay(this.config.checkIntervalMs);
                
            } catch (error) {
                console.error(`[SimpleMM] Error:`, error.message);
                await this._delay(5000);
            }
        }
    }
    
    async _openPosition(price) {
        try {
            await buy(
                this.connection,
                this.payer,
                this.mint,
                this.config.tradeAmountSOL,
                this.config.slippage
            );
            
            this.position = {
                entryPrice: price,
                amount: this.config.tradeAmountSOL,
                entryTime: Date.now(),
            };
            
            this.onTrade({ type: 'open', price, amount: this.config.tradeAmountSOL });
        } catch (e) {
            console.error(`[SimpleMM] Failed to open position:`, e.message);
        }
    }
    
    async _closePosition(price, reason) {
        try {
            await sell(
                this.connection,
                this.payer,
                this.mint,
                null,
                this.config.slippage
            );
            
            const trade = {
                entryPrice: this.position.entryPrice,
                exitPrice: price,
                amount: this.position.amount,
                reason,
                pnlPercent: (price - this.position.entryPrice) / this.position.entryPrice,
                duration: Date.now() - this.position.entryTime,
            };
            
            this.trades.push(trade);
            this.position = null;
            
            this.onTrade({ type: 'close', ...trade });
        } catch (e) {
            console.error(`[SimpleMM] Failed to close position:`, e.message);
        }
    }
    
    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}


