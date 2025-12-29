/**
 * Token Market Maker
 * 
 * ONE user = ONE token = ONE wallet = ONE market maker
 * 
 * Flow:
 * 1. User creates wallet & funds it
 * 2. User creates token (becomes creator, receives fees)
 * 3. MM uses wallet funds to buy/sell the token
 * 4. MM auto-claims creator fees every 4 hours
 * 5. MM uses claimed fees to continue trading
 * 6. Runs forever, self-sustaining
 */

import { buy, sell, getPrice, getTokenStatus } from '../trading/index.js';
import { checkAllFees, claimAllFees } from '../fees/claim.js';
import { LAMPORTS_PER_SOL } from '../constants.js';

// ============================================================================
// TOKEN MARKET MAKER
// ============================================================================

export class TokenMarketMaker {
    constructor(connection, wallet, tokenMint, config = {}) {
        this.connection = connection;
        this.wallet = wallet;           // Keypair - wallet that CREATED the token
        this.tokenMint = tokenMint;     // PublicKey - the token this wallet created
        
        // Configuration
        this.config = {
            // Trade sizing (as % of available balance)
            tradePercentMin: config.tradePercentMin || 0.15,  // 15% min
            tradePercentMax: config.tradePercentMax || 0.30,  // 30% max
            
            // Or fixed amounts (if set, overrides percent)
            fixedTradeMin: config.fixedTradeMin || null,      // e.g., 0.05 SOL
            fixedTradeMax: config.fixedTradeMax || null,      // e.g., 0.2 SOL
            
            // Timing
            minDelayMs: config.minDelayMs || 3000,            // 3 sec min between cycles
            maxDelayMs: config.maxDelayMs || 15000,           // 15 sec max
            
            // Fee claiming - every 4 hours
            feeClaimIntervalMs: config.feeClaimIntervalMs || 4 * 60 * 60 * 1000,
            
            // Safety
            minBalanceSOL: config.minBalanceSOL || 0.005,     // Keep for gas
            slippage: config.slippage || 0.25,                // 25% slippage tolerance
            
            // Retries
            maxRetries: config.maxRetries || 3,
        };
        
        // State
        this.isRunning = false;
        this.lastBuyAmount = 0; // Track last buy for sell reporting
        this.stats = {
            startTime: null,
            totalVolume: 0,
            totalCycles: 0,
            totalFeesClaimed: 0,
            lastFeeClaim: null,
            lastTrade: null,
            errors: 0,
        };
        
        // Callbacks
        this.onLog = config.onLog || ((msg) => console.log(`[MM] ${msg}`));
        this.onTrade = config.onTrade || (() => {});
        this.onFeeClaim = config.onFeeClaim || (() => {});
        this.onError = config.onError || ((err) => console.error(`[MM] Error: ${err}`));
    }
    
    // ========================================================================
    // MAIN CONTROL
    // ========================================================================
    
    async start() {
        if (this.isRunning) {
            this.onLog('Already running');
            return false;
        }
        
        this.onLog(`Starting Market Maker for token ${this.tokenMint.toBase58()}`);
        this.onLog(`Wallet: ${this.wallet.publicKey.toBase58()}`);
        
        // Check initial balance
        const balance = await this._getBalance();
        if (balance < this.config.minBalanceSOL) {
            this.onError(`Insufficient balance: ${balance} SOL`);
            return false;
        }
        
        this.onLog(`Initial balance: ${balance.toFixed(4)} SOL`);
        
        // Check token exists
        const tokenStatus = await getTokenStatus(this.connection, this.tokenMint);
        if (!tokenStatus) {
            this.onError('Token not found');
            return false;
        }
        
        this.onLog(`Token on ${tokenStatus.dex}, price: ${tokenStatus.price}`);
        
        // Start
        this.isRunning = true;
        this.stats.startTime = Date.now();
        
        // Start the main loop
        this._runMainLoop();
        
        // Start fee claim scheduler (every 4 hours)
        this._startFeeClaimScheduler();
        
        return true;
    }
    
