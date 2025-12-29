/**
 * Production Volume Bot V2
 * 
 * Uses FundManager for intelligent fund handling
 * Handles all edge cases for production use
 */

import { buy, sell, getPrice, getTokenStatus } from '../trading/index.js';
import { FundManager } from './fund-manager.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { getTokenProgramForMint } from '../utils/pda.js';
import { LAMPORTS_PER_SOL } from '../constants.js';

// ============================================================================
// VOLUME BOT V2
// ============================================================================

export class VolumeBotV2 {
    constructor(connection, payer, mint, config = {}) {
        this.connection = connection;
        this.payer = payer;
        this.mint = mint;
        this.botId = `volume-${Date.now()}`;
        
        // Initialize Fund Manager
        this.fundManager = new FundManager(connection, payer, {
            thresholds: config.fundManagerThresholds || {},
            onBalanceUpdate: (data) => this._handleBalanceUpdate(data),
            onFeeClaimed: (data) => this._handleFeeClaimed(data),
            onCircuitBreaker: (data) => this._handleCircuitBreaker(data),
            onWarning: (msg) => this._log('warn', msg),
            onError: (msg) => this._log('error', msg),
        });
        
        // Configuration
        this.config = {
            // Trade timing
            minDelayMs: config.minDelayMs || 5000,
            maxDelayMs: config.maxDelayMs || 30000,
            delayBetweenBuySellMs: config.delayBetweenBuySellMs || 2000,
            
            // Slippage
            slippage: config.slippage || 0.25,
            maxSlippage: config.maxSlippage || 0.5,
            
            // Volume targets
            targetVolumeSOL: config.targetVolumeSOL || Infinity,
            targetTradesCount: config.targetTradesCount || Infinity,
            maxRunTimeMs: config.maxRunTimeMs || Infinity,
            
            // Behavior
            sellAllTokens: config.sellAllTokens !== false, // Default: sell all after each buy
            retryFailedTrades: config.retryFailedTrades !== false,
            maxRetries: config.maxRetries || 3,
            
            // Trading windows (optional)
            tradingStartHour: config.tradingStartHour || 0,  // 0-23
            tradingEndHour: config.tradingEndHour || 24,     // 0-24
        };
        
        // State
        this.state = {
            isRunning: false,
            isPaused: false,
            startTime: null,
            
            // Counters
            totalVolume: 0,
            totalTrades: 0,
            buyTrades: 0,
            sellTrades: 0,
            
            // Current cycle
            currentCycle: 0,
            lastBuyPrice: null,
            lastSellPrice: null,
            tokensHeld: 0,
            
            // Errors
            lastError: null,
            totalErrors: 0,
        };
        
        // Trade history
        this.trades = [];
        
        // Callbacks
        this.callbacks = {
            onTrade: config.onTrade || (() => {}),
            onCycle: config.onCycle || (() => {}),
            onError: config.onError || (() => {}),
            onStatusUpdate: config.onStatusUpdate || (() => {}),
            onStop: config.onStop || (() => {}),
            onLog: config.onLog || ((level, msg) => console.log(`[${level.toUpperCase()}] ${msg}`)),
        };
    }
    
    // ========================================================================
    // LIFECYCLE
    // ========================================================================
    
    /**
     * Start the volume bot
     */
    async start() {
        if (this.state.isRunning) {
            this._log('warn', 'Bot already running');
            return { success: false, reason: 'Already running' };
        }
        
        this._log('info', `Starting Volume Bot for ${this.mint.toBase58()}`);
        
        try {
            // Initialize fund manager
            await this.fundManager.initialize();
            
            // Check initial state
            const tokenStatus = await getTokenStatus(this.connection, this.mint);
            if (!tokenStatus) {
                throw new Error('Could not get token status - token may not exist');
            }
            
            this._log('info', `Token on ${tokenStatus.dex}, price: ${tokenStatus.price}`);
            
            // Check if we can trade
            const tradeCheck = this.fundManager.calculateTradeSize();
            if (!tradeCheck.canTrade) {
                throw new Error(`Cannot start: ${tradeCheck.reason}`);
            }
            
            // Start
            this.state.isRunning = true;
            this.state.startTime = Date.now();
            
            // Run main loop
            this._runLoop();
            
            return {
                success: true,
                botId: this.botId,
                status: await this.getStatus(),
            };
            
        } catch (error) {
            this._log('error', `Failed to start: ${error.message}`);
            return { success: false, reason: error.message };
        }
    }
    
