/**
 * Fee Claiming Module
 * Claim creator fees from Pump.fun tokens
 */

import {
    Connection,
    PublicKey,
    Transaction,
    TransactionInstruction,
    ComputeBudgetProgram,
    SystemProgram,
} from '@solana/web3.js';
import {
    PUMP_PROGRAM,
    PUMP_AMM_PROGRAM,
    TOKEN_PROGRAM,
    WSOL_MINT,
    SYSTEM_PROGRAM,
    ASSOCIATED_TOKEN_PROGRAM,
    DISCRIMINATORS,
    DEFAULT_COMPUTE_UNITS,
    DEFAULT_COMPUTE_PRICE,
} from '../constants.js';
import {
    getCreatorVault,
    getCoinCreatorVaultAuthority,
    getCoinCreatorVaultATA,
} from '../utils/pda.js';
import { getAssociatedTokenAddress, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction } from '@solana/spl-token';

// ============================================================================
// CHECK CLAIMABLE FEES
// ============================================================================

/**
 * Check claimable fees for a creator (bonding curve)
 */
export async function checkBondingCurveFees(connection, creator) {
    const creatorVault = getCreatorVault(creator);
    
    try {
        const balance = await connection.getBalance(creatorVault);
        return {
            vault: creatorVault,
            balance: balance,
            balanceSOL: balance / 1e9,
            type: 'bonding-curve',
        };
    } catch (e) {
        return {
            vault: creatorVault,
            balance: 0,
            balanceSOL: 0,
            type: 'bonding-curve',
            error: e.message,
        };
    }
}

/**
 * Check claimable fees for a creator (PumpSwap)
 */
export async function checkPumpSwapFees(connection, creator) {
    const vaultAuthority = getCoinCreatorVaultAuthority(creator);
    const vaultATA = await getCoinCreatorVaultATA(creator);
    
    try {
        const balance = await connection.getTokenAccountBalance(vaultATA);
        return {
            vault: vaultATA,
            authority: vaultAuthority,
            balance: parseInt(balance.value.amount),
            balanceSOL: parseFloat(balance.value.uiAmount),
            type: 'pumpswap',
        };
    } catch (e) {
        return {
            vault: vaultATA,
            authority: vaultAuthority,
            balance: 0,
            balanceSOL: 0,
            type: 'pumpswap',
            error: e.message,
        };
    }
}

/**
 * Check all claimable fees for a creator
 */
export async function checkAllFees(connection, creator) {
    const [bondingCurve, pumpSwap] = await Promise.all([
        checkBondingCurveFees(connection, creator),
        checkPumpSwapFees(connection, creator),
    ]);
    
    return {
        bondingCurve,
        pumpSwap,
        totalSOL: bondingCurve.balanceSOL + pumpSwap.balanceSOL,
    };
}

// ============================================================================
// CLAIM BONDING CURVE FEES
// ============================================================================

/**
 * Claim creator fees from bonding curve
 */
export async function claimBondingCurveFees(connection, payer) {
    console.log(`[Claim] Claiming bonding curve fees for ${payer.publicKey.toBase58()}`);
    
    const creatorVault = getCreatorVault(payer.publicKey);
    
    // Check balance first
    const balance = await connection.getBalance(creatorVault);
    if (balance === 0) {
        console.log(`[Claim] No fees to claim from bonding curve`);
        return null;
    }
    
    console.log(`[Claim] Claimable: ${balance / 1e9} SOL`);
    
    // Build accounts
    const accounts = [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: creatorVault, isSigner: false, isWritable: true },
        { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    ];
    
    // Build instruction
    const data = DISCRIMINATORS.BONDING_COLLECT_FEE;
    
    const claimInstruction = new TransactionInstruction({
        keys: accounts,
        programId: PUMP_PROGRAM,
        data,
    });
    
    // Build transaction
    const transaction = new Transaction();
    transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: DEFAULT_COMPUTE_UNITS }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: DEFAULT_COMPUTE_PRICE }),
        claimInstruction
    );
    
    // Send transaction
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = payer.publicKey;
    transaction.sign(payer);
    
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true,
    });
    
    console.log(`[Claim] TX sent: ${signature}`);
    
    // Confirm
    await connection.confirmTransaction(signature, 'confirmed');
    console.log(`[Claim] Bonding curve fees claimed!`);
    
    return {
        signature,
        amountClaimed: balance,
        amountClaimedSOL: balance / 1e9,
        type: 'bonding-curve',
    };
}

// ============================================================================
// CLAIM PUMPSWAP FEES
// ============================================================================

/**
 * Claim creator fees from PumpSwap (WSOL)
 */
