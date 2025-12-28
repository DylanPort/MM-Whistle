// ═══════════════════════════════════════════════════════════════════════════════
// MM WALLET PROGRAM v2.0 - SECURITY HARDENED
// All audit findings addressed
// ═══════════════════════════════════════════════════════════════════════════════

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_instruction};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("8M6v875sN8xt5EZcwKGS5nd7pcFtMnQPhRvPyssTYzEu");

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/// Pump.fun program ID (mainnet)
pub const PUMP_FUN_PROGRAM: Pubkey = pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

/// PumpSwap program ID (mainnet)  
pub const PUMPSWAP_PROGRAM: Pubkey = pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");

/// Minimum SOL to keep for rent (0.01 SOL)
pub const MIN_RENT_RESERVE: u64 = 10_000_000;

/// Maximum trade percentage (50% of balance)
pub const MAX_TRADE_PCT: u8 = 50;

/// Minimum lock duration (0 = no lock)
pub const MIN_LOCK_SECONDS: i64 = 0;

/// Maximum lock duration (365 days)
pub const MAX_LOCK_SECONDS: i64 = 365 * 24 * 60 * 60;

/// Maximum cumulative lock (5 years)
pub const MAX_TOTAL_LOCK_SECONDS: i64 = 5 * 365 * 24 * 60 * 60;

/// Minimum slippage protection (0.1%)
pub const MIN_SLIPPAGE_BPS: u16 = 10;

/// Maximum slippage allowed (50%)
pub const MAX_SLIPPAGE_BPS: u16 = 5000;

/// Program version for migrations
pub const PROGRAM_VERSION: u8 = 2;

// Pump.fun instruction discriminators (documented)
pub const PUMP_BUY_DISCRIMINATOR: [u8; 8] = [102, 6, 61, 18, 1, 218, 235, 234];
pub const PUMP_SELL_DISCRIMINATOR: [u8; 8] = [51, 230, 133, 164, 1, 127, 131, 173];
pub const PUMP_CREATE_DISCRIMINATOR: [u8; 8] = [24, 30, 200, 40, 5, 28, 7, 119];
pub const PUMP_WITHDRAW_DISCRIMINATOR: [u8; 8] = [183, 18, 70, 156, 148, 109, 161, 34];

// ═══════════════════════════════════════════════════════════════════════════════
// EVENTS
// ═══════════════════════════════════════════════════════════════════════════════

#[event]
pub struct WalletInitialized {
    pub owner: Pubkey,
    pub wallet: Pubkey,
    pub lock_until: i64,
    pub strategy: u8,
}

