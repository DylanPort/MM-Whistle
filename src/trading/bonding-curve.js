/**
 * Bonding Curve Trading Module
 * Direct integration with Pump.fun bonding curve (pre-migration tokens)
 * 0% PumpPortal fees!
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
    createAssociatedTokenAccountIdempotentInstruction,
    getAssociatedTokenAddress,
} from '@solana/spl-token';
import {
    PUMP_PROGRAM,
    PUMP_GLOBAL,
    PUMP_EVENT_AUTHORITY,
    PUMP_FEE,
    PUMP_FEE_PROGRAM,
    TOKEN_PROGRAM,
    TOKEN_2022_PROGRAM,
    SYSTEM_PROGRAM,
    DISCRIMINATORS,
    LAMPORTS_PER_SOL,
    TOKEN_DECIMALS,
    packU64,
    unpackU64,
    DEFAULT_COMPUTE_UNITS,
    DEFAULT_COMPUTE_PRICE,
    RESERVED_FEE_RECIPIENT_OFFSET,
    BONDING_CURVE_DISCRIMINATOR,
} from '../constants.js';
import {
    getBondingCurveAddress,
    getAssociatedBondingCurve,
    getCreatorVault,
    getGlobalVolumeAccumulator,
    getUserVolumeAccumulator,
    getFeeConfig,
    getTokenProgramForMint,
} from '../utils/pda.js';

// ============================================================================
// BONDING CURVE STATE PARSING
// ============================================================================

/**
 * Parse bonding curve account data
 */
export function parseBondingCurveState(data) {
    // Check discriminator
    const discriminator = data.slice(0, 8);
    if (!discriminator.equals(BONDING_CURVE_DISCRIMINATOR)) {
        throw new Error('Invalid bonding curve discriminator');
    }
    
    let offset = 8;
    
    const virtualTokenReserves = data.readBigUInt64LE(offset); offset += 8;
    const virtualSolReserves = data.readBigUInt64LE(offset); offset += 8;
    const realTokenReserves = data.readBigUInt64LE(offset); offset += 8;
    const realSolReserves = data.readBigUInt64LE(offset); offset += 8;
    const tokenTotalSupply = data.readBigUInt64LE(offset); offset += 8;
    const complete = data[offset] === 1; offset += 1;
    
    // Parse creator if available (added in V2)
    let creator = null;
    if (data.length >= offset + 32) {
        creator = new PublicKey(data.slice(offset, offset + 32));
        offset += 32;
    }
    
    // Parse mayhem mode flag if available (added in V3)
    let isMayhemMode = false;
    if (data.length >= offset + 1) {
        isMayhemMode = data[offset] === 1;
    }
    
    return {
        virtualTokenReserves,
        virtualSolReserves,
        realTokenReserves,
        realSolReserves,
        tokenTotalSupply,
        complete,
        creator,
        isMayhemMode,
    };
}

/**
 * Calculate token price from bonding curve state
 */
export function calculateBondingCurvePrice(state) {
    if (state.virtualTokenReserves <= 0n || state.virtualSolReserves <= 0n) {
        throw new Error('Invalid reserve state');
    }
    
    const solReserves = Number(state.virtualSolReserves) / LAMPORTS_PER_SOL;
    const tokenReserves = Number(state.virtualTokenReserves) / (10 ** TOKEN_DECIMALS);
    
    return solReserves / tokenReserves;
}

/**
 * Get fee recipient based on mayhem mode
 */
async function getFeeRecipient(connection, state) {
    if (!state.isMayhemMode) {
        return PUMP_FEE;
    }
    
    // Fetch Global account to get reserved_fee_recipient for mayhem mode
    const globalInfo = await connection.getAccountInfo(PUMP_GLOBAL);
    if (!globalInfo || globalInfo.data.length < RESERVED_FEE_RECIPIENT_OFFSET + 32) {
        return PUMP_FEE; // Fallback
    }
    
    return new PublicKey(globalInfo.data.slice(
        RESERVED_FEE_RECIPIENT_OFFSET,
        RESERVED_FEE_RECIPIENT_OFFSET + 32
    ));
}

// ============================================================================
// BUY TOKENS
// ============================================================================

/**
 * Buy tokens on bonding curve
 * @param {Connection} connection - Solana connection
 * @param {Keypair} payer - Wallet keypair
 * @param {PublicKey} mint - Token mint address
 * @param {number} solAmount - Amount of SOL to spend
 * @param {number} slippage - Slippage tolerance (0.25 = 25%)
 * @returns {Promise<string>} Transaction signature
 */