    async stop() {
        this.onLog('Stopping...');
        this.isRunning = false;
        
        // Clear fee claim scheduler
        if (this.feeClaimInterval) {
            clearInterval(this.feeClaimInterval);
            this.feeClaimInterval = null;
        }
        
        // Final fee claim
        await this._claimFees();
        
        // Sell any remaining tokens (use last buy amount for reporting)
        await this._sellAll(this.lastBuyAmount);
        
        return this.getStatus();
    }
    
    // ========================================================================
    // MAIN TRADING LOOP
    // ========================================================================
    
    async _runMainLoop() {
        while (this.isRunning) {
            try {
                // Get current balance
                this.onLog(`📊 Checking balance...`, 'status');
                const balance = await this._getBalance();
                const available = balance - this.config.minBalanceSOL;
                
                if (available <= 0) {
                    this.onLog(`⚠️ Low balance (${balance.toFixed(4)} SOL), waiting for fees...`, 'warning');
                    await this._delayWithCountdown(60000, 'Waiting for funds');
                    continue;
                }
                
                this.onLog(`💰 Balance: ${balance.toFixed(4)} SOL (Available: ${available.toFixed(4)} SOL)`, 'status');
                
                // Calculate trade amount
                let tradeAmount;
                
                if (this.config.fixedTradeMin && this.config.fixedTradeMax) {
                    // Use fixed amounts
                    tradeAmount = this._random(this.config.fixedTradeMin, this.config.fixedTradeMax);
                    // Cap at available
                    tradeAmount = Math.min(tradeAmount, available * 0.9);
                } else {
                    // Use percentage of available balance
                    const percent = this._random(this.config.tradePercentMin, this.config.tradePercentMax);
                    tradeAmount = available * percent;
                }
                
                // Ensure minimum trade
                tradeAmount = Math.max(0.005, tradeAmount);
                
                // Execute buy/sell cycle
                await this._executeCycle(tradeAmount);
                
                // Random delay with countdown
                const delay = this._random(this.config.minDelayMs, this.config.maxDelayMs);
                await this._delayWithCountdown(delay, 'Next trade');
                
            } catch (error) {
                this.stats.errors++;
                this.onError(error.message);
                await this._delayWithCountdown(10000, 'Cooldown after error');
            }
        }
    }
    
    async _executeCycle(amountSOL) {
        const cycleNum = this.stats.totalCycles + 1;
        this.onLog(`🔄 ═══ CYCLE ${cycleNum} START ═══`, 'cycle');
        this.onLog(`📈 Trade size: ${amountSOL.toFixed(4)} SOL`, 'status');
        
        // Store the buy amount for the sell report
        this.lastBuyAmount = amountSOL;
        
        // BUY
        const buyStart = Date.now();
        this.onLog(`🟢 Preparing BUY transaction...`, 'buy');
        const buySuccess = await this._buy(amountSOL);
        const buyDuration = ((Date.now() - buyStart) / 1000).toFixed(1);
        
        if (!buySuccess) {
            this.onLog(`❌ BUY failed after ${buyDuration}s`, 'error');
            return;
        }
        this.onLog(`✅ BUY completed in ${buyDuration}s`, 'buy');
        
        // Small delay with countdown
        await this._delayWithCountdown(2000, 'Hold before sell');
        
        // SELL ALL (pass the buy amount for reporting)
        const sellStart = Date.now();
        this.onLog(`🔴 Preparing SELL transaction...`, 'sell');
        const sellSuccess = await this._sellAll(amountSOL);
        const sellDuration = ((Date.now() - sellStart) / 1000).toFixed(1);
        
        if (!sellSuccess) {
            this.onLog(`❌ SELL failed after ${sellDuration}s`, 'error');
            return;
        }
        this.onLog(`✅ SELL completed in ${sellDuration}s`, 'sell');
        
        // Update stats
        this.stats.totalCycles++;
        this.stats.totalVolume += amountSOL * 2; // Buy + Sell
        this.stats.lastTrade = Date.now();
        
        this.onLog(`🔄 ═══ CYCLE ${cycleNum} COMPLETE ═══`, 'cycle');
        this.onLog(`📊 Total cycles: ${this.stats.totalCycles} | Volume: ${this.stats.totalVolume.toFixed(2)} SOL`, 'status');
    }
    
    // ========================================================================
    // TRADING
    // ========================================================================
    
