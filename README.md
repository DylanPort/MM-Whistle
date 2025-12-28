# MM Wallet v2.0

**Automated Market Making on Pump.fun**

A Solana smart contract that enables automated market making on Pump.fun tokens with built-in security features.

## 🚀 Deployed

**Program ID**: `4ZzKbBw9o1CuVgGVokLNWsgHy9Acnd4EzVH5N6nnbyf5`

**Network**: Solana Mainnet

## ✨ Features

- **PDA Wallets** - Create secure wallets tied to your address
- **Token Creation** - Create Pump.fun tokens with PDA as creator (earns 0.5% fees)
- **Bonding Curve Trading** - Buy/sell on Pump.fun bonding curves
- **AMM Trading** - Trade on PumpSwap for migrated tokens
- **Lock Mechanism** - Lock funds up to 365 days for trust
- **Multi-Strategy** - 6 different trading strategies
- **Operator Delegation** - Delegate trading rights while maintaining ownership

## 🔐 Security Features

| Feature | Description |
|---------|-------------|
| ✅ Authorization | Owner/Operator separation |
| ✅ Slippage Protection | On-chain calculation (0.1% - 50%) |
| ✅ Trade Limits | Max 50% of balance per trade |
| ✅ Rate Limiting | Prevents rapid trade abuse |
| ✅ Rent Reserve | Minimum 0.01 SOL always kept |
| ✅ Program Validation | Only allows Pump.fun/PumpSwap CPI |
| ✅ Lock Periods | Funds can be locked for trust |

## 📋 Trading Strategies

| Strategy | ID | Description |
|----------|:--:|-------------|
| VolumeBot | 0 | Generates trading volume |
| PriceReactive | 1 | Reacts to price movements |
| GridTrading | 2 | Grid-based buy/sell orders |
| TrendFollower | 3 | Follows market trends |
| SpreadMM | 4 | Traditional market making |
| PumpHunter | 5 | Targets pumping tokens |

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     MM Wallet System                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  User Wallet                                                │
│       │                                                     │
│       ▼                                                     │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
│  │  MM Wallet  │───▶│  PDA Wallet │───▶│  Pump.fun   │     │
│  │  (Config)   │    │   (SOL)     │    │ / PumpSwap  │     │
│  └─────────────┘    └─────────────┘    └─────────────┘     │
│       │                    │                                │
│       │               Tokens ◀──────────────────────────────│
│       │                    │                                │
│       └────── Operator ────┘                                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## 📦 Instructions (15 total)

### Initialization
- `initialize` - Create new MM wallet

### Deposits & Withdrawals
- `deposit` - Deposit SOL to PDA
- `withdraw` - Withdraw SOL (owner only, after lock)
- `withdrawTokens` - Withdraw tokens (owner only, after lock)

### Trading
- `executeBuy` - Buy on Pump.fun bonding curve
- `executeSell` - Sell on Pump.fun bonding curve
- `executeSwap` - Swap on PumpSwap AMM

### Token Management
- `createToken` - Create token with PDA as creator
- `setTokenMint` - Set token mint after creation
- `claimFees` - Claim creator fees

### Configuration
- `updateStrategy` - Change trading strategy
- `setOperator` - Update authorized operator
- `pause` - Pause trading
- `resume` - Resume trading
- `extendLock` - Extend lock period

## 🔧 Build

```bash
# Install dependencies
cargo install anchor-cli

# Build
anchor build

# Deploy (mainnet)
solana program deploy target/deploy/mm_wallet_v2.so \
  --program-id target/deploy/mm_wallet_v2-keypair.json \
  --url mainnet-beta
```

## 📝 Usage Example

```javascript
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";

// Derive PDA
const [mmWallet] = PublicKey.findProgramAddressSync(
  [Buffer.from("mm_wallet"), wallet.publicKey.toBuffer(), new BN(0).toArrayLike(Buffer, "le", 8)],
  programId
);

// Initialize wallet
await program.methods
  .initialize(
    new BN(0),           // nonce
    new BN(86400),       // lock 1 day
    { volumeBot: {} },   // strategy
    {
      tradeSizePct: 10,
      minDelaySecs: 5,
      maxDelaySecs: 30,
      slippageBps: 300,  // 3%
      param1: 0,
      param2: 0,
      param3: 0,
      reserved: new Array(32).fill(0)
    },
    operatorPubkey
  )
  .accounts({
    mmWallet,
    pdaWallet: mmWallet,
    owner: wallet.publicKey,
    systemProgram: SystemProgram.programId,
  })
  .rpc();
```

## 🔗 Integrations

| Program | ID | Usage |
|---------|-----|-------|
| **Pump.fun** | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | Token creation, bonding curve |
| **PumpSwap** | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | AMM swaps 

## ⚙️ Configuration Limits

| Parameter | Min | Max | Description |
|-----------|-----|-----|-------------|
| `tradeSizePct` | 1 | 50 | Max % of balance per trade |
| `slippageBps` | 10 | 5000 | 0.1% to 50% slippage |
| `lockSeconds` | 0 | 31,536,000 | Up to 1 year |
| Total Lock | - | 157,680,000 | Max 5 years cumulative |

## 📄 License

MIT License - See [LICENSE](LICENSE)

## 🔗 Links

- **Whistle Network**: [whistle.ninja](https://whistle.ninja)
- **Main Repo**: [github.com/DylanPort/whistle](https://github.com/DylanPort/whistle)

