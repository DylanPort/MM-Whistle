/**
 * Token Discovery - Find tokens created by a PDA wallet
 * 
 * Since Pump.fun's create instruction uses the "user" account as the creator,
 * we can scan the vault PDA's transaction history to find token creation events.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { PUMP_FUN_PROGRAM } from '../contract/index.js';

// Pump.fun create instruction discriminator (first 8 bytes)
const CREATE_DISCRIMINATOR = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]);

/**
 * Discover tokens created by a wallet (vault PDA)
 * @param {Connection} connection - Solana RPC connection
 * @param {string|PublicKey} vaultAddress - The vault PDA address to search
 * @param {number} limit - Max number of signatures to fetch
 * @returns {Promise<Array<{mint: string, signature: string, blockTime: number}>>}
 */
export async function discoverTokensByCreator(connection, vaultAddress, limit = 100) {
    const vaultPubkey = typeof vaultAddress === 'string' ? new PublicKey(vaultAddress) : vaultAddress;
    const tokens = [];
    
    try {
        // Get transaction signatures for this wallet
        const signatures = await connection.getSignaturesForAddress(vaultPubkey, { limit });
        
        console.log(`[Discovery] Found ${signatures.length} signatures for ${vaultPubkey.toBase58().slice(0,8)}...`);
        
        for (const sig of signatures) {
            try {
                // Get full transaction
                const tx = await connection.getTransaction(sig.signature, {
                    maxSupportedTransactionVersion: 0,
                    commitment: 'confirmed'
                });
                
                if (!tx || !tx.meta || tx.meta.err) continue;
                
                // Look for Pump.fun program in the transaction
                const accountKeys = tx.transaction.message.staticAccountKeys || 
                                   tx.transaction.message.accountKeys;
                
                const pumpIndex = accountKeys.findIndex(k => 
                    k.toBase58() === PUMP_FUN_PROGRAM.toBase58()
                );
                
                if (pumpIndex === -1) continue;
                
                // Check inner instructions for token creation
                const innerInstructions = tx.meta.innerInstructions || [];
                
                // Look for token mint creation in post token balances
                const postTokenBalances = tx.meta.postTokenBalances || [];
                
                for (const balance of postTokenBalances) {
                    // Token creation typically has the creator as the owner of the first token account
                    if (balance.owner === vaultPubkey.toBase58() && balance.uiTokenAmount.uiAmount > 0) {
                        const mint = balance.mint;
                        
                        // Verify this looks like a new token (not already in our list)
                        if (!tokens.find(t => t.mint === mint)) {
                            tokens.push({
                                mint,
                                signature: sig.signature,
                                blockTime: sig.blockTime || tx.blockTime,
                                amount: balance.uiTokenAmount.uiAmount
                            });
                            console.log(`[Discovery] Found token: ${mint} (${balance.uiTokenAmount.uiAmount} tokens)`);
                        }
                    }
                }
                
                // Also check if any new mint accounts were created in this tx
                // by looking at account keys that match token program patterns
                for (let i = 0; i < accountKeys.length; i++) {
                    const key = accountKeys[i];
                    
                    // Check if this account was created in this transaction
                    const preBalance = tx.meta.preBalances[i];
                    const postBalance = tx.meta.postBalances[i];
                    
                    // New account created (0 -> some balance)
                    if (preBalance === 0 && postBalance > 0) {
                        // Check if it looks like a mint account (rent exempt min lamports for mint ~1.5M)
                        if (postBalance > 1000000 && postBalance < 3000000) {
                            // This could be a mint, verify with token program
                            try {
                                const accountInfo = await connection.getAccountInfo(key);
                                if (accountInfo && accountInfo.owner.toBase58() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
                                    // This is a token mint!
                                    const mintAddress = key.toBase58();
                                    if (!tokens.find(t => t.mint === mintAddress)) {
                                        tokens.push({
                                            mint: mintAddress,
                                            signature: sig.signature,
                                            blockTime: sig.blockTime || tx.blockTime,
                                            amount: 0
                                        });
                                        console.log(`[Discovery] Found mint account: ${mintAddress}`);
                                    }
                                }
                            } catch (e) {
                                // Skip if can't fetch account info
                            }
                        }
                    }
                }
                
            } catch (e) {
                // Skip failed transaction fetches
                console.log(`[Discovery] Error processing tx ${sig.signature.slice(0,8)}...: ${e.message}`);
            }
        }
        
    } catch (e) {
        console.error(`[Discovery] Error fetching signatures: ${e.message}`);
    }
    
    return tokens;
}

/**
 * Quick check if a vault PDA has created any tokens
 * Uses a simpler heuristic - checks if any token accounts exist for this wallet
 */
export async function hasCreatedTokens(connection, vaultAddress) {
    const vaultPubkey = typeof vaultAddress === 'string' ? new PublicKey(vaultAddress) : vaultAddress;
    
    try {
        // Get token accounts owned by this wallet
        const tokenAccounts = await connection.getTokenAccountsByOwner(vaultPubkey, {
            programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
        });
        
        return tokenAccounts.value.length > 0;
    } catch (e) {
        return false;
    }
}

/**
 * Get token mints from vault's transaction history
 * This works even if the RPC doesn't have token secondary indexes
 */
export async function getVaultTokenMints(connection, vaultAddress) {
    const vaultPubkey = typeof vaultAddress === 'string' ? new PublicKey(vaultAddress) : vaultAddress;
    const mints = [];
    
    try {
        // Get transaction history for this vault
        const signatures = await connection.getSignaturesForAddress(vaultPubkey, { limit: 20 });
        
        for (const sig of signatures) {
            try {
                const tx = await connection.getTransaction(sig.signature, {
                    maxSupportedTransactionVersion: 0,
                    commitment: 'confirmed'
                });
                
                if (!tx || !tx.meta || tx.meta.err) continue;
                
                // Check for Pump.fun program
                const keys = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys;
                const pumpIdx = keys.findIndex(k => 
                    k.toBase58() === PUMP_FUN_PROGRAM.toBase58()
                );
                
                if (pumpIdx >= 0) {
                    // Check log messages for "Create" instruction
                    const logs = tx.meta.logMessages || [];
                    const isCreate = logs.some(log => log.includes('Instruction: Create'));
                    
                    if (isCreate) {
                        // Get token from postTokenBalances
                        const postTokenBalances = tx.meta.postTokenBalances || [];
                        for (const balance of postTokenBalances) {
                            const mint = balance.mint;
                            const amount = balance.uiTokenAmount?.uiAmount || 0;
                            
                            // Skip if we already have this mint
                            if (!mints.find(m => m.mint === mint)) {
                                mints.push({
                                    mint,
                                    balance: amount,
                                    signature: sig.signature,
                                    blockTime: sig.blockTime
                                });
                                console.log(`[Discovery] Found token ${mint} in tx ${sig.signature.slice(0,12)}...`);
                            }
                        }
                    }
                }
            } catch (txError) {
                // Skip failed transaction fetches
            }
        }
        
    } catch (e) {
        console.error(`[Discovery] Error getting transaction history: ${e.message}`);
    }
    
    return mints;
}

export default {
    discoverTokensByCreator,
    hasCreatedTokens,
    getVaultTokenMints
};

