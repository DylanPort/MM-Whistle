// Debug script to check landing page data
import Database from 'better-sqlite3';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getOwnerWallets, getMmWalletPDA, getPdaWalletAddress } from './src/contract/index.js';

const db = new Database('pump-mm.db');
const connection = new Connection('https://rpc.whistle.ninja', 'confirmed');

async function debug() {
    console.log('\n=== DATABASE DEBUG ===\n');
    
    // Check wallets table
    const wallets = db.prepare('SELECT id, name, publicKey, ownerWallet FROM wallets').all();
    console.log('Wallets in DB:', wallets.length);
    wallets.forEach(w => console.log(`  - ID ${w.id}: ${w.publicKey?.slice(0,8)}... owner: ${w.ownerWallet?.slice(0,8) || 'none'}...`));
    
    // Check tokens table
    const tokens = db.prepare('SELECT id, mint, name, symbol, ownerWallet FROM tokens').all();
    console.log('\nTokens in DB:', tokens.length);
    tokens.forEach(t => console.log(`  - ${t.symbol || t.name}: ${t.mint?.slice(0,8)}... owner: ${t.ownerWallet?.slice(0,8) || 'none'}...`));
    
    // Check contract_wallets table
    const contractWallets = db.prepare('SELECT * FROM contract_wallets').all();
    console.log('\nContract Wallets in DB:', contractWallets.length);
    contractWallets.forEach(w => console.log(`  - PDA: ${w.pdaAddress?.slice(0,8)}... owner: ${w.ownerWallet?.slice(0,8)}... nonce: ${w.nonce}`));
    
    // Get unique owners
    const owners1 = db.prepare('SELECT DISTINCT ownerWallet FROM wallets WHERE ownerWallet IS NOT NULL AND ownerWallet != ""').all();
    const owners2 = db.prepare('SELECT DISTINCT ownerWallet FROM tokens WHERE ownerWallet IS NOT NULL AND ownerWallet != ""').all();
    const owners3 = db.prepare('SELECT DISTINCT ownerWallet FROM contract_wallets WHERE ownerWallet IS NOT NULL').all();
    
    const uniqueOwners = new Set([
        ...owners1.map(o => o.ownerWallet),
        ...owners2.map(o => o.ownerWallet),
        ...owners3.map(o => o.ownerWallet)
    ].filter(Boolean));
    
    console.log('\n=== UNIQUE OWNERS ===\n');
    console.log('Total unique owners:', uniqueOwners.size);
    uniqueOwners.forEach(o => console.log(`  - ${o}`));
    
    console.log('\n=== ON-CHAIN TRUSTLESS WALLETS ===\n');
    
    for (const owner of uniqueOwners) {
        console.log(`\nScanning owner: ${owner}...`);
        try {
            const ownerPubkey = new PublicKey(owner);
            const onChainWallets = await getOwnerWallets(connection, ownerPubkey);
            console.log(`  Found ${onChainWallets.length} on-chain wallets`);
            
            for (const w of onChainWallets) {
                console.log(`    - MM Wallet: ${w.mmWalletAddress?.slice(0,8)}...`);
                console.log(`      Vault PDA: ${w.pdaWalletAddress?.slice(0,8)}...`);
                console.log(`      Balance: ${w.balanceSOL} SOL`);
                console.log(`      Token Mint: ${w.tokenMint || 'None'}`);
                console.log(`      Lock Until: ${w.lockUntil} (${w.lockUntil > Date.now()/1000 ? 'LOCKED' : 'UNLOCKED'})`);
                console.log(`      Is Creator: ${w.isCreator}`);
            }
        } catch (e) {
            console.log(`  Error: ${e.message}`);
        }
    }
    
    // Also try the specific owner from the logs
    console.log('\n=== SPECIFIC KNOWN OWNERS ===\n');
    const knownOwners = [
        '64pR7tmBvKvnPnWBht4Nni1vHuqWmx42XkzJDE1KnyYK',
        '4S8fvGCekcwUHNP6kaUPN37bsBVUPdm8jxZcbZQHqsEK'
    ];
    
    for (const owner of knownOwners) {
        console.log(`\nScanning known owner: ${owner}...`);
        try {
            const ownerPubkey = new PublicKey(owner);
            
            // Check first 5 nonces directly
            for (let nonce = 0; nonce < 5; nonce++) {
                const { pda: mmWallet } = getMmWalletPDA(ownerPubkey, nonce);
                const { pda: vault } = getPdaWalletAddress(ownerPubkey, nonce);
                
                const accountInfo = await connection.getAccountInfo(mmWallet);
                if (accountInfo) {
                    console.log(`  Nonce ${nonce}: MM Wallet EXISTS at ${mmWallet.toBase58()}`);
                    const vaultBal = await connection.getBalance(vault);
                    console.log(`    Vault ${vault.toBase58()} balance: ${vaultBal / LAMPORTS_PER_SOL} SOL`);
                }
            }
            
            const onChainWallets = await getOwnerWallets(connection, ownerPubkey);
            console.log(`  Total found via getOwnerWallets: ${onChainWallets.length}`);
        } catch (e) {
            console.log(`  Error: ${e.message}`);
        }
    }
}

debug().then(() => {
    console.log('\n=== DEBUG COMPLETE ===\n');
    process.exit(0);
}).catch(e => {
    console.error('Debug failed:', e);
    process.exit(1);
});


