/**
 * Smart Contract Client for MM Wallet Program v2
 * 
 * Program ID: 4ZzKbBw9o1CuVgGVokLNWsgHy9Acnd4EzVH5N6nnbyf5
 */

import { 
    PublicKey, 
    SystemProgram, 
    Transaction,
    TransactionInstruction,
    LAMPORTS_PER_SOL,
    Keypair
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import BN from 'bn.js';

// ============================================================================
// CONSTANTS
// ============================================================================

// Deployed Program ID (mainnet)
export const MM_WALLET_PROGRAM_ID = new PublicKey('4ZzKbBw9o1CuVgGVokLNWsgHy9Acnd4EzVH5N6nnbyf5');

// Pump.fun Program Constants
export const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMP_GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
export const PUMP_FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');
export const PUMP_EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');

// Pump.fun Fee Program
export const PUMP_FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

// Pump.fun Global Volume Accumulator (derived PDA)
const [PUMP_GLOBAL_VOLUME_ACCUMULATOR] = PublicKey.findProgramAddressSync(
    [Buffer.from('global_volume_accumulator')],
    PUMP_FUN_PROGRAM
);

// Pump.fun Fee Config (derived PDA from fee program)
const [PUMP_FEE_CONFIG] = PublicKey.findProgramAddressSync(
    [Buffer.from('fee_config'), PUMP_FUN_PROGRAM.toBuffer()],
    PUMP_FEE_PROGRAM
);

// Helper to derive user volume accumulator
function getUserVolumeAccumulator(user) {
    const userPubkey = typeof user === 'string' ? new PublicKey(user) : user;
    const [address] = PublicKey.findProgramAddressSync(
        [Buffer.from('user_volume_accumulator'), userPubkey.toBuffer()],
        PUMP_FUN_PROGRAM
    );
    return address;
}

// Helper to derive creator vault
export function getCreatorVault(creator) {
    const creatorPubkey = typeof creator === 'string' ? new PublicKey(creator) : creator;
    const [address] = PublicKey.findProgramAddressSync(
        [Buffer.from('creator-vault'), creatorPubkey.toBuffer()],
        PUMP_FUN_PROGRAM
    );
    return address;
}

// Metaplex Metadata Program
export const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
export const MPL_TOKEN_METADATA = METADATA_PROGRAM; // Alias for SDK compatibility
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const SYSVAR_RENT_PUBKEY = new PublicKey('SysvarRent111111111111111111111111111111111');

// Pump.fun Mayhem Mode (CreateV2) constants
export const MAYHEM_PROGRAM_ID = new PublicKey('MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e');
export const MAYHEM_GLOBAL_PARAMS = new PublicKey('13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ');
export const MAYHEM_SOL_VAULT = new PublicKey('BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s');

// Anchor instruction discriminators (sha256 hash of "global:<instruction_name>")[0..8]
const DISCRIMINATORS = {
    initialize: Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]),
    deposit: Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]),
    withdraw: Buffer.from([183, 18, 70, 156, 148, 109, 161, 34]),
    withdrawTokens: Buffer.from([2, 4, 225, 61, 19, 182, 106, 170]),
    executeBuy: Buffer.from([14, 137, 248, 5, 172, 244, 183, 152]),    // global:execute_buy
    executeSell: Buffer.from([105, 247, 168, 116, 231, 104, 224, 46]), // global:execute_sell
    executeSwap: Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]),
    claimFees: Buffer.from([82, 251, 233, 156, 12, 52, 184, 202]),     // global:claim_fees
    createToken: Buffer.from([84, 52, 204, 228, 24, 140, 234, 75]),
    setTokenMint: Buffer.from([47, 4, 88, 199, 117, 75, 168, 62]),
    updateStrategy: Buffer.from([16, 76, 138, 179, 171, 112, 196, 21]), // global:update_strategy
    setOperator: Buffer.from([238, 153, 101, 169, 243, 131, 36, 1]),    // global:set_operator
    pause: Buffer.from([211, 22, 221, 251, 74, 121, 193, 47]),
    resume: Buffer.from([1, 166, 51, 170, 127, 32, 141, 206]),          // global:resume
    extendLock: Buffer.from([68, 151, 140, 144, 139, 122, 118, 170]),   // global:extend_lock
};

// Strategy enum
export const STRATEGIES = {
    VolumeBot: 0,
    PriceReactive: 1,
    GridTrading: 2,
    TrendFollower: 3,
    SpreadMM: 4,
    PumpHunter: 5,
};

export const STRATEGY_NAMES = ['VolumeBot', 'PriceReactive', 'GridTrading', 'TrendFollower', 'SpreadMM', 'PumpHunter'];

// ============================================================================
// PDA DERIVATION
// ============================================================================

/**
 * Derive the MM Wallet PDA (state account) for a given owner and nonce
 * Seeds: ["mm_wallet", owner, nonce]
 */
export function getMmWalletPDA(owner, nonce) {
    const ownerPubkey = typeof owner === 'string' ? new PublicKey(owner) : owner;
    const nonceBuffer = Buffer.alloc(8);
    nonceBuffer.writeBigUInt64LE(BigInt(nonce));
    
    const [pda, bump] = PublicKey.findProgramAddressSync(
        [
            Buffer.from('mm_wallet'),
            ownerPubkey.toBuffer(),
            nonceBuffer
        ],
        MM_WALLET_PROGRAM_ID
    );
    return { pda, bump };
}

/**
 * Derive the PDA wallet (vault for SOL) address
 * Seeds: ["vault", owner, nonce] - DIFFERENT from mm_wallet!
 */
export function getPdaWalletAddress(owner, nonce) {
    const ownerPubkey = typeof owner === 'string' ? new PublicKey(owner) : owner;
    
    const nonceBuffer = Buffer.alloc(8);
    nonceBuffer.writeBigUInt64LE(BigInt(nonce));
    
    const [pda, bump] = PublicKey.findProgramAddressSync(
        [
            Buffer.from('vault'),
            ownerPubkey.toBuffer(),
            nonceBuffer
        ],
        MM_WALLET_PROGRAM_ID
    );
    return { pda, bump };
}

// ============================================================================
// INSTRUCTION BUILDERS
// ============================================================================

/**
 * Create instruction to initialize a new MM wallet
 */
