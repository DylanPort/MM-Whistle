/**
 * Production-Ready Fund Manager
 * Handles all fund-related logic for the Market Maker
 * 
 * Features:
 * - Dynamic fee claiming based on balance
 * - Intelligent trade sizing
 * - Gas reserve protection
 * - Circuit breakers
 * - Performance tracking
 */

import { checkAllFees, claimAllFees } from '../fees/claim.js';
import { LAMPORTS_PER_SOL } from '../constants.js';

// ============================================================================
// CONSTANTS & THRESHOLDS
// ============================================================================

const THRESHOLDS = {
    // Gas & Reserve
    MIN_GAS_RESERVE_SOL: 0.005,         // Minimum SOL to keep for gas (rent exempt + few txs)
    CRITICAL_BALANCE_SOL: 0.01,          // Trigger urgent fee claim
    LOW_BALANCE_SOL: 0.05,               // Trigger normal fee claim
    COMFORTABLE_BALANCE_SOL: 0.5,        // Don't claim fees unless above threshold
    
    // Fee Claiming
    MIN_CLAIM_THRESHOLD_SOL: 0.005,      // Minimum fees worth claiming
    CLAIM_INTERVAL_NORMAL_MS: 60 * 60 * 1000,     // 1 hour when balance comfortable
    CLAIM_INTERVAL_LOW_MS: 10 * 60 * 1000,        // 10 min when balance low
    CLAIM_INTERVAL_CRITICAL_MS: 2 * 60 * 1000,    // 2 min when critical
    
    // Trade Sizing
    MIN_TRADE_SOL: 0.005,                // Absolute minimum trade
    MAX_TRADE_PERCENT: 0.1,              // Max 10% of available balance per trade
    MAX_POSITION_PERCENT: 0.3,           // Max 30% in any single token position
    
    // Circuit Breakers (relaxed for meme token volatility)
    MAX_CONSECUTIVE_FAILURES: 10,        // Stop after 10 failed txs (network issues)
    MAX_HOURLY_LOSS_PERCENT: 0.5,        // 50% hourly - only for catastrophic events
    MAX_DAILY_LOSS_PERCENT: 0.8,         // 80% daily - basically total loss protection
    COOLDOWN_AFTER_FAILURE_MS: 10000,    // 10 sec cooldown after failure
    
    // Soft warnings (log but don't stop)
    WARN_HOURLY_LOSS_PERCENT: 0.15,      // Warn at 15% hourly
    WARN_DAILY_LOSS_PERCENT: 0.3,        // Warn at 30% daily
    
    // Performance
    TRADE_SLIPPAGE_WARNING: 0.05,        // Warn if slippage > 5%
    MAX_ACCEPTABLE_SLIPPAGE: 0.25,       // Reject if slippage > 25% (meme tokens are volatile)
};

// ============================================================================
// FUND MANAGER CLASS
// ============================================================================

export class FundManager {
    constructor(connection, payer, config = {}) {
        this.connection = connection;
        this.payer = payer;
        
        // Merge config with defaults
        this.thresholds = { ...THRESHOLDS, ...config.thresholds };
        
        // State
        this.state = {
            currentBalance: 0,
            reservedForGas: this.thresholds.MIN_GAS_RESERVE_SOL,
            availableForTrading: 0,
            totalFeesEarned: 0,
            totalFeesClaimed: 0,
            
            // Performance tracking
            startingBalance: 0,
            peakBalance: 0,
            totalTrades: 0,
            successfulTrades: 0,
            failedTrades: 0,
            consecutiveFailures: 0,
            
            // P&L tracking
            hourlyPnL: [],
            dailyPnL: 0,
            totalPnL: 0,
            
            // Timestamps
            lastFeeCheck: 0,
            lastFeeClaim: 0,
            lastTrade: 0,
            lastBalanceUpdate: 0,
            startTime: Date.now(),
        };
        
        // Circuit breaker state
        this.circuitBreaker = {
            isTripped: false,
            reason: null,
            trippedAt: null,
            autoResetAt: null,
        };
        
        // Pending claims
        this.pendingClaim = false;
        
        // Callbacks
        this.onBalanceUpdate = config.onBalanceUpdate || (() => {});
        this.onFeeClaimed = config.onFeeClaimed || (() => {});
        this.onCircuitBreaker = config.onCircuitBreaker || (() => {});
        this.onWarning = config.onWarning || console.warn;
        this.onError = config.onError || console.error;
        
        // Auto-refresh interval
        this.refreshIntervalId = null;
    }
    