#[event]
pub struct Deposited {
    pub wallet: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Withdrawn {
    pub wallet: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct TradeExecuted {
    pub wallet: Pubkey,
    pub trade_type: u8, // 0=buy, 1=sell
    pub amount_in: u64,
    pub min_amount_out: u64,
    pub timestamp: i64,
}

#[event]
pub struct FeesClaimed {
    pub wallet: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct StrategyUpdated {
    pub wallet: Pubkey,
    pub old_strategy: u8,
    pub new_strategy: u8,
}

#[event]
pub struct OperatorChanged {
    pub wallet: Pubkey,
    pub old_operator: Pubkey,
    pub new_operator: Pubkey,
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE ACCOUNTS
// ═══════════════════════════════════════════════════════════════════════════════

/// Main MM Wallet account - stores configuration and state
#[account]
pub struct MmWallet {
    /// Account version for migrations
    pub version: u8,
    
    /// PDA bump seed
    pub bump: u8,
    
    /// Owner who controls this wallet (user's connected wallet)
    pub owner: Pubkey,
    
    /// Authorized operator for trade execution (can be same as owner)
    pub operator: Pubkey,
    
    /// Token mint this MM is trading
    pub token_mint: Pubkey,
    
    /// Wallet nonce (for multiple wallets per user)
    pub nonce: u64,
    
    /// Strategy type
    pub strategy: Strategy,
    
    /// Strategy configuration
    pub config: StrategyConfig,
    
    /// Unix timestamp when lock expires (0 = no lock)
    pub lock_until: i64,
    
    /// Whether trading is currently paused
    pub paused: bool,
    
    /// Whether this wallet created the token (receives creator fees)
    pub is_creator: bool,
    
    /// Total SOL volume traded (for stats)
    pub total_volume: u64,
    
    /// Total trades executed
    pub total_trades: u64,
    
    /// Total fees claimed
    pub total_fees_claimed: u64,
    
    /// Last trade timestamp (for rate limiting)
    pub last_trade: i64,
    
    /// Creation timestamp
    pub created_at: i64,
    
    /// Reserved space for future upgrades
    pub reserved: [u8; 64],
}

impl MmWallet {
    pub const SIZE: usize = 8 +  // discriminator
        1 +   // version
        1 +   // bump
        32 +  // owner
        32 +  // operator
        32 +  // token_mint
        8 +   // nonce
        1 +   // strategy enum
        48 +  // config (including padding)
        8 +   // lock_until
        1 +   // paused
        1 +   // is_creator
        8 +   // total_volume
        8 +   // total_trades
        8 +   // total_fees_claimed
        8 +   // last_trade
        8 +   // created_at
        64;   // reserved
    
    /// Check if caller is authorized to execute trades
    pub fn is_authorized(&self, caller: &Pubkey) -> bool {
        *caller == self.owner || *caller == self.operator
    }
    
    /// Check if wallet is currently locked
    pub fn is_locked(&self, current_time: i64) -> bool {
        self.lock_until > 0 && current_time < self.lock_until
    }
    
    /// Calculate maximum trade amount
    pub fn max_trade_amount(&self, available_balance: u64) -> Result<u64> {
        available_balance
            .checked_mul(self.config.trade_size_pct as u64)
            .ok_or(error!(MmWalletError::MathOverflow))?
            .checked_div(100)
            .ok_or(error!(MmWalletError::MathOverflow))
    }
    
    /// Calculate minimum output with slippage protection
    pub fn calculate_min_output(&self, expected_output: u64) -> Result<u64> {
        let slippage_factor = 10000u64
            .checked_sub(self.config.slippage_bps as u64)
            .ok_or(error!(MmWalletError::MathOverflow))?;
        
        expected_output
            .checked_mul(slippage_factor)
            .ok_or(error!(MmWalletError::MathOverflow))?
            .checked_div(10000)
            .ok_or(error!(MmWalletError::MathOverflow))
    }
    
    /// Check if enough time has passed since last trade
    pub fn can_trade(&self, current_time: i64) -> bool {
        if self.last_trade == 0 {
            return true;
        }
        current_time >= self.last_trade + (self.config.min_delay_secs as i64)
    }
}

impl Default for MmWallet {
    fn default() -> Self {
        Self {
            version: PROGRAM_VERSION,
            bump: 0,
            owner: Pubkey::default(),
            operator: Pubkey::default(),
            token_mint: Pubkey::default(),
            nonce: 0,
            strategy: Strategy::default(),
            config: StrategyConfig::default(),
            lock_until: 0,
            paused: false,
            is_creator: false,
            total_volume: 0,
            total_trades: 0,
            total_fees_claimed: 0,
            last_trade: 0,
            created_at: 0,
            reserved: [0u8; 64],
        }
    }
}

/// Strategy types
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum Strategy {
    #[default]
    VolumeBot = 0,
    PriceReactive = 1,
    GridTrading = 2,
    TrendFollower = 3,
    SpreadMM = 4,
    PumpHunter = 5,
}

/// Strategy configuration
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct StrategyConfig {
    /// Trade size as percentage of balance (1-50)
    pub trade_size_pct: u8,
    
    /// Minimum delay between trades in seconds
    pub min_delay_secs: u16,
    
    /// Maximum delay between trades in seconds
    pub max_delay_secs: u16,
    
    /// Slippage tolerance in basis points (10-5000, where 100 = 1%)
    pub slippage_bps: u16,
    
    /// Strategy-specific parameter 1
    pub param1: u16,
    
    /// Strategy-specific parameter 2
    pub param2: u16,
    
    /// Strategy-specific parameter 3
    pub param3: u16,
    
    /// Reserved for future parameters
    pub reserved: [u8; 32],
}

// ═══════════════════════════════════════════════════════════════════════════════
// ERRORS
// ═══════════════════════════════════════════════════════════════════════════════

#[error_code]
pub enum MmWalletError {
    #[msg("Unauthorized: Only the owner can perform this action")]
    Unauthorized,
    
    #[msg("Unauthorized: Caller is not owner or authorized operator")]
    UnauthorizedOperator,
    
    #[msg("Wallet is locked until the specified time")]
    WalletLocked,
    
    #[msg("Trading is currently paused")]
    TradingPaused,
    
    #[msg("Invalid lock duration (0 to 365 days)")]
    InvalidLockDuration,
    
    #[msg("Total lock period exceeds maximum (5 years)")]
    LockTooLong,
    
    #[msg("Invalid trade size percentage (must be 1-50)")]
    InvalidTradeSize,
    
    #[msg("Invalid slippage (must be 10-5000 bps / 0.1% - 50%)")]
    InvalidSlippage,
    
    #[msg("Insufficient balance for trade")]
    InsufficientBalance,
    
    #[msg("Trade amount exceeds maximum allowed percentage")]
    TradeExceedsMax,
    
    #[msg("Invalid program for CPI call")]
    InvalidProgram,
    
    #[msg("Token mint mismatch")]
    TokenMintMismatch,
    
    #[msg("Wallet already initialized for this nonce")]
    AlreadyInitialized,
    
    #[msg("Token not yet created for this wallet")]
    TokenNotCreated,
    
    #[msg("Token mint already set")]
    TokenMintAlreadySet,
    
    #[msg("Cannot withdraw to different address")]
    InvalidWithdrawDestination,
    
    #[msg("Must keep minimum rent reserve (0.01 SOL)")]
    BelowRentReserve,
    
    #[msg("Arithmetic overflow")]
    MathOverflow,
    
    #[msg("Invalid delay configuration (min > max)")]
    InvalidDelayConfig,
    
    #[msg("Trade rate limit exceeded - wait for cooldown")]
    TradeTooSoon,
    
    #[msg("Deposit amount must be greater than zero")]
    ZeroDeposit,
    
    #[msg("Invalid token mint account")]
    InvalidMintAccount,
    
    #[msg("Operator cannot be zero address")]
    InvalidOperator,
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROGRAM
// ═══════════════════════════════════════════════════════════════════════════════

#[program]
pub mod mm_wallet_v2 {
    use super::*;

    // ═══════════════════════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════════════════════

    /// Initialize a new MM wallet for a user
    /// 
    /// # Arguments
    /// * `nonce` - Unique identifier for this wallet (allows multiple wallets)
    /// * `lock_seconds` - How long to lock the wallet (0 = no lock)
    /// * `strategy` - Initial trading strategy
    /// * `config` - Strategy configuration
    /// * `operator` - Authorized address for trade execution
    pub fn initialize(
        ctx: Context<Initialize>,
        nonce: u64,
        lock_seconds: i64,
        strategy: Strategy,
        config: StrategyConfig,
        operator: Pubkey,
    ) -> Result<()> {
        // Validate lock duration
        require!(
            lock_seconds >= MIN_LOCK_SECONDS && lock_seconds <= MAX_LOCK_SECONDS,
            MmWalletError::InvalidLockDuration
        );
        
        // Validate operator is not zero
        require!(
            operator != Pubkey::default(),
            MmWalletError::InvalidOperator
        );
        
        // Validate config
        validate_config(&config)?;
        
        let wallet = &mut ctx.accounts.mm_wallet;
        let clock = Clock::get()?;
        
        wallet.version = PROGRAM_VERSION;
        wallet.bump = ctx.bumps.mm_wallet;
        wallet.owner = ctx.accounts.owner.key();
        wallet.operator = operator;
        wallet.token_mint = Pubkey::default();
        wallet.nonce = nonce;
        wallet.strategy = strategy;
        wallet.config = config;
        wallet.lock_until = if lock_seconds > 0 {
            clock.unix_timestamp
                .checked_add(lock_seconds)
                .ok_or(MmWalletError::MathOverflow)?
        } else {
            0
        };
        wallet.paused = false;
        wallet.is_creator = false;
        wallet.total_volume = 0;
        wallet.total_trades = 0;
        wallet.total_fees_claimed = 0;
        wallet.last_trade = 0;
        wallet.created_at = clock.unix_timestamp;
        wallet.reserved = [0u8; 64];
        
        // Emit event
        emit!(WalletInitialized {
            owner: wallet.owner,
            wallet: ctx.accounts.mm_wallet.key(),
            lock_until: wallet.lock_until,
            strategy: strategy as u8,
        });
        
        msg!("MM Wallet v{} initialized for owner: {}", PROGRAM_VERSION, wallet.owner);
        msg!("Operator: {}", wallet.operator);
        msg!("Lock until: {}", wallet.lock_until);
        
        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DEPOSITS
    // ═══════════════════════════════════════════════════════════════════════════

    /// Deposit SOL into the MM wallet PDA
    /// Anyone can deposit (e.g., user, airdrop), but only owner can withdraw
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, MmWalletError::ZeroDeposit);
        
        // Transfer SOL from depositor to PDA
        let ix = system_instruction::transfer(
            &ctx.accounts.depositor.key(),
            &ctx.accounts.pda_wallet.key(),
            amount,
        );
        
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.depositor.to_account_info(),
                ctx.accounts.pda_wallet.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
        
        // Emit event
        emit!(Deposited {
            wallet: ctx.accounts.mm_wallet.key(),
            depositor: ctx.accounts.depositor.key(),
            amount,
        });
        
        msg!("Deposited {} lamports to MM wallet", amount);
        
        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // WITHDRAWALS (Owner only, after lock)
    // ═══════════════════════════════════════════════════════════════════════════

    /// Withdraw SOL from the MM wallet (owner only, after lock expires)
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let wallet = &ctx.accounts.mm_wallet;
        let clock = Clock::get()?;
        
        // Check ownership
        require!(
            ctx.accounts.owner.key() == wallet.owner,
            MmWalletError::Unauthorized
        );
        
        // Check lock
        require!(
            !wallet.is_locked(clock.unix_timestamp),
            MmWalletError::WalletLocked
        );
        
        // Check destination is owner (prevent accidental sends)
        require!(
            ctx.accounts.destination.key() == wallet.owner,
            MmWalletError::InvalidWithdrawDestination
        );
        
        // Get PDA balance
        let pda_balance = ctx.accounts.pda_wallet.lamports();
        
        // Ensure minimum rent reserve remains
        let max_withdraw = pda_balance.saturating_sub(MIN_RENT_RESERVE);
        require!(amount <= max_withdraw, MmWalletError::BelowRentReserve);
        
        // Transfer from PDA to owner
        **ctx.accounts.pda_wallet.try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.destination.try_borrow_mut_lamports()? += amount;
        
        // Emit event
        emit!(Withdrawn {
            wallet: ctx.accounts.mm_wallet.key(),
            owner: ctx.accounts.owner.key(),
            amount,
        });
        
        msg!("Withdrawn {} lamports to owner", amount);
        
        Ok(())
    }

    /// Withdraw all tokens from the MM wallet (owner only, after lock expires)
    pub fn withdraw_tokens(ctx: Context<WithdrawTokens>) -> Result<()> {
        let wallet = &ctx.accounts.mm_wallet;
        let clock = Clock::get()?;
        
        // Check ownership
        require!(
            ctx.accounts.owner.key() == wallet.owner,
            MmWalletError::Unauthorized
        );
        
        // Check lock
        require!(
            !wallet.is_locked(clock.unix_timestamp),
            MmWalletError::WalletLocked
        );
        
        // Check token mint matches
        require!(
            ctx.accounts.token_mint.key() == wallet.token_mint,
            MmWalletError::TokenMintMismatch
        );
        
        let amount = ctx.accounts.pda_token_account.amount;
        
        if amount == 0 {
            msg!("No tokens to withdraw");
            return Ok(());
        }
        
        // Build signer seeds for PDA
        let owner_key = wallet.owner;
        let nonce_bytes = wallet.nonce.to_le_bytes();
        let seeds = &[
            b"mm_wallet",
            owner_key.as_ref(),
            nonce_bytes.as_ref(),
            &[wallet.bump],
        ];
        let signer_seeds = &[&seeds[..]];
        
        // Transfer tokens from PDA to owner
        let cpi_accounts = Transfer {
            from: ctx.accounts.pda_token_account.to_account_info(),
            to: ctx.accounts.owner_token_account.to_account_info(),
            authority: ctx.accounts.pda_wallet.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
        
        token::transfer(cpi_ctx, amount)?;
        
        msg!("Withdrawn {} tokens to owner", amount);
        
        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TRADING OPERATIONS (Authorized operator only)
    // ═══════════════════════════════════════════════════════════════════════════

    /// Execute a buy on Pump.fun bonding curve
    /// 
    /// # Security
    /// - Validates caller is owner or authorized operator
    /// - Validates target program is Pump.fun
    /// - Enforces trade amount limits
    /// - Enforces rate limiting
    /// - Calculates slippage protection on-chain
    pub fn execute_buy(
        ctx: Context<ExecuteTrade>,
        amount_lamports: u64,
        expected_tokens: u64, // Expected output from off-chain calculation
    ) -> Result<()> {
        let wallet = &mut ctx.accounts.mm_wallet;
        let clock = Clock::get()?;
        
        // ═══ AUTHORIZATION ═══
        require!(
            wallet.is_authorized(&ctx.accounts.caller.key()),
            MmWalletError::UnauthorizedOperator
        );
        
        // ═══ STATE CHECKS ═══
        require!(!wallet.paused, MmWalletError::TradingPaused);
        
        // ═══ RATE LIMITING ═══
        require!(
            wallet.can_trade(clock.unix_timestamp),
            MmWalletError::TradeTooSoon
        );
        
        // ═══ BALANCE & AMOUNT VALIDATION ═══
        let pda_balance = ctx.accounts.pda_wallet.lamports();
        let available = pda_balance.saturating_sub(MIN_RENT_RESERVE);
        
        let max_trade = wallet.max_trade_amount(available)?;
        require!(amount_lamports <= max_trade, MmWalletError::TradeExceedsMax);
        require!(amount_lamports <= available, MmWalletError::InsufficientBalance);
        
        // ═══ PROGRAM VALIDATION ═══
        require!(
            ctx.accounts.target_program.key() == PUMP_FUN_PROGRAM,
            MmWalletError::InvalidProgram
        );
        
        // ═══ SLIPPAGE PROTECTION (calculated on-chain) ═══
        let min_tokens_out = wallet.calculate_min_output(expected_tokens)?;
        
        // ═══ BUILD CPI ═══
        let owner_key = wallet.owner;
        let nonce_bytes = wallet.nonce.to_le_bytes();
        let seeds = &[
            b"mm_wallet",
            owner_key.as_ref(),
            nonce_bytes.as_ref(),
            &[wallet.bump],
        ];
        let signer_seeds = &[&seeds[..]];
        
        let mut data = PUMP_BUY_DISCRIMINATOR.to_vec();
        data.extend_from_slice(&min_tokens_out.to_le_bytes());
        data.extend_from_slice(&amount_lamports.to_le_bytes());
        
        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: PUMP_FUN_PROGRAM,
            accounts: ctx.remaining_accounts.iter().map(|a| {
                if a.is_writable {
                    anchor_lang::solana_program::instruction::AccountMeta::new(*a.key, a.is_signer)
                } else {
                    anchor_lang::solana_program::instruction::AccountMeta::new_readonly(*a.key, a.is_signer)
                }
            }).collect(),
            data,
        };
        
        // Execute CPI with PDA as signer
        invoke_signed(&ix, ctx.remaining_accounts, signer_seeds)?;
        
        // ═══ UPDATE STATS ═══
        wallet.total_volume = wallet.total_volume.saturating_add(amount_lamports);
        wallet.total_trades = wallet.total_trades.saturating_add(1);
        wallet.last_trade = clock.unix_timestamp;
        
        // Emit event
        emit!(TradeExecuted {
            wallet: ctx.accounts.mm_wallet.key(),
            trade_type: 0, // buy
            amount_in: amount_lamports,
            min_amount_out: min_tokens_out,
            timestamp: clock.unix_timestamp,
        });
        
        msg!("Executed buy: {} lamports, min tokens: {}", amount_lamports, min_tokens_out);
        
        Ok(())
    }

    /// Execute a sell on Pump.fun bonding curve
    pub fn execute_sell(
        ctx: Context<ExecuteTrade>,
        token_amount: u64,
        expected_sol: u64, // Expected output from off-chain calculation
    ) -> Result<()> {
        let wallet = &mut ctx.accounts.mm_wallet;
        let clock = Clock::get()?;
        
        // ═══ AUTHORIZATION ═══
        require!(
            wallet.is_authorized(&ctx.accounts.caller.key()),
            MmWalletError::UnauthorizedOperator
        );
        
        // ═══ STATE CHECKS ═══
        require!(!wallet.paused, MmWalletError::TradingPaused);
        
        // ═══ RATE LIMITING ═══
        require!(
            wallet.can_trade(clock.unix_timestamp),
            MmWalletError::TradeTooSoon
        );
        
        // ═══ PROGRAM VALIDATION ═══
        require!(
            ctx.accounts.target_program.key() == PUMP_FUN_PROGRAM,
            MmWalletError::InvalidProgram
        );
        
        // ═══ SLIPPAGE PROTECTION (calculated on-chain) ═══
        let min_sol_out = wallet.calculate_min_output(expected_sol)?;
        
        // ═══ BUILD CPI ═══
        let owner_key = wallet.owner;
        let nonce_bytes = wallet.nonce.to_le_bytes();
        let seeds = &[
            b"mm_wallet",
            owner_key.as_ref(),
            nonce_bytes.as_ref(),
            &[wallet.bump],
        ];
        let signer_seeds = &[&seeds[..]];
        
        let mut data = PUMP_SELL_DISCRIMINATOR.to_vec();
        data.extend_from_slice(&token_amount.to_le_bytes());
        data.extend_from_slice(&min_sol_out.to_le_bytes());
        
        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: PUMP_FUN_PROGRAM,
            accounts: ctx.remaining_accounts.iter().map(|a| {
                if a.is_writable {
                    anchor_lang::solana_program::instruction::AccountMeta::new(*a.key, a.is_signer)
                } else {
                    anchor_lang::solana_program::instruction::AccountMeta::new_readonly(*a.key, a.is_signer)
                }
            }).collect(),
            data,
        };
        
        invoke_signed(&ix, ctx.remaining_accounts, signer_seeds)?;
        
        // ═══ UPDATE STATS ═══
        wallet.total_volume = wallet.total_volume.saturating_add(expected_sol);
        wallet.total_trades = wallet.total_trades.saturating_add(1);
        wallet.last_trade = clock.unix_timestamp;
        
        // Emit event
        emit!(TradeExecuted {
            wallet: ctx.accounts.mm_wallet.key(),
            trade_type: 1, // sell
            amount_in: token_amount,
            min_amount_out: min_sol_out,
            timestamp: clock.unix_timestamp,
        });
        
        msg!("Executed sell: {} tokens, min SOL: {}", token_amount, min_sol_out);
        
        Ok(())
    }

    /// Execute a swap on PumpSwap AMM (for migrated tokens)
    pub fn execute_swap(
        ctx: Context<ExecuteSwap>,
        amount_in: u64,
        expected_out: u64,
        is_buy: bool,
    ) -> Result<()> {
        let wallet = &mut ctx.accounts.mm_wallet;
        let clock = Clock::get()?;
        
        // ═══ AUTHORIZATION ═══
        require!(
            wallet.is_authorized(&ctx.accounts.caller.key()),
            MmWalletError::UnauthorizedOperator
        );
        
        // ═══ STATE CHECKS ═══
        require!(!wallet.paused, MmWalletError::TradingPaused);
        
        // ═══ RATE LIMITING ═══
        require!(
            wallet.can_trade(clock.unix_timestamp),
            MmWalletError::TradeTooSoon
        );
        
        // ═══ PROGRAM VALIDATION ═══
        require!(
            ctx.accounts.target_program.key() == PUMPSWAP_PROGRAM,
            MmWalletError::InvalidProgram
        );
        
        // For buys, validate amount against balance
        if is_buy {
            let pda_balance = ctx.accounts.pda_wallet.lamports();
            let available = pda_balance.saturating_sub(MIN_RENT_RESERVE);
            
            let max_trade = wallet.max_trade_amount(available)?;
            require!(amount_in <= max_trade, MmWalletError::TradeExceedsMax);
            require!(amount_in <= available, MmWalletError::InsufficientBalance);
        }
        
        // ═══ SLIPPAGE PROTECTION ═══
        let min_amount_out = wallet.calculate_min_output(expected_out)?;
        
        // ═══ BUILD CPI ═══
        let owner_key = wallet.owner;
        let nonce_bytes = wallet.nonce.to_le_bytes();
        let seeds = &[
            b"mm_wallet",
            owner_key.as_ref(),
            nonce_bytes.as_ref(),
            &[wallet.bump],
        ];
        let signer_seeds = &[&seeds[..]];
        
        // PumpSwap uses different discriminators
        let discriminator = if is_buy {
            [248, 198, 158, 145, 225, 117, 135, 200]
        } else {
            [51, 230, 133, 164, 1, 127, 131, 173]
        };
        
        let mut data = discriminator.to_vec();
        data.extend_from_slice(&amount_in.to_le_bytes());
        data.extend_from_slice(&min_amount_out.to_le_bytes());
        
        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: PUMPSWAP_PROGRAM,
            accounts: ctx.remaining_accounts.iter().map(|a| {
                if a.is_writable {
                    anchor_lang::solana_program::instruction::AccountMeta::new(*a.key, a.is_signer)
                } else {
                    anchor_lang::solana_program::instruction::AccountMeta::new_readonly(*a.key, a.is_signer)
                }
            }).collect(),
            data,
        };
        
        invoke_signed(&ix, ctx.remaining_accounts, signer_seeds)?;
        
        // ═══ UPDATE STATS ═══
        wallet.total_volume = wallet.total_volume.saturating_add(amount_in);
        wallet.total_trades = wallet.total_trades.saturating_add(1);
        wallet.last_trade = clock.unix_timestamp;
        
        // Emit event
        emit!(TradeExecuted {
            wallet: ctx.accounts.mm_wallet.key(),
            trade_type: if is_buy { 0 } else { 1 },
            amount_in,
            min_amount_out,
            timestamp: clock.unix_timestamp,
        });
        
        msg!("Executed swap: {} (buy: {})", amount_in, is_buy);
        
        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // FEE CLAIMING
    // ═══════════════════════════════════════════════════════════════════════════

    /// Claim creator fees from Pump.fun
    pub fn claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
        let wallet = &mut ctx.accounts.mm_wallet;
        let clock = Clock::get()?;
        
        // Check is authorized (owner or operator can claim)
        require!(
            wallet.is_authorized(&ctx.accounts.caller.key()),
            MmWalletError::UnauthorizedOperator
        );
        
        // Check not paused
        require!(!wallet.paused, MmWalletError::TradingPaused);
        
        // Check is creator
        require!(wallet.is_creator, MmWalletError::Unauthorized);
        
        // Record balance before claim
        let balance_before = ctx.accounts.pda_wallet.lamports();
        
        // Build signer seeds for PDA
        let owner_key = wallet.owner;
        let nonce_bytes = wallet.nonce.to_le_bytes();
        let seeds = &[
            b"mm_wallet",
            owner_key.as_ref(),
            nonce_bytes.as_ref(),
            &[wallet.bump],
        ];
        let signer_seeds = &[&seeds[..]];
        
        let data = PUMP_WITHDRAW_DISCRIMINATOR.to_vec();
        
        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: PUMP_FUN_PROGRAM,
            accounts: ctx.remaining_accounts.iter().map(|a| {
                if a.is_writable {
                    anchor_lang::solana_program::instruction::AccountMeta::new(*a.key, a.is_signer)
                } else {
                    anchor_lang::solana_program::instruction::AccountMeta::new_readonly(*a.key, a.is_signer)
                }
            }).collect(),
            data,
        };
        
        invoke_signed(&ix, ctx.remaining_accounts, signer_seeds)?;
        
        // Calculate fees claimed
        let balance_after = ctx.accounts.pda_wallet.lamports();
        let fees_claimed = balance_after.saturating_sub(balance_before);
        
        wallet.total_fees_claimed = wallet.total_fees_claimed.saturating_add(fees_claimed);
        
        // Emit event
        emit!(FeesClaimed {
            wallet: ctx.accounts.mm_wallet.key(),
            amount: fees_claimed,
            timestamp: clock.unix_timestamp,
        });
        
        msg!("Claimed {} lamports in fees", fees_claimed);
        
        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TOKEN CREATION (PDA as creator)
    // ═══════════════════════════════════════════════════════════════════════════

    /// Create a new token on Pump.fun with PDA as creator
    pub fn create_token(
        ctx: Context<CreateToken>,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        let wallet = &mut ctx.accounts.mm_wallet;
        
        // Only owner can create token
        require!(
            ctx.accounts.owner.key() == wallet.owner,
            MmWalletError::Unauthorized
        );
        
        // Ensure token not already created
        require!(
            wallet.token_mint == Pubkey::default(),
            MmWalletError::AlreadyInitialized
        );
        
        // Build signer seeds for PDA
        let owner_key = wallet.owner;
        let nonce_bytes = wallet.nonce.to_le_bytes();
        let seeds = &[
            b"mm_wallet",
            owner_key.as_ref(),
            nonce_bytes.as_ref(),
            &[wallet.bump],
        ];
        let signer_seeds = &[&seeds[..]];
        
        let mut data = PUMP_CREATE_DISCRIMINATOR.to_vec();
        
        // Serialize strings with length prefix
        data.extend_from_slice(&(name.len() as u32).to_le_bytes());
        data.extend_from_slice(name.as_bytes());
        data.extend_from_slice(&(symbol.len() as u32).to_le_bytes());
        data.extend_from_slice(symbol.as_bytes());
        data.extend_from_slice(&(uri.len() as u32).to_le_bytes());
        data.extend_from_slice(uri.as_bytes());
        
        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: PUMP_FUN_PROGRAM,
            accounts: ctx.remaining_accounts.iter().map(|a| {
                if a.is_writable {
                    anchor_lang::solana_program::instruction::AccountMeta::new(*a.key, a.is_signer)
                } else {
                    anchor_lang::solana_program::instruction::AccountMeta::new_readonly(*a.key, a.is_signer)
                }
            }).collect(),
            data,
        };
        
        invoke_signed(&ix, ctx.remaining_accounts, signer_seeds)?;
        
        // Mark as creator
        wallet.is_creator = true;
        
        msg!("Token created with PDA as creator: {}", name);
        
        Ok(())
    }

    /// Set the token mint after creation (owner only, one-time)
    pub fn set_token_mint(ctx: Context<SetTokenMint>) -> Result<()> {
        let wallet = &mut ctx.accounts.mm_wallet;
        
        // Check ownership
        require!(
            ctx.accounts.owner.key() == wallet.owner,
            MmWalletError::Unauthorized
        );
        
        // Ensure not already set
        require!(
            wallet.token_mint == Pubkey::default(),
            MmWalletError::TokenMintAlreadySet
        );
        
        // Validate it's actually a mint account
        // The token_mint_account is validated by Anchor's Account<'info, Mint> type
        
        wallet.token_mint = ctx.accounts.token_mint_account.key();
        
        msg!("Token mint set: {}", wallet.token_mint);
        
        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CONFIGURATION (Owner only)
    // ═══════════════════════════════════════════════════════════════════════════

    /// Update trading strategy
    pub fn update_strategy(
        ctx: Context<UpdateConfig>,
        strategy: Strategy,
        config: StrategyConfig,
    ) -> Result<()> {
        let wallet = &mut ctx.accounts.mm_wallet;
        
        // Check ownership
        require!(
            ctx.accounts.owner.key() == wallet.owner,
            MmWalletError::Unauthorized
        );
        
        // Validate config
        validate_config(&config)?;
        
        let old_strategy = wallet.strategy as u8;
        wallet.strategy = strategy;
        wallet.config = config;
        
        // Emit event
        emit!(StrategyUpdated {
            wallet: ctx.accounts.mm_wallet.key(),
            old_strategy,
            new_strategy: strategy as u8,
        });
        
        msg!("Strategy updated to: {:?}", strategy);
        
        Ok(())
    }

    /// Update authorized operator
    pub fn set_operator(ctx: Context<UpdateConfig>, new_operator: Pubkey) -> Result<()> {
        let wallet = &mut ctx.accounts.mm_wallet;
        
        // Check ownership
        require!(
            ctx.accounts.owner.key() == wallet.owner,
            MmWalletError::Unauthorized
        );
        
        // Validate operator is not zero
        require!(
            new_operator != Pubkey::default(),
            MmWalletError::InvalidOperator
        );
        
        let old_operator = wallet.operator;
        wallet.operator = new_operator;
        
        // Emit event
        emit!(OperatorChanged {
            wallet: ctx.accounts.mm_wallet.key(),
            old_operator,
            new_operator,
        });
        
        msg!("Operator changed from {} to {}", old_operator, new_operator);
        
        Ok(())
    }

    /// Pause trading
    pub fn pause(ctx: Context<UpdateConfig>) -> Result<()> {
        let wallet = &mut ctx.accounts.mm_wallet;
        
        // Check ownership
        require!(
            ctx.accounts.owner.key() == wallet.owner,
            MmWalletError::Unauthorized
        );
        
        wallet.paused = true;
        
        msg!("Trading paused");
        
        Ok(())
    }

    /// Resume trading
    pub fn resume(ctx: Context<UpdateConfig>) -> Result<()> {
        let wallet = &mut ctx.accounts.mm_wallet;
        
        // Check ownership
        require!(
            ctx.accounts.owner.key() == wallet.owner,
            MmWalletError::Unauthorized
        );
        
        wallet.paused = false;
        
        msg!("Trading resumed");
        
        Ok(())
    }

    /// Extend lock period (can only increase, never decrease)
    pub fn extend_lock(ctx: Context<UpdateConfig>, additional_seconds: i64) -> Result<()> {
        let wallet = &mut ctx.accounts.mm_wallet;
        let clock = Clock::get()?;
        
        // Check ownership
        require!(
            ctx.accounts.owner.key() == wallet.owner,
            MmWalletError::Unauthorized
        );
        
        // Validate additional time
        require!(
            additional_seconds > 0 && additional_seconds <= MAX_LOCK_SECONDS,
            MmWalletError::InvalidLockDuration
        );
        
        // Calculate new lock time
        let new_lock = if wallet.lock_until > clock.unix_timestamp {
            wallet.lock_until
                .checked_add(additional_seconds)
                .ok_or(MmWalletError::MathOverflow)?
        } else {
            clock.unix_timestamp
                .checked_add(additional_seconds)
                .ok_or(MmWalletError::MathOverflow)?
        };
        
        // Validate total lock doesn't exceed maximum (5 years from now)
        let max_allowed = clock.unix_timestamp
            .checked_add(MAX_TOTAL_LOCK_SECONDS)
            .ok_or(MmWalletError::MathOverflow)?;
        
        require!(new_lock <= max_allowed, MmWalletError::LockTooLong);
        
        wallet.lock_until = new_lock;
        
        msg!("Lock extended to: {}", wallet.lock_until);
        
        Ok(())
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// VALIDATION HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

fn validate_config(config: &StrategyConfig) -> Result<()> {
    // Trade size: 1-50%
    require!(
        config.trade_size_pct >= 1 && config.trade_size_pct <= MAX_TRADE_PCT,
        MmWalletError::InvalidTradeSize
    );
    
    // Slippage: 0.1% - 50% (10-5000 bps)
    require!(
        config.slippage_bps >= MIN_SLIPPAGE_BPS && config.slippage_bps <= MAX_SLIPPAGE_BPS,
        MmWalletError::InvalidSlippage
    );
    
    // Delays: min <= max
    require!(
        config.min_delay_secs <= config.max_delay_secs,
        MmWalletError::InvalidDelayConfig
    );
    
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACCOUNT CONTEXTS
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = owner,
        space = MmWallet::SIZE,
        seeds = [b"mm_wallet", owner.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub mm_wallet: Account<'info, MmWallet>,
    
    /// CHECK: PDA for holding SOL
    #[account(
        seeds = [b"mm_wallet", owner.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub pda_wallet: AccountInfo<'info>,
    
    #[account(mut)]
    pub owner: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub mm_wallet: Account<'info, MmWallet>,
    
    /// CHECK: PDA for holding SOL
    #[account(
        mut,
        seeds = [b"mm_wallet", mm_wallet.owner.as_ref(), &mm_wallet.nonce.to_le_bytes()],
        bump = mm_wallet.bump
    )]
    pub pda_wallet: AccountInfo<'info>,
    
    #[account(mut)]
    pub depositor: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub mm_wallet: Account<'info, MmWallet>,
    
    /// CHECK: PDA for holding SOL
    #[account(
        mut,
        seeds = [b"mm_wallet", mm_wallet.owner.as_ref(), &mm_wallet.nonce.to_le_bytes()],
        bump = mm_wallet.bump
    )]
    pub pda_wallet: AccountInfo<'info>,
    
    #[account(mut)]
    pub owner: Signer<'info>,
    
    /// CHECK: Must be same as owner (validated in handler)
    #[account(mut)]
    pub destination: AccountInfo<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawTokens<'info> {
    pub mm_wallet: Account<'info, MmWallet>,
    
    /// CHECK: PDA for signing
    #[account(
        seeds = [b"mm_wallet", mm_wallet.owner.as_ref(), &mm_wallet.nonce.to_le_bytes()],
        bump = mm_wallet.bump
    )]
    pub pda_wallet: AccountInfo<'info>,
    
    #[account(mut)]
    pub pda_token_account: Account<'info, TokenAccount>,
    
    #[account(mut)]
    pub owner_token_account: Account<'info, TokenAccount>,
    
    pub token_mint: Account<'info, Mint>,
    
    #[account(mut)]
    pub owner: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ExecuteTrade<'info> {
    #[account(mut)]
    pub mm_wallet: Account<'info, MmWallet>,
    
    /// CHECK: PDA for signing
    #[account(
        mut,
        seeds = [b"mm_wallet", mm_wallet.owner.as_ref(), &mm_wallet.nonce.to_le_bytes()],
        bump = mm_wallet.bump
    )]
    pub pda_wallet: AccountInfo<'info>,
    
    /// CHECK: Must be Pump.fun program
    pub target_program: AccountInfo<'info>,
    
    /// Caller must be owner or authorized operator
    pub caller: Signer<'info>,
    
    // Remaining accounts are passed to Pump.fun CPI
}

