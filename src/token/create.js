/**
 * Token Creation Module
 * Create tokens on Pump.fun (both legacy and V2/Mayhem mode)
 */

import {
    Connection,
    Keypair,
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
    PUMP_MINT_AUTHORITY,
    PUMP_FEE_PROGRAM,
    MAYHEM_PROGRAM,
    MAYHEM_GLOBAL_PARAMS,
    MAYHEM_SOL_VAULT,
    TOKEN_PROGRAM,
    TOKEN_2022_PROGRAM,
    SYSTEM_PROGRAM,
    RENT_PROGRAM,
    ASSOCIATED_TOKEN_PROGRAM,
    DISCRIMINATORS,
    LAMPORTS_PER_SOL,
    packU64,
    encodeString,
    DEFAULT_COMPUTE_UNITS,
    DEFAULT_COMPUTE_PRICE,
} from '../constants.js';
import {
    getBondingCurveAddress,
    getAssociatedBondingCurve,
    getCreatorVault,
    getMayhemState,
    getMayhemTokenVault,
    getGlobalVolumeAccumulator,
    getUserVolumeAccumulator,
    getFeeConfig,
} from '../utils/pda.js';
import * as bs58 from 'bs58';

// ============================================================================
// LEGACY TOKEN CREATION (Token Program)
// ============================================================================

/**
 * Create token on Pump.fun (legacy - Token Program)
 * @param {Connection} connection - Solana connection
 * @param {Keypair} payer - Wallet keypair
 * @param {Object} tokenConfig - Token configuration
 * @returns {Promise<{signature: string, mint: PublicKey}>}
 */
export async function createToken(connection, payer, tokenConfig) {
    const {
        name,
        symbol,
        uri,
        buyAmount = 0, // Optional initial buy in SOL
    } = tokenConfig;
    
    console.log(`[Create] Creating token: ${name} (${symbol})`);
    
    // Generate new mint keypair
    const mint = Keypair.generate();
    console.log(`[Create] Mint address: ${mint.publicKey.toBase58()}`);
    
    // Derive addresses
    const bondingCurve = getBondingCurveAddress(mint.publicKey);
    const associatedBondingCurve = getAssociatedBondingCurve(mint.publicKey, bondingCurve, TOKEN_PROGRAM);
    const creatorVault = getCreatorVault(payer.publicKey);
    
    // Build accounts
    const accounts = [
        { pubkey: mint.publicKey, isSigner: true, isWritable: true },
        { pubkey: PUMP_MINT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
        { pubkey: PublicKey.findProgramAddressSync([Buffer.from('metadata'), TOKEN_PROGRAM.toBuffer(), mint.publicKey.toBuffer()], new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'))[0], isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: creatorVault, isSigner: false, isWritable: true },
        { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'), isSigner: false, isWritable: false },
        { pubkey: RENT_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
    ];
    
    // Build instruction data: discriminator + name + symbol + uri
    const data = Buffer.concat([
        DISCRIMINATORS.BONDING_CREATE,
        encodeString(name),
        encodeString(symbol),
        encodeString(uri),
    ]);
    
    const createInstruction = new TransactionInstruction({
        keys: accounts,
        programId: PUMP_PROGRAM,
        data,
    });
    
    // Build transaction
    const transaction = new Transaction();
    transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: DEFAULT_COMPUTE_UNITS }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: DEFAULT_COMPUTE_PRICE }),
        createInstruction
    );
    
    // Add initial buy if specified
    if (buyAmount > 0) {
        const userATA = await getAssociatedTokenAddress(mint.publicKey, payer.publicKey, false, TOKEN_PROGRAM);
        
        // Create ATA
        transaction.add(
            createAssociatedTokenAccountIdempotentInstruction(
                payer.publicKey,
                userATA,
                payer.publicKey,
                mint.publicKey,
                TOKEN_PROGRAM
            )
        );
        
        // Buy instruction would go here...
        // For simplicity, do the buy in a separate transaction
    }
    
    // Send transaction
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = payer.publicKey;
    transaction.sign(payer, mint);
    
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true,
    });
    
    console.log(`[Create] TX sent: ${signature}`);
    
    // Confirm
    await connection.confirmTransaction(signature, 'confirmed');
    console.log(`[Create] Token created successfully!`);
    
    return {
        signature,
        mint: mint.publicKey,
        bondingCurve,
    };
}

