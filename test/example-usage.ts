/**
 * Example Usage - MM Wallet SDK
 * 
 * This file shows how to use the MM Wallet SDK in your frontend.
 */

import { Connection, Keypair, Transaction, PublicKey } from '@solana/web3.js';
import { 
  MmWalletClient, 
  Strategy, 
  deriveMmWalletPDA, 
  deriveVaultPDA,
  deriveCreatorVaultPDA,
  addComputeBudget,
  solToLamports,
  lamportsToSol,
} from './mm-wallet-sdk';

// ═══════════════════════════════════════════════════════════════
//                    CONFIGURATION
// ═══════════════════════════════════════════════════════════════

const RPC_URL = 'https://api.mainnet-beta.solana.com';
// Or use your own RPC: 'https://your-rpc-endpoint.com'

// ═══════════════════════════════════════════════════════════════
//                    EXAMPLE: INITIALIZE WALLET
// ═══════════════════════════════════════════════════════════════

async function initializeWallet(
  wallet: { publicKey: PublicKey; signTransaction: (tx: Transaction) => Promise<Transaction> },
  nonce: bigint = 0n,
  lockDays: number = 0
): Promise<{ mmWallet: PublicKey; vault: PublicKey }> {
  const connection = new Connection(RPC_URL, 'confirmed');
  const client = new MmWalletClient(connection);
  
  const [mmWallet] = deriveMmWalletPDA(wallet.publicKey, nonce);
  const [vault] = deriveVaultPDA(wallet.publicKey, nonce);
  
  // Check if already exists
  const existing = await client.getMmWallet(mmWallet);
  if (existing) {
    console.log('Wallet already exists:', mmWallet.toBase58());
    return { mmWallet, vault };
  }
  
  const lockDurationSeconds = BigInt(lockDays * 24 * 60 * 60);
  
  const ix = client.buildInitializeIx(
    wallet.publicKey,
    nonce,
    lockDurationSeconds,
    {
      strategy: Strategy.VolumeBot,
      minTradeSize: solToLamports(0.001),
      maxTradeSize: solToLamports(1.0),
      targetSpread: 100, // 1% = 100 basis points
      maxSlippage: 500,  // 5% = 500 basis points
      cooldownSeconds: 60,
      reserved: new Array(32).fill(0),
    }
  );
  
  const tx = new Transaction();
  addComputeBudget(tx);
  tx.add(ix);
  
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  
  const signedTx = await wallet.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signedTx.serialize());
  await connection.confirmTransaction(sig, 'confirmed');
  
  console.log('Initialized wallet:', mmWallet.toBase58());
  console.log('Vault:', vault.toBase58());
  console.log('Tx:', sig);
  
  return { mmWallet, vault };
}

// ═══════════════════════════════════════════════════════════════
//                    EXAMPLE: DEPOSIT SOL
// ═══════════════════════════════════════════════════════════════

async function depositSol(
  wallet: { publicKey: PublicKey; signTransaction: (tx: Transaction) => Promise<Transaction> },
  mmWallet: PublicKey,
  vault: PublicKey,
  amountSol: number
): Promise<string> {
  const connection = new Connection(RPC_URL, 'confirmed');
  const client = new MmWalletClient(connection);
  
  const ix = client.buildDepositIx(
    wallet.publicKey,
    mmWallet,
    vault,
    solToLamports(amountSol)
  );
  
  const tx = new Transaction();
  addComputeBudget(tx);
  tx.add(ix);
  
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  
  const signedTx = await wallet.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signedTx.serialize());
  await connection.confirmTransaction(sig, 'confirmed');
  
  console.log(`Deposited ${amountSol} SOL, Tx:`, sig);
  return sig;
}

// ═══════════════════════════════════════════════════════════════
//                    EXAMPLE: CREATE TOKEN
// ═══════════════════════════════════════════════════════════════