#[derive(Accounts)]
pub struct ExecuteSwap<'info> {
    #[account(mut)]
    pub mm_wallet: Account<'info, MmWallet>,
    
    /// CHECK: PDA for signing
    #[account(
        mut,
        seeds = [b"mm_wallet", mm_wallet.owner.as_ref(), &mm_wallet.nonce.to_le_bytes()],
        bump = mm_wallet.bump
    )]
    pub pda_wallet: AccountInfo<'info>,
    
    /// CHECK: Must be PumpSwap program
    pub target_program: AccountInfo<'info>,
    
    /// Caller must be owner or authorized operator
    pub caller: Signer<'info>,
    
    // Remaining accounts are passed to PumpSwap CPI
}

#[derive(Accounts)]
pub struct ClaimFees<'info> {
    #[account(mut)]
    pub mm_wallet: Account<'info, MmWallet>,
    
    /// CHECK: PDA for signing
    #[account(
        mut,
        seeds = [b"mm_wallet", mm_wallet.owner.as_ref(), &mm_wallet.nonce.to_le_bytes()],
        bump = mm_wallet.bump
    )]
    pub pda_wallet: AccountInfo<'info>,
    
    /// Caller must be owner or authorized operator
    pub caller: Signer<'info>,
    
    // Remaining accounts are passed to Pump.fun CPI
}