export function createInitializeInstruction(
    owner,
    nonce,
    lockSeconds,
    strategy,
    config,
    operator = null
) {
    const ownerPubkey = typeof owner === 'string' ? new PublicKey(owner) : owner;
    const { pda: mmWallet } = getMmWalletPDA(ownerPubkey, nonce);
    // pda_wallet (vault) uses DIFFERENT seeds: ["vault", owner, nonce]
    const { pda: pdaWallet } = getPdaWalletAddress(ownerPubkey, nonce);
    
    // Serialize strategy config (matches IDL StrategyConfig)
    const configBuffer = Buffer.alloc(48); // 1 + 2 + 2 + 2 + 2 + 2 + 2 + 32 + padding
    let offset = 0;
    configBuffer.writeUInt8(config.tradeSizePct || 10, offset); offset += 1;
    configBuffer.writeUInt16LE(config.minDelaySecs || 30, offset); offset += 2;
    configBuffer.writeUInt16LE(config.maxDelaySecs || 120, offset); offset += 2;
    configBuffer.writeUInt16LE(config.slippageBps || 500, offset); offset += 2;
    configBuffer.writeUInt16LE(config.param1 || 0, offset); offset += 2;
    configBuffer.writeUInt16LE(config.param2 || 0, offset); offset += 2;
    configBuffer.writeUInt16LE(config.param3 || 0, offset); offset += 2;
    // 32 bytes reserved (zeros)
    
    // Nonce as u64
    const nonceBuffer = Buffer.alloc(8);
    nonceBuffer.writeBigUInt64LE(BigInt(nonce));
    
    // Lock seconds as i64
    const lockBuffer = Buffer.alloc(8);
    lockBuffer.writeBigInt64LE(BigInt(lockSeconds));
    
    // Strategy as single byte
    const strategyBuffer = Buffer.from([strategy]);
    
    // Operator pubkey (32 bytes)
    const operatorPubkey = operator ? 
        (typeof operator === 'string' ? new PublicKey(operator) : operator) : 
        ownerPubkey;
    
    // Build instruction data
    const data = Buffer.concat([
        DISCRIMINATORS.initialize,
        nonceBuffer,           // nonce: u64
        lockBuffer,            // lockSeconds: i64
        strategyBuffer,        // strategy: Strategy (enum, 1 byte)
        configBuffer,          // config: StrategyConfig
        operatorPubkey.toBuffer() // operator: Pubkey
    ]);
    
    const keys = [
        { pubkey: mmWallet, isSigner: false, isWritable: true },
        { pubkey: pdaWallet, isSigner: false, isWritable: false },
        { pubkey: ownerPubkey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    
    return new TransactionInstruction({
        keys,
        programId: MM_WALLET_PROGRAM_ID,
        data,
    });
}

/**
 * Create instruction to deposit SOL to MM wallet
 * Note: Requires owner and nonce to derive the vault PDA
 */
export function createDepositInstruction(owner, nonce, depositor, amountLamports) {
    const ownerPubkey = typeof owner === 'string' ? new PublicKey(owner) : owner;
    const depositorPubkey = typeof depositor === 'string' ? new PublicKey(depositor) : depositor;
    const { pda: mmWallet } = getMmWalletPDA(ownerPubkey, nonce);
    // vault PDA uses ["vault", owner, nonce] seeds
    const { pda: pdaWallet } = getPdaWalletAddress(ownerPubkey, nonce);
    
    const amountBuffer = Buffer.alloc(8);
    amountBuffer.writeBigUInt64LE(BigInt(amountLamports));
    
    const data = Buffer.concat([
        DISCRIMINATORS.deposit,
        amountBuffer,
    ]);
    
    const keys = [
        { pubkey: mmWallet, isSigner: false, isWritable: false },
        { pubkey: pdaWallet, isSigner: false, isWritable: true },
        { pubkey: depositorPubkey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    
    return new TransactionInstruction({
        keys,
        programId: MM_WALLET_PROGRAM_ID,
        data,
    });
}

/**
 * Create deposit instruction using known mm_wallet address and owner/nonce
 * (Uses vault PDA derived from owner/nonce)
 */
export function createDepositInstructionDirect(mmWallet, owner, nonce, depositor, amountLamports) {
    const mmWalletPubkey = typeof mmWallet === 'string' ? new PublicKey(mmWallet) : mmWallet;
    const depositorPubkey = typeof depositor === 'string' ? new PublicKey(depositor) : depositor;
    // Derive vault PDA using ["vault", owner, nonce] seeds
    const { pda: pdaWallet } = getPdaWalletAddress(owner, nonce);
    
    const amountBuffer = Buffer.alloc(8);
    amountBuffer.writeBigUInt64LE(BigInt(amountLamports));
    
    const data = Buffer.concat([
        DISCRIMINATORS.deposit,
        amountBuffer,
    ]);
    
    const keys = [
        { pubkey: mmWalletPubkey, isSigner: false, isWritable: false },
        { pubkey: pdaWallet, isSigner: false, isWritable: true },
        { pubkey: depositorPubkey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    
    return new TransactionInstruction({
        keys,
        programId: MM_WALLET_PROGRAM_ID,
        data,
    });
}

/**
 * Create instruction to withdraw SOL from MM wallet (owner only, after lock)
 * Note: Requires nonce to derive vault PDA
 */
export function createWithdrawInstruction(owner, nonce, destination, amountLamports) {
    const ownerPubkey = typeof owner === 'string' ? new PublicKey(owner) : owner;
    const destinationPubkey = typeof destination === 'string' ? new PublicKey(destination) : destination;
    const { pda: mmWallet } = getMmWalletPDA(ownerPubkey, nonce);
    // vault PDA uses ["vault", owner, nonce] seeds
    const { pda: pdaWallet } = getPdaWalletAddress(ownerPubkey, nonce);
    
    const amountBuffer = Buffer.alloc(8);
    amountBuffer.writeBigUInt64LE(BigInt(amountLamports));
    
    const data = Buffer.concat([
        DISCRIMINATORS.withdraw,
        amountBuffer,
    ]);
    
    const keys = [
        { pubkey: mmWallet, isSigner: false, isWritable: false },
        { pubkey: pdaWallet, isSigner: false, isWritable: true },
        { pubkey: ownerPubkey, isSigner: true, isWritable: true },
        { pubkey: destinationPubkey, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    
    return new TransactionInstruction({
        keys,
        programId: MM_WALLET_PROGRAM_ID,
        data,
    });
}

/**
 * Create withdraw instruction using known mm_wallet address and owner/nonce
 */
export function createWithdrawInstructionDirect(mmWallet, owner, nonce, destination, amountLamports) {
    const mmWalletPubkey = typeof mmWallet === 'string' ? new PublicKey(mmWallet) : mmWallet;
    const ownerPubkey = typeof owner === 'string' ? new PublicKey(owner) : owner;
    const destinationPubkey = typeof destination === 'string' ? new PublicKey(destination) : destination;
    // Derive vault PDA using ["vault", owner, nonce] seeds
    const { pda: pdaWallet } = getPdaWalletAddress(owner, nonce);
    
    const amountBuffer = Buffer.alloc(8);
    amountBuffer.writeBigUInt64LE(BigInt(amountLamports));
    
    const data = Buffer.concat([
        DISCRIMINATORS.withdraw,
        amountBuffer,
    ]);
    
    const keys = [
        { pubkey: mmWalletPubkey, isSigner: false, isWritable: false },
        { pubkey: pdaWallet, isSigner: false, isWritable: true },
        { pubkey: ownerPubkey, isSigner: true, isWritable: true },
        { pubkey: destinationPubkey, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    
    return new TransactionInstruction({
        keys,
        programId: MM_WALLET_PROGRAM_ID,
        data,
    });
}

/**
 * Create instruction to pause trading
 */
export function createPauseInstruction(mmWallet, owner) {
    const mmWalletPubkey = typeof mmWallet === 'string' ? new PublicKey(mmWallet) : mmWallet;
    const ownerPubkey = typeof owner === 'string' ? new PublicKey(owner) : owner;
    
    const keys = [
        { pubkey: mmWalletPubkey, isSigner: false, isWritable: true },
        { pubkey: ownerPubkey, isSigner: true, isWritable: false },
    ];
    
    return new TransactionInstruction({
        keys,
        programId: MM_WALLET_PROGRAM_ID,
        data: DISCRIMINATORS.pause,
    });
}

/**
 * Create instruction to resume trading
 */
export function createResumeInstruction(mmWallet, owner) {
    const mmWalletPubkey = typeof mmWallet === 'string' ? new PublicKey(mmWallet) : mmWallet;
    const ownerPubkey = typeof owner === 'string' ? new PublicKey(owner) : owner;
    
    const keys = [
        { pubkey: mmWalletPubkey, isSigner: false, isWritable: true },
        { pubkey: ownerPubkey, isSigner: true, isWritable: false },
    ];
    
    return new TransactionInstruction({
        keys,
        programId: MM_WALLET_PROGRAM_ID,
        data: DISCRIMINATORS.resume,
    });
}

// ============================================================================
// TOKEN CREATION (PDA as creator - fees go to vault!)
// ============================================================================

/**
 * Derive Pump.fun accounts for token creation from a given mint
 * NOTE: Pump.fun uses a NEW Keypair for mint, not derived PDAs!
 */
export function derivePumpFunAccounts(mintPubkey) {
    const mint = typeof mintPubkey === 'string' ? new PublicKey(mintPubkey) : mintPubkey;
    
    // Bonding curve PDA
    const [bondingCurve] = PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), mint.toBuffer()],
        PUMP_FUN_PROGRAM
    );
    
    // Bonding curve ATA
    const bondingCurveAta = getAssociatedTokenAddressSync(mint, bondingCurve, true);
    
    // Metadata PDA
    const [metadata] = PublicKey.findProgramAddressSync(
        [Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), mint.toBuffer()],
        METADATA_PROGRAM
    );
    
    return {
        mint,
        bondingCurve,
        bondingCurveAta,
        metadata,
    };
}

/**
 * Create instruction to create a token on Pump.fun with PDA as creator
 * This makes creator fees go directly to the vault!
 * 
 * IMPORTANT: You need to generate a NEW Keypair for the mint and pass it!
 * The mint keypair must sign the transaction.
 * 
 * @param owner - Owner wallet pubkey
 * @param nonce - Nonce for PDA derivation
 * @param mintKeypair - NEW Keypair for the token mint (must sign tx!)
 * @param name - Token name
 * @param symbol - Token symbol  
 * @param uri - Metadata URI
 */
export function createTokenInstruction(owner, nonce, mintKeypair, name, symbol, uri) {
    const ownerPubkey = typeof owner === 'string' ? new PublicKey(owner) : owner;
    const { pda: mmWallet } = getMmWalletPDA(ownerPubkey, nonce);
    const { pda: vaultPda } = getPdaWalletAddress(ownerPubkey, nonce);
    const mint = mintKeypair.publicKey;
    
    // Derive Pump.fun accounts from the mint
    const pumpAccounts = derivePumpFunAccounts(mint);
    const vaultAta = getAssociatedTokenAddressSync(mint, vaultPda, true);
    
    // Pump.fun legacy create discriminator (SDK uses this)
    const PUMP_LEGACY_DISCRIMINATOR = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]);
    
    const nameBytes = Buffer.from(name, 'utf8');
    const symbolBytes = Buffer.from(symbol, 'utf8');
    const uriBytes = Buffer.from(uri, 'utf8');
    
    // Build pumpCreateData - EXACT format from working test:
    // discriminator (8) + name (4+len) + symbol (4+len) + uri (4+len) + creator (32)
    const pumpCreateData = Buffer.alloc(8 + 4 + nameBytes.length + 4 + symbolBytes.length + 4 + uriBytes.length + 32);
    let pumpOffset = 0;
    
    PUMP_LEGACY_DISCRIMINATOR.copy(pumpCreateData, pumpOffset);
    pumpOffset += 8;
    
    pumpCreateData.writeUInt32LE(nameBytes.length, pumpOffset);
    pumpOffset += 4;
    nameBytes.copy(pumpCreateData, pumpOffset);
    pumpOffset += nameBytes.length;
    
    pumpCreateData.writeUInt32LE(symbolBytes.length, pumpOffset);
    pumpOffset += 4;
    symbolBytes.copy(pumpCreateData, pumpOffset);
    pumpOffset += symbolBytes.length;
    
    pumpCreateData.writeUInt32LE(uriBytes.length, pumpOffset);
    pumpOffset += 4;
    uriBytes.copy(pumpCreateData, pumpOffset);
    pumpOffset += uriBytes.length;
    
    // creator pubkey (vault PDA) - REQUIRED for Pump.fun create!
    vaultPda.toBuffer().copy(pumpCreateData, pumpOffset);
    
    // Build MM instruction data
    const numCreateAccounts = 14;
    const data = Buffer.alloc(8 + 4 + pumpCreateData.length + 1);
    let offset = 0;
    
    DISCRIMINATORS.createToken.copy(data, offset);
    offset += 8;
    
    data.writeUInt32LE(pumpCreateData.length, offset);
    offset += 4;
    
    pumpCreateData.copy(data, offset);
    offset += pumpCreateData.length;
    
    data.writeUInt8(numCreateAccounts, offset);
    
    // Pump.fun legacy create accounts (14 total) - EXACT ORDER FROM WORKING TEST
    const createAccounts = [
        mint,                        // 0: mint (signer)
        PUMP_MINT_AUTHORITY,         // 1: mint_authority (Pump.fun's PDA, NOT vault!)
        pumpAccounts.bondingCurve,   // 2: bonding_curve
        pumpAccounts.bondingCurveAta,// 3: bonding_curve_ata
        PUMP_GLOBAL,                 // 4: global
        MPL_TOKEN_METADATA,          // 5: mpl_token_metadata
        pumpAccounts.metadata,       // 6: metadata
        vaultPda,                    // 7: user/creator (vault PDA - THE CREATOR!)
        SystemProgram.programId,     // 8: system_program
        TOKEN_PROGRAM_ID,            // 9: token_program
        ASSOCIATED_TOKEN_PROGRAM,    // 10: associated_token_program
        SYSVAR_RENT_PUBKEY,          // 11: rent
        PUMP_EVENT_AUTHORITY,        // 12: event_authority
        PUMP_FUN_PROGRAM,            // 13: program
    ];
    
    // Build keys array - MUST MATCH CONTRACT'S CreateToken STRUCT!
    // Contract expects: mm_wallet, pda_wallet, owner, target_program, system_program
    const keys = [
        // Main accounts for CreateToken struct (5 accounts)
        { pubkey: mmWallet, isSigner: false, isWritable: true },           // 0: mm_wallet
        { pubkey: vaultPda, isSigner: false, isWritable: true },           // 1: pda_wallet
        { pubkey: ownerPubkey, isSigner: true, isWritable: true },         // 2: owner
        { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },  // 3: target_program
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 4: system_program
        // Remaining accounts for Pump.fun CPI (14 accounts)
        ...createAccounts.map((pubkey, i) => ({
            pubkey,
            isSigner: i === 0, // Only mint (index 0) is signer
            isWritable: [0, 2, 3, 6, 7].includes(i),
        })),
    ];
    
    return {
        instruction: new TransactionInstruction({
            keys,
            programId: MM_WALLET_PROGRAM_ID,
            data,
        }),
        mint,
        mintKeypair,  // Return so caller can add to signers
        bondingCurve: pumpAccounts.bondingCurve,
        metadata: pumpAccounts.metadata,
        vaultTokenAta: vaultAta,
    };
}

// Pump.fun mint authority PDA (derived, not fixed address!)
const [PUMP_MINT_AUTHORITY] = PublicKey.findProgramAddressSync(
    [Buffer.from('mint-authority')],
    PUMP_FUN_PROGRAM
);
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/**
 * Derive Pump.fun accounts for token creation from a mint
 * The mint is a NEW keypair generated for each token
 */
export function derivePumpFunAccountsFromMint(mintPubkey) {
    const mint = typeof mintPubkey === 'string' ? new PublicKey(mintPubkey) : mintPubkey;
    
    // Bonding curve PDA
    const [bondingCurve] = PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), mint.toBuffer()],
        PUMP_FUN_PROGRAM
    );
    
    // Associated bonding curve (token account for bonding curve)
    const [associatedBondingCurve] = PublicKey.findProgramAddressSync(
        [bondingCurve.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
        ASSOCIATED_TOKEN_PROGRAM
    );
    
    // Metadata PDA
    const [metadata] = PublicKey.findProgramAddressSync(
        [Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), mint.toBuffer()],
        METADATA_PROGRAM
    );
    
    return {
        bondingCurve,
        associatedBondingCurve,
        metadata,
    };
}

/**
 * Derive Mayhem Mode accounts for CreateV2
 */
function deriveMayhemAccounts(mint) {
    const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;
    
    // Mayhem State PDA: ["mayhem_state", mint]
    const [mayhemState] = PublicKey.findProgramAddressSync(
        [Buffer.from('mayhem_state'), mintPubkey.toBuffer()],
        MAYHEM_PROGRAM_ID
    );
    
    // Mayhem Token Vault: Token2022 ATA of SOL_VAULT for the mint
    const mayhemTokenVault = getAssociatedTokenAddressSync(
        mintPubkey,
        MAYHEM_SOL_VAULT,
        true,  // allowOwnerOffCurve
        TOKEN_2022_PROGRAM_ID  // Token2022!
    );
    
    return { mayhemState, mayhemTokenVault };
}

/**
 * Create instruction to create token with PDA as creator
 * 
 * WORKING VERSION - Tested and verified on mainnet!
 * Token: 63qivZsE9AL9yZib7KSx6CTmbvtbvz8e3zw4qJZwvocp
 * 
 * Main accounts (7):
 * 0. mmWallet - writable
 * 1. vault - writable  
 * 2. owner - signer, writable
 * 3. mint - signer, writable
 * 4. systemProgram
 * 5. tokenProgram
 * 6. pumpFunProgram (targetProgram)
 * 
 * Remaining accounts (14 for Pump.fun legacy Initialize):
 */
export function createTokenInstructionDirect(mmWallet, pdaWallet, owner, mintPubkey, name, symbol, uri) {
    const mmWalletPubkey = typeof mmWallet === 'string' ? new PublicKey(mmWallet) : mmWallet;
    const vault = typeof pdaWallet === 'string' ? new PublicKey(pdaWallet) : pdaWallet;
    const ownerPubkey = typeof owner === 'string' ? new PublicKey(owner) : owner;
    const mint = typeof mintPubkey === 'string' ? new PublicKey(mintPubkey) : mintPubkey;
    
    // Derive PDAs
    const [bondingCurve] = PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), mint.toBuffer()],
        PUMP_FUN_PROGRAM
    );
    const bondingCurveAta = getAssociatedTokenAddressSync(mint, bondingCurve, true);
    const [metadata] = PublicKey.findProgramAddressSync(
        [Buffer.from('metadata'), MPL_TOKEN_METADATA.toBuffer(), mint.toBuffer()],
        MPL_TOKEN_METADATA
    );
    const vaultAta = getAssociatedTokenAddressSync(mint, vault, true);
    
    // Pump.fun legacy create discriminator (SDK uses this)
    // Contract replaces this with its own, but format must be correct
    const PUMP_LEGACY_DISCRIMINATOR = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]);
    
    const nameBytes = Buffer.from(name, 'utf8');
    const symbolBytes = Buffer.from(symbol, 'utf8');
    const uriBytes = Buffer.from(uri, 'utf8');
    
    // Build pumpCreateData - EXACT format from working test-pda-legacy.cjs:
    // discriminator (8) + name (4+len) + symbol (4+len) + uri (4+len) + creator (32)
    const pumpCreateData = Buffer.alloc(8 + 4 + nameBytes.length + 4 + symbolBytes.length + 4 + uriBytes.length + 32);
    let pumpOffset = 0;
    
    // Discriminator
    PUMP_LEGACY_DISCRIMINATOR.copy(pumpCreateData, pumpOffset);
    pumpOffset += 8;
    
    // name (String = u32 length + bytes)
    pumpCreateData.writeUInt32LE(nameBytes.length, pumpOffset);
    pumpOffset += 4;
    nameBytes.copy(pumpCreateData, pumpOffset);
    pumpOffset += nameBytes.length;
    
    // symbol
    pumpCreateData.writeUInt32LE(symbolBytes.length, pumpOffset);
    pumpOffset += 4;
    symbolBytes.copy(pumpCreateData, pumpOffset);
    pumpOffset += symbolBytes.length;
    
    // uri
    pumpCreateData.writeUInt32LE(uriBytes.length, pumpOffset);
    pumpOffset += 4;
    uriBytes.copy(pumpCreateData, pumpOffset);
    pumpOffset += uriBytes.length;
    
    // creator pubkey (vault PDA) - REQUIRED for Pump.fun create!
    vault.toBuffer().copy(pumpCreateData, pumpOffset);
    
    // Build MM wallet instruction data
    const numCreateAccounts = 14;
    const data = Buffer.alloc(8 + 4 + pumpCreateData.length + 1);
    let offset = 0;
    
    // MM discriminator
    DISCRIMINATORS.createToken.copy(data, offset);
    offset += 8;
    
    // Vec<u8> length prefix (u32 LE)
    data.writeUInt32LE(pumpCreateData.length, offset);
    offset += 4;
    
    // pump_create_data bytes
    pumpCreateData.copy(data, offset);
    offset += pumpCreateData.length;
    
    // num_create_accounts (u8)
    data.writeUInt8(numCreateAccounts, offset);
    
    console.log(`[CreateToken] Creating token with PDA as creator`);
    console.log(`[CreateToken] Vault (creator): ${vault.toBase58()}`);
    console.log(`[CreateToken] Mint: ${mint.toBase58()}`);
    console.log(`[CreateToken] name: "${name}", symbol: "${symbol}"`);
    
    // Pump.fun legacy create accounts (14 total) - EXACT ORDER FROM WORKING TEST
    const createAccounts = [
        mint,                        // 0: mint (signer)
        PUMP_MINT_AUTHORITY,         // 1: mint_authority (Pump.fun's PDA, NOT vault!)
        bondingCurve,                // 2: bonding_curve
        bondingCurveAta,             // 3: bonding_curve_ata
        PUMP_GLOBAL,                 // 4: global
        MPL_TOKEN_METADATA,          // 5: mpl_token_metadata
        metadata,                    // 6: metadata
        vault,                       // 7: user/creator (vault PDA - THIS IS THE CREATOR!)
        SystemProgram.programId,     // 8: system_program
        TOKEN_PROGRAM_ID,            // 9: token_program
        ASSOCIATED_TOKEN_PROGRAM,    // 10: associated_token_program
        SYSVAR_RENT_PUBKEY,          // 11: rent
        PUMP_EVENT_AUTHORITY,        // 12: event_authority
        PUMP_FUN_PROGRAM,            // 13: program
    ];
    
    // Build keys array - MUST MATCH CONTRACT'S CreateToken STRUCT!
    // Contract expects: mm_wallet, pda_wallet, owner, target_program, system_program
    // Then remaining_accounts for Pump.fun CPI
    const keys = [
        // Main accounts for CreateToken struct (5 accounts)
        { pubkey: mmWalletPubkey, isSigner: false, isWritable: true },      // 0: mm_wallet
        { pubkey: vault, isSigner: false, isWritable: true },               // 1: pda_wallet
        { pubkey: ownerPubkey, isSigner: true, isWritable: true },          // 2: owner
        { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },   // 3: target_program
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 4: system_program
        // Remaining accounts for Pump.fun CPI (14 accounts)
        // Mint is at index 0 and must be a signer!
        ...createAccounts.map((pubkey, i) => ({
            pubkey,
            isSigner: i === 0, // Only mint (index 0) is signer in remaining accounts
            isWritable: [0, 2, 3, 6, 7].includes(i), // mint, bonding_curve, bonding_curve_ata, metadata, user
        })),
    ];
    
    return {
        instruction: new TransactionInstruction({
            programId: MM_WALLET_PROGRAM_ID,
            keys,
            data,
        }),
        mint,
        mintKeypair: null, // Caller provides this
        bondingCurve,
        metadata,
        vaultTokenAta: vaultAta,
        accounts: createAccounts,
    };
}