    // ========================================================================
    // INITIALIZATION
    // ========================================================================
    
    async initialize() {
        console.log(`[FundManager] Initializing...`);
        
        // Get initial balance
        await this.refreshBalance();
        this.state.startingBalance = this.state.currentBalance;
        this.state.peakBalance = this.state.currentBalance;
        
        // Check initial fees
        await this.checkAndClaimFees(true);
        
        // Start auto-refresh
        this.startAutoRefresh();
        
        console.log(`[FundManager] Initialized with ${this.state.currentBalance} SOL`);
        console.log(`[FundManager] Available for trading: ${this.state.availableForTrading} SOL`);
        
        return this.getStatus();
    }
    
    // ========================================================================
    // BALANCE MANAGEMENT
    // ========================================================================
    
    /**
     * Refresh current balance from chain
     */
    async refreshBalance() {
        try {
            const lamports = await this.connection.getBalance(this.payer.publicKey);
            const balance = lamports / LAMPORTS_PER_SOL;
            
            const previousBalance = this.state.currentBalance;
            this.state.currentBalance = balance;
            this.state.lastBalanceUpdate = Date.now();
            
            // Update available for trading (balance - gas reserve)
            this.state.availableForTrading = Math.max(
                0,
                balance - this.thresholds.MIN_GAS_RESERVE_SOL
            );
            
            // Track peak balance
            if (balance > this.state.peakBalance) {
                this.state.peakBalance = balance;
            }
            
            // Track P&L
            if (previousBalance > 0) {
                const change = balance - previousBalance;
                this.state.totalPnL = balance - this.state.startingBalance;
                this._trackHourlyPnL(change);
            }
            
            // Notify
            this.onBalanceUpdate({
                balance,
                available: this.state.availableForTrading,
                pnl: this.state.totalPnL,
            });
            
            // Check for low balance alerts
            this._checkBalanceAlerts(balance);
            
            return balance;
            
        } catch (error) {
            this.onError(`[FundManager] Failed to refresh balance: ${error.message}`);
            return this.state.currentBalance;
        }
    }
    
    /**
     * Check balance and trigger alerts/actions
     */
    _checkBalanceAlerts(balance) {
        if (balance < this.thresholds.CRITICAL_BALANCE_SOL) {
            this.onWarning(`[FundManager] ⚠️ CRITICAL: Balance ${balance.toFixed(4)} SOL`);
            // Trigger urgent fee claim
            this.checkAndClaimFees(true);
        } else if (balance < this.thresholds.LOW_BALANCE_SOL) {
            this.onWarning(`[FundManager] ⚠️ LOW: Balance ${balance.toFixed(4)} SOL`);
        }
    }
    
    // ========================================================================
    // FEE CLAIMING
    // ========================================================================
    
