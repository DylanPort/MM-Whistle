/**
 * PumpSwap AMM Trading Module
 * Direct integration with PumpSwap (post-migration tokens)
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
    createSyncNativeInstruction,
} from '@solana/spl-token';
import {
    PUMP_AMM_PROGRAM,
    PUMP_SWAP_GLOBAL_CONFIG,
    PUMP_SWAP_EVENT_AUTHORITY,
    PUMP_FEE_PROGRAM,
    STANDARD_PUMPSWAP_FEE_RECIPIENT,
    TOKEN_PROGRAM,
    TOKEN_2022_PROGRAM,
    SYSTEM_PROGRAM,
    ASSOCIATED_TOKEN_PROGRAM,
    WSOL_MINT,
    DISCRIMINATORS,
    LAMPORTS_PER_SOL,
    TOKEN_DECIMALS,
    packU64,
    DEFAULT_COMPUTE_UNITS,
    DEFAULT_COMPUTE_PRICE,
    POOL_BASE_MINT_OFFSET,
    POOL_MAYHEM_MODE_OFFSET,
    GLOBALCONFIG_RESERVED_FEE_OFFSET,
} from '../constants.js';
import {
    getCoinCreatorVaultAuthority,
    getCoinCreatorVaultATA,
    getPumpSwapGlobalVolumeAccumulator,
    getPumpSwapUserVolumeAccumulator,
    getPumpSwapFeeConfig,
    getTokenProgramForMint,
} from '../utils/pda.js';

// ============================================================================
// POOL DISCOVERY AND PARSING
// ============================================================================

// Cache for discovered pools (mint -> pool address)
const poolCache = new Map();

/**
 * Find PumpSwap pool for a token mint
 * @param {Connection} connection - Main RPC connection
 * @param {PublicKey} mint - Token mint
 * @param {Connection} indexedConnection - Optional indexed RPC for getProgramAccounts
 */
export async function findPumpSwapPool(connection, mint, indexedConnection = null) {
    const mintStr = typeof mint === 'string' ? mint : mint.toBase58();
    
    // Check cache first
    if (poolCache.has(mintStr)) {
        return poolCache.get(mintStr);
    }
    
    // Try getProgramAccounts first (fastest if available)
    const rpcToUse = indexedConnection || connection;
    try {
        const filters = [
                {
                    memcmp: {
                        offset: POOL_BASE_MINT_OFFSET,
                        bytes: mintStr,
                    },
                },
        ];
        
        const accounts = await rpcToUse.getProgramAccounts(PUMP_AMM_PROGRAM, {
            filters,
            encoding: 'base64',
        });
        
        if (accounts.length > 0) {
            const pool = accounts[0].pubkey;
            poolCache.set(mintStr, pool);
            console.log(`[PumpSwap] Found pool via getProgramAccounts: ${pool.toBase58()}`);
            return pool;
        }
    } catch (e) {
        console.log(`[PumpSwap] getProgramAccounts failed, trying PDA derivation...`);
    }
    
    // Fallback: Try deterministic PDA derivation
    // Pool PDA is derived from [b"pool", index (2 bytes), base_mint, quote_mint]
    // Use batch fetching for efficiency
    const poolPdas = [];
    for (let index = 0; index < 100; index++) {
        const indexBuffer = Buffer.alloc(2);
        indexBuffer.writeUInt16LE(index);
        
        const [poolPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('pool'), indexBuffer, mint.toBuffer(), WSOL_MINT.toBuffer()],
            PUMP_AMM_PROGRAM
        );
        poolPdas.push({ index, pda: poolPda });
    }
    
    // Batch fetch in groups of 10 using getMultipleAccountsInfo
    for (let i = 0; i < poolPdas.length; i += 10) {
        const batch = poolPdas.slice(i, i + 10);
        try {
            const accounts = await connection.getMultipleAccountsInfo(batch.map(p => p.pda));
            
            for (let j = 0; j < accounts.length; j++) {
                const poolInfo = accounts[j];
                if (poolInfo && poolInfo.data.length > 0) {
                    // Verify it's actually for this mint
                    const baseMint = new PublicKey(poolInfo.data.slice(POOL_BASE_MINT_OFFSET, POOL_BASE_MINT_OFFSET + 32));
                    if (baseMint.equals(mint)) {
                        poolCache.set(mintStr, batch[j].pda);
                        console.log(`[PumpSwap] Found pool via PDA derivation (index ${batch[j].index}): ${batch[j].pda.toBase58()}`);
                        return batch[j].pda;
                    }
                }
            }
        } catch (e) {
            console.log(`[PumpSwap] Batch ${i}-${i+10} fetch failed: ${e.message}`);
        }
    }
    
    return null;
}