/**
 * Create instruction to set a new operator
 */
export function createSetOperatorInstruction(mmWallet, owner, newOperator) {
    const mmWalletPubkey = typeof mmWallet === 'string' ? new PublicKey(mmWallet) : mmWallet;
    const ownerPubkey = typeof owner === 'string' ? new PublicKey(owner) : owner;
    const newOperatorPubkey = typeof newOperator === 'string' ? new PublicKey(newOperator) : newOperator;
    
    const data = Buffer.concat([
        DISCRIMINATORS.setOperator,
        newOperatorPubkey.toBuffer(),
    ]);
    
    const keys = [
        { pubkey: mmWalletPubkey, isSigner: false, isWritable: true },
        { pubkey: ownerPubkey, isSigner: true, isWritable: false },
    ];
    
    return new TransactionInstruction({
        keys,
        programId: MM_WALLET_PROGRAM_ID,
        data,
    });
}

/**
 * Create instruction to extend the lock period
 */
export function createExtendLockInstruction(mmWallet, owner, additionalSeconds) {
    const mmWalletPubkey = typeof mmWallet === 'string' ? new PublicKey(mmWallet) : mmWallet;
    const ownerPubkey = typeof owner === 'string' ? new PublicKey(owner) : owner;
    
    const additionalBuffer = Buffer.alloc(8);
    additionalBuffer.writeBigInt64LE(BigInt(additionalSeconds));
    
    const data = Buffer.concat([
        DISCRIMINATORS.extendLock,
        additionalBuffer,
    ]);
    
    const keys = [
        { pubkey: mmWalletPubkey, isSigner: false, isWritable: true },
        { pubkey: ownerPubkey, isSigner: true, isWritable: false },
    ];
    
    return new TransactionInstruction({
        keys,
        programId: MM_WALLET_PROGRAM_ID,
        data,
    });
}