    /**
     * Smart fee claiming based on balance and available fees
     */
    async checkAndClaimFees(urgent = false) {
        // Prevent concurrent claims
        if (this.pendingClaim) {
            console.log(`[FundManager] Claim already in progress`);
            return null;
        }
        
        const now = Date.now();
        const timeSinceLastClaim = now - this.state.lastFeeClaim;
        
        // Determine claim interval based on balance state
        let requiredInterval;
        if (this.state.currentBalance < this.thresholds.CRITICAL_BALANCE_SOL) {
            requiredInterval = this.thresholds.CLAIM_INTERVAL_CRITICAL_MS;
        } else if (this.state.currentBalance < this.thresholds.LOW_BALANCE_SOL) {
            requiredInterval = this.thresholds.CLAIM_INTERVAL_LOW_MS;
        } else {
            requiredInterval = this.thresholds.CLAIM_INTERVAL_NORMAL_MS;
        }
        
        // Skip if not urgent and interval not met
        if (!urgent && timeSinceLastClaim < requiredInterval) {
            return null;
        }
        
        try {
            this.pendingClaim = true;
            this.state.lastFeeCheck = now;
            
            // Check available fees
            const fees = await checkAllFees(this.connection, this.payer.publicKey);
            console.log(`[FundManager] Fees available: ${fees.totalSOL.toFixed(4)} SOL`);
            
            this.state.totalFeesEarned = fees.totalSOL;
            
            // Decide whether to claim
            const shouldClaim = this._shouldClaimFees(fees.totalSOL, urgent);
            
            if (shouldClaim) {
                console.log(`[FundManager] Claiming ${fees.totalSOL.toFixed(4)} SOL...`);
                
                const result = await claimAllFees(this.connection, this.payer);
                
                if (result.totalClaimedSOL > 0) {
                    this.state.totalFeesClaimed += result.totalClaimedSOL;
                    this.state.lastFeeClaim = Date.now();
                    
                    this.onFeeClaimed({
                        amount: result.totalClaimedSOL,
                        total: this.state.totalFeesClaimed,
                    });
                    
                    // Refresh balance after claim
                    await this.refreshBalance();
                    
                    console.log(`[FundManager] ✅ Claimed ${result.totalClaimedSOL.toFixed(4)} SOL`);
                }
                
                return result;
            }
            
            return null;
            
        } catch (error) {
            this.onError(`[FundManager] Fee claim error: ${error.message}`);
            return null;
        } finally {
            this.pendingClaim = false;
        }
    }
    
    /**
     * Decide if we should claim fees
     */
    _shouldClaimFees(availableFees, urgent) {
        // Always claim if urgent and there's something to claim
        if (urgent && availableFees >= this.thresholds.MIN_CLAIM_THRESHOLD_SOL) {
            return true;
        }
        
        // If balance is critical, claim anything
        if (this.state.currentBalance < this.thresholds.CRITICAL_BALANCE_SOL) {
            return availableFees > 0;
        }
        
        // If balance is low, claim if meets threshold
        if (this.state.currentBalance < this.thresholds.LOW_BALANCE_SOL) {
            return availableFees >= this.thresholds.MIN_CLAIM_THRESHOLD_SOL;
        }
        
        // If balance is comfortable, only claim if significant fees
        if (this.state.currentBalance >= this.thresholds.COMFORTABLE_BALANCE_SOL) {
            return availableFees >= this.thresholds.MIN_CLAIM_THRESHOLD_SOL * 5;
        }
        
        // Default: claim if meets threshold
        return availableFees >= this.thresholds.MIN_CLAIM_THRESHOLD_SOL;
    }
    
    // ========================================================================
    // TRADE SIZING
    // ========================================================================
    