/**
 * Clear pool cache (useful if pool changes)
 */
export function clearPoolCache() {
    poolCache.clear();
}

/**
 * Parse pool account data
 */
export function parsePoolData(data) {
    let offset = 8; // Skip discriminator
    
    const poolBump = data[offset]; offset += 1;
    const index = data.readUInt16LE(offset); offset += 2;
    const creator = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
    const baseMint = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
    const quoteMint = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
    const lpMint = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
    const poolBaseTokenAccount = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
    const poolQuoteTokenAccount = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
    const lpSupply = data.readBigUInt64LE(offset); offset += 8;
    const coinCreator = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
    
    // Check mayhem mode
    let isMayhemMode = false;
    if (data.length >= POOL_MAYHEM_MODE_OFFSET + 1) {
        isMayhemMode = data[POOL_MAYHEM_MODE_OFFSET] === 1;
    }
    
    return {
        poolBump,
        index,
        creator,
        baseMint,
        quoteMint,
        lpMint,
        poolBaseTokenAccount,
        poolQuoteTokenAccount,
        lpSupply,
        coinCreator,
        isMayhemMode,
    };
}

/**
 * Calculate pool price from reserves
 */
export async function calculatePoolPrice(connection, poolBaseTokenAccount, poolQuoteTokenAccount) {
    const [baseBalance, quoteBalance] = await Promise.all([
        connection.getTokenAccountBalance(poolBaseTokenAccount),
        connection.getTokenAccountBalance(poolQuoteTokenAccount),
    ]);
    
    const baseAmount = parseFloat(baseBalance.value.uiAmount);
    const quoteAmount = parseFloat(quoteBalance.value.uiAmount);
    
    return quoteAmount / baseAmount; // SOL per token
}

/**
 * Get fee recipient based on mayhem mode
 * Uses getMultipleAccountsInfo for better RPC compatibility
 */
async function getPumpSwapFeeRecipient(connection, pool) {
    // Fetch pool and global config in one call
    const accounts = await connection.getMultipleAccountsInfo([pool, PUMP_SWAP_GLOBAL_CONFIG]);
    const poolInfo = accounts?.[0];
    const configInfo = accounts?.[1];
    
    if (!poolInfo) {
        return { recipient: STANDARD_PUMPSWAP_FEE_RECIPIENT, tokenAccount: null };
    }
    
    const isMayhemMode = poolInfo.data.length >= POOL_MAYHEM_MODE_OFFSET + 1 &&
                         poolInfo.data[POOL_MAYHEM_MODE_OFFSET] === 1;
    
    let feeRecipient;
    if (isMayhemMode && configInfo && configInfo.data.length >= GLOBALCONFIG_RESERVED_FEE_OFFSET + 32) {
        feeRecipient = new PublicKey(configInfo.data.slice(
            GLOBALCONFIG_RESERVED_FEE_OFFSET,
            GLOBALCONFIG_RESERVED_FEE_OFFSET + 32
        ));
    } else {
        feeRecipient = STANDARD_PUMPSWAP_FEE_RECIPIENT;
    }
    
    // Get fee recipient's WSOL account
    const feeRecipientTokenAccount = await getAssociatedTokenAddress(
        WSOL_MINT,
        feeRecipient,
        true,
        TOKEN_PROGRAM
    );
    
    return { recipient: feeRecipient, tokenAccount: feeRecipientTokenAccount };
}