/**
 * Get creator vault balance (accumulated trading fees from being the token creator)
 * @param connection - Solana connection
 * @param creator - The creator address (vault PDA that created the token)
 * @returns Balance in SOL
 */
export async function getCreatorFees(connection, creator) {
    const creatorPubkey = typeof creator === 'string' ? new PublicKey(creator) : creator;
    const creatorVault = getCreatorVault(creatorPubkey);
    try {
        const balance = await connection.getBalance(creatorVault);
        return balance / 1e9; // Return in SOL
    } catch (e) {
        return 0;
    }
}

/**
 * Create instruction to claim accumulated creator fees
 * When the vault PDA is the token creator, trading fees accumulate in its creator vault
 * 
 * WORKING VERSION - Tested on mainnet!
 * Tx: 5Bp64tx4fbYjYv6ieGy62PqvE5PVop2SbjnKq2PNvKLFfvNthHNkYh3uBSLmepwVopsGvAjd61v6UXEXxFDvgDGH
 * 
 * Contract ClaimFees struct:
 * 0. mmWallet - writable
 * 1. pdaWallet (vault) - writable
 * 2. caller - signer
 * 
 * Remaining accounts for Pump.fun claim CPI (5 total):
 * 0. vault (creator) - writable
 * 1. creator_vault - writable  
 * 2. system_program
 * 3. event_authority
 * 4. pump_fun_program
 */
