/**
 * Persistent Bot Manager
 * Manages always-on market maker bots that run server-side
 * Bots never stop - they pause when no funds and resume when funds available
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { buy, sell, getPrice, getTokenStatus } from '../trading/index.js';
import { checkAllFees, claimAllFees } from '../fees/claim.js';
import { 
    getMmWalletPDA, 
    getPdaWalletAddress, 
    getMmWalletInfo,
    createExecuteBuyInstruction,
    createExecuteSellInstruction,
    derivePumpFunAccountsFromMint,
    parseMmWalletAccount
} from '../contract/index.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from '@solana/spl-token';
import * as bs58 from 'bs58';
import { buyOnPumpSwap, sellOnPumpSwap, findPumpSwapPool, getPumpSwapPrice } from '../trading/pumpswap.js';

// ============================================================================
// PERSISTENT BOT CLASS
// ============================================================================

class PersistentBot {
    constructor(manager, config) {
        this.manager = manager;
        this.id = config.id;
        this.tokenMint = config.tokenMint;
        this.pdaAddress = config.pdaAddress;
        this.ownerWallet = config.ownerWallet;
        
        // Strategy config
        this.strategy = config.strategy || 'volume';
        this.strategyConfig = config.strategyConfig || {};
        
        // Runtime state
        this.isRunning = false;
        this.isPaused = false;
        this.pauseReason = null;
        this.loopInterval = null;
        
        // Stats - LOAD FROM DB if available
        this.stats = {
            startTime: null,
            totalTrades: config.totalTrades || 0,
            totalVolume: config.totalVolume || 0,
            lastTrade: config.lastTrade ? { time: new Date(config.lastTrade).getTime() } : null,
            lastCheck: null,
            consecutiveFailures: 0,
            insufficientFundsCount: 0
        };
        
        // Track if token is graduated to PumpSwap/Raydium
        this.isGraduated = false;
        this.pumpSwapPool = null;
        
        // Default config
        this.config = {
            // Trade sizing
            tradePercentMin: 0.15,
            tradePercentMax: 0.30,
            minTradeSOL: 0.01,
            maxTradeSOL: 0.5,
            
            // Timing
            minDelayMs: 5000,      // 5 sec min
            maxDelayMs: 30000,     // 30 sec max
            checkIntervalMs: 10000, // Check every 10 sec when paused
            
            // Safety - must match contract's MIN_RENT_RESERVE (0.01 SOL)
            minBalanceSOL: 0.01,  // Contract's MIN_RENT_RESERVE
            slippage: 0.25,
            maxRetries: 3,
            
            // Fee claiming
            feeClaimIntervalMs: 4 * 60 * 60 * 1000, // 4 hours
            
            ...this.strategyConfig
        };
        
        this.lastFeeClaim = 0;
    }
    
    async start() {
        if (this.isRunning) return;
        
        this.isRunning = true;
        this.isPaused = false;
        this.stats.startTime = Date.now();
        
        this.log(`STARTING PERSISTENT BOT - NEVER STOPS`);
        this.log(`Token: ${this.tokenMint.slice(0, 8)}...`);
        this.log(`PDA: ${this.pdaAddress.slice(0, 8)}...`);
        
        // Start the INFINITE main loop - this NEVER exits
        this._runInfiniteLoop();
        
        return true;
    }
    
    /**
     * INFINITE LOOP - This bot NEVER stops
     * - Recovers from ALL errors
     * - Waits for funds when empty
     * - Starts trading IMMEDIATELY when funds detected
     * - No stop mechanism - truly trustless
     */
    async _runInfiniteLoop() {
        // This loop runs FOREVER
        while (true) {
            try {
                await this._executeCycle();
                
                // Reset failure counter on success
                if (!this.isPaused) {
                    this.stats.consecutiveFailures = 0;
                }
            } catch (e) {
                this.stats.consecutiveFailures++;
                this.log(`Cycle error (${this.stats.consecutiveFailures}): ${e.message}`, 'error');
                
                // Even on error, we NEVER stop - just wait and retry
                // Exponential backoff on repeated failures (max 60 sec)
                const backoff = Math.min(60000, 5000 * Math.pow(1.5, this.stats.consecutiveFailures));
                await this._sleep(backoff);
                continue;
            }
            
            // Calculate delay based on state
            let delay;
            if (this.isPaused) {
                // When waiting for funds, check frequently (every 3 sec)
                delay = 3000;
            } else {
                // When trading, use random delay
                delay = this._randomDelay();
            }
            
            await this._sleep(delay);
        }
    }
    
    async _executeCycle() {
        this.stats.lastCheck = Date.now();
        
        // Get vault balance - keep checking until we get funds
        const balance = await this._getVaultBalance();
        
        // Minimum to trade (very low threshold for continuous operation)
        const minRequired = this.config.minBalanceSOL + this.config.minTradeSOL;
        
        if (balance < minRequired) {
            // Not enough funds - but we NEVER stop, just wait
            if (!this.isPaused) {
                this.isPaused = true;
                this.pauseReason = 'insufficient_funds';
                this.stats.insufficientFundsCount++;
                this.log(`WAITING FOR FUNDS (${balance.toFixed(4)} SOL < ${minRequired.toFixed(4)} SOL needed)`, 'warn');
            }
            // Return and loop will check again in 3 seconds
            return;
        }
        
        // FUNDS DETECTED! Start trading IMMEDIATELY
        if (this.isPaused) {
            this.isPaused = false;
            this.pauseReason = null;
            this.log(`FUNDS DETECTED! (${balance.toFixed(4)} SOL) - STARTING TRADES IMMEDIATELY!`, 'info');
            
            // Broadcast to connected clients
            this.manager.broadcast({
                type: 'bot-funds-detected',
                botId: this.id,
                tokenMint: this.tokenMint,
                balance,
                message: 'Bot is now trading!'
            });
        }
        
        // Execute trade cycle - THIS IS THE VOLUME BOT
        await this._executeTrade(balance);
        
        // Check if we should claim fees (every 4 hours)
        if (Date.now() - this.lastFeeClaim > this.config.feeClaimIntervalMs) {
            await this._claimFees();
        }
    }
    
    async _executeTrade(balance) {
        const conn = this.manager.getConnection();
        const operatorKeypair = this.manager.getOperatorKeypair();
        
        try {
            // First check if token mint exists
            const tokenMintPk = new PublicKey(this.tokenMint);
            const mintInfo = await conn.getAccountInfo(tokenMintPk);
            if (!mintInfo) {
                this.consecutiveFailures = (this.consecutiveFailures || 0) + 1;
                if (this.consecutiveFailures >= 3) {
                    this.log(`TOKEN DOES NOT EXIST - stopping bot permanently`, 'error');
                    this.isRunning = false;
                    // Mark as inactive in DB
                    try {
                        this.manager.db.prepare('UPDATE persistent_bots SET is_active = 0 WHERE tokenMint = ?')
                            .run(this.tokenMint);
                    } catch (e) { /* Column might not exist in older DB */ }
                    return;
                }
                this.log(`Token mint not found (attempt ${this.consecutiveFailures}/3)`, 'warn');
                return;
            }
            this.consecutiveFailures = 0;
            
            // Get token status from bonding curve
            const tokenStatus = await getTokenStatus(conn, this.tokenMint);
            
            // Check if token has graduated to PumpSwap/Raydium
            if (!tokenStatus || tokenStatus.error || tokenStatus.migrated) {
                // Try to find PumpSwap pool
                if (!this.isGraduated) {
                    this.log(`Checking if token has graduated to PumpSwap... (mint: ${this.tokenMint})`, 'info');
                    try {
                        const mintPk = new PublicKey(this.tokenMint);
                        this.log(`Searching for PumpSwap pool for mint: ${mintPk.toBase58()}`, 'info');
                        const pool = await findPumpSwapPool(conn, mintPk);
                        this.log(`PumpSwap pool search result: ${pool ? pool.toBase58() : 'null'}`, 'info');
                        if (pool) {
                            this.isGraduated = true;
                            this.pumpSwapPool = pool;
                            this.log(`✅ Token GRADUATED! Trading via PumpSwap AMM`, 'info');
                            this.log(`Pool: ${pool.toBase58()}`, 'info');
                        } else {
                            this.log(`Token status unavailable and no PumpSwap pool found - will retry`, 'warn');
                            return;
                        }
                    } catch (e) {
                        this.log(`PumpSwap pool check failed: ${e.message}`, 'error');
                        this.log(`Error stack: ${e.stack}`, 'error');
                        return;
                    }
                }
            }
            
            // Check if bonding curve's ATA exists (required for trading)
            const pumpAccountsCheck = derivePumpFunAccountsFromMint(tokenMintPk);
            const bondingCurveAtaInfo = await conn.getAccountInfo(pumpAccountsCheck.associatedBondingCurve);
            if (!bondingCurveAtaInfo) {
                this.bcAtaFailures = (this.bcAtaFailures || 0) + 1;
                if (this.bcAtaFailures >= 3) {
                    this.log(`BONDING CURVE ATA DOES NOT EXIST - token never traded or invalid`, 'error');
                    this.log(`Stopping bot - this token cannot be traded on Pump.fun`, 'error');
                    this.isRunning = false;
                    try {
                        this.manager.db.prepare('UPDATE persistent_bots SET is_active = 0 WHERE tokenMint = ?')
                            .run(this.tokenMint);
                    } catch (e) { /* Column might not exist in older DB */ }
                    return;
                }
                this.log(`Bonding curve ATA not found (attempt ${this.bcAtaFailures}/3) - skipping trade`, 'warn');
                return;
            }
            this.bcAtaFailures = 0;
            
            // Get MM wallet info first to read on-chain config
            const mmWalletInfo = await this._getMmWalletInfo();
            if (!mmWalletInfo) {
                this.log(`Could not get MM wallet info`, 'error');
                return;
            }
            
            // Check vault-level rate limit (shared across all bots using same vault)
            const minDelaySecs = mmWalletInfo.minDelaySecs || 30;
            const vaultAddress = mmWalletInfo.vault.toBase58();
            
            if (!this.manager.canVaultTrade(vaultAddress, minDelaySecs)) {
                const lastTrade = this.manager.vaultLastTrade.get(vaultAddress) || 0;
                const waitTime = Math.ceil(minDelaySecs - (Date.now() - lastTrade) / 1000);
                this.log(`Rate limit: waiting ${waitTime}s (cooldown=${minDelaySecs}s)`, 'info');
                return; // Skip this cycle, will retry in 3s
            }
            
            // Calculate trade amount RESPECTING ON-CHAIN CONFIG
            // On-chain trade_size_pct limits the max trade as % of available balance
            const availableForTrade = balance - this.config.minBalanceSOL;
            const onChainMaxPercent = (mmWalletInfo.tradeSizePct || 25) / 100; // Convert from % to decimal
            
            // Calculate absolute max trade allowed by on-chain config (in SOL)
            const onChainMaxSOL = availableForTrade * onChainMaxPercent;
            
            // If on-chain max is too low, we can't trade
            if (onChainMaxSOL < 0.001) {
                this.log(`On-chain max trade too low: ${onChainMaxSOL.toFixed(6)} SOL (${(onChainMaxPercent*100).toFixed(0)}% of ${availableForTrade.toFixed(4)})`, 'warn');
                return;
            }
            
            // Trade amount: random % of available, but NEVER exceed on-chain max
            const tradePercent = this.config.tradePercentMin + 
                Math.random() * (this.config.tradePercentMax - this.config.tradePercentMin);
            
            let tradeAmount = availableForTrade * tradePercent;
            // Cap by on-chain max (most important)
            tradeAmount = Math.min(tradeAmount, onChainMaxSOL * 0.95); // Stay 5% under to be safe
            // Apply bot's min/max
            tradeAmount = Math.max(0.001, Math.min(this.config.maxTradeSOL, tradeAmount));
            
            this.log(`Trade sizing: available=${availableForTrade.toFixed(4)}, onChainMax=${onChainMaxSOL.toFixed(6)} SOL (${(onChainMaxPercent*100).toFixed(0)}%), amount=${tradeAmount.toFixed(6)}`, 'info');
            
            // Decide buy or sell (volume strategy = alternating)
            const shouldBuy = this.stats.totalTrades % 2 === 0;
            const tokenBalance = await this._getTokenBalance();
            
            // If we should sell but have no tokens, buy instead
            if (!shouldBuy && tokenBalance <= 0) {
                this.log(`No tokens to sell - buying instead`, 'info');
            }
            
            const actuallyBuy = shouldBuy || tokenBalance <= 0;
            
            // OPTION 1: Try to find a regular wallet for this address (has private key)
            const regularWallet = this._getRegularWalletKeypair();
            if (regularWallet) {
                // Trade directly with regular wallet (server has private key!)
                this.log(`Trading via regular wallet: ${regularWallet.publicKey.toBase58().slice(0,8)}...`, 'info');
                
                const mintPk = new PublicKey(this.tokenMint);
                
                if (actuallyBuy) {
                    this.log(`BUY ${tradeAmount.toFixed(4)} SOL`, 'trade');
                    try {
                        const signature = await buy(conn, regularWallet, mintPk, tradeAmount, this.config.slippage);
                        this.stats.totalTrades++;
                        this.stats.totalVolume += tradeAmount;
                        this.stats.lastTrade = { type: 'buy', amount: tradeAmount, time: Date.now(), signature };
                        this._updateDB();
                        this.log(`BUY SUCCESS: ${signature.slice(0, 20)}...`, 'trade');
                    } catch (e) {
                        this.log(`Buy failed: ${e.message}`, 'error');
                    }
                } else {
                    this.log(`SELL tokens`, 'trade');
                    try {
                        const signature = await sell(conn, regularWallet, mintPk, null, this.config.slippage);
                        this.stats.totalTrades++;
                        this.stats.totalVolume += tokenStatus.priceSOL * tokenBalance || 0;
                        this.stats.lastTrade = { type: 'sell', amount: tokenBalance, time: Date.now(), signature };
                        this._updateDB();
                        this.log(`SELL SUCCESS: ${signature.slice(0, 20)}...`, 'trade');
                    } catch (e) {
                        this.log(`Sell failed: ${e.message}`, 'error');
                    }
                }
                
                // Wait before next trade
                const delay = (this.config.minDelayMs + Math.random() * (this.config.maxDelayMs - this.config.minDelayMs)) / 1000;
                await new Promise(r => setTimeout(r, delay * 1000));
                return;
            }
            
            // OPTION 2: PDA trading via contract (or PumpSwap for graduated tokens)
            // Vault should pay all fees per user's contract design
            // Operator is only needed as signer, not for fees
            if (!operatorKeypair) {
                this.log(`No operator keypair available`, 'error');
                return;
            }
            
            // mmWalletInfo already fetched above for on-chain config
            const mintPubkey = new PublicKey(this.tokenMint);
            
            // Check if token is graduated - use PumpSwap AMM
            if (this.isGraduated) {
                this.log(`Trading via PumpSwap (graduated token)`, 'info');
                
                if (actuallyBuy) {
                    await this._executeBuyViaPumpSwap(conn, operatorKeypair, mmWalletInfo, tradeAmount);
                } else {
                    await this._executeSellViaPumpSwap(conn, operatorKeypair, mmWalletInfo, tokenBalance * 0.5);
                }
            } else {
                // Non-graduated - use Pump.fun bonding curve via contract
                const pumpAccounts = derivePumpFunAccountsFromMint(mintPubkey);
                
                this.log(`Trading via PDA: ${this.pdaAddress.slice(0,8)}...`, 'info');
                
                if (actuallyBuy) {
                    await this._executeBuyViaContract(conn, operatorKeypair, mmWalletInfo, pumpAccounts, tradeAmount, tokenStatus);
                } else {
                    await this._executeSellViaContract(conn, operatorKeypair, mmWalletInfo, pumpAccounts, tokenBalance * 0.5, tokenStatus);
                }
            }
            
            // Wait before next trade
            const delay = (this.config.minDelayMs + Math.random() * (this.config.maxDelayMs - this.config.minDelayMs)) / 1000;
            await new Promise(r => setTimeout(r, delay * 1000));
            
        } catch (e) {
            this.log(`Trade error: ${e.message}`, 'error');
            
            // Check for BondingCurveComplete error - indicates token graduated
            if (e.message.includes('BondingCurveComplete') || e.message.includes('0x1775') || e.message.includes('6005')) {
                this.log(`🎓 Detected BondingCurveComplete - token has GRADUATED to PumpSwap!`, 'info');
                this.isGraduated = true;
                
                // Try to find the PumpSwap pool
                try {
                    const conn = this.manager.getConnection();
                    const pool = await findPumpSwapPool(conn, new PublicKey(this.tokenMint));
                    if (pool) {
                        this.pumpSwapPool = pool;
                        this.log(`✅ Found PumpSwap pool: ${pool.toBase58()}`, 'info');
                        this.log(`Next trade will use PumpSwap AMM`, 'info');
                    }
                } catch (poolError) {
                    this.log(`Could not find PumpSwap pool: ${poolError.message}`, 'warn');
                }
            }
        }
    }
    
    /**
     * Get a regular wallet keypair (with stored private key) for trading
     */
    _getRegularWalletKeypair() {
        try {
            // Check if the PDA address is actually a regular wallet
            let wallet = this.manager.db.prepare(
                'SELECT publicKey, privateKey FROM wallets WHERE publicKey = ?'
            ).get(this.pdaAddress);
            
            if (wallet && wallet.privateKey) {
                const decoded = bs58.default.decode(wallet.privateKey);
                return Keypair.fromSecretKey(decoded);
            }
            
            return null;
        } catch (e) {
            return null;
        }
    }
    
    async _executeBuyViaContract(conn, operatorKeypair, mmWalletInfo, pumpAccounts, tradeAmount, tokenStatus) {
        try {
            const amountLamports = Math.floor(tradeAmount * LAMPORTS_PER_SOL);
            
            // Calculate expected tokens based on current price (with slippage)
            // tokenStatus.price is price per token in SOL
            const priceSOL = tokenStatus.price || 0;
            const expectedTokens = priceSOL > 0 
                ? Math.floor((tradeAmount / priceSOL) * 1e6)  // 6 decimals
                : 100000; // Fallback: expect 100k tokens
            const minTokens = Math.max(1, Math.floor(expectedTokens * 0.80)); // 20% slippage, min 1
            
            this.log(`BUY ${tradeAmount.toFixed(4)} SOL via PDA (expect ~${(expectedTokens/1e6).toFixed(0)} tokens)`, 'trade');
            
            // Get VAULT's token ATA (vault PDA holds SOL and receives tokens)
            // DEPLOYED contract: pda_wallet seeds=["vault",...] - DIFFERENT from mm_wallet!
            const { ata: vaultTokenAta, createIx: createAtaIx } = 
                await this._getOrCreateVaultTokenAta(conn, mmWalletInfo.vault, operatorKeypair);
            
            // Get token creator from tokenStatus (parsed from bonding curve)
            const tokenCreator = tokenStatus.creator || mmWalletInfo.vault; // Fallback to vault
            
            // Create the execute_buy instruction
            // mmWallet = state account, vault = pda_wallet (holds SOL for trading)
            const buyIx = createExecuteBuyInstruction(
                mmWalletInfo.mmWalletPda,   // mm_wallet state account
                mmWalletInfo.vault,         // pda_wallet = VAULT! (holds SOL)
                operatorKeypair.publicKey,  // Signer (operator OR owner)
                this.tokenMint,
                pumpAccounts.bondingCurve,
                pumpAccounts.associatedBondingCurve,
                vaultTokenAta,              // vault's ATA receives tokens
                tokenCreator,               // token creator for fee vault
                amountLamports,
                minTokens
            );
            
            // Build transaction - include create ATA instruction if needed
            const tx = new Transaction();
            if (createAtaIx) {
                this.log(`Adding ATA creation instruction`, 'info');
                tx.add(createAtaIx);
            }
            tx.add(buyIx);
            
            const { blockhash } = await conn.getLatestBlockhash();
            tx.recentBlockhash = blockhash;
            
            // Operator pays network fee + ATA creation rent if needed
            // mmWallet PDA pays the actual trade amount + Pump.fun's trading fee
            tx.feePayer = operatorKeypair.publicKey;
            
            const signature = await sendAndConfirmTransaction(conn, tx, [operatorKeypair], {
                skipPreflight: false,  // Enable preflight to catch errors early
                commitment: 'confirmed'
            });
            
            this.stats.totalTrades++;
            this.stats.totalVolume += tradeAmount;
            this.stats.lastTrade = { type: 'buy', amount: tradeAmount, time: Date.now(), signature };
            this._updateDB();
            
            // Record vault trade time for shared rate limiting
            this.manager.recordVaultTrade(mmWalletInfo.vault.toBase58());
            
            this.log(`BUY SUCCESS: ${signature.slice(0, 20)}...`, 'trade');
            
        } catch (e) {
            this.log(`Buy failed: ${e.message}`, 'error');
            throw e;
        }
    }
    
    async _executeSellViaContract(conn, operatorKeypair, mmWalletInfo, pumpAccounts, tokenAmount, tokenStatus) {
        try {
            const tokenAmountRaw = Math.floor(tokenAmount * 1e6); // Assuming 6 decimals
            const minSolOut = 1; // Minimal slippage protection
            
            this.log(`SELL ${tokenAmount.toFixed(2)} tokens via PDA`, 'trade');
            
            // Get VAULT's token ATA (should exist after buy)
            const { ata: vaultTokenAta } = 
                await this._getOrCreateVaultTokenAta(conn, mmWalletInfo.vault, operatorKeypair);
            
            // Get token creator from tokenStatus (parsed from bonding curve)
            const tokenCreator = tokenStatus.creator || mmWalletInfo.vault; // Fallback to vault
            
            // Create the execute_sell instruction
            // mmWallet = state account, vault = pda_wallet (holds tokens for selling)
            const sellIx = createExecuteSellInstruction(
                mmWalletInfo.mmWalletPda,   // mm_wallet state account
                mmWalletInfo.vault,         // pda_wallet = VAULT! (holds tokens)
                operatorKeypair.publicKey,  // Signer (operator OR owner)
                this.tokenMint,
                pumpAccounts.bondingCurve,
                pumpAccounts.associatedBondingCurve,
                vaultTokenAta,              // vault's ATA holds the tokens
                tokenCreator,               // token creator for fee vault
                tokenAmountRaw,
                minSolOut
            );
            
            const tx = new Transaction().add(sellIx);
            const { blockhash } = await conn.getLatestBlockhash();
            tx.recentBlockhash = blockhash;
            
            // Operator pays network fee, mmWallet PDA pays trade fees
            tx.feePayer = operatorKeypair.publicKey;
            
            const signature = await sendAndConfirmTransaction(conn, tx, [operatorKeypair], {
                skipPreflight: false,  // Enable preflight to catch errors early
                commitment: 'confirmed'
            });
            
            this.stats.totalTrades++;
            this.stats.totalVolume += tokenStatus.price * tokenAmount || 0;
            this.stats.lastTrade = { type: 'sell', amount: tokenAmount, time: Date.now(), signature };
            this._updateDB();
            
            // Record vault trade time for shared rate limiting
            this.manager.recordVaultTrade(mmWalletInfo.vault.toBase58());
            
            this.log(`SELL SUCCESS: ${signature.slice(0, 20)}...`, 'trade');
            
        } catch (e) {
            this.log(`Sell failed: ${e.message}`, 'error');
            throw e;
        }
    }
    
    /**
     * Execute BUY via PumpSwap AMM (for graduated tokens)
     * Uses operator wallet to trade, then transfers tokens to vault
     */
    async _executeBuyViaPumpSwap(conn, operatorKeypair, mmWalletInfo, tradeAmount) {
        try {
            this.log(`BUY ${tradeAmount.toFixed(4)} SOL via PumpSwap`, 'trade');
            
            // Get current price from PumpSwap
            const priceInfo = await getPumpSwapPrice(conn, new PublicKey(this.tokenMint));
            if (!priceInfo) {
                throw new Error('Could not get PumpSwap price');
            }
            
            const expectedTokens = Math.floor((tradeAmount / priceInfo.price) * 1e6);
            this.log(`PumpSwap price: ${priceInfo.price.toFixed(12)} SOL/token, expected: ${(expectedTokens / 1e6).toFixed(2)} tokens`, 'info');
            
            // Execute buy via PumpSwap (operator pays and receives tokens)
            const signature = await buyOnPumpSwap(
                conn, 
                operatorKeypair, 
                new PublicKey(this.tokenMint), 
                tradeAmount, 
                this.config.slippage
            );
            
            this.stats.totalTrades++;
            this.stats.totalVolume += tradeAmount;
            this.stats.lastTrade = { type: 'buy', amount: tradeAmount, time: Date.now(), signature };
            this._updateDB();
            
            // Record vault trade time for shared rate limiting
            this.manager.recordVaultTrade(mmWalletInfo.vault.toBase58());
            
            this.log(`PUMPSWAP BUY SUCCESS: ${signature.slice(0, 20)}...`, 'trade');
            
        } catch (e) {
            this.log(`PumpSwap buy failed: ${e.message}`, 'error');
            
            // If it's a "pool not found" error, mark as non-graduated
            if (e.message.includes('pool not found')) {
                this.isGraduated = false;
                this.pumpSwapPool = null;
                this.log(`Token may not be graduated - switching back to bonding curve`, 'warn');
            }
            
            throw e;
        }
    }
    
    /**
     * Execute SELL via PumpSwap AMM (for graduated tokens)
     * Uses operator wallet to sell tokens
     */
    async _executeSellViaPumpSwap(conn, operatorKeypair, mmWalletInfo, tokenAmount) {
        try {
            const tokenAmountRaw = Math.floor(tokenAmount * 1e6);
            
            this.log(`SELL ${tokenAmount.toFixed(2)} tokens via PumpSwap`, 'trade');
            
            // Get current price from PumpSwap
            const priceInfo = await getPumpSwapPrice(conn, new PublicKey(this.tokenMint));
            if (!priceInfo) {
                throw new Error('Could not get PumpSwap price');
            }
            
            const expectedSol = tokenAmount * priceInfo.price;
            this.log(`PumpSwap price: ${priceInfo.price.toFixed(12)} SOL/token, expected: ${expectedSol.toFixed(6)} SOL`, 'info');
            
            // Execute sell via PumpSwap (operator sells tokens)
            const signature = await sellOnPumpSwap(
                conn,
                operatorKeypair,
                new PublicKey(this.tokenMint),
                tokenAmountRaw,
                this.config.slippage
            );
            
            this.stats.totalTrades++;
            this.stats.totalVolume += expectedSol;
            this.stats.lastTrade = { type: 'sell', amount: tokenAmount, time: Date.now(), signature };
            this._updateDB();
            
            // Record vault trade time for shared rate limiting
            this.manager.recordVaultTrade(mmWalletInfo.vault.toBase58());
            
            this.log(`PUMPSWAP SELL SUCCESS: ${signature.slice(0, 20)}...`, 'trade');
            
        } catch (e) {
            this.log(`PumpSwap sell failed: ${e.message}`, 'error');
            
            // If it's a "pool not found" error, mark as non-graduated
            if (e.message.includes('pool not found')) {
                this.isGraduated = false;
                this.pumpSwapPool = null;
                this.log(`Token may not be graduated - switching back to bonding curve`, 'warn');
            }
            
            throw e;
        }
    }
    
    async _getMmWalletInfo() {
        try {
            const conn = this.manager.getConnection();
            
            // Get owner and nonce from database
            const dbBot = this.manager.db.prepare('SELECT * FROM persistent_bots WHERE tokenMint = ?').get(this.tokenMint);
            if (!dbBot) {
                this.log(`No bot found in DB for tokenMint: ${this.tokenMint}`, 'error');
                return null;
            }
            
            const contractWallet = this.manager.db.prepare('SELECT * FROM contract_wallets WHERE pdaAddress = ?').get(this.pdaAddress);
            if (!contractWallet) {
                this.log(`No contract wallet found for pdaAddress: ${this.pdaAddress}`, 'error');
                return null;
            }
            
            this.log(`Contract wallet: owner=${contractWallet.ownerWallet}, nonce=${contractWallet.nonce}`, 'info');
            
            const ownerPubkey = new PublicKey(contractWallet.ownerWallet);
            const nonce = contractWallet.nonce || 0;
            
            const { pda: mmWalletPda } = getMmWalletPDA(ownerPubkey, nonce);
            const { pda: vault } = getPdaWalletAddress(ownerPubkey, nonce);
            
            this.log(`Derived: mmWallet=${mmWalletPda.toBase58()}, vault=${vault.toBase58()}`, 'info');
            
            // Read on-chain config
            let tradeSizePct = 25; // Default 25%
            let minDelaySecs = 30; // Default 30 seconds
            let maxDelaySecs = 120; // Default 120 seconds
            try {
                const { getMmWalletInfo } = await import('../contract/index.js');
                const onChainInfo = await getMmWalletInfo(conn, mmWalletPda);
                if (onChainInfo && onChainInfo.config) {
                    tradeSizePct = onChainInfo.config.tradeSizePct || 25;
                    minDelaySecs = onChainInfo.config.minDelaySecs || 30;
                    maxDelaySecs = onChainInfo.config.maxDelaySecs || 120;
                    this.log(`On-chain config: tradeSizePct=${tradeSizePct}%, delay=${minDelaySecs}-${maxDelaySecs}s`, 'info');
                }
            } catch (e) {
                this.log(`Could not read on-chain config, using defaults: ${e.message}`, 'warn');
            }
            
            return {
                mmWalletPda,
                vault,
                owner: ownerPubkey,
                nonce,
                tradeSizePct,
                minDelaySecs,
                maxDelaySecs
            };
        } catch (e) {
            this.log(`getMmWalletInfo error: ${e.message}`, 'error');
            return null;
        }
    }
    
    async _getOrCreateVaultTokenAta(conn, vaultPubkey, operatorKeypair) {
        const { 
            getAssociatedTokenAddress, 
            createAssociatedTokenAccountInstruction,
            getAccount,
            TOKEN_PROGRAM_ID,
            TOKEN_2022_PROGRAM_ID
        } = await import('@solana/spl-token');
        
        const tokenMintPubkey = new PublicKey(this.tokenMint);
        
        // Detect token program (Token-2022 or regular)
        const mintInfo = await conn.getAccountInfo(tokenMintPubkey);
        const tokenProgram = mintInfo?.owner?.equals(TOKEN_2022_PROGRAM_ID) 
            ? TOKEN_2022_PROGRAM_ID 
            : TOKEN_PROGRAM_ID;
        
        const ata = await getAssociatedTokenAddress(
            tokenMintPubkey,
            vaultPubkey,
            true, // allowOwnerOffCurve for PDAs
            tokenProgram
        );
        
        // Check if ATA exists
        try {
            await getAccount(conn, ata, undefined, tokenProgram);
            // ATA exists, just return it
            return { ata, createIx: null, tokenProgram };
        } catch (e) {
            // ATA doesn't exist - need to create it
            this.log(`Creating token ATA for vault PDA (${tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'Token'})...`, 'info');
            
            const createIx = createAssociatedTokenAccountInstruction(
                operatorKeypair.publicKey, // payer
                ata,                        // ata address
                vaultPubkey,               // owner (the vault PDA)
                tokenMintPubkey,           // mint
                tokenProgram               // token program
            );
            
            return { ata, createIx, tokenProgram };
        }
    }
    
    async _getVaultBalance() {
        try {
            const conn = this.manager.getConnection();
            
            // DEPLOYED contract: SOL is in VAULT PDA (seeds=["vault", owner, nonce])
            // Need to derive vault from owner/nonce stored in DB
            const contractWallet = this.manager.db.prepare('SELECT * FROM contract_wallets WHERE pdaAddress = ?').get(this.pdaAddress);
            if (contractWallet) {
                const ownerPubkey = new PublicKey(contractWallet.ownerWallet);
                const nonce = contractWallet.nonce || 0;
                const { pda: vault } = getPdaWalletAddress(ownerPubkey, nonce);
                const vaultBalance = await conn.getBalance(vault);
                return vaultBalance / LAMPORTS_PER_SOL;
            }
            
            // Fallback - shouldn't happen
            this.log(`No contract wallet found, using pdaAddress`, 'warn');
            const pubkey = new PublicKey(this.pdaAddress);
            const balance = await conn.getBalance(pubkey);
            return balance / LAMPORTS_PER_SOL;
        } catch (e) {
            this.log(`Balance check error: ${e.message}`, 'error');
            return 0;
        }
    }
    
    async _getTokenBalance() {
        try {
            const conn = this.manager.getConnection();
            const mintPubkey = new PublicKey(this.tokenMint);
            
            // Detect token program first
            const { getAssociatedTokenAddress: getAta, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
            const mintInfo = await conn.getAccountInfo(mintPubkey);
            const tokenProgram = mintInfo?.owner?.equals(TOKEN_2022_PROGRAM_ID) 
                ? TOKEN_2022_PROGRAM_ID 
                : TOKEN_PROGRAM_ID;
            
            // For graduated tokens, also check operator's balance
            if (this.isGraduated && this.manager.operatorKeypair) {
                const operatorAta = await getAta(
                    mintPubkey,
                    this.manager.operatorKeypair.publicKey,
                    false,
                    tokenProgram
                );
                
                try {
                    const balanceInfo = await conn.getTokenAccountBalance(operatorAta);
                    const balance = balanceInfo.value.uiAmount || 0;
                    if (balance > 0) {
                        this.log(`Token balance (operator): ${balance.toFixed(2)}`, 'info');
                    }
                    return balance;
                } catch (ataError) {
                    // ATA doesn't exist - no tokens
                    return 0;
                }
            }
            
            // Non-graduated: Tokens are in the VAULT PDA
            const contractWallet = this.manager.db.prepare('SELECT * FROM contract_wallets WHERE pdaAddress = ?').get(this.pdaAddress);
            if (!contractWallet) return 0;
            
            const ownerPubkey = new PublicKey(contractWallet.ownerWallet);
            const nonce = contractWallet.nonce || 0;
            const { pda: vault } = getPdaWalletAddress(ownerPubkey, nonce);
            
            const vaultAta = await getAta(
                mintPubkey,
                vault,
                true, // allowOwnerOffCurve for PDAs
                tokenProgram
            );
            
            try {
                const balanceInfo = await conn.getTokenAccountBalance(vaultAta);
                const balance = balanceInfo.value.uiAmount || 0;
                if (balance > 0) {
                    this.log(`Token balance: ${balance.toFixed(2)}`, 'info');
                }
                return balance;
            } catch (ataError) {
                // ATA doesn't exist yet - no tokens
                return 0;
            }
        } catch (e) {
            this.log(`Token balance check error: ${e.message}`, 'warn');
            return 0;
        }
    }
    
    async _claimFees() {
        try {
            this.log(`Checking fees to claim...`, 'info');
            
            const conn = this.manager.getConnection();
            const vaultPubkey = new PublicKey(this.pdaAddress);
            
            const fees = await checkAllFees(conn, vaultPubkey);
            
            if (fees.totalSOL >= 0.001) {
                this.log(`Claiming ${fees.totalSOL.toFixed(4)} SOL in fees`, 'info');
                // Note: Fee claiming for PDA requires special handling
                // This may need to be done through the contract
            }
            
            this.lastFeeClaim = Date.now();
        } catch (e) {
            this.log(`Fee claim error: ${e.message}`, 'error');
        }
    }
    
    updateStrategy(strategy, config) {
        this.strategy = strategy;
        this.strategyConfig = config;
        this.config = { ...this.config, ...config };
        this.log(`Strategy updated to: ${strategy}`, 'info');
        this._updateDB();
    }
    
    getStatus() {
        return {
            id: this.id,
            tokenMint: this.tokenMint,
            pdaAddress: this.pdaAddress,
            ownerWallet: this.ownerWallet,
            strategy: this.strategy,
            isRunning: this.isRunning,
            isPaused: this.isPaused,
            pauseReason: this.pauseReason,
            stats: this.stats,
            config: this.config,
            uptime: this.stats.startTime ? Date.now() - this.stats.startTime : 0
        };
    }
    
    log(message, level = 'info') {
        const prefix = `[Bot:${this.tokenMint.slice(0, 6)}]`;
        const timestamp = new Date().toISOString();
        
        console.log(`${timestamp} ${prefix} ${message}`);
        
        // Persist to database
        this.manager.saveLog(this.id, this.tokenMint, message, level, timestamp);
        
        // Broadcast to connected clients
        this.manager.broadcast({
            type: 'bot-log',
            botId: this.id,
            tokenMint: this.tokenMint,
            pdaAddress: this.pdaAddress,
            message,
            level,
            timestamp
        });
    }
    
    _updateDB() {
        this.manager.updateBotInDB(this);
    }
    
    _randomDelay() {
        return this.config.minDelayMs + 
            Math.random() * (this.config.maxDelayMs - this.config.minDelayMs);
    }
    
    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// ============================================================================
// PERSISTENT BOT MANAGER
// ============================================================================

export class PersistentBotManager {
    constructor(db, getConnection, broadcast) {
        this.db = db;
        this._getConnection = getConnection;
        this._broadcast = broadcast;
        this.bots = new Map(); // tokenMint -> PersistentBot
        this.operatorKeypair = null;
        this.vaultLastTrade = new Map(); // vault address -> timestamp (for shared rate limiting)
        
        // Initialize database table
        this._initDB();
        
        // Load or generate operator keypair
        this._initOperatorKeypair();
    }
    
    /**
     * Check if vault can trade (rate limit check across all bots using same vault)
     */
    canVaultTrade(vaultAddress, minDelaySecs) {
        const lastTrade = this.vaultLastTrade.get(vaultAddress) || 0;
        const timeSinceLastTrade = (Date.now() - lastTrade) / 1000;
        return timeSinceLastTrade >= minDelaySecs;
    }
    
    /**
     * Record trade for vault rate limiting
     */
    recordVaultTrade(vaultAddress) {
        this.vaultLastTrade.set(vaultAddress, Date.now());
    }
    
    /**
     * Initialize or load the operator keypair for server-side trading
     * This keypair must be set as the operator on PDAs for auto-trading to work
     */
    _initOperatorKeypair() {
        // Try to load from environment variable
        const operatorKey = process.env.OPERATOR_PRIVATE_KEY;
        
        if (operatorKey) {
            try {
                // Try to parse as base58
                const secretKey = bs58.default.decode(operatorKey);
                this.operatorKeypair = Keypair.fromSecretKey(secretKey);
                console.log(`[BotManager] Loaded operator keypair: ${this.operatorKeypair.publicKey.toBase58()}`);
            } catch (e) {
                // Try as JSON array
                try {
                    const secretKey = new Uint8Array(JSON.parse(operatorKey));
                    this.operatorKeypair = Keypair.fromSecretKey(secretKey);
                    console.log(`[BotManager] Loaded operator keypair: ${this.operatorKeypair.publicKey.toBase58()}`);
                } catch (e2) {
                    console.error('[BotManager] Failed to parse OPERATOR_PRIVATE_KEY');
                }
            }
        }
        
        if (!this.operatorKeypair) {
            // Generate a new one and log it for user to save
            this.operatorKeypair = Keypair.generate();
            console.log('[BotManager] Generated new operator keypair');
            console.log(`[BotManager] OPERATOR_PUBLIC_KEY: ${this.operatorKeypair.publicKey.toBase58()}`);
            console.log(`[BotManager] \n⚠️  TO ENABLE AUTO-TRADING:`);
            console.log(`[BotManager] 1. Add this to your .env file:`);
            console.log(`OPERATOR_PRIVATE_KEY=${bs58.default.encode(this.operatorKeypair.secretKey)}`);
            console.log(`[BotManager] 2. Fund the operator with SOL for transaction fees:`);
            console.log(`[BotManager]    Send ~0.1 SOL to: ${this.operatorKeypair.publicKey.toBase58()}`);
            console.log(`[BotManager] 3. Set this pubkey as operator on your PDAs via the frontend.\n`);
        } else {
            console.log(`[BotManager] Loaded operator from .env: ${this.operatorKeypair.publicKey.toBase58()}`);
        }
    }
    
    getOperatorKeypair() {
        return this.operatorKeypair;
    }
    
    getOperatorPublicKey() {
        return this.operatorKeypair?.publicKey?.toBase58();
    }
    
    _initDB() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS persistent_bots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tokenMint TEXT UNIQUE NOT NULL,
                pdaAddress TEXT NOT NULL,
                ownerWallet TEXT NOT NULL,
                strategy TEXT DEFAULT 'volume',
                strategyConfig TEXT DEFAULT '{}',
                totalTrades INTEGER DEFAULT 0,
                totalVolume REAL DEFAULT 0,
                lastTrade DATETIME,
                status TEXT DEFAULT 'running',
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS bot_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                botId INTEGER,
                tokenMint TEXT NOT NULL,
                message TEXT NOT NULL,
                level TEXT DEFAULT 'info',
                timestamp TEXT NOT NULL,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE INDEX IF NOT EXISTS idx_bot_logs_token ON bot_logs(tokenMint);
            CREATE INDEX IF NOT EXISTS idx_bot_logs_time ON bot_logs(timestamp DESC);
        `);
        
        console.log('[BotManager] Database initialized');
    }
    
    getConnection() {
        return this._getConnection();
    }
    
    broadcast(data) {
        if (this._broadcast) {
            this._broadcast(data);
        }
    }
    
    /**
     * Start a new persistent bot for a token
     */
    async startBot(tokenMint, pdaAddress, ownerWallet, strategy = 'volume', strategyConfig = {}) {
        // Check if bot already exists
        if (this.bots.has(tokenMint)) {
            console.log(`[BotManager] Bot already running for ${tokenMint.slice(0, 8)}...`);
            return this.bots.get(tokenMint);
        }
        
        // Check if in DB
        let dbBot = this.db.prepare('SELECT * FROM persistent_bots WHERE tokenMint = ?').get(tokenMint);
        
        if (!dbBot) {
            // Insert new bot
            this.db.prepare(`
                INSERT INTO persistent_bots (tokenMint, pdaAddress, ownerWallet, strategy, strategyConfig)
                VALUES (?, ?, ?, ?, ?)
            `).run(tokenMint, pdaAddress, ownerWallet, strategy, JSON.stringify(strategyConfig));
            
            dbBot = this.db.prepare('SELECT * FROM persistent_bots WHERE tokenMint = ?').get(tokenMint);
        }
        
        // Create and start bot with LOADED STATS from DB
        const bot = new PersistentBot(this, {
            id: dbBot.id,
            tokenMint,
            pdaAddress,
            ownerWallet,
            strategy: dbBot.strategy,
            strategyConfig: JSON.parse(dbBot.strategyConfig || '{}'),
            // Load persisted stats!
            totalTrades: dbBot.totalTrades || 0,
            totalVolume: dbBot.totalVolume || 0,
            lastTrade: dbBot.lastTrade
        });
        
        await bot.start();
        this.bots.set(tokenMint, bot);
        
        console.log(`[BotManager] Started bot for ${tokenMint.slice(0, 8)}... (Total: ${this.bots.size})`);
        
        return bot;
    }
    
    /**
     * Load and start all bots from database
     */
    async resumeAllBots() {
        console.log('[BotManager] Resuming all persistent bots...');
        
        const dbBots = this.db.prepare('SELECT * FROM persistent_bots WHERE status = ?').all('running');
        
        console.log(`[BotManager] Found ${dbBots.length} bots to resume`);
        
        for (const dbBot of dbBots) {
            try {
                await this.startBot(
                    dbBot.tokenMint,
                    dbBot.pdaAddress,
                    dbBot.ownerWallet,
                    dbBot.strategy,
                    JSON.parse(dbBot.strategyConfig || '{}')
                );
            } catch (e) {
                console.error(`[BotManager] Failed to resume bot ${dbBot.tokenMint}: ${e.message}`);
            }
        }
        
        console.log(`[BotManager] Resumed ${this.bots.size} bots`);
    }
    
    /**
     * Start bots for all tokens in the tokens table that don't have bots
     */
    async startBotsForExistingTokens() {
        console.log('[BotManager] Checking for existing tokens without bots...');
        
        // Get all tokens from contract_wallets that have a tokenMint
        const walletsWithTokens = this.db.prepare(`
            SELECT DISTINCT cw.tokenMint, cw.pdaAddress, cw.ownerWallet
            FROM contract_wallets cw
            WHERE cw.tokenMint IS NOT NULL 
            AND cw.tokenMint != ''
            AND NOT EXISTS (
                SELECT 1 FROM persistent_bots pb WHERE pb.tokenMint = cw.tokenMint
            )
        `).all();
        
        console.log(`[BotManager] Found ${walletsWithTokens.length} tokens without bots`);
        
        for (const wallet of walletsWithTokens) {
            try {
                await this.startBot(
                    wallet.tokenMint,
                    wallet.pdaAddress,
                    wallet.ownerWallet
                );
            } catch (e) {
                console.error(`[BotManager] Failed to start bot for ${wallet.tokenMint}: ${e.message}`);
            }
        }
        
        // Start background task to continuously check for new tokens
        this._startTokenWatcher();
    }
    
    /**
     * Background task that watches for new tokens and starts bots immediately
     * This ensures no token ever goes without a bot
     */
    _startTokenWatcher() {
        if (this._tokenWatcherInterval) return;
        
        console.log('[BotManager] Starting token watcher (checks every 10s for new tokens)');
        
        this._tokenWatcherInterval = setInterval(async () => {
            try {
                const newTokens = this.db.prepare(`
                    SELECT DISTINCT cw.tokenMint, cw.pdaAddress, cw.ownerWallet
                    FROM contract_wallets cw
                    WHERE cw.tokenMint IS NOT NULL 
                    AND cw.tokenMint != ''
                    AND NOT EXISTS (
                        SELECT 1 FROM persistent_bots pb WHERE pb.tokenMint = cw.tokenMint
                    )
                `).all();
                
                for (const wallet of newTokens) {
                    console.log(`[BotManager] New token detected: ${wallet.tokenMint.slice(0, 8)}... - starting bot immediately!`);
                    await this.startBot(
                        wallet.tokenMint,
                        wallet.pdaAddress,
                        wallet.ownerWallet
                    );
                }
            } catch (e) {
                // Silent fail - will retry next interval
            }
        }, 10000); // Check every 10 seconds
    }
    
    /**
     * Update bot strategy
     */
    updateStrategy(tokenMint, strategy, config) {
        const bot = this.bots.get(tokenMint);
        if (bot) {
            bot.updateStrategy(strategy, config);
            return true;
        }
        return false;
    }
    
    /**
     * Get bot status
     */
    getBotStatus(tokenMint) {
        const bot = this.bots.get(tokenMint);
        return bot ? bot.getStatus() : null;
    }
    
    /**
     * Get all bots status
     */
    getAllBotsStatus() {
        const statuses = [];
        for (const [tokenMint, bot] of this.bots) {
            statuses.push(bot.getStatus());
        }
        return statuses;
    }
    
    /**
     * Get aggregate stats across all bots
     */
    getAggregateStats() {
        let totalVolume = 0;
        let totalTrades = 0;
        let activeBots = 0;
        
        for (const [tokenMint, bot] of this.bots) {
            totalVolume += bot.stats.totalVolume || 0;
            totalTrades += bot.stats.totalTrades || 0;
            if (bot.isRunning && !bot.isPaused) activeBots++;
        }
        
        // Also get from DB for stopped bots
        const dbStats = this.db.prepare(`
            SELECT COALESCE(SUM(totalVolume), 0) as totalVolume, 
                   COALESCE(SUM(totalTrades), 0) as totalTrades,
                   COUNT(*) as totalBots
            FROM persistent_bots
        `).get();
        
        return {
            totalVolume: Math.max(totalVolume, dbStats.totalVolume),
            totalTrades: Math.max(totalTrades, dbStats.totalTrades),
            activeBots,
            totalBots: dbStats.totalBots
        };
    }
    
    /**
     * Update bot in database
     */
    updateBotInDB(bot) {
        this.db.prepare(`
            UPDATE persistent_bots 
            SET strategy = ?, strategyConfig = ?, totalTrades = ?, totalVolume = ?, 
                lastTrade = ?, updatedAt = CURRENT_TIMESTAMP
            WHERE tokenMint = ?
        `).run(
            bot.strategy,
            JSON.stringify(bot.strategyConfig),
            bot.stats.totalTrades,
            bot.stats.totalVolume,
            bot.stats.lastTrade ? new Date(bot.stats.lastTrade.time).toISOString() : null,
            bot.tokenMint
        );
    }
    
    /**
     * Save log to database for persistence
     */
    saveLog(botId, tokenMint, message, level, timestamp) {
        try {
            this.db.prepare(`
                INSERT INTO bot_logs (botId, tokenMint, message, level, timestamp)
                VALUES (?, ?, ?, ?, ?)
            `).run(botId, tokenMint, message, level, timestamp);
            
            // Keep only last 1000 logs per token to prevent bloat
            this.db.prepare(`
                DELETE FROM bot_logs WHERE tokenMint = ? AND id NOT IN (
                    SELECT id FROM bot_logs WHERE tokenMint = ? ORDER BY id DESC LIMIT 1000
                )
            `).run(tokenMint, tokenMint);
        } catch (e) {
            // Silent fail - logging shouldn't break trading
        }
    }
    
    /**
     * Get recent logs for a token (for frontend display on reconnect)
     */
    getRecentLogs(tokenMint, limit = 50) {
        try {
            return this.db.prepare(`
                SELECT * FROM bot_logs WHERE tokenMint = ? ORDER BY id DESC LIMIT ?
            `).all(tokenMint, limit).reverse(); // Reverse to get chronological order
        } catch (e) {
            return [];
        }
    }
    
    /**
     * Get all recent logs (for frontend display on reconnect)
     */
    getAllRecentLogs(limit = 100) {
        try {
            return this.db.prepare(`
                SELECT * FROM bot_logs ORDER BY id DESC LIMIT ?
            `).all(limit).reverse();
        } catch (e) {
            return [];
        }
    }
    
    /**
     * Get count of running bots
     */
    getRunningCount() {
        return this.bots.size;
    }
}

export default PersistentBotManager;