// ============================================================================
// BUY TOKENS ON PUMPSWAP
// ============================================================================

/**
 * Buy tokens on PumpSwap AMM
 */
export async function buyOnPumpSwap(connection, payer, mint, solAmount, slippage = 0.25, indexedConnection = null) {
    const mintStr = typeof mint === 'string' ? mint : mint.toBase58();
    console.log(`[PumpSwap] Buying ${solAmount} SOL worth of ${mintStr}`);
    
    // Find pool (use indexed connection if available)
    const pool = await findPumpSwapPool(connection, mint, indexedConnection);
    if (!pool) {
        throw new Error('PumpSwap pool not found for this token');
    }
    
    // Get pool data using getMultipleAccountsInfo for better RPC compatibility
    const poolAccounts = await connection.getMultipleAccountsInfo([pool]);
    const poolInfo = poolAccounts?.[0];
    if (!poolInfo) {
        throw new Error('Pool account not found');
    }
    const poolData = parsePoolData(poolInfo.data);
    
    // Get token program
    const tokenProgram = await getTokenProgramForMint(connection, mint);
    
    // Calculate price and amounts
    const price = await calculatePoolPrice(
        connection,
        poolData.poolBaseTokenAccount,
        poolData.poolQuoteTokenAccount
    );
    
    const expectedTokens = Math.floor((solAmount / price) * (10 ** TOKEN_DECIMALS));
    const maxSolInput = Math.floor(solAmount * (1 + slippage) * LAMPORTS_PER_SOL);
    
    console.log(`[PumpSwap] Price: ${price.toFixed(12)} SOL per token`);
    console.log(`[PumpSwap] Expected tokens: ${expectedTokens / (10 ** TOKEN_DECIMALS)}`);
    console.log(`[PumpSwap] Max SOL input: ${maxSolInput / LAMPORTS_PER_SOL}`);
    
    // Derive addresses
    const userBaseTokenAccount = await getAssociatedTokenAddress(mint, payer.publicKey, false, tokenProgram);
    const userQuoteTokenAccount = await getAssociatedTokenAddress(WSOL_MINT, payer.publicKey, false, TOKEN_PROGRAM);
    const coinCreatorVaultAuthority = getCoinCreatorVaultAuthority(poolData.coinCreator);
    const coinCreatorVaultATA = await getCoinCreatorVaultATA(poolData.coinCreator);
    
    // Get fee recipient
    const { recipient: feeRecipient, tokenAccount: feeRecipientTokenAccount } = 
        await getPumpSwapFeeRecipient(connection, pool);
    
    // Build accounts (order matters!)
    const accounts = [
        { pubkey: pool, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: PUMP_SWAP_GLOBAL_CONFIG, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
        { pubkey: userBaseTokenAccount, isSigner: false, isWritable: true },
        { pubkey: userQuoteTokenAccount, isSigner: false, isWritable: true },
        { pubkey: poolData.poolBaseTokenAccount, isSigner: false, isWritable: true },
        { pubkey: poolData.poolQuoteTokenAccount, isSigner: false, isWritable: true },
        { pubkey: feeRecipient, isSigner: false, isWritable: false },
        { pubkey: feeRecipientTokenAccount, isSigner: false, isWritable: true },
        { pubkey: tokenProgram, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: PUMP_SWAP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_AMM_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: coinCreatorVaultATA, isSigner: false, isWritable: true },
        { pubkey: coinCreatorVaultAuthority, isSigner: false, isWritable: false },
        { pubkey: getPumpSwapGlobalVolumeAccumulator(), isSigner: false, isWritable: false },
        { pubkey: getPumpSwapUserVolumeAccumulator(payer.publicKey), isSigner: false, isWritable: true },
        { pubkey: getPumpSwapFeeConfig(), isSigner: false, isWritable: false },
        { pubkey: PUMP_FEE_PROGRAM, isSigner: false, isWritable: false },
    ];
    
    // Build instruction data: discriminator + amount_out + max_in + track_volume
    const trackVolume = Buffer.from([1]); // true
    const data = Buffer.concat([
        DISCRIMINATORS.PUMPSWAP_BUY,
        packU64(expectedTokens),
        packU64(maxSolInput),
        trackVolume,
    ]);
    
    const buyInstruction = new TransactionInstruction({
        keys: accounts,
        programId: PUMP_AMM_PROGRAM,
        data,
    });
    
    // Wrap SOL amount (with buffer for fees)
    const wrapAmount = Math.floor(solAmount * 1.1 * LAMPORTS_PER_SOL);
    
    // Build transaction
    const transaction = new Transaction();
    transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: DEFAULT_COMPUTE_UNITS }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: DEFAULT_COMPUTE_PRICE }),
        // Create WSOL ATA
        createAssociatedTokenAccountIdempotentInstruction(
            payer.publicKey,
            userQuoteTokenAccount,
            payer.publicKey,
            WSOL_MINT,
            TOKEN_PROGRAM
        ),
        // Transfer SOL to WSOL account
        SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: userQuoteTokenAccount,
            lamports: wrapAmount,
        }),
        // Sync native
        createSyncNativeInstruction(userQuoteTokenAccount, TOKEN_PROGRAM),
        // Create token ATA
        createAssociatedTokenAccountIdempotentInstruction(
            payer.publicKey,
            userBaseTokenAccount,
            payer.publicKey,
            mint,
            tokenProgram
        ),
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
    
    console.log(`[PumpSwap] Buy TX sent: ${signature}`);
    
    // Confirm
    await connection.confirmTransaction(signature, 'confirmed');
    console.log(`[PumpSwap] Buy confirmed!`);
    
    return signature;
}