export function createClaimFeesInstruction(
    mmWallet,
    vault,
    caller
) {
    const mmWalletPubkey = typeof mmWallet === 'string' ? new PublicKey(mmWallet) : mmWallet;
    const vaultPubkey = typeof vault === 'string' ? new PublicKey(vault) : vault;
    const callerPubkey = typeof caller === 'string' ? new PublicKey(caller) : caller;
    
    // Derive creator vault PDA (where Pump.fun deposits creator fees)
    const creatorVault = getCreatorVault(vaultPubkey);
    
    // Pump.fun claim accounts (from PumpPortal - VERIFIED WORKING)
    const claimAccounts = [
        { pubkey: vaultPubkey, isSigner: false, isWritable: true },      // 0: creator (vault PDA)
        { pubkey: creatorVault, isSigner: false, isWritable: true },     // 1: creator_vault
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 2: system_program
        { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },    // 3: event_authority
        { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },        // 4: program
    ];
    
    const data = DISCRIMINATORS.claimFees;
    
    const keys = [
        // Main accounts for ClaimFees struct
        { pubkey: mmWalletPubkey, isSigner: false, isWritable: true },
        { pubkey: vaultPubkey, isSigner: false, isWritable: true },
        { pubkey: callerPubkey, isSigner: true, isWritable: false },
        // Remaining accounts for Pump.fun CPI
        ...claimAccounts,
    ];
    
    console.log(`[ClaimFees] Creator (vault): ${vaultPubkey.toBase58()}`);
    console.log(`[ClaimFees] CreatorVault: ${creatorVault.toBase58()}`);
    
    return new TransactionInstruction({
        keys,
        programId: MM_WALLET_PROGRAM_ID,
        data,
    });
}