    /**
     * Calculate optimal trade size based on current state
     */
    calculateTradeSize(requestedAmount = null) {
        // Check circuit breaker
        if (this.circuitBreaker.isTripped) {
            return { 
                canTrade: false, 
                amount: 0, 
                reason: `Circuit breaker: ${this.circuitBreaker.reason}` 
            };
        }
        
        const available = this.state.availableForTrading;
        
        // Check minimum
        if (available < this.thresholds.MIN_TRADE_SOL) {
            return {
                canTrade: false,
                amount: 0,
                reason: `Insufficient balance: ${available.toFixed(4)} SOL (need ${this.thresholds.MIN_TRADE_SOL})`,
                shouldClaimFees: true,
            };
        }
        
        // Calculate max allowed trade size
        const maxFromPercent = available * this.thresholds.MAX_TRADE_PERCENT;
        const maxAllowed = Math.max(this.thresholds.MIN_TRADE_SOL, maxFromPercent);
        
        // If requested amount specified, validate it
        if (requestedAmount !== null) {
            if (requestedAmount > maxAllowed) {
                return {
                    canTrade: true,
                    amount: maxAllowed,
                    reason: `Reduced from ${requestedAmount} to ${maxAllowed} (max ${this.thresholds.MAX_TRADE_PERCENT * 100}% of available)`,
                    adjusted: true,
                };
            }
            
            if (requestedAmount < this.thresholds.MIN_TRADE_SOL) {
                return {
                    canTrade: false,
                    amount: 0,
                    reason: `Amount ${requestedAmount} below minimum ${this.thresholds.MIN_TRADE_SOL}`,
                };
            }
            
            return {
                canTrade: true,
                amount: requestedAmount,
                reason: null,
            };
        }
        
        // Return recommended trade size (based on available balance)
        let recommendedSize;
        
        if (available < 0.1) {
            // Very low: trade minimum
            recommendedSize = this.thresholds.MIN_TRADE_SOL;
        } else if (available < 1) {
            // Low: trade 5%
            recommendedSize = Math.max(this.thresholds.MIN_TRADE_SOL, available * 0.05);
        } else if (available < 10) {
            // Medium: trade 3%
            recommendedSize = Math.max(this.thresholds.MIN_TRADE_SOL, available * 0.03);
        } else {
            // High: trade 2%
            recommendedSize = Math.max(this.thresholds.MIN_TRADE_SOL, available * 0.02);
        }
        
        return {
            canTrade: true,
            amount: recommendedSize,
            maxAllowed,
            available,
            reason: null,
        };
    }
    
    /**
     * Calculate dynamic trade range for volume bot
     */
    calculateTradeRange() {
        const available = this.state.availableForTrading;
        
        if (available < this.thresholds.MIN_TRADE_SOL) {
            return null;
        }
        
        // Scale trade sizes based on available balance
        let minTrade, maxTrade;
        
        if (available < 0.1) {
            // Micro balance
            minTrade = this.thresholds.MIN_TRADE_SOL;
            maxTrade = Math.min(available * 0.3, 0.02);
        } else if (available < 0.5) {
            // Small balance
            minTrade = 0.005;
            maxTrade = Math.min(available * 0.15, 0.05);
        } else if (available < 2) {
            // Medium balance
            minTrade = 0.01;
            maxTrade = Math.min(available * 0.1, 0.2);
        } else if (available < 10) {
            // Good balance
            minTrade = 0.02;
            maxTrade = Math.min(available * 0.08, 0.5);
        } else {
            // Large balance
            minTrade = 0.05;
            maxTrade = Math.min(available * 0.05, 1);
        }
        
        return {
            min: Math.max(this.thresholds.MIN_TRADE_SOL, minTrade),
            max: maxTrade,
            available,
        };
    }
    
    // ========================================================================
    // CIRCUIT BREAKERS
    // ========================================================================
    