// ============================================================================
// SELL TOKENS ON PUMPSWAP
// ============================================================================

/**
 * Sell tokens on PumpSwap AMM
 */
export async function sellOnPumpSwap(connection, payer, mint, tokenAmount = null, slippage = 0.25, indexedConnection = null) {
    const mintStr = typeof mint === 'string' ? mint : mint.toBase58();
    console.log(`[PumpSwap] Selling tokens of ${mintStr}`);
    
    // Find pool (use indexed connection if available)
    const pool = await findPumpSwapPool(connection, mint, indexedConnection);
    if (!pool) {
        throw new Error('PumpSwap pool not found for this token');
    }
    
    // Get pool data using getMultipleAccountsInfo for better RPC compatibility
    const poolAccountsData = await connection.getMultipleAccountsInfo([pool]);
    const poolInfo = poolAccountsData?.[0];
    if (!poolInfo) {
        throw new Error('Pool account not found');
    }
    const poolData = parsePoolData(poolInfo.data);
    
    // Get token program
    const tokenProgram = await getTokenProgramForMint(connection, mint);
    
    // Derive addresses
    const userBaseTokenAccount = await getAssociatedTokenAddress(mint, payer.publicKey, false, tokenProgram);
    const userQuoteTokenAccount = await getAssociatedTokenAddress(WSOL_MINT, payer.publicKey, false, TOKEN_PROGRAM);
    
    // Get token balance if not specified
    if (tokenAmount === null) {
        const balance = await connection.getTokenAccountBalance(userBaseTokenAccount);
        tokenAmount = parseInt(balance.value.amount);
        console.log(`[PumpSwap] Selling all tokens: ${tokenAmount / (10 ** TOKEN_DECIMALS)}`);
    }
    
    if (tokenAmount === 0) {
        throw new Error('No tokens to sell');
    }
    
    // Calculate price and expected output
    const price = await calculatePoolPrice(
        connection,
        poolData.poolBaseTokenAccount,
        poolData.poolQuoteTokenAccount
    );
    
    const expectedSol = (tokenAmount / (10 ** TOKEN_DECIMALS)) * price;
    const minSolOutput = Math.floor(expectedSol * (1 - slippage) * LAMPORTS_PER_SOL);
    
    console.log(`[PumpSwap] Price: ${price.toFixed(12)} SOL per token`);
    console.log(`[PumpSwap] Expected SOL: ${expectedSol.toFixed(9)}`);
    console.log(`[PumpSwap] Min SOL output: ${minSolOutput / LAMPORTS_PER_SOL}`);
    
    const coinCreatorVaultAuthority = getCoinCreatorVaultAuthority(poolData.coinCreator);
    const coinCreatorVaultATA = await getCoinCreatorVaultATA(poolData.coinCreator);
    
    // Get fee recipient
    const { recipient: feeRecipient, tokenAccount: feeRecipientTokenAccount } = 
        await getPumpSwapFeeRecipient(connection, pool);
    
    // Build accounts
    const accounts = [
        { pubkey: pool, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: PUMP_SWAP_GLOBAL_CONFIG, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
        { pubkey: userBaseTokenAccount, isSigner: false, isWritable: true },
        { pubkey: userQuoteTokenAccount, isSigner: false, isWritable: true },
        { pubkey: poolData.poolBaseTokenAccount, isSigner: false, isWritable: true },
        { pubkey: poolData.poolQuoteTokenAccount, isSigner: false, isWritable: true },
        { pubkey: feeRecipient, isSigner: false, isWritable: false },
        { pubkey: feeRecipientTokenAccount, isSigner: false, isWritable: true },
        { pubkey: tokenProgram, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: PUMP_SWAP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_AMM_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: coinCreatorVaultATA, isSigner: false, isWritable: true },
        { pubkey: coinCreatorVaultAuthority, isSigner: false, isWritable: false },
        { pubkey: getPumpSwapFeeConfig(), isSigner: false, isWritable: false },
        { pubkey: PUMP_FEE_PROGRAM, isSigner: false, isWritable: false },
    ];
    
    // Build instruction data: discriminator + amount + min_out
    const data = Buffer.concat([
        DISCRIMINATORS.PUMPSWAP_SELL,
        packU64(tokenAmount),
        packU64(minSolOutput),
    ]);
    
    const sellInstruction = new TransactionInstruction({
        keys: accounts,
        programId: PUMP_AMM_PROGRAM,
        data,
    });
    
    // Build transaction
    const transaction = new Transaction();
    transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: DEFAULT_COMPUTE_UNITS }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: DEFAULT_COMPUTE_PRICE }),
        // Create WSOL ATA to receive SOL
        createAssociatedTokenAccountIdempotentInstruction(
            payer.publicKey,
            userQuoteTokenAccount,
            payer.publicKey,
            WSOL_MINT,
            TOKEN_PROGRAM
        ),
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
    
    console.log(`[PumpSwap] Sell TX sent: ${signature}`);
    
    // Confirm
    await connection.confirmTransaction(signature, 'confirmed');
    console.log(`[PumpSwap] Sell confirmed!`);
    
    return signature;
}

// ============================================================================
// GET PRICE
// ============================================================================

/**
 * Get current price from PumpSwap pool
 * Uses getMultipleAccountsInfo for better RPC compatibility
 */
export async function getPumpSwapPrice(connection, mint, indexedConnection = null) {
    const pool = await findPumpSwapPool(connection, mint, indexedConnection);
    if (!pool) {
        return null;
    }
    
    // Use getMultipleAccountsInfo for better RPC compatibility
    const poolAccounts = await connection.getMultipleAccountsInfo([pool]);
    const poolInfo = poolAccounts?.[0];
    if (!poolInfo) {
        return null;
    }
    const poolData = parsePoolData(poolInfo.data);
    
    const price = await calculatePoolPrice(
        connection,
        poolData.poolBaseTokenAccount,
        poolData.poolQuoteTokenAccount
    );
    
    return {
        price,
        pool,
        poolData,
    };
}