/**
 * Create instruction to execute a buy via the PDA
 * This can be called by either the owner OR the operator
 * 
 * Account order per contract ExecuteTrade:
 * 1. mmWallet - PDA state account (seeds: ["mm_wallet", owner, nonce])
 * 2. pdaWallet - SAME PDA as mmWallet! Used as AccountInfo for signing
 * 3. targetProgram - Pump.fun program
 * 4. caller - owner or operator (signer)
 * 5+ remaining accounts for Pump.fun CPI
 */
export function createExecuteBuyInstruction(
    mmWallet,
    vault,            // SEPARATE vault PDA with ["vault", owner, nonce] seeds!
    signer,
    tokenMint,
    bondingCurve,
    bondingCurveAta,
    vaultTokenAta,    // Token ATA for vault PDA
    tokenCreator,     // Token creator (for creator vault fees)
    amountLamports,
    minTokens
) {
    const mmWalletPubkey = typeof mmWallet === 'string' ? new PublicKey(mmWallet) : mmWallet;
    const vaultPubkey = typeof vault === 'string' ? new PublicKey(vault) : vault;
    const signerPubkey = typeof signer === 'string' ? new PublicKey(signer) : signer;
    const tokenMintPubkey = typeof tokenMint === 'string' ? new PublicKey(tokenMint) : tokenMint;
    const bondingCurvePubkey = typeof bondingCurve === 'string' ? new PublicKey(bondingCurve) : bondingCurve;
    const bondingCurveAtaPubkey = typeof bondingCurveAta === 'string' ? new PublicKey(bondingCurveAta) : bondingCurveAta;
    const vaultTokenAtaPubkey = typeof vaultTokenAta === 'string' ? new PublicKey(vaultTokenAta) : vaultTokenAta;
    const tokenCreatorPubkey = typeof tokenCreator === 'string' ? new PublicKey(tokenCreator) : tokenCreator;
    
    // Derive creator vault (for creator fees)
    const creatorVault = getCreatorVault(tokenCreatorPubkey);
    // Derive user volume accumulator (for the vault PDA as "user")
    const userVolumeAcc = getUserVolumeAccumulator(vaultPubkey);
    
    const amountBuffer = Buffer.alloc(8);
    amountBuffer.writeBigUInt64LE(BigInt(amountLamports));
    
    const minTokensBuffer = Buffer.alloc(8);
    minTokensBuffer.writeBigUInt64LE(BigInt(minTokens));
    
    const data = Buffer.concat([
        DISCRIMINATORS.executeBuy,
        amountBuffer,
        minTokensBuffer,
    ]);
    
    // DEPLOYED contract uses pda_wallet seeds = ["vault", owner, nonce] - DIFFERENT from mm_wallet!
    // Account order matches working bonding-curve.js buy implementation
    const keys = [
        { pubkey: mmWalletPubkey, isSigner: false, isWritable: true },     // 0. mmWallet (state)
        { pubkey: vaultPubkey, isSigner: false, isWritable: true },        // 1. pdaWallet = VAULT!
        { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },  // 2. targetProgram
        { pubkey: signerPubkey, isSigner: true, isWritable: false },       // 3. caller (operator)
        // Remaining accounts for Pump.fun CPI (exact order from bonding-curve.js):
        { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },               // 4. global
        { pubkey: PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },         // 5. fee_recipient
        { pubkey: tokenMintPubkey, isSigner: false, isWritable: false },           // 6. mint
        { pubkey: bondingCurvePubkey, isSigner: false, isWritable: true },         // 7. bonding_curve
        { pubkey: bondingCurveAtaPubkey, isSigner: false, isWritable: true },      // 8. associated_bonding_curve
        { pubkey: vaultTokenAtaPubkey, isSigner: false, isWritable: true },        // 9. associated_user (vault's ATA)
        { pubkey: vaultPubkey, isSigner: false, isWritable: true },                // 10. user (vault PDA - signs via CPI!)
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },   // 11. system_program
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },          // 12. token_program
        { pubkey: creatorVault, isSigner: false, isWritable: true },               // 13. creator_vault
        { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },      // 14. event_authority
        { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },          // 15. program
        { pubkey: PUMP_GLOBAL_VOLUME_ACCUMULATOR, isSigner: false, isWritable: false }, // 16. global_volume_accumulator
        { pubkey: userVolumeAcc, isSigner: false, isWritable: true },              // 17. user_volume_accumulator
        { pubkey: PUMP_FEE_CONFIG, isSigner: false, isWritable: false },           // 18. fee_config
        { pubkey: PUMP_FEE_PROGRAM, isSigner: false, isWritable: false },          // 19. fee_program
    ];
    
    return new TransactionInstruction({
        keys,
        programId: MM_WALLET_PROGRAM_ID,
        data,
    });
}

/**
 * Create instruction to execute a sell via the PDA
 * Account order per contract ExecuteTrade:
 * 0. mmWallet - PDA state account (seeds: ["mm_wallet", owner, nonce])
 * 1. pdaWallet - SAME PDA as mmWallet! Used as AccountInfo for signing
 * 2. targetProgram - Pump.fun program
 * 3. caller - owner or operator (signer)
 * 4+ remaining accounts for Pump.fun CPI
 */
export function createExecuteSellInstruction(
    mmWallet,
    vault,            // SEPARATE vault PDA with ["vault", owner, nonce] seeds!
    signer,
    tokenMint,
    bondingCurve,
    bondingCurveAta,
    vaultTokenAta,    // Token ATA for vault PDA
    tokenCreator,     // Token creator (for creator vault fees)
    tokenAmount,
    minSolOut
) {
    const mmWalletPubkey = typeof mmWallet === 'string' ? new PublicKey(mmWallet) : mmWallet;
    const vaultPubkey = typeof vault === 'string' ? new PublicKey(vault) : vault;
    const signerPubkey = typeof signer === 'string' ? new PublicKey(signer) : signer;
    const tokenMintPubkey = typeof tokenMint === 'string' ? new PublicKey(tokenMint) : tokenMint;
    const bondingCurvePubkey = typeof bondingCurve === 'string' ? new PublicKey(bondingCurve) : bondingCurve;
    const bondingCurveAtaPubkey = typeof bondingCurveAta === 'string' ? new PublicKey(bondingCurveAta) : bondingCurveAta;
    const vaultTokenAtaPubkey = typeof vaultTokenAta === 'string' ? new PublicKey(vaultTokenAta) : vaultTokenAta;
    const tokenCreatorPubkey = typeof tokenCreator === 'string' ? new PublicKey(tokenCreator) : tokenCreator;
    
    // Derive creator vault (for creator fees)
    const creatorVault = getCreatorVault(tokenCreatorPubkey);
    
    const tokenAmountBuffer = Buffer.alloc(8);
    tokenAmountBuffer.writeBigUInt64LE(BigInt(tokenAmount));
    
    const minSolBuffer = Buffer.alloc(8);
    minSolBuffer.writeBigUInt64LE(BigInt(minSolOut));
    
    const data = Buffer.concat([
        DISCRIMINATORS.executeSell,
        tokenAmountBuffer,
        minSolBuffer,
    ]);
    
    // DEPLOYED contract uses pda_wallet seeds = ["vault", owner, nonce] - DIFFERENT from mm_wallet!
    // Account order matches working bonding-curve.js sell implementation
    const keys = [
        { pubkey: mmWalletPubkey, isSigner: false, isWritable: true },     // 0. mmWallet (state)
        { pubkey: vaultPubkey, isSigner: false, isWritable: true },        // 1. pdaWallet = VAULT!
        { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },  // 2. targetProgram
        { pubkey: signerPubkey, isSigner: true, isWritable: false },       // 3. caller (operator)
        // Remaining accounts for Pump.fun CPI (exact order from bonding-curve.js sell):
        { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },               // 4. global
        { pubkey: PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },         // 5. fee_recipient
        { pubkey: tokenMintPubkey, isSigner: false, isWritable: false },           // 6. mint
        { pubkey: bondingCurvePubkey, isSigner: false, isWritable: true },         // 7. bonding_curve
        { pubkey: bondingCurveAtaPubkey, isSigner: false, isWritable: true },      // 8. associated_bonding_curve
        { pubkey: vaultTokenAtaPubkey, isSigner: false, isWritable: true },        // 9. associated_user (vault's ATA)
        { pubkey: vaultPubkey, isSigner: false, isWritable: true },                // 10. user (vault PDA - signs via CPI!)
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },   // 11. system_program
        { pubkey: creatorVault, isSigner: false, isWritable: true },               // 12. creator_vault
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },          // 13. token_program
        { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },      // 14. event_authority
        { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },          // 15. program
        { pubkey: PUMP_FEE_CONFIG, isSigner: false, isWritable: false },           // 16. fee_config
        { pubkey: PUMP_FEE_PROGRAM, isSigner: false, isWritable: false },          // 17. fee_program
    ];
    
    return new TransactionInstruction({
        keys,
        programId: MM_WALLET_PROGRAM_ID,
        data,
    });
}