export async function buyOnBondingCurve(connection, payer, mint, solAmount, slippage = 0.25) {
    const mintStr = typeof mint === 'string' ? mint : mint.toBase58();
    console.log(`[Bonding Curve] Buying ${solAmount} SOL worth of ${mintStr}`);
    
    // Get token program
    const tokenProgram = await getTokenProgramForMint(connection, mint);
    
    // Derive addresses
    const bondingCurve = getBondingCurveAddress(mint);
    const associatedBondingCurve = getAssociatedBondingCurve(mint, bondingCurve, tokenProgram);
    const userATA = await getAssociatedTokenAddress(mint, payer.publicKey, false, tokenProgram);
    
    // Fetch bonding curve state using getMultipleAccountsInfo for better RPC compatibility
    const accountsInfo = await connection.getMultipleAccountsInfo([bondingCurve]);
    const bondingCurveInfo = accountsInfo?.[0];
    if (!bondingCurveInfo) {
        throw new Error('Bonding curve not found - token may have migrated');
    }
    const state = parseBondingCurveState(bondingCurveInfo.data);
    
    if (state.complete) {
        throw new Error('Bonding curve is complete - token has migrated to PumpSwap');
    }
    
    // Calculate amounts
    const tokenPrice = calculateBondingCurvePrice(state);
    const tokenAmount = Math.floor((solAmount / tokenPrice) * (10 ** TOKEN_DECIMALS));
    const maxSolCost = Math.floor(solAmount * (1 + slippage) * LAMPORTS_PER_SOL);
    
    console.log(`[Bonding Curve] Price: ${tokenPrice.toFixed(12)} SOL per token`);
    console.log(`[Bonding Curve] Expected tokens: ${tokenAmount / (10 ** TOKEN_DECIMALS)}`);
    console.log(`[Bonding Curve] Max SOL: ${maxSolCost / LAMPORTS_PER_SOL}`);
    
    // Get creator vault
    const creatorVault = state.creator ? getCreatorVault(state.creator) : getCreatorVault(payer.publicKey);
    
    // Get fee recipient
    const feeRecipient = await getFeeRecipient(connection, state);
    
    // Build accounts
    const accounts = [
        { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
        { pubkey: feeRecipient, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: userATA, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: tokenProgram, isSigner: false, isWritable: false },
        { pubkey: creatorVault, isSigner: false, isWritable: true },
        { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: getGlobalVolumeAccumulator(), isSigner: false, isWritable: false },
        { pubkey: getUserVolumeAccumulator(payer.publicKey), isSigner: false, isWritable: true },
        { pubkey: getFeeConfig(), isSigner: false, isWritable: false },
        { pubkey: PUMP_FEE_PROGRAM, isSigner: false, isWritable: false },
    ];
    
    // Build instruction data: discriminator + token_amount + max_sol_cost + track_volume
    const trackVolume = Buffer.from([1, 1]); // Some(true)
    const data = Buffer.concat([
        DISCRIMINATORS.BONDING_BUY,
        packU64(tokenAmount),
        packU64(maxSolCost),
        trackVolume,
    ]);
    
    const buyInstruction = new TransactionInstruction({
        keys: accounts,
        programId: PUMP_PROGRAM,
        data,
    });
    
    // Create ATA instruction
    const createATAInstruction = createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        userATA,
        payer.publicKey,
        mint,
        tokenProgram
    );
    
    // Build transaction
    const transaction = new Transaction();
    transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: DEFAULT_COMPUTE_UNITS }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: DEFAULT_COMPUTE_PRICE }),
        createATAInstruction,
        buyInstruction
    );
    
    // Send transaction
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = payer.publicKey;
    transaction.sign(payer);
    
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true,
    });
    
    console.log(`[Bonding Curve] Buy TX sent: ${signature}`);
    
    // Confirm
    await connection.confirmTransaction(signature, 'confirmed');
    console.log(`[Bonding Curve] Buy confirmed!`);
    
    return signature;
}

// ============================================================================
// SELL TOKENS
// ============================================================================

/**
 * Sell tokens on bonding curve
 * @param {Connection} connection - Solana connection
 * @param {Keypair} payer - Wallet keypair
 * @param {PublicKey} mint - Token mint address
 * @param {number|null} tokenAmount - Amount of tokens to sell (null = all)
 * @param {number} slippage - Slippage tolerance (0.25 = 25%)
 * @returns {Promise<string>} Transaction signature
 */