export async function claimPumpSwapFees(connection, payer) {
    console.log(`[Claim] Claiming PumpSwap fees for ${payer.publicKey.toBase58()}`);
    
    const vaultAuthority = getCoinCreatorVaultAuthority(payer.publicKey);
    const vaultATA = await getCoinCreatorVaultATA(payer.publicKey);
    const userWSOL = await getAssociatedTokenAddress(WSOL_MINT, payer.publicKey, false, TOKEN_PROGRAM);
    
    // Check balance first
    let balance;
    try {
        const balanceInfo = await connection.getTokenAccountBalance(vaultATA);
        balance = parseInt(balanceInfo.value.amount);
    } catch (e) {
        console.log(`[Claim] No PumpSwap fee vault found`);
        return null;
    }
    
    if (balance === 0) {
        console.log(`[Claim] No fees to claim from PumpSwap`);
        return null;
    }
    
    console.log(`[Claim] Claimable: ${balance / 1e9} SOL`);
    
    // Build accounts for collect_coin_creator_fee
    const accounts = [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: vaultAuthority, isSigner: false, isWritable: false },
        { pubkey: vaultATA, isSigner: false, isWritable: true },
        { pubkey: userWSOL, isSigner: false, isWritable: true },
        { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ];
    
    // Build instruction
    const data = DISCRIMINATORS.PUMPSWAP_COLLECT_FEE;
    
    const claimInstruction = new TransactionInstruction({
        keys: accounts,
        programId: PUMP_AMM_PROGRAM,
        data,
    });
    
    // Build transaction
    const transaction = new Transaction();
    transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: DEFAULT_COMPUTE_UNITS }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: DEFAULT_COMPUTE_PRICE }),
        // Create user WSOL account if doesn't exist
        createAssociatedTokenAccountIdempotentInstruction(
            payer.publicKey,
            userWSOL,
            payer.publicKey,
            WSOL_MINT,
            TOKEN_PROGRAM
        ),
        claimInstruction,
        // Close WSOL account to get SOL back
        createCloseAccountInstruction(
            userWSOL,
            payer.publicKey,
            payer.publicKey,
            [],
            TOKEN_PROGRAM
        )
    );
    
    // Send transaction
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = payer.publicKey;
    transaction.sign(payer);
    
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true,
    });
    
    console.log(`[Claim] TX sent: ${signature}`);
    
    // Confirm
    await connection.confirmTransaction(signature, 'confirmed');
    console.log(`[Claim] PumpSwap fees claimed!`);
    
    return {
        signature,
        amountClaimed: balance,
        amountClaimedSOL: balance / 1e9,
        type: 'pumpswap',
    };
}

// ============================================================================
// CLAIM ALL FEES
// ============================================================================

/**
 * Claim all fees from both bonding curve and PumpSwap
 */
export async function claimAllFees(connection, payer) {
    console.log(`[Claim] Claiming all fees for ${payer.publicKey.toBase58()}`);
    
    const results = {
        bondingCurve: null,
        pumpSwap: null,
        totalClaimed: 0,
        totalClaimedSOL: 0,
    };
    
    // Try claiming from bonding curve
    try {
        const bondingResult = await claimBondingCurveFees(connection, payer);
        if (bondingResult) {
            results.bondingCurve = bondingResult;
            results.totalClaimed += bondingResult.amountClaimed;
            results.totalClaimedSOL += bondingResult.amountClaimedSOL;
        }
    } catch (e) {
        console.log(`[Claim] Bonding curve claim error: ${e.message}`);
    }
    
    // Try claiming from PumpSwap
    try {
        const pumpSwapResult = await claimPumpSwapFees(connection, payer);
        if (pumpSwapResult) {
            results.pumpSwap = pumpSwapResult;
            results.totalClaimed += pumpSwapResult.amountClaimed;
            results.totalClaimedSOL += pumpSwapResult.amountClaimedSOL;
        }
    } catch (e) {
        console.log(`[Claim] PumpSwap claim error: ${e.message}`);
    }
    
    console.log(`[Claim] Total claimed: ${results.totalClaimedSOL} SOL`);
    
    return results;
}

// ============================================================================
// AUTO-CLAIM SCHEDULER
// ============================================================================

/**
 * Start auto-claim scheduler
 */
export function startAutoClaimScheduler(connection, payer, intervalMinutes = 60, minClaimSOL = 0.01) {
    console.log(`[AutoClaim] Starting scheduler - interval: ${intervalMinutes}min, min: ${minClaimSOL} SOL`);
    
    const claimIfNeeded = async () => {
        try {
            const fees = await checkAllFees(connection, payer.publicKey);
            console.log(`[AutoClaim] Checking fees - Total: ${fees.totalSOL} SOL`);
            
            if (fees.totalSOL >= minClaimSOL) {
                console.log(`[AutoClaim] Claiming ${fees.totalSOL} SOL`);
                await claimAllFees(connection, payer);
            }
        } catch (e) {
            console.error(`[AutoClaim] Error: ${e.message}`);
        }
    };
    
    // Run immediately
    claimIfNeeded();
    
    // Schedule periodic claims
    const intervalId = setInterval(claimIfNeeded, intervalMinutes * 60 * 1000);
    
    return {
        stop: () => {
            clearInterval(intervalId);
            console.log(`[AutoClaim] Scheduler stopped`);
        },
    };
}