    /**
     * Stop the volume bot
     */
    async stop(reason = 'Manual stop') {
        this._log('info', `Stopping: ${reason}`);
        this.state.isRunning = false;
        
        // Sell any remaining tokens
        if (this.state.tokensHeld > 0) {
            this._log('info', 'Selling remaining tokens before stop...');
            try {
                await this._executeSell();
            } catch (e) {
                this._log('warn', `Could not sell remaining tokens: ${e.message}`);
            }
        }
        
        // Shutdown fund manager
        await this.fundManager.shutdown();
        
        const finalStatus = await this.getStatus();
        this.callbacks.onStop(finalStatus);
        
        return finalStatus;
    }
    
    /**
     * Pause trading (but keep monitoring)
     */
    pause() {
        this.state.isPaused = true;
        this._log('info', 'Bot paused');
    }
    
    /**
     * Resume trading
     */
    resume() {
        this.state.isPaused = false;
        this._log('info', 'Bot resumed');
    }
    
    // ========================================================================
    // MAIN LOOP
    // ========================================================================
    
    async _runLoop() {
        while (this.state.isRunning) {
            try {
                // Check if paused
                if (this.state.isPaused) {
                    await this._delay(5000);
                    continue;
                }
                
                // Check circuit breaker
                if (this.fundManager.circuitBreaker.isTripped) {
                    this._log('warn', 'Circuit breaker active, waiting...');
                    await this._delay(30000);
                    continue;
                }
                
                // Check runtime limit
                if (this._checkRuntimeLimit()) {
                    await this.stop('Runtime limit reached');
                    break;
                }
                
                // Check volume/trade limits
                if (this._checkLimits()) {
                    await this.stop('Target reached');
                    break;
                }
                
                // Check trading hours
                if (!this._isWithinTradingHours()) {
                    this._log('info', 'Outside trading hours, waiting...');
                    await this._delay(60000);
                    continue;
                }
                
                // Get trade size from fund manager
                const tradeSize = this.fundManager.calculateTradeRange();
                
                if (!tradeSize) {
                    this._log('warn', 'Insufficient funds, waiting for fees...');
                    await this.fundManager.checkAndClaimFees(true);
                    await this._delay(30000);
                    continue;
                }
                
                // Calculate random trade amount within range
                const tradeAmount = this._randomBetween(tradeSize.min, tradeSize.max);
                
                // Execute buy-sell cycle
                await this._executeCycle(tradeAmount);
                
                // Random delay before next cycle
                const delay = this._randomBetween(
                    this.config.minDelayMs,
                    this.config.maxDelayMs
                );
                this._log('info', `Next cycle in ${(delay / 1000).toFixed(1)}s`);
                await this._delay(delay);
                
            } catch (error) {
                this.state.totalErrors++;
                this.state.lastError = error.message;
                this._log('error', `Loop error: ${error.message}`);
                this.callbacks.onError(error);
                
                // Exponential backoff
                const backoff = Math.min(60000, 5000 * Math.pow(2, Math.min(this.state.totalErrors, 5)));
                await this._delay(backoff);
            }
        }
    }
    
    // ========================================================================
    // TRADING CYCLE
    // ========================================================================
    
    async _executeCycle(amountSOL) {
        this.state.currentCycle++;
        this._log('info', `=== Cycle ${this.state.currentCycle} | Trade: ${amountSOL.toFixed(4)} SOL ===`);
        
        const cycleStart = Date.now();
        let buyResult = null;
        let sellResult = null;
        
        try {
            // === BUY ===
            buyResult = await this._executeBuy(amountSOL);
            
            if (!buyResult.success) {
                this._log('error', `Buy failed: ${buyResult.error}`);
                const errorType = this._classifyError(buyResult.error);
                this.fundManager.recordTradeResult(false, 0, errorType);
                return;
            }
            
            // Wait between buy and sell
            await this._delay(this.config.delayBetweenBuySellMs);
            
            // === SELL ===
            if (this.config.sellAllTokens) {
                sellResult = await this._executeSell();
                
                if (!sellResult.success) {
                    this._log('error', `Sell failed: ${sellResult.error}`);
                    // Don't record as hard failure since we still have tokens
                    // They can be sold later
                }
            }
            
            // Record success
            this.fundManager.recordTradeResult(true);
            
            // Update stats
            this.state.totalVolume += amountSOL * 2; // Buy + Sell
            
            // Notify
            this.callbacks.onCycle({
                cycle: this.state.currentCycle,
                buy: buyResult,
                sell: sellResult,
                duration: Date.now() - cycleStart,
            });
            
            this.callbacks.onStatusUpdate(await this.getStatus());
            
        } catch (error) {
            this._log('error', `Cycle error: ${error.message}`);
            const errorType = this._classifyError(error.message);
            this.fundManager.recordTradeResult(false, 0, errorType);
        }
    }
    