/**
 * Create instruction to update strategy
 */
export function createUpdateStrategyInstruction(mmWallet, owner, strategy, config) {
    const mmWalletPubkey = typeof mmWallet === 'string' ? new PublicKey(mmWallet) : mmWallet;
    const ownerPubkey = typeof owner === 'string' ? new PublicKey(owner) : owner;
    
    // Serialize config
    const configBuffer = Buffer.alloc(48);
    let offset = 0;
    configBuffer.writeUInt8(config.tradeSizePct || 10, offset); offset += 1;
    configBuffer.writeUInt16LE(config.minDelaySecs || 30, offset); offset += 2;
    configBuffer.writeUInt16LE(config.maxDelaySecs || 120, offset); offset += 2;
    configBuffer.writeUInt16LE(config.slippageBps || 500, offset); offset += 2;
    configBuffer.writeUInt16LE(config.param1 || 0, offset); offset += 2;
    configBuffer.writeUInt16LE(config.param2 || 0, offset); offset += 2;
    configBuffer.writeUInt16LE(config.param3 || 0, offset); offset += 2;
    
    const data = Buffer.concat([
        DISCRIMINATORS.updateStrategy,
        Buffer.from([strategy]),
        configBuffer,
    ]);
    
    const keys = [
        { pubkey: mmWalletPubkey, isSigner: false, isWritable: true },
        { pubkey: ownerPubkey, isSigner: true, isWritable: false },
    ];
    
    return new TransactionInstruction({
        keys,
        programId: MM_WALLET_PROGRAM_ID,
        data,
    });
}

// ============================================================================
// ACCOUNT PARSING
// ============================================================================

/**
 * Parse MM Wallet account data based on IDL
 * 
 * MmWallet struct:
 * - version: u8
 * - bump: u8
 * - owner: Pubkey (32)
 * - operator: Pubkey (32)
 * - tokenMint: Pubkey (32)
 * - nonce: u64
 * - strategy: Strategy (1 byte enum)
 * - config: StrategyConfig (48 bytes)
 * - lockUntil: i64
 * - paused: bool
 * - isCreator: bool
 * - totalVolume: u64
 * - totalTrades: u64
 * - totalFeesClaimed: u64
 * - lastTrade: i64
 * - createdAt: i64
 * - reserved: [u8; 64]
 */
export function parseMmWalletAccount(data) {
    if (!data || data.length < 251) {  // +1 for vault_bump
        return null;
    }
    
    let offset = 8; // Skip Anchor discriminator
    
    const version = data.readUInt8(offset); offset += 1;
    const bump = data.readUInt8(offset); offset += 1;
    const vaultBump = data.readUInt8(offset); offset += 1;  // vault_bump IS in deployed contract!
    
    const owner = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
    const operator = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
    const tokenMint = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
    
    const nonce = Number(data.readBigUInt64LE(offset)); offset += 8;
    
    const strategy = data.readUInt8(offset); offset += 1;
    
    // Parse config (StrategyConfig is 45 bytes: 1+2+2+2+2+2+2+32)
    const config = {
        tradeSizePct: data.readUInt8(offset),
        minDelaySecs: data.readUInt16LE(offset + 1),
        maxDelaySecs: data.readUInt16LE(offset + 3),
        slippageBps: data.readUInt16LE(offset + 5),
        param1: data.readUInt16LE(offset + 7),
        param2: data.readUInt16LE(offset + 9),
        param3: data.readUInt16LE(offset + 11),
    };
    offset += 45; // Config is 45 bytes (1+2+2+2+2+2+2+32)
    
    const lockUntil = Number(data.readBigInt64LE(offset)); offset += 8;
    const paused = data.readUInt8(offset) === 1; offset += 1;
    const isCreator = data.readUInt8(offset) === 1; offset += 1;
    const totalVolume = Number(data.readBigUInt64LE(offset)); offset += 8;
    const totalTrades = Number(data.readBigUInt64LE(offset)); offset += 8;
    const totalFeesClaimed = Number(data.readBigUInt64LE(offset)); offset += 8;
    const lastTrade = Number(data.readBigInt64LE(offset)); offset += 8;
    const createdAt = Number(data.readBigInt64LE(offset)); offset += 8;
    
    return {
        version,
        bump,
        vaultBump,
        owner,
        operator,
        tokenMint,
        nonce,
        strategy,
        strategyName: STRATEGY_NAMES[strategy] || 'Unknown',
        config,
        lockUntil,
        paused,
        isCreator,
        totalVolume,
        totalTrades,
        totalFeesClaimed,
        lastTrade,
        createdAt,
    };
}

// ============================================================================
// RPC HELPERS
// ============================================================================

/**
 * Find the next available nonce for an owner
 */
export async function findNextNonce(connection, owner) {
    const ownerPubkey = typeof owner === 'string' ? new PublicKey(owner) : owner;
    
    for (let nonce = 0; nonce < 100; nonce++) {
        const { pda } = getMmWalletPDA(ownerPubkey, nonce);
        
        try {
            const accountInfo = await connection.getAccountInfo(pda);
            if (!accountInfo) {
                return nonce; // This nonce is available
            }
        } catch (e) {
            return nonce; // Error means account doesn't exist
        }
    }
    
    throw new Error('No available nonce found (max 100 wallets per owner)');
}

/**
 * Get all MM wallets owned by a specific wallet
 * Optimized with batch calls for speed
 */