// ============================================================================
// V2 TOKEN CREATION (Token-2022 / Mayhem Mode)
// ============================================================================

/**
 * Create token on Pump.fun V2 (Token-2022 with optional Mayhem mode)
 */
export async function createTokenV2(connection, payer, tokenConfig) {
    const {
        name,
        symbol,
        uri,
        mayhemMode = false,
        buyAmount = 0,
    } = tokenConfig;
    
    console.log(`[Create V2] Creating token: ${name} (${symbol}) - Mayhem: ${mayhemMode}`);
    
    // Generate new mint keypair
    const mint = Keypair.generate();
    console.log(`[Create V2] Mint address: ${mint.publicKey.toBase58()}`);
    
    // Derive addresses
    const bondingCurve = getBondingCurveAddress(mint.publicKey);
    const associatedBondingCurve = getAssociatedBondingCurve(mint.publicKey, bondingCurve, TOKEN_2022_PROGRAM);
    const creatorVault = getCreatorVault(payer.publicKey);
    
    // Build base accounts
    const accounts = [
        { pubkey: mint.publicKey, isSigner: true, isWritable: true },
        { pubkey: PUMP_MINT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: creatorVault, isSigner: false, isWritable: true },
        { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: RENT_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
    ];
    
    // Add Mayhem-specific accounts if enabled
    if (mayhemMode) {
        const mayhemState = getMayhemState(mint.publicKey);
        const mayhemTokenVault = await getMayhemTokenVault(mint.publicKey);
        
        accounts.push(
            { pubkey: MAYHEM_PROGRAM, isSigner: false, isWritable: false },
            { pubkey: mayhemState, isSigner: false, isWritable: true },
            { pubkey: MAYHEM_GLOBAL_PARAMS, isSigner: false, isWritable: false },
            { pubkey: mayhemTokenVault, isSigner: false, isWritable: true },
            { pubkey: MAYHEM_SOL_VAULT, isSigner: false, isWritable: true },
        );
    }
    
    // Build instruction data: discriminator + name + symbol + uri + mayhem_enabled
    const data = Buffer.concat([
        DISCRIMINATORS.BONDING_CREATE_V2,
        encodeString(name),
        encodeString(symbol),
        encodeString(uri),
        Buffer.from([mayhemMode ? 1 : 0]), // mayhem enabled flag
    ]);
    
    const createInstruction = new TransactionInstruction({
        keys: accounts,
        programId: PUMP_PROGRAM,
        data,
    });
    
    // Build transaction
    const transaction = new Transaction();
    transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), // V2 needs more compute
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: DEFAULT_COMPUTE_PRICE }),
        createInstruction
    );
    
    // Send transaction
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = payer.publicKey;
    transaction.sign(payer, mint);
    
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true,
    });
    
    console.log(`[Create V2] TX sent: ${signature}`);
    
    // Confirm
    await connection.confirmTransaction(signature, 'confirmed');
    console.log(`[Create V2] Token created successfully!`);
    
    return {
        signature,
        mint: mint.publicKey,
        bondingCurve,
        isMayhemMode: mayhemMode,
    };
}

// ============================================================================
// MINT AND BUY (Single Transaction)
// ============================================================================

/**
 * Create token and buy in a single transaction
 */