    /**
     * Classify error type for smart circuit breaker handling
     */
    _classifyError(errorMessage) {
        const msg = (errorMessage || '').toLowerCase();
        
        if (msg.includes('timeout') || msg.includes('network') || msg.includes('connection') || 
            msg.includes('econnrefused') || msg.includes('503') || msg.includes('502') ||
            msg.includes('rate limit') || msg.includes('429')) {
            return 'network';
        }
        
        if (msg.includes('slippage') || msg.includes('price') || msg.includes('amount')) {
            return 'slippage';
        }
        
        if (msg.includes('insufficient') || msg.includes('not enough') || msg.includes('balance')) {
            return 'insufficient';
        }
        
        return 'unknown';
    }
    
    /**
     * Execute buy with retries
     */
    async _executeBuy(amountSOL) {
        let lastError = null;
        
        for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
            try {
                this._log('info', `BUY ${amountSOL.toFixed(4)} SOL (attempt ${attempt})`);
                
                // Get current price for slippage check
                const preBuyPrice = await getPrice(this.connection, this.mint);
                
                // Execute buy
                const signature = await buy(
                    this.connection,
                    this.payer,
                    this.mint,
                    amountSOL,
                    this.config.slippage
                );
                
                // Get post-buy balance
                const tokenBalance = await this._getTokenBalance();
                
                // Record trade
                const trade = {
                    type: 'buy',
                    amount: amountSOL,
                    signature,
                    price: preBuyPrice?.price,
                    timestamp: Date.now(),
                    cycle: this.state.currentCycle,
                };
                
                this.trades.push(trade);
                this.state.buyTrades++;
                this.state.totalTrades++;
                this.state.lastBuyPrice = preBuyPrice?.price;
                this.state.tokensHeld = tokenBalance;
                
                this.callbacks.onTrade(trade);
                
                this._log('info', `✅ BUY success: ${signature.slice(0, 20)}...`);
                
                return { success: true, signature, trade };
                
            } catch (error) {
                lastError = error;
                this._log('warn', `Buy attempt ${attempt} failed: ${error.message}`);
                
                if (attempt < this.config.maxRetries) {
                    await this._delay(2000 * attempt);
                }
            }
        }
        