    async _buy(amountSOL) {
        for (let i = 0; i < this.config.maxRetries; i++) {
            try {
                const attempt = i + 1;
                this.onLog(`🟢 BUY ${amountSOL.toFixed(4)} SOL (attempt ${attempt}/${this.config.maxRetries})`, 'buy');
                
                // Get current price before trade
                let priceInfo = null;
                try {
                    priceInfo = await getPrice(this.connection, this.tokenMint);
                    if (priceInfo) {
                        this.onLog(`📈 Current price: ${priceInfo.toExponential(4)} SOL`, 'status');
                    }
                } catch (e) {}
                
                this.onLog(`⏳ Sending BUY transaction...`, 'buy');
                const txStart = Date.now();
                
                const signature = await buy(
                    this.connection,
                    this.wallet,
                    this.tokenMint,
                    amountSOL,
                    this.config.slippage
                );
                
                const txTime = ((Date.now() - txStart) / 1000).toFixed(1);
                this.onLog(`✅ BUY confirmed in ${txTime}s`, 'buy');
                this.onLog(`🔗 TX: ${signature.slice(0, 8)}...${signature.slice(-8)}`, 'tx');
                
                this.onTrade({ 
                    type: 'buy', 
                    amount: amountSOL, 
                    signature,
                    price: priceInfo || null,
                    marketCap: null,
                    duration: parseFloat(txTime)
                });
                return true;
                
            } catch (error) {
                this.onLog(`⚠️ BUY attempt ${i + 1} failed: ${error.message}`, 'error');
                if (i < this.config.maxRetries - 1) {
                    this.onLog(`⏳ Retrying in ${(2 * (i + 1))}s...`, 'status');
                    await this._delay(2000 * (i + 1));
                }
            }
        }
        return false;
    }
    
    async _sellAll(estimatedAmountSOL = null) {
        // Use last buy amount if not provided
        const reportAmount = estimatedAmountSOL || this.lastBuyAmount || 0;
        
        for (let i = 0; i < this.config.maxRetries; i++) {
            try {
                const attempt = i + 1;
                this.onLog(`🔴 SELL ~${reportAmount.toFixed(4)} SOL (attempt ${attempt}/${this.config.maxRetries})`, 'sell');
                
                // Get current price before trade
                let priceInfo = null;
                try {
                    priceInfo = await getPrice(this.connection, this.tokenMint);
                    if (priceInfo) {
                        this.onLog(`📈 Current price: ${priceInfo.toExponential(4)} SOL`, 'status');
                    }
                } catch (e) {}
                
                this.onLog(`⏳ Sending SELL transaction...`, 'sell');
                const txStart = Date.now();
                
                const signature = await sell(
                    this.connection,
                    this.wallet,
                    this.tokenMint,
                    null, // null = sell all
                    this.config.slippage
                );
                
                const txTime = ((Date.now() - txStart) / 1000).toFixed(1);
                this.onLog(`✅ SELL confirmed in ${txTime}s`, 'sell');
                this.onLog(`🔗 TX: ${signature.slice(0, 8)}...${signature.slice(-8)}`, 'tx');
                this.onTrade({ 
                    type: 'sell', 
                    amount: reportAmount, 
                    signature,
                    price: priceInfo || null,
                    marketCap: null,
                    duration: parseFloat(txTime)
                });
                return true;
                
            } catch (error) {
                this.onLog(`⚠️ SELL attempt ${i + 1} failed: ${error.message}`, 'error');
                if (i < this.config.maxRetries - 1) {
                    this.onLog(`⏳ Retrying in ${(2 * (i + 1))}s...`, 'status');
                    await this._delay(2000 * (i + 1));
                }
            }
        }
        return false;
    }
    
    // ========================================================================
    // FEE CLAIMING (Every 4 hours)
    // ========================================================================
    
    _startFeeClaimScheduler() {
        // Claim immediately on start
        this._claimFees();
        
        // Then every 4 hours
        this.feeClaimInterval = setInterval(() => {
            this._claimFees();
        }, this.config.feeClaimIntervalMs);
        
        this.onLog(`Fee claim scheduled every ${this.config.feeClaimIntervalMs / 1000 / 60 / 60} hours`);
    }
    