export async function createAndBuy(connection, payer, tokenConfig, solAmount, slippage = 0.25) {
    const {
        name,
        symbol,
        uri,
        useV2 = false,
        mayhemMode = false,
    } = tokenConfig;
    
    console.log(`[Create+Buy] Creating and buying: ${name} (${symbol})`);
    
    // Generate new mint keypair
    const mint = Keypair.generate();
    const tokenProgram = useV2 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
    
    // Derive addresses
    const bondingCurve = getBondingCurveAddress(mint.publicKey);
    const associatedBondingCurve = getAssociatedBondingCurve(mint.publicKey, bondingCurve, tokenProgram);
    const creatorVault = getCreatorVault(payer.publicKey);
    const userATA = await getAssociatedTokenAddress(mint.publicKey, payer.publicKey, false, tokenProgram);
    
    // Calculate token amount for buy
    // Initial price is ~0.000000028 SOL per token (30 SOL / 1.073B tokens)
    const initialPrice = 30 / 1_073_000_000;
    const estimatedTokens = Math.floor((solAmount / initialPrice) * 0.99); // 1% buffer
    const maxSolCost = Math.floor(solAmount * (1 + slippage) * LAMPORTS_PER_SOL);
    
    // Build CREATE accounts
    const createAccounts = useV2 ? [
        { pubkey: mint.publicKey, isSigner: true, isWritable: true },
        { pubkey: PUMP_MINT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: creatorVault, isSigner: false, isWritable: true },
        { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: RENT_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
    ] : [
        { pubkey: mint.publicKey, isSigner: true, isWritable: true },
        { pubkey: PUMP_MINT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
        { pubkey: PublicKey.findProgramAddressSync([Buffer.from('metadata'), TOKEN_PROGRAM.toBuffer(), mint.publicKey.toBuffer()], new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'))[0], isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: creatorVault, isSigner: false, isWritable: true },
        { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'), isSigner: false, isWritable: false },
        { pubkey: RENT_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
    ];
    
    // Build CREATE instruction data
    const createData = useV2 ? Buffer.concat([
        DISCRIMINATORS.BONDING_CREATE_V2,
        encodeString(name),
        encodeString(symbol),
        encodeString(uri),
        Buffer.from([mayhemMode ? 1 : 0]),
    ]) : Buffer.concat([
        DISCRIMINATORS.BONDING_CREATE,
        encodeString(name),
        encodeString(symbol),
        encodeString(uri),
    ]);
    
    const createInstruction = new TransactionInstruction({
        keys: createAccounts,
        programId: PUMP_PROGRAM,
        data: createData,
    });
    
    // Build BUY accounts
    const buyAccounts = [
        { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
        { pubkey: PUMP_FEE, isSigner: false, isWritable: true },
        { pubkey: mint.publicKey, isSigner: false, isWritable: false },
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
    
    // Build BUY instruction data
    const trackVolume = Buffer.from([1, 1]); // Some(true)
    const buyData = Buffer.concat([
        DISCRIMINATORS.BONDING_BUY,
        packU64(estimatedTokens * (10 ** 6)),
        packU64(maxSolCost),
        trackVolume,
    ]);
    
    const buyInstruction = new TransactionInstruction({
        keys: buyAccounts,
        programId: PUMP_PROGRAM,
        data: buyData,
    });
    
    // Create ATA instruction
    const createATAInstruction = createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        userATA,
        payer.publicKey,
        mint.publicKey,
        tokenProgram
    );
    
    // Build transaction
    const transaction = new Transaction();
    transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: DEFAULT_COMPUTE_PRICE }),
        createInstruction,
        createATAInstruction,
        buyInstruction
    );
    
    // Send transaction
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = payer.publicKey;
    transaction.sign(payer, mint);
    
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true,
    });
    
    console.log(`[Create+Buy] TX sent: ${signature}`);
    
    // Confirm
    await connection.confirmTransaction(signature, 'confirmed');
    console.log(`[Create+Buy] Token created and bought!`);
    
    return {
        signature,
        mint: mint.publicKey,
        bondingCurve,
    };
}