async function createToken(
  wallet: { publicKey: PublicKey; signTransaction: (tx: Transaction) => Promise<Transaction> },
  mmWallet: PublicKey,
  vault: PublicKey,
  name: string,
  symbol: string,
  uri: string
): Promise<{ mint: PublicKey; tx: string }> {
  const connection = new Connection(RPC_URL, 'confirmed');
  const client = new MmWalletClient(connection);
  
  // Generate new mint keypair
  const mint = Keypair.generate();
  
  const { instruction, mint: mintKp } = client.buildCreateTokenIx(
    wallet.publicKey,
    mmWallet,
    vault,
    mint,
    name,
    symbol,
    uri
  );
  
  const tx = new Transaction();
  addComputeBudget(tx, 400000); // Token creation needs more compute
  tx.add(instruction);
  
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  
  // Need to sign with both wallet and mint keypair
  tx.partialSign(mintKp);
  const signedTx = await wallet.signTransaction(tx);
  
  const sig = await connection.sendRawTransaction(signedTx.serialize());
  await connection.confirmTransaction(sig, 'confirmed');
  
  console.log('Token created!');
  console.log('Mint:', mint.publicKey.toBase58());
  console.log('Creator (vault):', vault.toBase58());
  console.log('Tx:', sig);
  console.log(`https://pump.fun/coin/${mint.publicKey.toBase58()}`);
  
  return { mint: mint.publicKey, tx: sig };
}

// ═══════════════════════════════════════════════════════════════
//                    EXAMPLE: BUY TOKENS
// ═══════════════════════════════════════════════════════════════

async function buyTokens(
  wallet: { publicKey: PublicKey; signTransaction: (tx: Transaction) => Promise<Transaction> },
  mmWallet: PublicKey,
  vault: PublicKey,
  mint: PublicKey,
  amountSol: number
): Promise<string> {
  const connection = new Connection(RPC_URL, 'confirmed');
  const client = new MmWalletClient(connection);
  
  // Ensure vault has an ATA for the token
  const ataIx = await client.ensureVaultAta(vault, mint, wallet.publicKey);
  
  const buyIx = client.buildExecuteBuyIx(
    wallet.publicKey,
    mmWallet,
    vault,
    mint,
    solToLamports(amountSol),
    0n // minTokensOut - set to 0 for now, calculate based on price for production
  );
  
  const tx = new Transaction();
  addComputeBudget(tx);
  if (ataIx) tx.add(ataIx); // Add ATA creation if needed
  tx.add(buyIx);
  
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  
  const signedTx = await wallet.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signedTx.serialize());
  await connection.confirmTransaction(sig, 'confirmed');
  
  console.log(`Bought tokens with ${amountSol} SOL, Tx:`, sig);
  return sig;
}

// ═══════════════════════════════════════════════════════════════
//                    EXAMPLE: SELL TOKENS
// ═══════════════════════════════════════════════════════════════

async function sellTokens(
  wallet: { publicKey: PublicKey; signTransaction: (tx: Transaction) => Promise<Transaction> },
  mmWallet: PublicKey,
  vault: PublicKey,
  mint: PublicKey,
  tokenAmount: bigint
): Promise<string> {
  const connection = new Connection(RPC_URL, 'confirmed');
  const client = new MmWalletClient(connection);
  
  const sellIx = client.buildExecuteSellIx(
    wallet.publicKey,
    mmWallet,
    vault,
    mint,
    tokenAmount,
    0n // minSolOut - set to 0 for now, calculate for production
  );
  
  const tx = new Transaction();
  addComputeBudget(tx);
  tx.add(sellIx);
  
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  
  const signedTx = await wallet.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signedTx.serialize());
  await connection.confirmTransaction(sig, 'confirmed');
  
  console.log(`Sold ${tokenAmount} tokens, Tx:`, sig);
  return sig;
}

// ═══════════════════════════════════════════════════════════════
//                    EXAMPLE: GET WALLET INFO
// ═══════════════════════════════════════════════════════════════

