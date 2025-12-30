# MM Wallet Frontend SDK

This SDK provides everything you need to integrate with the MM Wallet smart contract.

## Program ID

```
4ZzKbBw9o1CuVgGVokLNWsgHy9Acnd4EzVH5N6nnbyf5
```

## Installation

```bash
npm install @solana/web3.js @solana/spl-token
```

## Quick Start

```typescript
import { Connection, PublicKey } from '@solana/web3.js';
import { MmWalletClient, deriveMmWalletPDA, deriveVaultPDA } from './mm-wallet-sdk';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const client = new MmWalletClient(connection);

// Derive PDAs for a wallet
const owner = new PublicKey('YOUR_WALLET_ADDRESS');
const nonce = 0n;
const [mmWallet] = deriveMmWalletPDA(owner, nonce);
const [vault] = deriveVaultPDA(owner, nonce);

// Get wallet info
const info = await client.getMmWallet(mmWallet);
```

## Files

| File | Description |
|------|-------------|
| `mm-wallet-sdk.ts` | Main SDK with all instruction builders |
| `example-usage.ts` | Example implementations |
| `constants.ts` | All program IDs and constants |
| `mm_wallet_v2.json` | IDL file for the program |

## Key Features

### 1. Initialize Wallet
Creates a new MM wallet with a vault PDA for holding funds.

```typescript
const ix = client.buildInitializeIx(owner, nonce, lockDuration, strategyConfig);
```

### 2. Deposit/Withdraw SOL
Add or remove funds from the vault.

```typescript
const depositIx = client.buildDepositIx(owner, mmWallet, vault, amount);
const withdrawIx = client.buildWithdrawIx(owner, mmWallet, vault, amount);
```

### 3. Create Token (PDA as Creator)
Create a Pump.fun token where the vault PDA is the creator. This means:
- Creator fees accumulate in a PDA controlled by your contract
- Fees are locked and can only be used for market making
- Users cannot withdraw creator fees directly

```typescript
const { instruction, mint } = client.buildCreateTokenIx(
  owner, mmWallet, vault, mintKeypair, name, symbol, uri
);
```

### 4. Buy/Sell Tokens
Execute trades on Pump.fun through the vault PDA.

```typescript
const buyIx = client.buildExecuteBuyIx(caller, mmWallet, vault, mint, solAmount, minTokens);
const sellIx = client.buildExecuteSellIx(caller, mmWallet, vault, mint, tokenAmount, minSol);
```

## PDA Derivations

| PDA | Seeds |
|-----|-------|
| MM Wallet | `["mm_wallet", owner, nonce]` |
| Vault | `["vault", owner, nonce]` |
| Bonding Curve | `["bonding-curve", mint]` (Pump.fun) |
| Creator Vault | `["creator-vault", creator]` (Pump.fun) |

## Test Addresses (Mainnet)

| Address | Description |
|---------|-------------|
| `5io1DKP2mkBsHPeNuhneJpLpke6U79t5V1MzcjnC4jGo` | Test MM Wallet |
| `76n7XMhUU8vY1Va3uUaEa5HjgDZkm6U6e7pseCq7rUYw` | Test Vault (PDA) |
| `63qivZsE9AL9yZib7KSx6CTmbvtbvz8e3zw4qJZwvocp` | Test Token (PDA Test) |
| `BdHJe2gnRssCBM5mJFz5ChR5RE12bt5VHaBFx8qfLFoQ` | Test Creator Vault |

## Strategies

```typescript
enum Strategy {
  VolumeBot = 0,      // Volume-based trading
  PriceReactive = 1,  // React to price changes
  GridTrading = 2,    // Grid trading strategy
  TrendFollower = 3,  // Follow market trends
  SpreadMM = 4,       // Spread market making
  PumpHunter = 5,     // Hunt pump opportunities
}
```

## Error Codes

| Code | Name | Description |
|------|------|-------------|
| 6000 | Unauthorized | Not the owner |
| 6001 | UnauthorizedOperator | Not owner or operator |
| 6002 | WalletLocked | Lock period not expired |
| 6003 | InsufficientFunds | Not enough SOL in vault |
| 6004 | TradingPaused | Wallet is paused |
| 6005 | InvalidAmount | Amount too small/large |
| 6006 | CooldownActive | Must wait between trades |

## Transaction Structure

Every transaction should include compute budget instructions:

```typescript
import { ComputeBudgetProgram } from '@solana/web3.js';

tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }));
tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }));
```

## Proof: PDA Token Creation Works

The test token `63qivZsE9AL9yZib7KSx6CTmbvtbvz8e3zw4qJZwvocp` was created with:
- **Creator (in bonding curve):** `76n7XMhUU8vY1Va3uUaEa5HjgDZkm6U6e7pseCq7rUYw` (Vault PDA)
- **Creator fees accumulated:** ~0.01 SOL
- **Fees are locked:** Only claimable via contract's `invoke_signed`

Transaction: [2XtEKBxCiErwByxQUCdX5iuJh3vmg2fji45KbLbQ22jDV7xSCtXoSAGMsjFtQLQ86BWBNt7Y7J994o4dWz6uuTKG](https://solscan.io/tx/2XtEKBxCiErwByxQUCdX5iuJh3vmg2fji45KbLbQ22jDV7xSCtXoSAGMsjFtQLQ86BWBNt7Y7J994o4dWz6uuTKG)