export async function sellOnBondingCurve(connection, payer, mint, tokenAmount = null, slippage = 0.25) {
    const mintStr = typeof mint === 'string' ? mint : mint.toBase58();
    console.log(`[Bonding Curve] Selling tokens of ${mintStr}`);
    
    // Get token program
    const tokenProgram = await getTokenProgramForMint(connection, mint);
    
    // Derive addresses
    const bondingCurve = getBondingCurveAddress(mint);
    const associatedBondingCurve = getAssociatedBondingCurve(mint, bondingCurve, tokenProgram);
    const userATA = await getAssociatedTokenAddress(mint, payer.publicKey, false, tokenProgram);
    
    // Get token balance if not specified
    if (tokenAmount === null) {
        const balance = await connection.getTokenAccountBalance(userATA);
        tokenAmount = parseInt(balance.value.amount);
        console.log(`[Bonding Curve] Selling all tokens: ${tokenAmount / (10 ** TOKEN_DECIMALS)}`);
    }
    
    if (tokenAmount === 0) {
        throw new Error('No tokens to sell');
    }
    
    // Fetch bonding curve state using getMultipleAccountsInfo for better RPC compatibility
    const accountsInfo = await connection.getMultipleAccountsInfo([bondingCurve]);
    const bondingCurveInfo = accountsInfo?.[0];
    if (!bondingCurveInfo) {
        throw new Error('Bonding curve not found - token may have migrated');
    }
    const state = parseBondingCurveState(bondingCurveInfo.data);
    
    if (state.complete) {
        throw new Error('Bonding curve is complete - use PumpSwap to sell');
    }
    
    // Calculate minimum SOL output
    const tokenPrice = calculateBondingCurvePrice(state);
    const expectedSol = (tokenAmount / (10 ** TOKEN_DECIMALS)) * tokenPrice;
    const minSolOutput = Math.floor(expectedSol * (1 - slippage) * LAMPORTS_PER_SOL);
    
    console.log(`[Bonding Curve] Price: ${tokenPrice.toFixed(12)} SOL per token`);
    console.log(`[Bonding Curve] Expected SOL: ${expectedSol.toFixed(9)}`);
    console.log(`[Bonding Curve] Min SOL output: ${minSolOutput / LAMPORTS_PER_SOL}`);
    
    // Get creator vault
    const creatorVault = state.creator ? getCreatorVault(state.creator) : getCreatorVault(payer.publicKey);
    
    // Get fee recipient
    const feeRecipient = await getFeeRecipient(connection, state);
    
    // Build accounts
    const accounts = [
        { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
        { pubkey: feeRecipient, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: userATA, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: creatorVault, isSigner: false, isWritable: true },
        { pubkey: tokenProgram, isSigner: false, isWritable: false },
        { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: getFeeConfig(), isSigner: false, isWritable: false },
        { pubkey: PUMP_FEE_PROGRAM, isSigner: false, isWritable: false },
    ];
    
    // Build instruction data: discriminator + token_amount + min_sol_output + track_volume
    const trackVolume = Buffer.from([1, 1]); // Some(true)
    const data = Buffer.concat([
        DISCRIMINATORS.BONDING_SELL,
        packU64(tokenAmount),
        packU64(minSolOutput),
        trackVolume,
    ]);
    
    const sellInstruction = new TransactionInstruction({
        keys: accounts,
        programId: PUMP_PROGRAM,
        data,
    });
    
    // Build transaction
    const transaction = new Transaction();
    transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: DEFAULT_COMPUTE_UNITS }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: DEFAULT_COMPUTE_PRICE }),
        sellInstruction
    );
    
    // Send transaction
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = payer.publicKey;
    transaction.sign(payer);
    
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true,
    });
    
    console.log(`[Bonding Curve] Sell TX sent: ${signature}`);
    
    // Confirm
    await connection.confirmTransaction(signature, 'confirmed');
    console.log(`[Bonding Curve] Sell confirmed!`);
    
    return signature;
}

// ============================================================================
// GET PRICE
// ============================================================================

/**
 * Get current price from bonding curve
 * Uses getMultipleAccountsInfo for better RPC compatibility
 */
export async function getBondingCurvePrice(connection, mint) {
    const bondingCurve = getBondingCurveAddress(mint);
    
    // Use getMultipleAccountsInfo for better RPC compatibility
    const accounts = await connection.getMultipleAccountsInfo([bondingCurve]);
    const bondingCurveInfo = accounts?.[0];
    
    if (!bondingCurveInfo) {
        return null; // Migrated or doesn't exist
    }
    
    const state = parseBondingCurveState(bondingCurveInfo.data);
    
    if (state.complete) {
        return null; // Migrated
    }
    
    return {
        price: calculateBondingCurvePrice(state),
        state,
    };
}