async function getWalletInfo(
  mmWallet: PublicKey,
  vault: PublicKey
): Promise<void> {
  const connection = new Connection(RPC_URL, 'confirmed');
  const client = new MmWalletClient(connection);
  
  const wallet = await client.getMmWallet(mmWallet);
  if (!wallet) {
    console.log('Wallet not found');
    return;
  }
  
  const vaultBalance = await connection.getBalance(vault);
  const creatorFees = await client.getCreatorFees(vault);
  
  console.log('═══════════════════════════════════════');
  console.log('         MM WALLET INFO');
  console.log('═══════════════════════════════════════');
  console.log('MM Wallet:', mmWallet.toBase58());
  console.log('Vault:', vault.toBase58());
  console.log('Owner:', wallet.owner.toBase58());
  console.log('Operator:', wallet.operator?.toBase58() || 'None');
  console.log('Token Mint:', wallet.tokenMint?.toBase58() || 'None');
  console.log('');
  console.log('💰 BALANCES:');
  console.log('  Vault SOL:', lamportsToSol(vaultBalance), 'SOL');
  console.log('  Creator Fees:', creatorFees, 'SOL');
  console.log('');
  console.log('📊 STATS:');
  console.log('  Total Deposited:', lamportsToSol(wallet.totalDeposited), 'SOL');
  console.log('  Total Withdrawn:', lamportsToSol(wallet.totalWithdrawn), 'SOL');
  console.log('  Total Bought:', lamportsToSol(wallet.totalBought), 'SOL');
  console.log('  Total Sold:', lamportsToSol(wallet.totalSold), 'SOL');
  console.log('  Trade Count:', wallet.tradeCount.toString());
  console.log('');
  console.log('⚙️ STATUS:');
  console.log('  Paused:', wallet.paused);
  console.log('  Is Creator:', wallet.isCreator);
  console.log('  Lock Until:', new Date(Number(wallet.lockUntil) * 1000).toISOString());
  console.log('');
  console.log('🎯 STRATEGY:');
  console.log('  Type:', Strategy[wallet.strategyConfig.strategy]);
  console.log('  Min Trade:', lamportsToSol(wallet.strategyConfig.minTradeSize), 'SOL');
  console.log('  Max Trade:', lamportsToSol(wallet.strategyConfig.maxTradeSize), 'SOL');
  console.log('  Target Spread:', wallet.strategyConfig.targetSpread / 100, '%');
  console.log('  Max Slippage:', wallet.strategyConfig.maxSlippage / 100, '%');
  console.log('  Cooldown:', wallet.strategyConfig.cooldownSeconds, 'seconds');
}

// ═══════════════════════════════════════════════════════════════
//                    REACT HOOK EXAMPLE
// ═══════════════════════════════════════════════════════════════

/*
// Example React hook for use with @solana/wallet-adapter

import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useState, useEffect } from 'react';
import { MmWalletClient, deriveMmWalletPDA, deriveVaultPDA } from './mm-wallet-sdk';

export function useMmWallet(nonce: bigint = 0n) {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const [client] = useState(() => new MmWalletClient(connection));
  const [mmWallet, setMmWallet] = useState<PublicKey | null>(null);
  const [vault, setVault] = useState<PublicKey | null>(null);
  const [walletData, setWalletData] = useState<MmWalletAccount | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!publicKey) {
      setMmWallet(null);
      setVault(null);
      setWalletData(null);
      setLoading(false);
      return;
    }

    const [mmWalletPda] = deriveMmWalletPDA(publicKey, nonce);
    const [vaultPda] = deriveVaultPDA(publicKey, nonce);
    
    setMmWallet(mmWalletPda);
    setVault(vaultPda);

    client.getMmWallet(mmWalletPda).then(data => {
      setWalletData(data);
      setLoading(false);
    });
  }, [publicKey, nonce, client]);

  const initialize = async (lockDays: number = 0) => {
    if (!publicKey || !signTransaction) throw new Error('Wallet not connected');
    // ... implement initialization
  };

  const deposit = async (amountSol: number) => {
    if (!publicKey || !signTransaction || !mmWallet || !vault) {
      throw new Error('Wallet not ready');
    }
    // ... implement deposit
  };

  const createToken = async (name: string, symbol: string, uri: string) => {
    if (!publicKey || !signTransaction || !mmWallet || !vault) {
      throw new Error('Wallet not ready');
    }
    // ... implement token creation
  };

  return {
    mmWallet,
    vault,
    walletData,
    loading,
    initialize,
    deposit,
    createToken,
  };
}
*/

// ═══════════════════════════════════════════════════════════════
//                    EXPORTS
// ═══════════════════════════════════════════════════════════════

export {
  initializeWallet,
  depositSol,
  createToken,
  buyTokens,
  sellTokens,
  getWalletInfo,
};