    /**
     * Record trade result and check circuit breakers
     * @param {boolean} success - Whether trade succeeded
     * @param {number} pnl - Profit/loss from trade
     * @param {string} errorType - Type of error: 'network', 'slippage', 'insufficient', 'unknown'
     */
    recordTradeResult(success, pnl = 0, errorType = 'unknown') {
        this.state.totalTrades++;
        this.state.lastTrade = Date.now();
        
        if (success) {
            this.state.successfulTrades++;
            this.state.consecutiveFailures = 0;
        } else {
            this.state.failedTrades++;
            this.state.consecutiveFailures++;
            
            // Different handling based on error type
            if (errorType === 'network') {
                // Network errors - use exponential backoff but don't trip breaker quickly
                const backoff = Math.min(60000, this.thresholds.COOLDOWN_AFTER_FAILURE_MS * Math.pow(1.5, this.state.consecutiveFailures));
                this.onWarning(`[FundManager] Network issue, backing off ${(backoff/1000).toFixed(0)}s`);
                
                // Only trip after many network failures (likely RPC down)
                if (this.state.consecutiveFailures >= this.thresholds.MAX_CONSECUTIVE_FAILURES * 2) {
                    this._tripCircuitBreaker(
                        `${this.state.consecutiveFailures} network failures - RPC may be down`,
                        5 * 60 * 1000 // 5 min cooldown
                    );
                }
            } else if (errorType === 'slippage') {
                // Slippage failures - market too volatile, wait longer
                this.onWarning(`[FundManager] High slippage, market volatile`);
                if (this.state.consecutiveFailures >= 5) {
                    this._tripCircuitBreaker(
                        `Market too volatile (${this.state.consecutiveFailures} slippage fails)`,
                        2 * 60 * 1000 // 2 min cooldown
                    );
                }
            } else if (errorType === 'insufficient') {
                // Insufficient funds - don't count as failure, trigger fee claim
                this.state.consecutiveFailures = Math.max(0, this.state.consecutiveFailures - 1);
                this.checkAndClaimFees(true);
            } else {
                // Unknown errors - standard handling
                if (this.state.consecutiveFailures >= this.thresholds.MAX_CONSECUTIVE_FAILURES) {
                    this._tripCircuitBreaker(
                        `${this.state.consecutiveFailures} consecutive failures`,
                        this.thresholds.COOLDOWN_AFTER_FAILURE_MS * this.state.consecutiveFailures
                    );
                }
            }
        }
        
        // Update P&L
        if (pnl !== 0) {
            this.state.totalPnL += pnl;
            this._trackHourlyPnL(pnl);
        }
        
        // Check loss limits (only if we have meaningful data)
        if (this.state.totalTrades > 5) {
            this._checkLossLimits();
        }
        
        // Refresh balance
        this.refreshBalance();
    }
    
    /**
     * Track hourly P&L for loss detection
     */
    _trackHourlyPnL(change) {
        const now = Date.now();
        const oneHourAgo = now - 60 * 60 * 1000;
        
        // Add new entry
        this.state.hourlyPnL.push({ time: now, change });
        
        // Remove entries older than 1 hour
        this.state.hourlyPnL = this.state.hourlyPnL.filter(e => e.time > oneHourAgo);
    }
    
    /**
     * Check loss limits and trip circuit breaker if needed
     * For meme tokens, we use relaxed thresholds and soft warnings
     */
    _checkLossLimits() {
        // Skip if starting balance is 0 (avoid division by zero)
        if (this.state.startingBalance <= 0) return;
        
        // Calculate hourly loss
        const hourlyLoss = this.state.hourlyPnL.reduce((sum, e) => sum + e.change, 0);
        const hourlyLossPercent = Math.abs(hourlyLoss) / this.state.startingBalance;
        
        // Soft warning for hourly loss
        if (hourlyLoss < 0 && hourlyLossPercent >= this.thresholds.WARN_HOURLY_LOSS_PERCENT) {
            this.onWarning(`[FundManager] ⚠️ Hourly loss: ${(hourlyLossPercent * 100).toFixed(1)}%`);
        }
        
        // Hard stop only for catastrophic hourly loss
        if (hourlyLoss < 0 && hourlyLossPercent >= this.thresholds.MAX_HOURLY_LOSS_PERCENT) {
            this._tripCircuitBreaker(
                `Catastrophic hourly loss ${(hourlyLossPercent * 100).toFixed(1)}%`,
                30 * 60 * 1000 // 30 min cooldown (not full hour)
            );
            return;
        }
        
        // Calculate daily loss
        const dailyLossPercent = Math.abs(this.state.totalPnL) / this.state.startingBalance;
        
        // Soft warning for daily loss
        if (this.state.totalPnL < 0 && dailyLossPercent >= this.thresholds.WARN_DAILY_LOSS_PERCENT) {
            this.onWarning(`[FundManager] ⚠️ Daily loss: ${(dailyLossPercent * 100).toFixed(1)}%`);
        }
        
        // Hard stop only for near-total loss
        if (this.state.totalPnL < 0 && dailyLossPercent >= this.thresholds.MAX_DAILY_LOSS_PERCENT) {
            this._tripCircuitBreaker(
                `Near-total loss ${(dailyLossPercent * 100).toFixed(1)}% - manual intervention needed`,
                null // No auto-reset for this - needs manual reset
            );
        }
    }
    