    async _claimFees() {
        try {
            this.onLog('Checking claimable fees...');
            
            // Check available fees
            const fees = await checkAllFees(this.connection, this.wallet.publicKey);
            
            if (fees.totalSOL < 0.001) {
                this.onLog(`No significant fees to claim (${fees.totalSOL.toFixed(4)} SOL)`);
                return;
            }
            
            this.onLog(`Claimable fees: ${fees.totalSOL.toFixed(4)} SOL`);
            
            // Claim
            const result = await claimAllFees(this.connection, this.wallet);
            
            if (result.totalClaimedSOL > 0) {
                this.stats.totalFeesClaimed += result.totalClaimedSOL;
                this.stats.lastFeeClaim = Date.now();
                
                this.onLog(`💰 Claimed ${result.totalClaimedSOL.toFixed(4)} SOL (Total: ${this.stats.totalFeesClaimed.toFixed(4)} SOL)`);
                this.onFeeClaim(result);
            }
            
        } catch (error) {
            this.onLog(`Fee claim error: ${error.message}`);
        }
    }
    
    // ========================================================================
    // HELPERS
    // ========================================================================
    
    async _getBalance() {
        const lamports = await this.connection.getBalance(this.wallet.publicKey);
        return lamports / LAMPORTS_PER_SOL;
    }
    
    _random(min, max) {
        return Math.random() * (max - min) + min;
    }
    
    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    async _delayWithCountdown(ms, label = 'Next action') {
        const seconds = Math.ceil(ms / 1000);
        
        // For short delays (under 5 sec), just show once
        if (seconds <= 5) {
            this.onLog(`⏱️ ${label} in ${seconds}s...`, 'countdown');
            await this._delay(ms);
            return;
        }
        
        // For longer delays, countdown every 5 seconds
        let remaining = seconds;
        while (remaining > 0 && this.isRunning) {
            this.onLog(`⏱️ ${label} in ${remaining}s...`, 'countdown');
            const waitTime = Math.min(remaining, 5) * 1000;
            await this._delay(waitTime);
            remaining -= Math.min(remaining, 5);
        }
    }
    
    // ========================================================================
    // STATUS
    // ========================================================================
    
    async getStatus() {
        const balance = await this._getBalance();
        const tokenStatus = await getTokenStatus(this.connection, this.tokenMint).catch(() => null);
        const fees = await checkAllFees(this.connection, this.wallet.publicKey).catch(() => ({ totalSOL: 0 }));
        
        const runtime = this.stats.startTime ? Date.now() - this.stats.startTime : 0;
        const runtimeHours = runtime / 1000 / 60 / 60;
        const volumePerHour = runtimeHours > 0 ? this.stats.totalVolume / runtimeHours : 0;
        
        return {
            // Running state
            isRunning: this.isRunning,
            runtime,
            runtimeHuman: this._formatRuntime(runtime),
            
            // Wallet
            wallet: this.wallet.publicKey.toBase58(),
            balanceSOL: balance,
            
            // Token
            tokenMint: this.tokenMint.toBase58(),
            tokenDex: tokenStatus?.dex || 'unknown',
            tokenPrice: tokenStatus?.price || 0,
            
            // Stats
            totalCycles: this.stats.totalCycles,
            totalVolume: this.stats.totalVolume,
            volumePerHour,
            
            // Fees
            pendingFees: fees.totalSOL,
            totalFeesClaimed: this.stats.totalFeesClaimed,
            lastFeeClaim: this.stats.lastFeeClaim,
            nextFeeClaim: this.stats.lastFeeClaim 
                ? this.stats.lastFeeClaim + this.config.feeClaimIntervalMs 
                : null,
            
            // Health
            errors: this.stats.errors,
            lastTrade: this.stats.lastTrade,
        };
    }
    
    _formatRuntime(ms) {
        const hours = Math.floor(ms / 1000 / 60 / 60);
        const minutes = Math.floor((ms / 1000 / 60) % 60);
        if (hours > 24) {
            const days = Math.floor(hours / 24);
            return `${days}d ${hours % 24}h`;
        }
        return `${hours}h ${minutes}m`;
    }
}

export default TokenMarketMaker;