        return { success: false, error: lastError.message };
    }
    
    /**
     * Execute sell with retries
     */
    async _executeSell(tokenAmount = null) {
        let lastError = null;
        
        for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
            try {
                this._log('info', `SELL ${tokenAmount ? tokenAmount : 'ALL'} tokens (attempt ${attempt})`);
                
                // Get current price
                const preSellPrice = await getPrice(this.connection, this.mint);
                
                // Execute sell
                const signature = await sell(
                    this.connection,
                    this.payer,
                    this.mint,
                    tokenAmount, // null = sell all
                    this.config.slippage
                );
                
                // Record trade
                const trade = {
                    type: 'sell',
                    amount: this.state.tokensHeld,
                    signature,
                    price: preSellPrice?.price,
                    timestamp: Date.now(),
                    cycle: this.state.currentCycle,
                };
                
                this.trades.push(trade);
                this.state.sellTrades++;
                this.state.totalTrades++;
                this.state.lastSellPrice = preSellPrice?.price;
                this.state.tokensHeld = 0;
                
                this.callbacks.onTrade(trade);
                
                this._log('info', `✅ SELL success: ${signature.slice(0, 20)}...`);
                
                return { success: true, signature, trade };
                
            } catch (error) {
                lastError = error;
                this._log('warn', `Sell attempt ${attempt} failed: ${error.message}`);
                
                if (attempt < this.config.maxRetries) {
                    await this._delay(2000 * attempt);
                }
            }
        }
        
        return { success: false, error: lastError.message };
    }
    
    // ========================================================================
    // HELPERS
    // ========================================================================
    
    async _getTokenBalance() {
        try {
            const tokenProgram = await getTokenProgramForMint(this.connection, this.mint);
            const ata = await getAssociatedTokenAddress(
                this.mint,
                this.payer.publicKey,
                false,
                tokenProgram
            );
            const balanceInfo = await this.connection.getTokenAccountBalance(ata);
            return parseFloat(balanceInfo.value.uiAmount) || 0;
        } catch (e) {
            return 0;
        }
    }
    
    _checkRuntimeLimit() {
        if (this.config.maxRunTimeMs === Infinity) return false;
        return Date.now() - this.state.startTime >= this.config.maxRunTimeMs;
    }
    
    _checkLimits() {
        if (this.state.totalVolume >= this.config.targetVolumeSOL) {
            this._log('info', `Volume target reached: ${this.state.totalVolume} SOL`);
            return true;
        }
        if (this.state.currentCycle >= this.config.targetTradesCount) {
            this._log('info', `Trade count target reached: ${this.state.currentCycle}`);
            return true;
        }
        return false;
    }
    
    _isWithinTradingHours() {
        const hour = new Date().getUTCHours();
        if (this.config.tradingStartHour <= this.config.tradingEndHour) {
            return hour >= this.config.tradingStartHour && hour < this.config.tradingEndHour;
        } else {
            // Wraps around midnight
            return hour >= this.config.tradingStartHour || hour < this.config.tradingEndHour;
        }
    }
    
    _randomBetween(min, max) {
        return Math.random() * (max - min) + min;
    }
    
    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    _log(level, message) {
        const prefix = `[VolumeBot:${this.botId.slice(-6)}]`;
        this.callbacks.onLog(level, `${prefix} ${message}`);
    }
    
    // Fund manager callbacks
    _handleBalanceUpdate(data) {
        this._log('info', `Balance: ${data.balance.toFixed(4)} SOL (available: ${data.available.toFixed(4)})`);
    }
    
    _handleFeeClaimed(data) {
        this._log('info', `💰 Fees claimed: ${data.amount.toFixed(4)} SOL (total: ${data.total.toFixed(4)})`);
    }
    
    _handleCircuitBreaker(data) {
        this._log('error', `🚨 Circuit breaker: ${data.reason}`);
        this.callbacks.onError(new Error(`Circuit breaker: ${data.reason}`));
    }
    
    // ========================================================================
    // STATUS
    // ========================================================================
    
    async getStatus() {
        const fundStatus = this.fundManager.getStatus();
        const tokenStatus = await getTokenStatus(this.connection, this.mint).catch(() => null);
        
        const runtime = this.state.startTime ? Date.now() - this.state.startTime : 0;
        const volumePerHour = runtime > 0 ? (this.state.totalVolume / runtime * 3600000) : 0;
        
        return {
            botId: this.botId,
            mint: this.mint.toBase58(),
            
            // State
            isRunning: this.state.isRunning,
            isPaused: this.state.isPaused,
            runtime,
            runtimeHuman: this._formatDuration(runtime),
            
            // Token
            token: tokenStatus,
            tokensHeld: this.state.tokensHeld,
            
            // Trading
            currentCycle: this.state.currentCycle,
            totalTrades: this.state.totalTrades,
            buyTrades: this.state.buyTrades,
            sellTrades: this.state.sellTrades,
            totalVolume: this.state.totalVolume,
            volumePerHour,
            
            // Last prices
            lastBuyPrice: this.state.lastBuyPrice,
            lastSellPrice: this.state.lastSellPrice,
            
            // Errors
            totalErrors: this.state.totalErrors,
            lastError: this.state.lastError,
            
            // Fund Manager
            funds: fundStatus,
            
            // Recent trades
            recentTrades: this.trades.slice(-10),
        };
    }
    
    _formatDuration(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        
        if (days > 0) return `${days}d ${hours % 24}h`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m`;
        return `${seconds}s`;
    }
}

export default VolumeBotV2;