    /**
     * Trip the circuit breaker
     */
    _tripCircuitBreaker(reason, autoResetMs = null) {
        console.log(`[FundManager] 🚨 CIRCUIT BREAKER: ${reason}`);
        
        this.circuitBreaker = {
            isTripped: true,
            reason,
            trippedAt: Date.now(),
            autoResetAt: autoResetMs ? Date.now() + autoResetMs : null,
        };
        
        this.onCircuitBreaker(this.circuitBreaker);
        
        // Schedule auto-reset if configured
        if (autoResetMs) {
            setTimeout(() => {
                this.resetCircuitBreaker();
            }, autoResetMs);
        }
    }
    
    /**
     * Reset circuit breaker
     */
    resetCircuitBreaker() {
        console.log(`[FundManager] Circuit breaker reset`);
        
        this.circuitBreaker = {
            isTripped: false,
            reason: null,
            trippedAt: null,
            autoResetAt: null,
        };
        
        this.state.consecutiveFailures = 0;
    }
    
    // ========================================================================
    // AUTO REFRESH
    // ========================================================================
    
    /**
     * Start auto-refresh of balance and fees
     */
    startAutoRefresh(intervalMs = 30000) {
        if (this.refreshIntervalId) {
            clearInterval(this.refreshIntervalId);
        }
        
        this.refreshIntervalId = setInterval(async () => {
            await this.refreshBalance();
            await this.checkAndClaimFees();
        }, intervalMs);
        
        console.log(`[FundManager] Auto-refresh started (${intervalMs / 1000}s interval)`);
    }
    
    /**
     * Stop auto-refresh
     */
    stopAutoRefresh() {
        if (this.refreshIntervalId) {
            clearInterval(this.refreshIntervalId);
            this.refreshIntervalId = null;
        }
    }
    
    // ========================================================================
    // STATUS & REPORTING
    // ========================================================================
    
    /**
     * Get comprehensive status
     */
    getStatus() {
        const uptime = Date.now() - this.state.startTime;
        const tradeSuccessRate = this.state.totalTrades > 0
            ? (this.state.successfulTrades / this.state.totalTrades * 100).toFixed(1)
            : 0;
        
        const hourlyLoss = this.state.hourlyPnL.reduce((sum, e) => sum + e.change, 0);
        
        return {
            // Balance
            balance: {
                current: this.state.currentBalance,
                available: this.state.availableForTrading,
                reserved: this.thresholds.MIN_GAS_RESERVE_SOL,
                starting: this.state.startingBalance,
                peak: this.state.peakBalance,
            },
            
            // Fees
            fees: {
                earned: this.state.totalFeesEarned,
                claimed: this.state.totalFeesClaimed,
                lastClaim: this.state.lastFeeClaim,
            },
            
            // Performance
            performance: {
                totalPnL: this.state.totalPnL,
                hourlyPnL: hourlyLoss,
                totalTrades: this.state.totalTrades,
                successfulTrades: this.state.successfulTrades,
                failedTrades: this.state.failedTrades,
                successRate: parseFloat(tradeSuccessRate),
            },
            
            // Circuit Breaker
            circuitBreaker: this.circuitBreaker,
            
            // System
            uptime,
            uptimeHuman: this._formatDuration(uptime),
            lastUpdate: this.state.lastBalanceUpdate,
            
            // Trade sizing recommendation
            tradeSizing: this.calculateTradeSize(),
            tradeRange: this.calculateTradeRange(),
        };
    }
    
    _formatDuration(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        
        if (days > 0) return `${days}d ${hours % 24}h`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }
    
    /**
     * Clean shutdown
     */
    async shutdown() {
        console.log(`[FundManager] Shutting down...`);
        this.stopAutoRefresh();
        
        // Final fee claim attempt
        await this.checkAndClaimFees(true);
        
        return this.getStatus();
    }
}

export default FundManager;