#[derive(Accounts)]
pub struct CreateToken<'info> {
    #[account(mut)]
    pub mm_wallet: Account<'info, MmWallet>,
    
    /// CHECK: PDA for signing
    #[account(
        mut,
        seeds = [b"mm_wallet", mm_wallet.owner.as_ref(), &mm_wallet.nonce.to_le_bytes()],
        bump = mm_wallet.bump
    )]
    pub pda_wallet: AccountInfo<'info>,
    
    #[account(mut)]
    pub owner: Signer<'info>,
    
    // Remaining accounts are passed to Pump.fun CPI
}

#[derive(Accounts)]
pub struct SetTokenMint<'info> {
    #[account(mut)]
    pub mm_wallet: Account<'info, MmWallet>,
    
    /// Validated by Anchor's Mint type
    pub token_mint_account: Account<'info, Mint>,
    
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(mut)]
    pub mm_wallet: Account<'info, MmWallet>,
    
    pub owner: Signer<'info>,
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS (Unit tests for security-critical functions)
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_calculate_min_output() {
        let wallet = MmWallet {
            config: StrategyConfig {
                slippage_bps: 1000, // 10%
                ..Default::default()
            },
            ..Default::default()
        };
        
        // 100 tokens with 10% slippage = 90 min
        let result = wallet.calculate_min_output(100).unwrap();
        assert_eq!(result, 90);
    }
    
    #[test]
    fn test_max_trade_amount() {
        let wallet = MmWallet {
            config: StrategyConfig {
                trade_size_pct: 25, // 25%
                ..Default::default()
            },
            ..Default::default()
        };
        
        // 1000 available, 25% max = 250
        let result = wallet.max_trade_amount(1000).unwrap();
        assert_eq!(result, 250);
    }
    
    #[test]
    fn test_is_locked() {
        let wallet = MmWallet {
            lock_until: 1000,
            ..Default::default()
        };
        
        assert!(wallet.is_locked(500)); // Before lock expires
        assert!(!wallet.is_locked(1000)); // At expiration
        assert!(!wallet.is_locked(1500)); // After expiration
    }
    
    #[test]
    fn test_can_trade_rate_limiting() {
        let wallet = MmWallet {
            last_trade: 1000,
            config: StrategyConfig {
                min_delay_secs: 60,
                ..Default::default()
            },
            ..Default::default()
        };
        
        assert!(!wallet.can_trade(1030)); // 30s later - too soon
        assert!(!wallet.can_trade(1059)); // 59s later - still too soon
        assert!(wallet.can_trade(1060)); // 60s later - OK
        assert!(wallet.can_trade(1061)); // 61s later - OK
    }
    
    #[test]
    fn test_validate_config() {
        // Valid config
        let valid = StrategyConfig {
            trade_size_pct: 25,
            slippage_bps: 500,
            min_delay_secs: 10,
            max_delay_secs: 60,
            ..Default::default()
        };
        assert!(validate_config(&valid).is_ok());
        
        // Invalid trade size (too high)
        let invalid_size = StrategyConfig {
            trade_size_pct: 60, // > 50%
            slippage_bps: 500,
            min_delay_secs: 10,
            max_delay_secs: 60,
            ..Default::default()
        };
        assert!(validate_config(&invalid_size).is_err());
        
        // Invalid slippage (too low)
        let invalid_slip = StrategyConfig {
            trade_size_pct: 25,
            slippage_bps: 5, // < 10 bps
            min_delay_secs: 10,
            max_delay_secs: 60,
            ..Default::default()
        };
        assert!(validate_config(&invalid_slip).is_err());
        
        // Invalid delay (min > max)
        let invalid_delay = StrategyConfig {
            trade_size_pct: 25,
            slippage_bps: 500,
            min_delay_secs: 100,
            max_delay_secs: 60,
            ..Default::default()
        };
        assert!(validate_config(&invalid_delay).is_err());
    }
}