export async function getOwnerWallets(connection, owner) {
    const ownerPubkey = typeof owner === 'string' ? new PublicKey(owner) : owner;
    const wallets = [];
    
    // Pre-derive all PDAs for batch lookup (check first 20 nonces)
    const MAX_NONCES = 20;
    const mmWalletPDAs = [];
    const vaultPDAs = [];
    
    for (let nonce = 0; nonce < MAX_NONCES; nonce++) {
        const { pda: mmWallet } = getMmWalletPDA(ownerPubkey, nonce);
        const { pda: vaultPda } = getPdaWalletAddress(ownerPubkey, nonce);
        mmWalletPDAs.push(mmWallet);
        vaultPDAs.push(vaultPda);
    }
    
    try {
        // Batch fetch all mm_wallet accounts
        const mmWalletAccounts = await connection.getMultipleAccountsInfo(mmWalletPDAs);
        
        // Find which wallets exist
        const existingIndices = [];
        for (let i = 0; i < mmWalletAccounts.length; i++) {
            const accountInfo = mmWalletAccounts[i];
            if (accountInfo && accountInfo.owner.equals(MM_WALLET_PROGRAM_ID)) {
                existingIndices.push(i);
            }
        }
        
        if (existingIndices.length === 0) {
            return [];
        }
        
        // Batch fetch balances for existing vaults only
        const existingVaultPDAs = existingIndices.map(i => vaultPDAs[i]);
        let vaultBalances = [];
        
        try {
            // Get balances in batch (some RPCs support this)
            const balancePromises = existingVaultPDAs.map(pda => 
                connection.getBalance(pda).catch(() => 0)
            );
            vaultBalances = await Promise.all(balancePromises);
        } catch (e) {
            vaultBalances = existingIndices.map(() => 0);
        }
        
        // Parse and build wallet list
        for (let j = 0; j < existingIndices.length; j++) {
            const i = existingIndices[j];
            const accountInfo = mmWalletAccounts[i];
            
            try {
                const parsed = parseMmWalletAccount(accountInfo.data);
                if (parsed) {
                    wallets.push({
                        mmWalletAddress: mmWalletPDAs[i].toBase58(),
                        pdaWalletAddress: vaultPDAs[i].toBase58(),
                        nonce: i,
                        balanceSOL: vaultBalances[j] / LAMPORTS_PER_SOL,
                        ...parsed,
                    });
                }
            } catch (e) {
                // Skip unparseable wallets
            }
        }
    } catch (e) {
        console.error('[Contract] getOwnerWallets error:', e.message);
    }
    
    return wallets;
}

/**
 * Get detailed info for a specific MM wallet
 */
export async function getMmWalletInfo(connection, mmWallet) {
    const mmWalletPubkey = typeof mmWallet === 'string' ? new PublicKey(mmWallet) : mmWallet;
    
    try {
        const accountInfo = await connection.getAccountInfo(mmWalletPubkey);
        
        if (!accountInfo) {
            return null;
        }
        
        if (!accountInfo.owner.equals(MM_WALLET_PROGRAM_ID)) {
            return null;
        }
        
        const parsed = parseMmWalletAccount(accountInfo.data);
        if (!parsed) {
            return null;
        }
        
        // Get vault PDA and its balance
        const { pda: vaultPda } = getPdaWalletAddress(parsed.owner, parsed.nonce);
        let balanceSOL = 0;
        try {
            const vaultBalance = await connection.getBalance(vaultPda);
            balanceSOL = vaultBalance / LAMPORTS_PER_SOL;
        } catch (e) {}
        
        // Calculate lock status
        const now = Math.floor(Date.now() / 1000);
        const isLocked = parsed.lockUntil > now;
        const lockRemaining = isLocked ? formatLockTime(parsed.lockUntil - now) : null;
        
        return {
            mmWalletAddress: mmWalletPubkey.toBase58(),
            mmWalletPda: mmWalletPubkey,
            pdaWalletAddress: vaultPda.toBase58(),
            vault: vaultPda,
            balanceSOL,
            isLocked,
            lockRemaining,
            ...parsed,
        };
    } catch (e) {
        console.error('[Contract] getMmWalletInfo error:', e);
        return null;
    }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Check if wallet is currently locked
 */
export function isWalletLocked(walletInfo) {
    if (!walletInfo?.lockUntil) return false;
    return Date.now() / 1000 < walletInfo.lockUntil;
}

/**
 * Get remaining lock time in seconds
 */
export function getLockTimeRemaining(walletInfo) {
    if (!walletInfo?.lockUntil) return 0;
    const remaining = walletInfo.lockUntil - Math.floor(Date.now() / 1000);
    return Math.max(0, remaining);
}

/**
 * Format lock time remaining as human-readable string
 */
export function formatLockTime(seconds) {
    if (seconds <= 0) return 'Unlocked';
    
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    
    if (days > 0) {
        return `${days}d ${hours}h`;
    } else if (hours > 0) {
        return `${hours}h ${mins}m`;
    } else {
        return `${mins}m`;
    }
}

/**
 * Convert days to seconds for lock period
 */
export function daysToSeconds(days) {
    return days * 24 * 60 * 60;
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

/**
 * Create a new token with PDA as creator - FULL TRANSACTION BUILDER
 * 
 * Usage:
 * ```js
 * const { transaction, mint, signers } = await buildCreateTokenTransaction(
 *   connection, owner, nonce, 'Token Name', 'SYMBOL', 'https://uri...'
 * );
 * // Add owner and mint keypairs to signers, then send
 * ```
 * 
 * @returns Transaction + mint pubkey + signers array (includes mintKeypair)
 */
export async function buildCreateTokenTransaction(
    connection,
    owner,
    nonce,
    name,
    symbol,
    uri,
    priorityFeeMicroLamports = 100000
) {
    const ownerPubkey = typeof owner === 'string' ? new PublicKey(owner) : owner;
    
    // Generate new mint keypair
    const mintKeypair = Keypair.generate();
    
    // Build create token instruction
    const result = createTokenInstruction(ownerPubkey, nonce, mintKeypair, name, symbol, uri);
    
    // Build transaction
    const transaction = new Transaction();
    
    // Add compute budget if needed
    const { ComputeBudgetProgram } = await import('@solana/web3.js');
    transaction.add(
        ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: priorityFeeMicroLamports,
        })
    );
    transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({
            units: 400000,
        })
    );
    
    // Add create token instruction
    transaction.add(result.instruction);
    
    // Get blockhash
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = ownerPubkey;
    
    return {
        transaction,
        mint: mintKeypair.publicKey,
        mintKeypair,
        bondingCurve: result.bondingCurve,
        metadata: result.metadata,
        vaultTokenAta: result.vaultTokenAta,
        signers: [mintKeypair],  // Owner must also sign but caller handles that
    };
}

/**
 * Get all info needed for a token created by PDA
 */
export async function getTokenCreatorInfo(connection, vault) {
    const vaultPubkey = typeof vault === 'string' ? new PublicKey(vault) : vault;
    
    // Get creator vault and its balance
    const creatorVault = getCreatorVault(vaultPubkey);
    let feesSOL = 0;
    try {
        const balance = await connection.getBalance(creatorVault);
        feesSOL = balance / LAMPORTS_PER_SOL;
    } catch (e) {}
    
    return {
        creator: vaultPubkey.toBase58(),
        creatorVault: creatorVault.toBase58(),
        accumulatedFeesSOL: feesSOL,
    };
}
