/**
 * Pump.fun Direct Market Maker - Server
 * Direct integration with no PumpPortal fees!
 */

import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, VersionedTransaction } from '@solana/web3.js';
import * as bs58 from 'bs58';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import FormData from 'form-data';
import multer from 'multer';
import fs from 'fs';

// Load environment variables
dotenv.config();

// Import our modules
import { buy, sell, getPrice, getTokenStatus, setIndexedConnection, setGeyserConnection } from './src/trading/index.js';
import { createToken, createTokenV2, createAndBuy } from './src/token/create.js';
import { checkAllFees, claimAllFees, startAutoClaimScheduler } from './src/fees/claim.js';
import { VolumeBot, GridBot, SimpleMarketMaker } from './src/mm/market-maker.js';
import { VolumeBotV2 } from './src/mm/volume-bot-v2.js';
import { FundManager } from './src/mm/fund-manager.js';
import { TokenMarketMaker } from './src/mm/token-market-maker.js';
import { STRATEGIES, getStrategyInfo, createStrategy } from './src/mm/strategies/index.js';
import { PersistentBotManager } from './src/mm/persistent-bot-manager.js';

// Smart Contract Integration
import {
    MM_WALLET_PROGRAM_ID,
    STRATEGIES as CONTRACT_STRATEGIES,
    getMmWalletPDA,
    getPdaWalletAddress,
    getOwnerWallets,
    getMmWalletInfo,
    parseMmWalletAccount,
    createInitializeInstruction,
    createDepositInstruction,
    createDepositInstructionDirect,
    createWithdrawInstruction,
    createWithdrawInstructionDirect,
    createPauseInstruction,
    createResumeInstruction,
    createSetOperatorInstruction,
    createExtendLockInstruction,
    createTokenInstructionDirect,
    derivePumpFunAccounts,
    isWalletLocked,
    getLockTimeRemaining,
    formatLockTime,
} from './src/contract/index.js';

import { getVaultTokenMints } from './src/utils/token-discovery.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// CONFIGURATION
// ============================================================================

const PORT = process.env.PORT || 3333;

// Use Whistle in-house RPC for trading (fast, no limits)
const RPC_URL = process.env.RPC_URL || 'https://rpc.whistle.ninja';

// WebSocket RPC for real-time subscriptions (price tracking)
// Note: Using same RPC with wss:// for WebSocket
const WS_RPC_URL = process.env.WS_RPC_URL || 'https://rpc.whistle.ninja';

// Indexed RPC for getProgramAccounts (pool discovery only)
const INDEXED_RPC_URL = process.env.INDEXED_RPC_URL || 'https://api.mainnet-beta.solana.com';

// Connection with retry logic
function createConnection(url) {
    return new Connection(url, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 60000,
        disableRetryOnRateLimit: false,
    });
}

// WebSocket connection for real-time subscriptions
let wsConnection = null;
function getWsConnection() {
    if (!wsConnection) {
        // Use wss:// endpoint for WebSocket subscriptions
        wsConnection = new Connection(WS_RPC_URL, {
            commitment: 'confirmed',
            wsEndpoint: WS_RPC_URL.replace('https://', 'wss://').replace('http://', 'ws://'),
        });
        console.log(`[WebSocket] Connected to ${WS_RPC_URL.replace('https://', 'wss://')}`);
    }
    return wsConnection;
}

// Separate connection for indexed queries
let indexedConnection = null;
function getIndexedConnection() {
    if (!indexedConnection) {
        indexedConnection = createConnection(INDEXED_RPC_URL);
    }
    return indexedConnection;
}

// ============================================================================
// DATABASE
// ============================================================================

const db = new Database('pump-mm.db');

// Initialize tables (ownerWallet added via migration below)
db.exec(`
    CREATE TABLE IF NOT EXISTS wallets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        publicKey TEXT NOT NULL UNIQUE,
        privateKey TEXT NOT NULL,
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mint TEXT NOT NULL UNIQUE,
        name TEXT,
        symbol TEXT,
        creatorWallet TEXT,
        bondingCurve TEXT,
        migrated INTEGER DEFAULT 0,
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet TEXT NOT NULL,
        mint TEXT NOT NULL,
        type TEXT NOT NULL,
        amountSOL REAL NOT NULL,
        signature TEXT NOT NULL,
        dex TEXT NOT NULL,
        timestamp TEXT DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS bots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet TEXT NOT NULL,
        mint TEXT NOT NULL,
        botType TEXT NOT NULL,
        config TEXT,
        status TEXT DEFAULT 'stopped',
        totalVolume REAL DEFAULT 0,
        totalTrades INTEGER DEFAULT 0,
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mint TEXT NOT NULL,
        price REAL NOT NULL,
        priceUSD REAL,
        marketCap REAL,
        liquidity REAL,
        timestamp INTEGER NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS trade_markers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mint TEXT NOT NULL,
        type TEXT NOT NULL,
        amountSOL REAL NOT NULL,
        price REAL,
        marketCap REAL,
        timestamp INTEGER NOT NULL,
        signature TEXT
    );
    
    CREATE INDEX IF NOT EXISTS idx_price_history_mint ON price_history(mint);
    CREATE INDEX IF NOT EXISTS idx_price_history_timestamp ON price_history(mint, timestamp);
    CREATE INDEX IF NOT EXISTS idx_trade_markers_mint ON trade_markers(mint);
    
    -- Trustless Contract Wallets
    CREATE TABLE IF NOT EXISTS contract_wallets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ownerWallet TEXT NOT NULL,
        pdaAddress TEXT NOT NULL UNIQUE,
        nonce INTEGER NOT NULL DEFAULT 0,
        tokenMint TEXT,
        strategy INTEGER DEFAULT 0,
        lockUntil INTEGER DEFAULT 0,
        lockDays INTEGER DEFAULT 0,
        paused INTEGER DEFAULT 0,
        isCreator INTEGER DEFAULT 0,
        totalVolume REAL DEFAULT 0,
        totalTrades INTEGER DEFAULT 0,
        totalFeesClaimed REAL DEFAULT 0,
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE INDEX IF NOT EXISTS idx_contract_wallets_owner ON contract_wallets(ownerWallet);
`);

// Migration: Add ownerWallet column to existing tables (if missing)
try {
    db.exec(`ALTER TABLE wallets ADD COLUMN ownerWallet TEXT DEFAULT ''`);
    console.log('[DB] Added ownerWallet column to wallets table');
} catch (e) {
    // Column already exists
}
try {
    db.exec(`ALTER TABLE tokens ADD COLUMN ownerWallet TEXT DEFAULT ''`);
    console.log('[DB] Added ownerWallet column to tokens table');
} catch (e) {
    // Column already exists
}
try {
    db.exec(`ALTER TABLE trades ADD COLUMN ownerWallet TEXT DEFAULT ''`);
    console.log('[DB] Added ownerWallet column to trades table');
} catch (e) {
    // Column already exists
}
try {
    db.exec(`ALTER TABLE bots ADD COLUMN ownerWallet TEXT DEFAULT ''`);
    console.log('[DB] Added ownerWallet column to bots table');
} catch (e) {
    // Column already exists
}

// Create indexes for ownerWallet (after migration)
try {
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_wallets_owner ON wallets(ownerWallet);
        CREATE INDEX IF NOT EXISTS idx_tokens_owner ON tokens(ownerWallet);
        CREATE INDEX IF NOT EXISTS idx_trades_owner ON trades(ownerWallet);
        CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots(ownerWallet);
    `);
} catch (e) {
    console.log('[DB] Index creation note:', e.message);
}

// ============================================================================
// EXPRESS APP
// ============================================================================

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'web')));

// Multer for file uploads
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
    fileFilter: (req, file, cb) => {
        const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only PNG, JPG, GIF, WEBP allowed.'));
        }
    }
});

// ============================================================================
// STATE
// ============================================================================

let connection = null;
let activeBots = new Map(); // botId -> bot instance
let activeWallet = null;

// Persistent Bot Manager - manages always-on MM bots
let persistentBotManager = null;

// ============================================================================
// HELPERS
// ============================================================================

function getConnection() {
    if (!connection) {
        connection = createConnection(RPC_URL);
    }
    return connection;
}

// Retry wrapper for RPC calls
async function withRetry(fn, maxRetries = 5) {
    let lastError;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (error.message?.includes('429') || error.message?.includes('Too Many Requests')) {
                const delay = Math.min(1000 * Math.pow(2, i), 10000);
                console.log(`[RPC] Rate limited, retrying in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
            } else {
                throw error;
            }
        }
    }
    throw lastError;
}

function getWalletKeypair(privateKey) {
    const decoded = bs58.default.decode(privateKey);
    return Keypair.fromSecretKey(decoded);
}

function broadcast(wss, type, data) {
    const message = JSON.stringify({ type, data, timestamp: Date.now() });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// ============================================================================
// API ROUTES - CONFIGURATION
// ============================================================================

// Set RPC URL
app.post('/api/config/rpc', (req, res) => {
    const { rpcUrl } = req.body;
    if (!rpcUrl) {
        return res.status(400).json({ error: 'RPC URL required' });
    }
    
    connection = createConnection(rpcUrl);
    console.log(`[Config] RPC set to: ${rpcUrl}`);
    res.json({ success: true, rpcUrl });
});

// Get current RPC
app.get('/api/config', (req, res) => {
    res.json({ rpcUrl: connection ? 'custom' : RPC_URL });
});

// Get RPC status
app.get('/api/config/rpc', async (req, res) => {
    try {
        const conn = getConnection();
        const version = await conn.getVersion();
        res.json({ 
            connected: true, 
            rpcUrl: RPC_URL,
            version: version['solana-core']
        });
    } catch (e) {
        res.json({ connected: false, error: e.message });
    }
});

// ============================================================================
// API ROUTES - WALLETS
// ============================================================================

// Create new wallet (requires ownerWallet - connected Phantom wallet)
app.post('/api/wallets', (req, res) => {
    const { name, ownerWallet } = req.body;
    if (!ownerWallet) {
        return res.status(401).json({ error: 'Please connect your wallet first' });
    }
    
    const keypair = Keypair.generate();
    const privateKey = bs58.default.encode(keypair.secretKey);
    const publicKey = keypair.publicKey.toBase58();
    
    try {
        const result = db.prepare('INSERT INTO wallets (name, publicKey, privateKey, ownerWallet) VALUES (?, ?, ?, ?)')
            .run(name || 'MM Wallet', publicKey, privateKey, ownerWallet);
        
        console.log(`[Wallet] Created: ${name || 'MM Wallet'} (${publicKey}) for owner: ${ownerWallet.slice(0,8)}...`);
        res.json({ 
            success: true, 
            walletId: result.lastInsertRowid,
            wallet: { id: result.lastInsertRowid, name: name || 'MM Wallet', publicKey },
            // Return private key only on creation!
            privateKey 
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Import existing wallet
app.post('/api/wallets/import', (req, res) => {
    const { name, privateKey, ownerWallet } = req.body;
    if (!ownerWallet) {
        return res.status(401).json({ error: 'Please connect your wallet first' });
    }
    if (!privateKey) {
        return res.status(400).json({ error: 'Private key required' });
    }
    
    try {
        const keypair = getWalletKeypair(privateKey);
        const publicKey = keypair.publicKey.toBase58();
        
        const result = db.prepare('INSERT INTO wallets (name, publicKey, privateKey, ownerWallet) VALUES (?, ?, ?, ?)')
            .run(name || 'Imported Wallet', publicKey, privateKey, ownerWallet);
        
        console.log(`[Wallet] Imported: ${name} (${publicKey}) for owner: ${ownerWallet.slice(0,8)}...`);
        res.json({ success: true, walletId: result.lastInsertRowid, wallet: { id: result.lastInsertRowid, name, publicKey } });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// List wallets (filtered by ownerWallet)
app.get('/api/wallets', async (req, res) => {
    const { ownerWallet } = req.query;
    if (!ownerWallet) {
        return res.status(401).json({ error: 'Please connect your wallet first' });
    }
    
    const wallets = db.prepare('SELECT id, name, publicKey, createdAt FROM wallets WHERE ownerWallet = ?').all(ownerWallet);
    
    // Get balances with retry
    const conn = getConnection();
    for (const wallet of wallets) {
        try {
            const balance = await withRetry(() => conn.getBalance(new PublicKey(wallet.publicKey)));
            wallet.balanceSOL = balance / 1e9;
        } catch (e) {
            wallet.balanceSOL = 0;
            console.log(`[Wallet] Balance fetch failed: ${e.message}`);
        }
    }
    
    res.json({ wallets });
});

// Get wallet by ID (with ownership verification)
app.get('/api/wallets/:id', async (req, res) => {
    const { ownerWallet } = req.query;
    
    const wallet = db.prepare('SELECT id, name, publicKey, ownerWallet, createdAt FROM wallets WHERE id = ?')
        .get(req.params.id);
    
    if (!wallet) {
        return res.status(404).json({ error: 'Wallet not found' });
    }
    
    // Verify ownership (allow if ownerWallet matches OR wallet has no owner yet - legacy data)
    if (ownerWallet && wallet.ownerWallet && wallet.ownerWallet !== '' && wallet.ownerWallet !== ownerWallet) {
        return res.status(403).json({ error: 'Access denied - not your wallet' });
    }
    
    try {
        const conn = getConnection();
        wallet.balanceSOL = await conn.getBalance(new PublicKey(wallet.publicKey)) / 1e9;
        
        // Get claimable fees
        const fullWallet = db.prepare('SELECT privateKey FROM wallets WHERE id = ?').get(req.params.id);
        const keypair = getWalletKeypair(fullWallet.privateKey);
        const fees = await checkAllFees(conn, keypair.publicKey);
        wallet.claimableFees = fees;
    } catch (e) {
        wallet.balanceSOL = 0;
        wallet.claimableFees = { totalSOL: 0 };
    }
    
    // Don't expose ownerWallet in response
    delete wallet.ownerWallet;
    res.json({ wallet });
});

// Set active wallet (with ownership verification)
app.post('/api/wallets/:id/activate', (req, res) => {
    const { ownerWallet } = req.body;
    const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(req.params.id);
    if (!wallet) {
        return res.status(404).json({ error: 'Wallet not found' });
    }
    
    // Verify ownership
    if (ownerWallet && wallet.ownerWallet && wallet.ownerWallet !== '' && wallet.ownerWallet !== ownerWallet) {
        return res.status(403).json({ error: 'Access denied - not your wallet' });
    }
    
    activeWallet = wallet;
    console.log(`[Wallet] Active: ${wallet.name} (${wallet.publicKey})`);
    res.json({ success: true, activeWallet: { name: wallet.name, publicKey: wallet.publicKey } });
});

// ============================================================================
// API ROUTES - TRADING
// ============================================================================

// Get token status
app.get('/api/tokens/:mint/status', async (req, res) => {
    try {
        const conn = getConnection();
        const mint = new PublicKey(req.params.mint);
        const status = await withRetry(() => getTokenStatus(conn, mint));
        res.json(status);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Buy tokens
app.post('/api/trade/buy', async (req, res) => {
    const { walletId, mint, amountSOL, slippage } = req.body;
    
    if (!walletId || !mint || !amountSOL) {
        return res.status(400).json({ error: 'walletId, mint, and amountSOL required' });
    }
    
    try {
        const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(walletId);
        if (!wallet) {
            return res.status(404).json({ error: 'Wallet not found' });
        }
        
        const conn = getConnection();
        const keypair = getWalletKeypair(wallet.privateKey);
        const mintPk = new PublicKey(mint);
        
        console.log(`[Trade] Buy ${amountSOL} SOL of ${mint}`);
        const signature = await buy(conn, keypair, mintPk, parseFloat(amountSOL), slippage || 0.25);
        
        // Record trade
        const status = await getTokenStatus(conn, mintPk);
        db.prepare('INSERT INTO trades (wallet, mint, type, amountSOL, signature, dex) VALUES (?, ?, ?, ?, ?, ?)')
            .run(wallet.publicKey, mint, 'buy', amountSOL, signature, status.dex);
        
        res.json({ success: true, signature, dex: status.dex });
    } catch (e) {
        console.error(`[Trade] Buy error:`, e.message);
        res.status(400).json({ error: e.message });
    }
});

// Sell tokens
app.post('/api/trade/sell', async (req, res) => {
    const { walletId, mint, amountTokens, slippage } = req.body;
    
    if (!walletId || !mint) {
        return res.status(400).json({ error: 'walletId and mint required' });
    }
    
    try {
        const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(walletId);
        if (!wallet) {
            return res.status(404).json({ error: 'Wallet not found' });
        }
        
        const conn = getConnection();
        const keypair = getWalletKeypair(wallet.privateKey);
        const mintPk = new PublicKey(mint);
        
        console.log(`[Trade] Sell ${amountTokens || 'all'} tokens of ${mint}`);
        const signature = await sell(
            conn, 
            keypair, 
            mintPk, 
            amountTokens ? parseInt(amountTokens) : null,
            slippage || 0.25
        );
        
        // Record trade
        const status = await getTokenStatus(conn, mintPk);
        db.prepare('INSERT INTO trades (wallet, mint, type, amountSOL, signature, dex) VALUES (?, ?, ?, ?, ?, ?)')
            .run(wallet.publicKey, mint, 'sell', 0, signature, status.dex);
        
        res.json({ success: true, signature, dex: status.dex });
    } catch (e) {
        console.error(`[Trade] Sell error:`, e.message);
        res.status(400).json({ error: e.message });
    }
});

// ============================================================================
// API ROUTES - TOKEN CREATION
// ============================================================================

// Create token via PumpPortal API (with image upload support)
app.post('/api/tokens/create', upload.single('image'), async (req, res) => {
    const { walletId, name, symbol, description, initialBuySOL, twitter, telegram, website, ownerWallet } = req.body;
    
    if (!ownerWallet) {
        return res.status(401).json({ error: 'Please connect your wallet first' });
    }
    if (!walletId || !name || !symbol) {
        return res.status(400).json({ error: 'walletId, name, and symbol required' });
    }
    
    try {
        const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(walletId);
        
        // Verify ownership of the MM wallet
        if (wallet.ownerWallet && wallet.ownerWallet !== '' && wallet.ownerWallet !== ownerWallet) {
            return res.status(403).json({ error: 'Access denied - not your wallet' });
        }
        if (!wallet) {
            return res.status(404).json({ error: 'Wallet not found' });
        }
        
        const conn = getConnection();
        const keypair = getWalletKeypair(wallet.privateKey);
        
        // Check balance first
        const balance = await conn.getBalance(keypair.publicKey);
        const minRequired = 0.02 + (parseFloat(initialBuySOL) || 0); // 0.02 for creation + initial buy
        if (balance < minRequired * LAMPORTS_PER_SOL) {
            return res.status(400).json({ 
                error: `Insufficient balance. Need at least ${minRequired.toFixed(3)} SOL (have ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL)`
            });
        }
        
        // Generate mint keypair
        const mintKeypair = Keypair.generate();
        
        // PumpPortal API - Create Token
        console.log(`[Token] Creating token ${symbol} via PumpPortal...`);
        
        // Build form data for pump.fun IPFS upload
        const formData = new FormData();
        formData.append('name', name);
        formData.append('symbol', symbol);
        formData.append('description', description || `${name} token`);
        if (twitter) formData.append('twitter', twitter);
        if (telegram) formData.append('telegram', telegram);
        if (website) formData.append('website', website);
        formData.append('showName', 'true');
        
        // Add image if uploaded
        if (req.file) {
            console.log(`[Token] Image uploaded: ${req.file.originalname} (${req.file.size} bytes)`);
            formData.append('file', req.file.buffer, {
                filename: req.file.originalname,
                contentType: req.file.mimetype
            });
        }
        
        // Get IPFS metadata from pump.fun
        const ipfsResponse = await fetch('https://pump.fun/api/ipfs', {
            method: 'POST',
            body: formData,
            headers: formData.getHeaders ? formData.getHeaders() : {}
        });
        
        if (!ipfsResponse.ok) {
            const errText = await ipfsResponse.text();
            console.error('[Token] IPFS error:', errText);
            throw new Error('Failed to upload metadata to IPFS: ' + errText);
        }
        
        const ipfsData = await ipfsResponse.json();
        console.log(`[Token] IPFS metadata:`, ipfsData.metadataUri);
        
        // Create token via PumpPortal transaction API
        const createResponse = await fetch('https://pumpportal.fun/api/trade-local', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                publicKey: keypair.publicKey.toBase58(),
                action: 'create',
                tokenMetadata: {
                    name,
                    symbol,
                    uri: ipfsData.metadataUri
                },
                mint: mintKeypair.publicKey.toBase58(),
                denominatedInSol: 'true',
                amount: parseFloat(initialBuySOL) || 0,
                slippage: 25,
                priorityFee: 0.0005,
                pool: 'pump'
            })
        });
        
        if (!createResponse.ok) {
            const errText = await createResponse.text();
            throw new Error(`PumpPortal error: ${errText}`);
        }
        
        // Sign and send the transaction
        const txData = await createResponse.arrayBuffer();
        const tx = VersionedTransaction.deserialize(new Uint8Array(txData));
        tx.sign([keypair, mintKeypair]);
        
        const signature = await conn.sendTransaction(tx, { 
            skipPreflight: true,
            maxRetries: 3 
        });
        
        console.log(`[Token] Created: ${mintKeypair.publicKey.toBase58()}, sig: ${signature}`);
        
        // Save token to DB with ownerWallet
        db.prepare('INSERT INTO tokens (mint, name, symbol, creatorWallet, bondingCurve, ownerWallet) VALUES (?, ?, ?, ?, ?, ?)')
            .run(mintKeypair.publicKey.toBase58(), name, symbol, wallet.publicKey, '', ownerWallet);
        
        res.json({ 
            success: true, 
            mint: mintKeypair.publicKey.toBase58(),
            signature
        });
    } catch (e) {
        console.error(`[Token] Create error:`, e.message);
        res.status(400).json({ error: e.message });
    }
});

// ============================================================================
// API ROUTES - FEE CLAIMING
// ============================================================================

// Check fees
app.get('/api/fees/:walletId', async (req, res) => {
    try {
        const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(req.params.walletId);
        if (!wallet) {
            return res.status(404).json({ error: 'Wallet not found' });
        }
        
        const conn = getConnection();
        const keypair = getWalletKeypair(wallet.privateKey);
        const fees = await checkAllFees(conn, keypair.publicKey);
        
        res.json(fees);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Claim fees
app.post('/api/fees/:walletId/claim', async (req, res) => {
    try {
        const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(req.params.walletId);
        if (!wallet) {
            return res.status(404).json({ error: 'Wallet not found' });
        }
        
        const conn = getConnection();
        const keypair = getWalletKeypair(wallet.privateKey);
        const result = await claimAllFees(conn, keypair);
        
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// ============================================================================
// API ROUTES - CHART DATA
// ============================================================================

// Save price data point (called by frontend polling)
app.post('/api/chart/price', (req, res) => {
    const { mint, price, priceUSD, marketCap, liquidity } = req.body;
    
    if (!mint || price === undefined) {
        return res.status(400).json({ error: 'mint and price required' });
    }
    
    try {
        const timestamp = Date.now();
        
        // Only save if price changed or every 5 seconds minimum
        const lastPoint = db.prepare(
            'SELECT * FROM price_history WHERE mint = ? ORDER BY timestamp DESC LIMIT 1'
        ).get(mint);
        
        const shouldSave = !lastPoint || 
            lastPoint.price !== price || 
            (timestamp - lastPoint.timestamp) > 5000;
        
        if (shouldSave) {
            db.prepare(
                'INSERT INTO price_history (mint, price, priceUSD, marketCap, liquidity, timestamp) VALUES (?, ?, ?, ?, ?, ?)'
            ).run(mint, price, priceUSD || null, marketCap || null, liquidity || null, timestamp);
        }
        
        res.json({ success: true, saved: shouldSave });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Get price history for chart
app.get('/api/chart/:mint', (req, res) => {
    const { mint } = req.params;
    const { range = '1h' } = req.query;
    
    try {
        // Calculate time range
        const now = Date.now();
        let fromTime;
        switch (range) {
            case '5m': fromTime = now - 5 * 60 * 1000; break;
            case '15m': fromTime = now - 15 * 60 * 1000; break;
            case '1h': fromTime = now - 60 * 60 * 1000; break;
            case '4h': fromTime = now - 4 * 60 * 60 * 1000; break;
            case '24h': fromTime = now - 24 * 60 * 60 * 1000; break;
            case 'all': fromTime = 0; break;
            default: fromTime = now - 60 * 60 * 1000;
        }
        
        // Get price history
        const prices = db.prepare(`
            SELECT timestamp, price, priceUSD, marketCap, liquidity 
            FROM price_history 
            WHERE mint = ? AND timestamp >= ?
            ORDER BY timestamp ASC
        `).all(mint, fromTime);
        
        // Get trade markers
        const trades = db.prepare(`
            SELECT timestamp, type, amountSOL, price, marketCap
            FROM trade_markers
            WHERE mint = ? AND timestamp >= ?
            ORDER BY timestamp ASC
        `).all(mint, fromTime);
        
        res.json({ 
            prices,
            trades,
            range,
            fromTime,
            toTime: now
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Record a trade marker on the chart
app.post('/api/chart/trade', (req, res) => {
    const { mint, type, amountSOL, price, marketCap, signature } = req.body;
    
    if (!mint || !type || amountSOL === undefined) {
        return res.status(400).json({ error: 'mint, type, and amountSOL required' });
    }
    
    try {
        const timestamp = Date.now();
        
        db.prepare(
            'INSERT INTO trade_markers (mint, type, amountSOL, price, marketCap, timestamp, signature) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(mint, type, amountSOL, price || null, marketCap || null, timestamp, signature || null);
        
        res.json({ success: true, timestamp });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Cleanup old price data (keep last 24h)
app.post('/api/chart/cleanup', (req, res) => {
    try {
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const result = db.prepare('DELETE FROM price_history WHERE timestamp < ?').run(cutoff);
        res.json({ success: true, deleted: result.changes });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// ============================================================================
// SOL PRICE (with caching)
// ============================================================================
let cachedSolPrice = { price: 200, timestamp: 0 };
const SOL_PRICE_CACHE_MS = 30000; // 30 second cache

async function getSolPrice() {
    const now = Date.now();
    if (now - cachedSolPrice.timestamp < SOL_PRICE_CACHE_MS) {
        return cachedSolPrice.price;
    }
    
    try {
        // Try CoinGecko
        const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(5000),
        });
        const data = await res.json();
        if (data?.solana?.usd) {
            cachedSolPrice = { price: data.solana.usd, timestamp: now };
            return data.solana.usd;
        }
    } catch (e) {
        // Fallback - try Jupiter price API
        try {
            const res = await fetch('https://price.jup.ag/v4/price?ids=SOL', {
                headers: { 'Accept': 'application/json' },
                signal: AbortSignal.timeout(5000),
            });
            const data = await res.json();
            if (data?.data?.SOL?.price) {
                cachedSolPrice = { price: data.data.SOL.price, timestamp: now };
                return data.data.SOL.price;
            }
        } catch (e2) {}
    }
    
    return cachedSolPrice.price; // Return cached/default if all fails
}

app.get('/api/sol-price', async (req, res) => {
    const price = await getSolPrice();
    res.json({ price, cached: Date.now() - cachedSolPrice.timestamp < SOL_PRICE_CACHE_MS });
});

// ============================================================================
// API ROUTES - BOTS
// ============================================================================

// Start volume bot (V2 - Production Ready)
app.post('/api/bots/volume/start', async (req, res) => {
    const { walletId, mint, config } = req.body;
    
    if (!walletId || !mint) {
        return res.status(400).json({ error: 'walletId and mint required' });
    }
    
    try {
        const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(walletId);
        if (!wallet) {
            return res.status(404).json({ error: 'Wallet not found' });
        }
        
        const conn = getConnection();
        const keypair = getWalletKeypair(wallet.privateKey);
        const mintPk = new PublicKey(mint);
        
        // Create V2 bot instance (production ready with fund management)
        const bot = new VolumeBotV2(conn, keypair, mintPk, {
            ...config,
            onTrade: (trade) => {
                console.log(`[VolumeBotV2] Trade: ${trade.type} ${trade.amount} SOL`);
                // Record trade
                db.prepare('INSERT INTO trades (wallet, mint, type, amountSOL, signature, dex) VALUES (?, ?, ?, ?, ?, ?)')
                    .run(wallet.publicKey, mint, trade.type, trade.amount || 0, trade.signature, 'auto');
                
                // Broadcast to WebSocket clients
                broadcastToClients({
                    type: 'trade',
                    botId: bot.botId,
                    trade,
                });
            },
            onCycle: (cycle) => {
                console.log(`[VolumeBotV2] Cycle ${cycle.cycle} completed`);
                broadcastToClients({
                    type: 'cycle',
                    botId: bot.botId,
                    cycle,
                });
            },
            onError: (err) => {
                console.error(`[VolumeBotV2] Error:`, err.message);
                broadcastToClients({
                    type: 'error',
                    botId: bot.botId,
                    error: err.message,
                });
            },
            onStatusUpdate: (status) => {
                broadcastToClients({
                    type: 'status',
                    botId: bot.botId,
                    status,
                });
            },
            onLog: (level, message) => {
                console.log(`[${level.toUpperCase()}] ${message}`);
                broadcastToClients({
                    type: 'log',
                    level,
                    message,
                });
            },
        });
        
        // Start bot
        const result = await bot.start();
        
        if (!result.success) {
            return res.status(400).json({ error: result.reason });
        }
        
        // Store in active bots
        activeBots.set(bot.botId, bot);
        
        // Save to DB
        db.prepare('INSERT INTO bots (wallet, mint, botType, config, status) VALUES (?, ?, ?, ?, ?)')
            .run(wallet.publicKey, mint, 'volume-v2', JSON.stringify(config), 'running');
        
        res.json({ 
            success: true, 
            botId: bot.botId, 
            status: result.status,
            message: 'V2 Bot started with intelligent fund management'
        });
    } catch (e) {
        console.error('[API] Bot start error:', e);
        res.status(400).json({ error: e.message });
    }
});

// Get fund manager status for a bot
app.get('/api/bots/:botId/funds', async (req, res) => {
    const bot = activeBots.get(req.params.botId);
    if (!bot) {
        return res.status(404).json({ error: 'Bot not found' });
    }
    
    if (!bot.fundManager) {
        return res.status(400).json({ error: 'Bot does not have fund manager' });
    }
    
    const status = bot.fundManager.getStatus();
    res.json(status);
});

// Force fee claim for a bot
app.post('/api/bots/:botId/claim-fees', async (req, res) => {
    const bot = activeBots.get(req.params.botId);
    if (!bot) {
        return res.status(404).json({ error: 'Bot not found' });
    }
    
    if (!bot.fundManager) {
        return res.status(400).json({ error: 'Bot does not have fund manager' });
    }
    
    try {
        const result = await bot.fundManager.checkAndClaimFees(true);
        res.json({ success: true, result });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Reset circuit breaker
app.post('/api/bots/:botId/reset-circuit-breaker', (req, res) => {
    const bot = activeBots.get(req.params.botId);
    if (!bot) {
        return res.status(404).json({ error: 'Bot not found' });
    }
    
    if (!bot.fundManager) {
        return res.status(400).json({ error: 'Bot does not have fund manager' });
    }
    
    bot.fundManager.resetCircuitBreaker();
    res.json({ success: true, message: 'Circuit breaker reset' });
});

// Pause bot
app.post('/api/bots/:botId/pause', (req, res) => {
    const bot = activeBots.get(req.params.botId);
    if (!bot) {
        return res.status(404).json({ error: 'Bot not found' });
    }
    
    bot.pause();
    res.json({ success: true, status: 'paused' });
});

// Resume bot
app.post('/api/bots/:botId/resume', (req, res) => {
    const bot = activeBots.get(req.params.botId);
    if (!bot) {
        return res.status(404).json({ error: 'Bot not found' });
    }
    
    bot.resume();
    res.json({ success: true, status: 'resumed' });
});

// Stop bot
app.post('/api/bots/:botId/stop', (req, res) => {
    const bot = activeBots.get(req.params.botId);
    if (!bot) {
        return res.status(404).json({ error: 'Bot not found' });
    }
    
    const result = bot.stop();
    activeBots.delete(req.params.botId);
    
    res.json({ success: true, ...result });
});

// Get bot status
app.get('/api/bots/:botId/status', async (req, res) => {
    const bot = activeBots.get(req.params.botId);
    if (!bot) {
        return res.status(404).json({ error: 'Bot not found' });
    }
    
    const status = await bot.getStatus();
    res.json(status);
});

// List active bots
app.get('/api/bots', async (req, res) => {
    const bots = [];
    for (const [botId, bot] of activeBots) {
        try {
            const status = await bot.getStatus();
            bots.push({ botId, ...status });
        } catch (e) {
            bots.push({ botId, error: e.message });
        }
    }
    res.json({ bots });
});

// ============================================================================
// API ROUTES - SIMPLE TOKEN MARKET MAKER (Main Flow)
// ============================================================================

/**
 * MAIN USER FLOW:
 * 1. POST /api/mm/setup - Create wallet, fund it, create token
 * 2. POST /api/mm/start - Start market maker for their token
 * 3. GET /api/mm/status - Check status
 * 4. POST /api/mm/stop - Stop market maker
 */

// Get available MM strategies
app.get('/api/mm/strategies', (req, res) => {
    res.json(getStrategyInfo());
});

// Setup: Create wallet for a new user (requires ownerWallet for authentication)
app.post('/api/mm/setup', async (req, res) => {
    const { name, ownerWallet } = req.body;
    
    if (!ownerWallet) {
        return res.status(401).json({ error: 'Please connect your wallet first' });
    }
    
    try {
        // Create new wallet
        const keypair = Keypair.generate();
        const publicKey = keypair.publicKey.toBase58();
        const privateKey = bs58.default.encode(keypair.secretKey);
        
        // Save to DB with ownerWallet
        const result = db.prepare(
            'INSERT INTO wallets (name, publicKey, privateKey, ownerWallet) VALUES (?, ?, ?, ?)'
        ).run(name || 'MM Wallet', publicKey, privateKey, ownerWallet);
        
        console.log(`[MM Setup] Created wallet for ${ownerWallet.slice(0,8)}...`);
        
        res.json({
            success: true,
            walletId: result.lastInsertRowid,
            publicKey,
            message: 'Wallet created. Fund this address with SOL, then create your token.',
            nextSteps: [
                `1. Send SOL to ${publicKey}`,
                '2. Create token via PumpPortal or /api/tokens/create',
                '3. Start market maker via /api/mm/start'
            ]
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Start market maker for user's token
app.post('/api/mm/start', async (req, res) => {
    const { walletId, tokenMint, strategy, config, ownerWallet } = req.body;
    
    if (!ownerWallet) {
        return res.status(401).json({ error: 'Please connect your wallet first' });
    }
    if (!walletId || !tokenMint) {
        return res.status(400).json({ error: 'walletId and tokenMint required' });
    }
    
    try {
        // Get wallet
        const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(walletId);
        if (!wallet) {
            return res.status(404).json({ error: 'Wallet not found' });
        }
        
        // Verify ownership of the MM wallet
        if (wallet.ownerWallet && wallet.ownerWallet !== '' && wallet.ownerWallet !== ownerWallet) {
            return res.status(403).json({ error: 'Access denied - not your wallet' });
        }
        
        const conn = getConnection();
        const keypair = getWalletKeypair(wallet.privateKey);
        const mint = new PublicKey(tokenMint);
        
        // Check balance (with error handling for RPC issues)
        let balance = 0;
        try {
            balance = await conn.getBalance(keypair.publicKey);
        } catch (e) {
            console.error(`[MM] Balance check failed: ${e.message}`);
            // If RPC fails, try to continue with 0 balance check disabled
            // The strategy will handle insufficient funds during trade
            balance = 0.1 * LAMPORTS_PER_SOL; // Assume enough to start
        }
        
        if (balance < 0.005 * LAMPORTS_PER_SOL) {
            return res.status(400).json({ 
                error: `Insufficient balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL. Need at least 0.005 SOL.`,
                wallet: wallet.publicKey
            });
        }
        
        // Strategy selection
        const strategyId = strategy || 'volume'; // Default to volume bot
        
        // Callbacks for all strategies
        const callbacks = {
            onLog: (msg, logType = 'info') => {
                console.log(`[MM:${walletId}] ${msg}`);
                broadcastToClients({ type: 'log', walletId, message: msg, logType });
            },
            onTrade: (trade) => {
                // Record trade
                db.prepare('INSERT INTO trades (wallet, mint, type, amountSOL, signature, dex) VALUES (?, ?, ?, ?, ?, ?)')
                    .run(wallet.publicKey, tokenMint, trade.type, trade.amount || 0, trade.signature || '', strategyId);
                broadcastToClients({ type: 'trade', walletId, trade });
            },
            onFeeClaim: (result) => {
                broadcastToClients({ type: 'fees', walletId, result });
            },
            onError: (err) => {
                console.error(`[MM:${walletId}] Error: ${err}`);
                broadcastToClients({ type: 'error', walletId, error: err });
            },
            ...config // User config overrides
        };
        
        let mm;
        
        // Check if using new strategies or legacy TokenMarketMaker
        console.log(`[MM] Strategy requested: ${strategyId}`);
        console.log(`[MM] Available strategies:`, Object.keys(STRATEGIES));
        
        if (STRATEGIES[strategyId]) {
            console.log(`[MM] Creating strategy: ${strategyId}`);
            mm = createStrategy(strategyId, conn, keypair, mint, callbacks);
        } else {
            console.log(`[MM] Strategy '${strategyId}' not found, using TokenMarketMaker`);
            mm = new TokenMarketMaker(conn, keypair, mint, callbacks);
        }
        
        // Start
        const started = await mm.start();
        if (!started) {
            return res.status(400).json({ error: 'Failed to start market maker' });
        }
        
        // Store
        const mmId = `mm_${walletId}_${Date.now()}`;
        
        // Start AUTO-CLAIM scheduler for ALL strategies (every 4 hours)
        // TokenMarketMaker has its own, but other strategies don't
        let autoClaimInterval = null;
        if (STRATEGIES[strategyId]) {
            console.log(`[AutoClaim] Starting auto-claim for strategy: ${strategyId}`);
            
            const runAutoClaim = async () => {
                try {
                    console.log(`[AutoClaim:${mmId}] Checking fees...`);
                    const fees = await checkAllFees(conn, keypair.publicKey);
                    
                    if (fees.totalSOL >= 0.001) {
                        console.log(`[AutoClaim:${mmId}] Claiming ${fees.totalSOL.toFixed(4)} SOL`);
                        const result = await claimAllFees(conn, keypair);
                        
                        if (result.totalClaimedSOL > 0) {
                            callbacks.onLog(`💰 AUTO-CLAIMED ${result.totalClaimedSOL.toFixed(4)} SOL`);
                            callbacks.onFeeClaim(result);
                            broadcastToClients({ 
                                type: 'fees', 
                                walletId, 
                                result,
                                auto: true 
                            });
                        }
                    } else {
                        console.log(`[AutoClaim:${mmId}] No fees to claim (${fees.totalSOL.toFixed(4)} SOL)`);
                    }
                } catch (e) {
                    console.error(`[AutoClaim:${mmId}] Error: ${e.message}`);
                }
            };
            
            // Claim immediately
            runAutoClaim();
            
            // Then every 4 hours
            autoClaimInterval = setInterval(runAutoClaim, 4 * 60 * 60 * 1000);
        }
        
        // Store bot + auto-claim interval
        activeBots.set(mmId, { 
            bot: mm, 
            autoClaimInterval,
            walletId,
            tokenMint,
            strategyId 
        });
        
        // Save to DB
        db.prepare('INSERT INTO bots (wallet, mint, botType, config, status) VALUES (?, ?, ?, ?, ?)')
            .run(wallet.publicKey, tokenMint, strategyId, JSON.stringify(config || {}), 'running');
        
        const strategyInfo = STRATEGIES[strategyId] || { name: 'Token Market Maker' };
        
        res.json({
            success: true,
            mmId,
            strategy: strategyId,
            strategyName: strategyInfo.name,
            message: `${strategyInfo.name} started with AUTO-CLAIM every 4 hours!`,
            status: await mm.getStatus()
        });
        
    } catch (e) {
        console.error('[MM] Start error:', e);
        res.status(400).json({ error: e.message });
    }
});

// Get market maker status
app.get('/api/mm/:mmId/status', async (req, res) => {
    const entry = activeBots.get(req.params.mmId);
    if (!entry) {
        return res.status(404).json({ error: 'Market maker not found' });
    }
    
    const mm = entry.bot || entry; // Handle both old and new structure
    const status = await mm.getStatus();
    res.json(status);
});

// Stop market maker
app.post('/api/mm/:mmId/stop', async (req, res) => {
    const entry = activeBots.get(req.params.mmId);
    if (!entry) {
        return res.status(404).json({ error: 'Market maker not found' });
    }
    
    const mm = entry.bot || entry; // Handle both old and new structure
    const status = await mm.stop();
    
    // Stop auto-claim interval if exists
    if (entry.autoClaimInterval) {
        clearInterval(entry.autoClaimInterval);
        console.log(`[AutoClaim] Stopped for ${req.params.mmId}`);
    }
    
    activeBots.delete(req.params.mmId);
    
    // Update DB
    db.prepare('UPDATE bots SET status = ? WHERE wallet = ? AND status = ?')
        .run('stopped', status.wallet, 'running');
    
    res.json({ success: true, finalStatus: status });
});

// Force fee claim (manual)
app.post('/api/mm/:mmId/claim', async (req, res) => {
    const entry = activeBots.get(req.params.mmId);
    if (!entry) {
        return res.status(404).json({ error: 'Market maker not found' });
    }
    
    try {
        const mm = entry.bot || entry;
        
        // If bot has _claimFees method (TokenMarketMaker), use it
        if (mm._claimFees) {
            await mm._claimFees();
            const status = await mm.getStatus();
            return res.json({ success: true, status });
        }
        
        // Otherwise use the stored wallet info to claim directly
        if (entry.walletId) {
            const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(entry.walletId);
            if (wallet) {
                const conn = getConnection();
                const keypair = getWalletKeypair(wallet.privateKey);
                const result = await claimAllFees(conn, keypair);
                
                broadcastToClients({ 
                    type: 'fees', 
                    walletId: entry.walletId, 
                    result,
                    manual: true 
                });
                
                return res.json({ success: true, ...result });
            }
        }
        
        res.status(400).json({ error: 'Cannot claim fees for this bot type' });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// ============================================================================
// API ROUTES - HISTORY
// ============================================================================

// Get trade history
app.get('/api/trades', (req, res) => {
    const { wallet, mint, limit } = req.query;
    
    let sql = 'SELECT * FROM trades WHERE 1=1';
    const params = [];
    
    if (wallet) {
        sql += ' AND wallet = ?';
        params.push(wallet);
    }
    if (mint) {
        sql += ' AND mint = ?';
        params.push(mint);
    }
    
    sql += ' ORDER BY timestamp DESC';
    
    if (limit) {
        sql += ' LIMIT ?';
        params.push(parseInt(limit));
    }
    
    const trades = db.prepare(sql).all(...params);
    res.json({ trades });
});

// ============================================================================
// API ROUTES - SMART CONTRACT (Trustless Wallets)
// ============================================================================

// Get contract program info
app.get('/api/contract/info', (req, res) => {
    res.json({
        programId: MM_WALLET_PROGRAM_ID.toBase58(),
        strategies: Object.entries(CONTRACT_STRATEGIES).map(([name, id]) => ({ name, id })),
        lockOptions: [
            { days: 0, label: 'No Lock (Trusted Mode)', trustLevel: 'trusted' },
            { days: 7, label: '7 Days', trustLevel: 'semi-trustless' },
            { days: 30, label: '30 Days', trustLevel: 'trustless' },
            { days: 90, label: '90 Days', trustLevel: 'very-trustless' },
            { days: 180, label: '180 Days', trustLevel: 'maximum' },
            { days: 365, label: '365 Days', trustLevel: 'ultra' },
        ],
    });
});

// Get user's contract wallets (on-chain)
app.get('/api/contract/wallets', async (req, res) => {
    const { ownerWallet } = req.query;
    if (!ownerWallet) {
        return res.status(401).json({ error: 'Please connect your wallet first' });
    }
    
    try {
        const conn = getConnection();
        const ownerPubkey = new PublicKey(ownerWallet);
        
        // Fetch from on-chain
        const onChainWallets = await getOwnerWallets(conn, ownerPubkey);
        
        // Merge with local database info
        const localWallets = db.prepare('SELECT * FROM contract_wallets WHERE ownerWallet = ?').all(ownerWallet);
        const localMap = new Map(localWallets.map(w => [w.pdaAddress, w]));
        
        const wallets = onChainWallets.map((w) => {
            // w already has mmWalletAddress (string), pdaWalletAddress (string), balanceSOL, and parsed data
            const local = localMap.get(w.mmWalletAddress);
            
            return {
                id: local?.id,
                pdaAddress: w.mmWalletAddress,       // The mm_wallet PDA (state account)
                vaultAddress: w.pdaWalletAddress,   // The vault PDA (SOL holder)
                nonce: w.nonce,
                ownerWallet,
                operator: w.operator?.toBase58?.() || w.operator,
                tokenMint: w.tokenMint?.toBase58?.() !== '11111111111111111111111111111111' ? (w.tokenMint?.toBase58?.() || w.tokenMint) : null,
                strategy: w.strategy,
                strategyName: Object.keys(CONTRACT_STRATEGIES).find(k => CONTRACT_STRATEGIES[k] === w.strategy) || 'Unknown',
                config: w.config,
                lockUntil: w.lockUntil,
                lockDays: local?.lockDays || 0,
                isLocked: isWalletLocked(w),
                lockRemaining: formatLockTime(getLockTimeRemaining(w)),
                paused: w.paused,
                isCreator: w.isCreator,
                stats: {
                    totalTrades: w.totalTrades || 0,
                    totalVolume: w.totalVolume || 0,
                    totalFeesClaimed: w.totalFeesClaimed || 0,
                },
                balanceSOL: w.balanceSOL || 0,
                createdAt: w.createdAt ? new Date(w.createdAt * 1000).toISOString() : null,
            };
        });
        
        res.json({ wallets });
    } catch (e) {
        console.error('[Contract] Get wallets error:', e.message);
        res.status(400).json({ error: e.message });
    }
});

// Get single contract wallet info (public - for checking operator status)
app.get('/api/contract/wallets/:address/info', async (req, res) => {
    try {
        const conn = getConnection();
        const pdaAddress = new PublicKey(req.params.address);
        
        const info = await getMmWalletInfo(conn, pdaAddress);
        if (!info) {
            return res.status(404).json({ error: 'Contract wallet not found' });
        }
        
        // Return public info including operator status
        res.json({
            pdaAddress: req.params.address,
            operator: info.operator?.toBase58(),
            isLocked: isWalletLocked(info),
            lockRemaining: formatLockTime(getLockTimeRemaining(info)),
            strategyName: Object.keys(CONTRACT_STRATEGIES).find(k => CONTRACT_STRATEGIES[k] === info.strategy) || 'Unknown',
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Get single contract wallet info (full - requires ownership)
app.get('/api/contract/wallets/:address', async (req, res) => {
    const { ownerWallet } = req.query;
    
    try {
        const conn = getConnection();
        const pdaAddress = new PublicKey(req.params.address);
        
        const info = await getMmWalletInfo(conn, pdaAddress);
        if (!info) {
            return res.status(404).json({ error: 'Contract wallet not found' });
        }
        
        // Verify ownership
        if (ownerWallet && info.owner?.toBase58() !== ownerWallet) {
            return res.status(403).json({ error: 'Access denied - not your wallet' });
        }
        
        // ALWAYS fetch fresh vault balance directly from RPC
        let balanceSOL = info.balanceSOL || 0;
        try {
            const vaultPdaAddress = info.pdaWalletAddress || info.vaultAddress;
            if (vaultPdaAddress) {
                const freshBalance = await conn.getBalance(new PublicKey(vaultPdaAddress));
                balanceSOL = freshBalance / LAMPORTS_PER_SOL;
                console.log(`[Balance] Vault ${vaultPdaAddress.slice(0,8)}... = ${balanceSOL.toFixed(4)} SOL`);
            }
        } catch (balErr) {
            console.error('[Balance] Failed to fetch vault balance:', balErr.message);
        }
        
        res.json({
            pdaAddress: req.params.address,
            ...info,
            balanceSOL, // Override with fresh balance
            owner: info.owner?.toBase58(),
            operator: info.operator?.toBase58(),
            tokenMint: info.tokenMint?.toBase58() !== '11111111111111111111111111111111' ? info.tokenMint?.toBase58() : null,
            isLocked: isWalletLocked(info),
            lockRemaining: formatLockTime(getLockTimeRemaining(info)),
            strategyName: Object.keys(CONTRACT_STRATEGIES).find(k => CONTRACT_STRATEGIES[k] === info.strategy) || 'Unknown',
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Direct vault balance endpoint - always fresh from RPC
app.get('/api/contract/wallets/:address/balance', async (req, res) => {
    try {
        const conn = getConnection();
        const mmWalletPubkey = new PublicKey(req.params.address);
        
        // Get wallet info to find vault PDA
        const info = await getMmWalletInfo(conn, mmWalletPubkey);
        if (!info) {
            return res.status(404).json({ error: 'Wallet not found' });
        }
        
        // Fetch vault balance directly
        const vaultPda = new PublicKey(info.pdaWalletAddress);
        const balance = await conn.getBalance(vaultPda);
        const balanceSOL = balance / LAMPORTS_PER_SOL;
        
        console.log(`[Balance API] ${vaultPda.toBase58().slice(0,8)}... = ${balanceSOL.toFixed(4)} SOL`);
        
        res.json({
            vaultAddress: info.pdaWalletAddress,
            balanceSOL,
            balanceLamports: balance
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Create contract wallet - returns unsigned transaction
app.post('/api/contract/wallets/create', async (req, res) => {
    const { 
        ownerWallet, 
        lockDays = 0, 
        strategy = 0,
        config = { tradeSizePct: 10, minDelaySecs: 30, maxDelaySecs: 120, slippageBps: 500 },
        operator 
    } = req.body;
    
    if (!ownerWallet) {
        return res.status(401).json({ error: 'Please connect your wallet first' });
    }
    
    try {
        const conn = getConnection();
        const ownerPubkey = new PublicKey(ownerWallet);
        
        // Find next available nonce
        const existingWallets = await getOwnerWallets(conn, ownerPubkey);
        const usedNonces = new Set(existingWallets.map(w => w.nonce));
        let nonce = 0;
        while (usedNonces.has(nonce) && nonce < 100) nonce++;
        
        const lockSeconds = lockDays * 24 * 60 * 60;
        const operatorPubkey = operator || ownerWallet;
        
        // Create the instruction
        const instruction = createInitializeInstruction(
            ownerPubkey,
            nonce,
            lockSeconds,
            strategy,
            config,
            new PublicKey(operatorPubkey)
        );
        
        // Build transaction
        const { Transaction, ComputeBudgetProgram } = await import('@solana/web3.js');
        const transaction = new Transaction();
        transaction.add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 }),
            instruction
        );
        
        const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = ownerPubkey;
        
        // Get PDA address for response
        const { pda } = getMmWalletPDA(ownerPubkey, BigInt(nonce));
        
        // Serialize for client-side signing
        const serialized = transaction.serialize({ requireAllSignatures: false }).toString('base64');
        
        res.json({
            success: true,
            transaction: serialized,
            pdaAddress: pda.toBase58(),
            nonce,
            lockDays,
            strategy,
            lastValidBlockHeight,
            message: `Sign this transaction to create your trustless MM wallet${lockDays > 0 ? ` with ${lockDays}-day lock` : ''}`,
        });
    } catch (e) {
        console.error('[Contract] Create wallet error:', e.message);
        res.status(400).json({ error: e.message });
    }
});

// Record contract wallet after on-chain creation
app.post('/api/contract/wallets/record', (req, res) => {
    const { ownerWallet, pdaAddress, nonce, lockDays, strategy, signature } = req.body;
    
    if (!ownerWallet || !pdaAddress) {
        return res.status(400).json({ error: 'ownerWallet and pdaAddress required' });
    }
    
    try {
        const lockUntil = lockDays > 0 ? Math.floor(Date.now() / 1000) + (lockDays * 24 * 60 * 60) : 0;
        
        const result = db.prepare(`
            INSERT OR REPLACE INTO contract_wallets 
            (ownerWallet, pdaAddress, nonce, lockDays, lockUntil, strategy)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(ownerWallet, pdaAddress, nonce || 0, lockDays || 0, lockUntil, strategy || 0);
        
        console.log(`[Contract] Wallet recorded: ${pdaAddress.slice(0,8)}... for ${ownerWallet.slice(0,8)}... (lock: ${lockDays} days)`);
        
        // Return operator pubkey so frontend can prompt to set it
        const operatorPubkey = persistentBotManager?.getOperatorPublicKey();
        
        res.json({ 
            success: true, 
            id: result.lastInsertRowid, 
            signature,
            operatorPubkey,
            needsOperatorSetup: !!operatorPubkey
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Build setOperator transaction for a contract wallet
app.post('/api/contract/wallets/:address/set-operator', async (req, res) => {
    const { ownerWallet } = req.body;
    const pdaAddress = req.params.address;
    
    if (!ownerWallet || !pdaAddress) {
        return res.status(400).json({ error: 'ownerWallet required' });
    }
    
    if (!persistentBotManager) {
        return res.status(400).json({ error: 'Bot manager not initialized' });
    }
    
    const operatorPubkey = persistentBotManager.getOperatorPublicKey();
    if (!operatorPubkey) {
        return res.status(400).json({ error: 'No operator configured' });
    }
    
    try {
        const conn = getConnection();
        const { Transaction } = await import('@solana/web3.js');
        
        const ix = createSetOperatorInstruction(
            pdaAddress,
            ownerWallet,
            operatorPubkey
        );
        
        const tx = new Transaction().add(ix);
        tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
        tx.feePayer = new PublicKey(ownerWallet);
        
        const serialized = tx.serialize({ requireAllSignatures: false });
        
        res.json({
            transaction: serialized.toString('base64'),
            operatorPubkey,
            message: `Setting operator to ${operatorPubkey.slice(0, 8)}... for auto-trading`
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Deposit to contract wallet - returns unsigned transaction
app.post('/api/contract/wallets/:address/deposit', async (req, res) => {
    const { ownerWallet, amountSOL } = req.body;
    
    if (!ownerWallet || !amountSOL) {
        return res.status(400).json({ error: 'ownerWallet and amountSOL required' });
    }
    
    try {
        const conn = getConnection();
        const depositorPubkey = new PublicKey(ownerWallet);
        const mmWalletPubkey = new PublicKey(req.params.address);
        const amountLamports = Math.floor(parseFloat(amountSOL) * 1e9);
        
        // Verify the wallet exists
        const info = await getMmWalletInfo(conn, mmWalletPubkey);
        if (!info) {
            return res.status(404).json({ error: 'Contract wallet not found' });
        }
        
        // Debug: Log what we're using
        console.log('[Deposit Debug]', {
            mmWallet: mmWalletPubkey.toBase58(),
            parsedOwner: info.owner?.toBase58?.() || info.owner,
            parsedNonce: info.nonce,
            depositor: depositorPubkey.toBase58(),
        });
        
        // Build deposit instruction using mm_wallet address and owner/nonce from chain
        const instruction = createDepositInstructionDirect(
            mmWalletPubkey,   // mm_wallet address
            info.owner,       // owner from on-chain data
            info.nonce,       // nonce from on-chain data
            depositorPubkey,  // depositor
            amountLamports
        );
        
        const { Transaction, ComputeBudgetProgram } = await import('@solana/web3.js');
        const transaction = new Transaction();
        transaction.add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 }),
            instruction
        );
        
        const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = depositorPubkey;
        
        const serialized = transaction.serialize({ requireAllSignatures: false }).toString('base64');
        
        res.json({
            success: true,
            transaction: serialized,
            amountSOL,
            lastValidBlockHeight,
            message: `Sign to deposit ${amountSOL} SOL to your MM wallet`,
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Withdraw from contract wallet - returns unsigned transaction
app.post('/api/contract/wallets/:address/withdraw', async (req, res) => {
    const { ownerWallet, amountSOL } = req.body;
    
    if (!ownerWallet || !amountSOL) {
        return res.status(400).json({ error: 'ownerWallet and amountSOL required' });
    }
    
    try {
        const conn = getConnection();
        const ownerPubkey = new PublicKey(ownerWallet);
        const mmWalletAddress = req.params.address;
        
        // Check if wallet is locked
        const info = await getMmWalletInfo(conn, mmWalletAddress);
        if (!info) {
            return res.status(404).json({ error: 'Contract wallet not found' });
        }
        
        if (isWalletLocked(info)) {
            return res.status(400).json({ 
                error: `Wallet is locked. Time remaining: ${formatLockTime(getLockTimeRemaining(info))}`,
                lockRemaining: getLockTimeRemaining(info),
            });
        }
        
        // Verify ownership
        if (info.owner?.toBase58() !== ownerWallet) {
            return res.status(403).json({ error: 'Access denied - not your wallet' });
        }
        
        const amountLamports = Math.floor(parseFloat(amountSOL) * 1e9);
        
        // Use direct instruction with mm_wallet address and owner/nonce from chain
        const instruction = createWithdrawInstructionDirect(
            mmWalletAddress,  // mm_wallet address
            info.owner,       // owner from on-chain data
            info.nonce,       // nonce from on-chain data
            ownerPubkey,      // destination (withdraw to owner)
            amountLamports
        );
        
        const { Transaction, ComputeBudgetProgram } = await import('@solana/web3.js');
        const transaction = new Transaction();
        transaction.add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 }),
            instruction
        );
        
        const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = ownerPubkey;
        
        const serialized = transaction.serialize({ requireAllSignatures: false }).toString('base64');
        
        res.json({
            success: true,
            transaction: serialized,
            amountSOL,
            lastValidBlockHeight,
            message: `Sign to withdraw ${amountSOL} SOL from your MM wallet`,
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Pause trading - returns unsigned transaction
app.post('/api/contract/wallets/:address/pause', async (req, res) => {
    const { ownerWallet } = req.body;
    
    if (!ownerWallet) {
        return res.status(400).json({ error: 'ownerWallet required' });
    }
    
    try {
        const conn = getConnection();
        const ownerPubkey = new PublicKey(ownerWallet);
        const mmWallet = new PublicKey(req.params.address);
        
        const instruction = createPauseInstruction(mmWallet, ownerPubkey);
        
        const { Transaction, ComputeBudgetProgram } = await import('@solana/web3.js');
        const transaction = new Transaction();
        transaction.add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }),
            instruction
        );
        
        const { blockhash } = await conn.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = ownerPubkey;
        
        const serialized = transaction.serialize({ requireAllSignatures: false }).toString('base64');
        
        res.json({ success: true, transaction: serialized });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Resume trading - returns unsigned transaction
app.post('/api/contract/wallets/:address/resume', async (req, res) => {
    const { ownerWallet } = req.body;
    
    if (!ownerWallet) {
        return res.status(400).json({ error: 'ownerWallet required' });
    }
    
    try {
        const conn = getConnection();
        const ownerPubkey = new PublicKey(ownerWallet);
        const mmWallet = new PublicKey(req.params.address);
        
        const instruction = createResumeInstruction(mmWallet, ownerPubkey);
        
        const { Transaction, ComputeBudgetProgram } = await import('@solana/web3.js');
        const transaction = new Transaction();
        transaction.add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }),
            instruction
        );
        
        const { blockhash } = await conn.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = ownerPubkey;
        
        const serialized = transaction.serialize({ requireAllSignatures: false }).toString('base64');
        
        res.json({ success: true, transaction: serialized });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Create token with PDA as creator (trustless - fees go to vault!)
app.post('/api/contract/wallets/:address/create-token', upload.single('image'), async (req, res) => {
    const { ownerWallet, name, symbol, description, twitter, telegram, website } = req.body;
    
    if (!ownerWallet || !name || !symbol) {
        return res.status(400).json({ error: 'ownerWallet, name, and symbol required' });
    }
    
    try {
        const conn = getConnection();
        const mmWalletAddress = req.params.address;
        
        console.log(`[Contract] Create token request for wallet: ${mmWalletAddress}`);
        console.log(`[Contract] Owner: ${ownerWallet}, Token: ${name} (${symbol})`);
        
        // Verify wallet exists and ownership
        let info;
        try {
            info = await getMmWalletInfo(conn, mmWalletAddress);
        } catch (parseErr) {
            console.error(`[Contract] Failed to parse wallet info:`, parseErr);
            return res.status(404).json({ 
                error: 'Contract wallet not found or invalid',
                details: parseErr.message,
                hint: 'Make sure the trustless wallet was created and the transaction confirmed'
            });
        }
        
        if (!info) {
            console.log(`[Contract] Wallet not found on-chain: ${mmWalletAddress}`);
            return res.status(404).json({ 
                error: 'Contract wallet not found on-chain',
                wallet: mmWalletAddress,
                hint: 'Please create a trustless wallet first (Step 1) and ensure the transaction confirmed'
            });
        }
        
        console.log(`[Contract] Wallet found - Owner: ${info.owner?.toBase58()}, Nonce: ${info.nonce}`);
        
        if (info.owner?.toBase58() !== ownerWallet) {
            return res.status(403).json({ error: 'Access denied - not your wallet' });
        }
        
        // Check if token already created
        if (info.tokenMint && info.tokenMint.toBase58() !== '11111111111111111111111111111111') {
            return res.status(400).json({ error: 'Token already created for this wallet' });
        }
        
        // Step 1: Upload image to Pump.fun IPFS if provided
        let metadataUri;
        if (req.file) {
            const FormData = (await import('form-data')).default;
            const formData = new FormData();
            formData.append('file', req.file.buffer, { 
                filename: req.file.originalname,
                contentType: req.file.mimetype 
            });
            formData.append('name', name);
            formData.append('symbol', symbol);
            formData.append('description', description || '');
            if (twitter) formData.append('twitter', twitter);
            if (telegram) formData.append('telegram', telegram);
            if (website) formData.append('website', website);
            formData.append('showName', 'true');
            
            const ipfsResponse = await fetch('https://pump.fun/api/ipfs', {
                method: 'POST',
                body: formData,
                headers: formData.getHeaders(),
            });
            
            if (!ipfsResponse.ok) {
                const errorText = await ipfsResponse.text();
                throw new Error(`Failed to upload metadata: ${errorText}`);
            }
            
            const ipfsData = await ipfsResponse.json();
            metadataUri = ipfsData.metadataUri;
        } else {
            return res.status(400).json({ error: 'Token image required' });
        }
        
        // Step 2: Get vault PDA
        const vaultResult = getPdaWalletAddress(info.owner, info.nonce);
        const vaultPda = vaultResult.pda;
        
        // Step 3: Generate a NEW mint keypair for this token
        const { Keypair, Transaction, ComputeBudgetProgram } = await import('@solana/web3.js');
        const mintKeypair = Keypair.generate();
        
        console.log(`[Contract] Generated mint keypair: ${mintKeypair.publicKey.toBase58()}`);
        
        // Create the instruction with the mint pubkey
        const { instruction, mint, bondingCurve, metadata } = createTokenInstructionDirect(
            mmWalletAddress,
            vaultPda,
            ownerWallet,
            mintKeypair.publicKey,  // Pass mint pubkey
            name,
            symbol,
            metadataUri
        );
        
        // Build transaction
        const transaction = new Transaction();
        transaction.add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),  // Increased for CPI
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150000 }),
            instruction
        );
        
        const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = new PublicKey(ownerWallet);
        
        // Sign with mint keypair first (the frontend will sign with the owner wallet)
        transaction.partialSign(mintKeypair);
        
        const serialized = transaction.serialize({ requireAllSignatures: false }).toString('base64');
        
        console.log(`[Contract] Token creation prepared: ${name} (${symbol})`);
        console.log(`[Contract] Mint: ${mintKeypair.publicKey.toBase58()}`);
        console.log(`[Contract] Creator (vault): ${vaultPda.toBase58()}`);
        console.log(`[Contract] Metadata: ${metadata.toBase58()}`);
        
        res.json({
            success: true,
            transaction: serialized,
            mint: mintKeypair.publicKey.toBase58(),
            bondingCurve: bondingCurve.toBase58(),
            vaultPda: vaultPda.toBase58(),
            metadataUri,
            metadata: metadata.toBase58(),
            lastValidBlockHeight,
            message: `Sign to create token ${name} (${symbol}) with your vault as creator. Creator fees (0.5%) will go directly to your vault!`,
        });
    } catch (e) {
        console.error('[Contract] Create token error:', e);
        res.status(400).json({ error: e.message });
    }
});

// Set token mint for contract wallet (after creating token elsewhere)
app.post('/api/contract/wallets/:address/set-token', async (req, res) => {
    const { ownerWallet, tokenMint } = req.body;
    
    if (!ownerWallet || !tokenMint) {
        return res.status(400).json({ error: 'ownerWallet and tokenMint required' });
    }
    
    try {
        const conn = getConnection();
        const mmWalletAddress = req.params.address;
        
        // Verify wallet exists and ownership
        const info = await getMmWalletInfo(conn, mmWalletAddress);
        if (!info) {
            return res.status(404).json({ error: 'Contract wallet not found' });
        }
        
        if (info.owner?.toBase58() !== ownerWallet) {
            return res.status(403).json({ error: 'Access denied - not your wallet' });
        }
        
        // Get vault PDA address
        const vaultResult = getPdaWalletAddress(info.owner, info.nonce);
        const vaultPda = vaultResult.pda.toBase58();
        
        // Record token mint in contract_wallets table
        db.prepare(`
            UPDATE contract_wallets 
            SET tokenMint = ?, isCreator = 1
            WHERE pdaAddress = ?
        `).run(tokenMint, mmWalletAddress);
        
        // Also record in tokens table with vault as creator
        try {
            db.prepare(`
                INSERT OR REPLACE INTO tokens (mint, name, symbol, creatorWallet, bondingCurve, migrated, ownerWallet)
                VALUES (?, ?, ?, ?, '', 0, ?)
            `).run(tokenMint, 'Trustless Token', 'TT', vaultPda, ownerWallet);
        } catch (e) {
            console.log('[Contract] Token already exists in tokens table');
        }
        
        console.log(`[Contract] Token mint set for ${mmWalletAddress.slice(0,8)}...: ${tokenMint}`);
        console.log(`[Contract] Vault PDA (creator): ${vaultPda}`);
        
        res.json({ 
            success: true, 
            mmWallet: mmWalletAddress,
            tokenMint,
            message: 'Token mint recorded. You can now start the market maker.'
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Extend lock period - returns unsigned transaction
app.post('/api/contract/wallets/:address/extend-lock', async (req, res) => {
    const { ownerWallet, additionalDays } = req.body;
    
    if (!ownerWallet || !additionalDays) {
        return res.status(400).json({ error: 'ownerWallet and additionalDays required' });
    }
    
    try {
        const conn = getConnection();
        const ownerPubkey = new PublicKey(ownerWallet);
        const mmWallet = new PublicKey(req.params.address);
        const additionalSeconds = additionalDays * 24 * 60 * 60;
        
        const instruction = createExtendLockInstruction(mmWallet, ownerPubkey, additionalSeconds);
        
        const { Transaction, ComputeBudgetProgram } = await import('@solana/web3.js');
        const transaction = new Transaction();
        transaction.add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }),
            instruction
        );
        
        const { blockhash } = await conn.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = ownerPubkey;
        
        const serialized = transaction.serialize({ requireAllSignatures: false }).toString('base64');
        
        res.json({ 
            success: true, 
            transaction: serialized,
            message: `Sign to extend lock by ${additionalDays} days`
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Submit signed transaction
app.post('/api/contract/submit-tx', async (req, res) => {
    const { signedTransaction, tokenData, walletData } = req.body;
    
    if (!signedTransaction) {
        return res.status(400).json({ error: 'signedTransaction required' });
    }
    
    try {
        const conn = getConnection();
        const txBuffer = Buffer.from(signedTransaction, 'base64');
        
        const signature = await conn.sendRawTransaction(txBuffer, {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
        });
        
        await conn.confirmTransaction(signature, 'confirmed');
        
        console.log(`[Contract] Transaction confirmed: ${signature}`);
        
        // Save token data to DB if provided (for token creation)
        if (tokenData && tokenData.mint) {
            try {
                // Save to tokens table
                db.prepare(`
                    INSERT OR REPLACE INTO tokens 
                    (mint, name, symbol, creatorWallet, bondingCurve, imageUri, migrated, ownerWallet, createdAt)
                    VALUES (?, ?, ?, ?, ?, ?, 0, ?, datetime('now'))
                `).run(
                    tokenData.mint, 
                    tokenData.name || 'Token', 
                    tokenData.symbol || '???',
                    tokenData.vaultPda || '',
                    tokenData.bondingCurve || '',
                    tokenData.metadataUri || '',
                    tokenData.ownerWallet || ''
                );
                
                // Update contract_wallets with token mint
                if (tokenData.mmWalletAddress) {
                    db.prepare(`
                        UPDATE contract_wallets 
                        SET tokenMint = ?, isCreator = 1
                        WHERE pdaAddress = ?
                    `).run(tokenData.mint, tokenData.mmWalletAddress);
                }
                
                console.log(`[Contract] Token saved to DB: ${tokenData.mint.slice(0,8)}... (${tokenData.name})`);
                
                // AUTO-START PERSISTENT BOT for this token
                if (persistentBotManager && tokenData.mmWalletAddress && tokenData.ownerWallet) {
                    try {
                        console.log(`[BotManager] Auto-starting bot for new token: ${tokenData.mint.slice(0,8)}...`);
                        await persistentBotManager.startBot(
                            tokenData.mint,
                            tokenData.mmWalletAddress,
                            tokenData.ownerWallet
                        );
                        console.log(`[BotManager] Bot started for ${tokenData.mint.slice(0,8)}...`);
                    } catch (botErr) {
                        console.error('[BotManager] Auto-start error:', botErr.message);
                        // Don't fail - token was created, bot can be started manually
                    }
                }
            } catch (dbErr) {
                console.error('[Contract] DB save error:', dbErr.message);
                // Don't fail the response, token was created on-chain
            }
        }
        
        // Save wallet data to DB if provided (for wallet creation)
        if (walletData && walletData.pdaAddress) {
            try {
                db.prepare(`
                    INSERT OR REPLACE INTO contract_wallets 
                    (ownerWallet, pdaAddress, nonce, lockDays, lockUntil, strategy)
                    VALUES (?, ?, ?, ?, ?, ?)
                `).run(
                    walletData.ownerWallet,
                    walletData.pdaAddress,
                    walletData.nonce || 0,
                    walletData.lockDays || 0,
                    walletData.lockUntil || 0,
                    walletData.strategy || 0
                );
                console.log(`[Contract] Wallet saved to DB: ${walletData.pdaAddress.slice(0,8)}...`);
            } catch (dbErr) {
                console.error('[Contract] DB save error:', dbErr.message);
            }
        }
        
        res.json({ success: true, signature });
    } catch (e) {
        console.error('[Contract] Submit error:', e.message);
        res.status(400).json({ error: e.message });
    }
});

// ============================================================================
// WEBSOCKET SERVER
// ============================================================================

// Initialize indexed connection for getProgramAccounts
setIndexedConnection(getIndexedConnection());

// Initialize WebSocket connection for real-time price tracking
setGeyserConnection(getWsConnection());

const server = app.listen(PORT, async () => {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   PUMP.FUN DIRECT MARKET MAKER                                ║
║                                                               ║
║   Server: http://localhost:${PORT}                              ║
║   Trading RPC: ${RPC_URL.substring(0, 30)}...
║   WebSocket:   ${WS_RPC_URL.replace('https://', 'wss://').substring(0, 30)}...
║   Indexed RPC: ${INDEXED_RPC_URL.substring(0, 30)}...
║                                                               ║
║   PERSISTENT MM BOTS - ALWAYS RUNNING                         ║
║   NO PUMPPORTAL FEES! 0% vs 0.5-1%                            ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
    `);
    
    // Initialize Persistent Bot Manager
    try {
        persistentBotManager = new PersistentBotManager(db, getConnection, broadcastToClients);
        
        // Resume all existing bots
        await persistentBotManager.resumeAllBots();
        
        // Start bots for any tokens that don't have bots yet
        await persistentBotManager.startBotsForExistingTokens();
        
        console.log(`[BotManager] Initialized with ${persistentBotManager.getRunningCount()} persistent bots`);
    } catch (e) {
        console.error('[BotManager] Failed to initialize:', e.message);
    }
});

const wss = new WebSocketServer({ server });

// Broadcast to all connected WebSocket clients
function broadcastToClients(data) {
    const message = JSON.stringify(data);
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

wss.on('connection', (ws) => {
    console.log('[WS] Client connected');
    
    // Send current bot statuses on connect
    setTimeout(async () => {
        const bots = [];
        for (const [botId, bot] of activeBots) {
            try {
                const status = await bot.getStatus();
                bots.push({ botId, ...status });
            } catch (e) {
                bots.push({ botId, error: e.message });
            }
        }
        ws.send(JSON.stringify({ type: 'bots', bots }));
        
        // Send persistent bot statuses and recent logs
        if (persistentBotManager) {
            const persistentBots = persistentBotManager.getAllBotsStatus();
            ws.send(JSON.stringify({ type: 'persistent-bots', bots: persistentBots }));
            
            // Send recent logs for continuity
            const recentLogs = persistentBotManager.getAllRecentLogs(100);
            ws.send(JSON.stringify({ type: 'recent-logs', logs: recentLogs }));
        }
    }, 100);
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('[WS] Received:', data.type);
            
            // Handle WebSocket commands
            if (data.type === 'subscribe') {
                // Could implement real-time price feeds here
            }
            
            if (data.type === 'get-status' && data.botId) {
                const bot = activeBots.get(data.botId);
                if (bot) {
                    const status = await bot.getStatus();
                    ws.send(JSON.stringify({ type: 'status', botId: data.botId, status }));
                }
            }
        } catch (e) {
            console.error('[WS] Error:', e.message);
        }
    });
    
    ws.on('close', () => {
        console.log('[WS] Client disconnected');
    });
});

// ============================================================================
// PERSISTENT BOT API - Always-on MM bots
// ============================================================================

// Get all persistent bots status
app.get('/api/persistent-bots', (req, res) => {
    if (!persistentBotManager) {
        return res.json({ bots: [], count: 0, stats: { totalVolume: 0, totalTrades: 0 } });
    }
    
    const bots = persistentBotManager.getAllBotsStatus();
    const stats = persistentBotManager.getAggregateStats();
    
    res.json({ 
        bots, 
        count: bots.length,
        running: bots.filter(b => b.isRunning && !b.isPaused).length,
        paused: bots.filter(b => b.isPaused).length,
        stats // Aggregate volume stats
    });
});

// Get specific bot status
app.get('/api/persistent-bots/:tokenMint', (req, res) => {
    if (!persistentBotManager) {
        return res.status(404).json({ error: 'Bot manager not initialized' });
    }
    
    const status = persistentBotManager.getBotStatus(req.params.tokenMint);
    if (!status) {
        return res.status(404).json({ error: 'Bot not found' });
    }
    
    res.json(status);
});

// Update bot strategy
app.post('/api/persistent-bots/:tokenMint/strategy', (req, res) => {
    const { strategy, config } = req.body;
    
    if (!persistentBotManager) {
        return res.status(400).json({ error: 'Bot manager not initialized' });
    }
    
    const success = persistentBotManager.updateStrategy(req.params.tokenMint, strategy, config || {});
    
    if (success) {
        res.json({ success: true, message: 'Strategy updated' });
    } else {
        res.status(404).json({ error: 'Bot not found' });
    }
});

// Manually start a bot for a token (in case auto-start failed)
app.post('/api/persistent-bots/start', async (req, res) => {
    const { tokenMint, pdaAddress, ownerWallet } = req.body;
    
    if (!tokenMint || !pdaAddress || !ownerWallet) {
        return res.status(400).json({ error: 'tokenMint, pdaAddress, and ownerWallet required' });
    }
    
    if (!persistentBotManager) {
        return res.status(400).json({ error: 'Bot manager not initialized' });
    }
    
    try {
        const bot = await persistentBotManager.startBot(tokenMint, pdaAddress, ownerWallet);
        res.json({ success: true, status: bot.getStatus() });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Get bot status for a specific owner's tokens
app.get('/api/persistent-bots/owner/:ownerWallet', (req, res) => {
    if (!persistentBotManager) {
        return res.json({ bots: [] });
    }
    
    const allBots = persistentBotManager.getAllBotsStatus();
    const ownerBots = allBots.filter(b => b.ownerWallet === req.params.ownerWallet);
    
    res.json({ bots: ownerBots, count: ownerBots.length });
});

// Get operator public key for setting up auto-trading
app.get('/api/persistent-bots/operator', (req, res) => {
    if (!persistentBotManager) {
        return res.status(400).json({ error: 'Bot manager not initialized' });
    }
    
    const operatorPubkey = persistentBotManager.getOperatorPublicKey();
    
    res.json({
        operatorPublicKey: operatorPubkey,
        instructions: 'To enable automatic trading for your trustless wallet, set this operator on your PDA wallet using the setOperator instruction.'
    });
});

// Get bot logs (for persistence and refresh)
app.get('/api/persistent-bots/logs', (req, res) => {
    if (!persistentBotManager) {
        return res.json({ logs: [] });
    }
    
    const { tokenMint, limit } = req.query;
    
    let logs;
    if (tokenMint) {
        logs = persistentBotManager.getRecentLogs(tokenMint, parseInt(limit) || 50);
    } else {
        logs = persistentBotManager.getAllRecentLogs(parseInt(limit) || 100);
    }
    
    res.json({ logs });
});

// ============================================================================
// LANDING PAGE API
// ============================================================================

// Get all trustless wallets (PDAs) for landing page display (REAL DATA ONLY)
app.get('/api/landing/tokens', async (req, res) => {
    try {
        const allWallets = [];
        
        // Get all contract wallets from database (this is where trustless PDAs are tracked)
        const contractWallets = db.prepare(`
            SELECT * FROM contract_wallets WHERE ownerWallet IS NOT NULL
        `).all();
        
        // Get all tokens from database to match with creator wallets
        const allDbTokens = db.prepare(`SELECT * FROM tokens`).all();
        
        // Get all active bots from database
        const allDbBots = db.prepare(`SELECT * FROM bots WHERE status = 'running'`).all();
        
        // Build a map of vault PDA -> token info
        const vaultToToken = new Map();
        const regularWalletToToken = new Map();
        for (const token of allDbTokens) {
            if (token.creatorWallet) {
                // Check if this creator is a vault PDA
                vaultToToken.set(token.creatorWallet, token);
                regularWalletToToken.set(token.creatorWallet, token);
            }
        }
        
        // Build a map of token mint -> active bot
        const mintToBot = new Map();
        for (const bot of allDbBots) {
            mintToBot.set(bot.mint, bot);
        }
        
        // Get unique owners from contract wallets
        const uniqueOwners = new Set(contractWallets.map(w => w.ownerWallet).filter(Boolean));
        
        console.log(`[Landing] Scanning ${uniqueOwners.size} owner wallets for trustless PDAs...`);
        
        // For each owner, get ALL their trustless wallets (not just ones with tokens)
        for (const ownerWallet of uniqueOwners) {
            if (!ownerWallet) continue;
            
            try {
                const wallets = await getOwnerWallets(getConnection(), new PublicKey(ownerWallet));
                
                for (const wallet of wallets) {
                    // Calculate lock status
                    const now = Math.floor(Date.now() / 1000);
                    const isLocked = wallet.lockUntil > now;
                    const lockRemaining = isLocked ? formatLockTime(wallet.lockUntil - now) : null;
                    const lockDays = isLocked ? Math.ceil((wallet.lockUntil - now) / 86400) : 0;
                    
                    // Check if has a real token (not default pubkey)
                    const hasToken = wallet.tokenMint && 
                                     wallet.tokenMint !== '11111111111111111111111111111111' &&
                                     wallet.tokenMint.length > 30;
                    
                    let walletData = {
                        // Wallet/PDA info
                        vaultAddress: wallet.pdaWalletAddress,
                        mmWalletAddress: wallet.mmWalletAddress,
                        ownerWallet: ownerWallet,
                        nonce: wallet.nonce,
                        
                        // Lock info
                        lockedSOL: wallet.balanceSOL || 0,
                        isLocked: isLocked,
                        lockRemaining: lockRemaining,
                        lockDays: lockDays,
                        lockUntil: wallet.lockUntil,
                        
                        // Token info (may be null)
                        mint: hasToken ? wallet.tokenMint : null,
                        name: null,
                        symbol: null,
                        image: null,
                        createdAt: wallet.createdAt ? new Date(wallet.createdAt * 1000).toISOString() : null,
                        
                        // Market data
                        marketCap: 0,
                        volume24h: 0,
                        priceHistory: [],
                        
                        // Bot status
                        botActive: false,
                        
                        // Stats from contract
                        totalVolume: wallet.totalVolume || 0,
                        totalTrades: wallet.totalTrades || 0,
                        totalFeesClaimed: wallet.totalFeesClaimed || 0,
                        isCreator: wallet.isCreator || false,
                    };
                    
                    // Check if this vault PDA created any tokens (look in tokens table by creatorWallet)
                    const vaultToken = vaultToToken.get(wallet.pdaWalletAddress);
                    if (vaultToken) {
                        walletData.mint = vaultToken.mint;
                        walletData.name = vaultToken.name;
                        walletData.symbol = vaultToken.symbol;
                        walletData.image = vaultToken.imageUri;
                        walletData.createdAt = vaultToken.createdAt;
                    }
                    
                    // Also check if there's a token stored in contract_wallets
                    const localWallet = contractWallets.find(cw => cw.pdaAddress === wallet.mmWalletAddress);
                    if (localWallet?.tokenMint) {
                        walletData.mint = localWallet.tokenMint;
                    }
                    
                    // If no token found but isCreator is true, try to discover from on-chain
                    if (!walletData.mint && wallet.isCreator) {
                        try {
                            const vaultTokens = await getVaultTokenMints(getConnection(), wallet.pdaWalletAddress);
                            if (vaultTokens.length > 0) {
                                // Use the first token with a balance (likely the created token)
                                const tokenWithBalance = vaultTokens.find(t => t.balance > 0) || vaultTokens[0];
                                walletData.mint = tokenWithBalance.mint;
                                walletData.discoveredOnChain = true;
                                console.log(`[Landing] Discovered token ${tokenWithBalance.mint} for vault ${wallet.pdaWalletAddress.slice(0,8)}...`);
                                
                                // Save to database for future lookups
                                try {
                                    db.prepare(`UPDATE contract_wallets SET tokenMint = ? WHERE pdaAddress = ?`)
                                        .run(tokenWithBalance.mint, wallet.mmWalletAddress);
                                } catch (e) {}
                            }
                        } catch (e) {
                            console.log(`[Landing] Token discovery failed for ${wallet.pdaWalletAddress.slice(0,8)}...: ${e.message}`);
                        }
                    }
                    
                    // If has token, try to get market data
                    if (walletData.mint) {
                        const conn = getConnection();
                        const mintPk = new PublicKey(walletData.mint);
                        
                        // First: Get market cap from bonding curve via RPC
                        try {
                            const status = await getTokenStatus(conn, mintPk);
                            if (status) {
                                // Get current SOL price (use cached if fresh)
                                let solPrice = 200;
                                const now = Date.now();
                                if (cachedSolPrice.timestamp > now - SOL_PRICE_CACHE_MS) {
                                    solPrice = cachedSolPrice.price;
                                } else {
                                    try {
                                        const sp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
                                        if (sp.ok) {
                                            const spData = await sp.json();
                                            solPrice = spData.solana?.usd || 200;
                                            cachedSolPrice = { price: solPrice, timestamp: now };
                                        }
                                    } catch (e) {}
                                }
                                
                                // Price is in SOL per token, convert to USD
                                const priceSOL = status.price || 0;
                                walletData.price = priceSOL * solPrice; // USD price
                                
                                // Market cap = price in SOL * 1B supply * SOL price
                                const mcapSOL = priceSOL * 1_000_000_000;
                                walletData.marketCap = mcapSOL * solPrice;
                                
                                // Liquidity in USD
                                walletData.liquidity = (status.liquiditySOL || 0) * solPrice;
                                walletData.dex = status.dex || 'pump';
                                
                                console.log(`[Landing] ${walletData.mint.slice(0,8)}: price=${priceSOL.toExponential(2)} SOL, mcap=$${walletData.marketCap.toFixed(0)}, SOL=$${solPrice}`);
                            }
                        } catch (e) {
                            console.log(`[Landing] RPC market data error for ${walletData.mint.slice(0,8)}: ${e.message}`);
                        }
                        
                        // Second: Get metadata from Token Intelligence API
                        try {
                            const r = await fetch(`https://tokens.whistle.ninja/token/${walletData.mint}`);
                            if (r.ok) {
                                const data = await r.json();
                                // Only use API data if RPC didn't provide it
                                if (!walletData.marketCap) walletData.marketCap = data.marketCap || 0;
                                if (!walletData.price) walletData.price = data.price || 0;
                                walletData.volume24h = data.volume24h || 0;
                                if (!walletData.name) walletData.name = data.name;
                                if (!walletData.symbol) walletData.symbol = data.symbol;
                                if (!walletData.image) walletData.image = data.image || data.imageUri || data.uri;
                            }
                        } catch (e) {}
                        
                        // Third: Fallback to pump.fun API for metadata if still missing
                        if (!walletData.name || !walletData.image) {
                            try {
                                const pumpR = await fetch(`https://frontend-api.pump.fun/coins/${walletData.mint}`);
                                if (pumpR.ok) {
                                    const pumpData = await pumpR.json();
                                    if (!walletData.name) walletData.name = pumpData.name;
                                    if (!walletData.symbol) walletData.symbol = pumpData.symbol;
                                    if (!walletData.image) walletData.image = pumpData.image_uri;
                                    if (!walletData.marketCap) walletData.marketCap = pumpData.usd_market_cap || 0;
                                }
                            } catch (e) {}
                        }
                        
                        // Convert IPFS URLs to use nftstorage.link gateway (most reliable)
                        if (walletData.image) {
                            if (walletData.image.includes('ipfs.io/ipfs/')) {
                                walletData.image = walletData.image.replace('ipfs.io/ipfs/', 'nftstorage.link/ipfs/');
                            } else if (walletData.image.includes('/ipfs/')) {
                                const match = walletData.image.match(/\/ipfs\/([a-zA-Z0-9]+)/);
                                if (match) {
                                    walletData.image = `https://nftstorage.link/ipfs/${match[1]}`;
                                }
                            }
                        }
                        
                        // Check if there's an active bot for this token (in-memory)
                        for (const [botId, bot] of activeBots) {
                            if (bot.tokenMint === walletData.mint) {
                                walletData.botActive = true;
                                walletData.botType = bot.strategyId || 'volume';
                                break;
                            }
                        }
                        
                        // Also check database for bot info
                        const dbBot = mintToBot.get(walletData.mint);
                        if (dbBot) {
                            walletData.botActive = walletData.botActive || dbBot.status === 'running';
                            walletData.botType = walletData.botType || dbBot.botType;
                            walletData.botTotalVolume = dbBot.totalVolume || 0;
                            walletData.botTotalTrades = dbBot.totalTrades || 0;
                        }
                        
                        // Get price history from chart data
                        try {
                            const history = db.prepare(`
                                SELECT price, marketCap, timestamp 
                                FROM price_history 
                                WHERE mint = ? 
                                ORDER BY timestamp DESC 
                                LIMIT 50
                            `).all(walletData.mint);
                            
                            walletData.priceHistory = history.reverse().map(h => ({ price: h.marketCap || h.price }));
                        } catch (e) {}
                    }
                    
                    allWallets.push(walletData);
                }
            } catch (e) {
                console.error(`[Landing] Error scanning owner ${ownerWallet}:`, e.message);
            }
        }
        
        // Sort: Locked first, then by SOL locked amount
        allWallets.sort((a, b) => {
            if (a.isLocked && !b.isLocked) return -1;
            if (!a.isLocked && b.isLocked) return 1;
            return (b.lockedSOL || 0) - (a.lockedSOL || 0);
        });
        
        console.log(`[Landing] Found ${allWallets.length} trustless wallets`);
        res.json(allWallets);
    } catch (e) {
        console.error('[Landing] Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Get landing page stats summary
app.get('/api/landing/stats', async (req, res) => {
    try {
        const tokenCount = db.prepare('SELECT COUNT(*) as count FROM tokens').get().count;
        
        // Calculate total volume from trades
        const volumeResult = db.prepare(`
            SELECT COALESCE(SUM(amountSOL), 0) as total FROM trades
        `).get();
        
        res.json({
            totalTokens: tokenCount,
            totalVolume: volumeResult.total || 0,
            activeBots: activeBots.size
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down...');
    
    // Stop all bots
    for (const [botId, bot] of activeBots) {
        bot.stop();
    }
    
    db.close();
    process.exit(0);
});

