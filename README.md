# MM Wallet - Backend & Frontend

**Automated Market Making Platform for Pump.fun Tokens**

This is the complete backend and frontend application for the MM Wallet smart contract system. It provides a modern web interface for creating trustless PDA wallets, launching tokens, and running 24/7 automated market making strategies.

## 🌐 Live Demo

Connect your Phantom or Solflare wallet to get started.

---

## ✨ Features

### Frontend (`web/`)
- **Modern Dark UI** - Sleek, professional interface with glassmorphism effects
- **Wallet Integration** - Phantom, Solflare, Backpack, Coinbase, Trust Wallet
- **Real-time Updates** - Live balance, transaction counts, and bot status
- **Landing Page** - Public showcase of all trustless wallets and tokens

### Backend (`server.js` + `src/`)
- **Express.js API** - RESTful endpoints for all operations
- **WebSocket** - Real-time bot logs and status updates
- **SQLite Database** - Persistent storage for wallets, tokens, and bot stats
- **Persistent Bots** - 24/7 market making that survives server restarts

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        MM Wallet Platform                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐     │
│  │   Frontend   │────▶│   Backend    │────▶│   Contract   │     │
│  │  (index.html)│     │  (server.js) │     │  (On-chain)  │     │
│  └──────────────┘     └──────────────┘     └──────────────┘     │
│         │                    │                    │              │
│         │              ┌─────┴─────┐              │              │
│         │              │           │              │              │
│         ▼              ▼           ▼              ▼              │
│  ┌──────────────┐ ┌─────────┐ ┌─────────┐ ┌──────────────┐      │
│  │   Wallet     │ │ SQLite  │ │ WebSocket│ │  Pump.fun    │      │
│  │  Connection  │ │   DB    │ │  Server  │ │  / PumpSwap  │      │
│  └──────────────┘ └─────────┘ └─────────┘ └──────────────┘      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📁 Project Structure

```
pump-mm-direct/
├── server.js                 # Main Express server
├── package.json              # Dependencies
├── .env                      # Environment variables (create this)
├── web/
│   ├── index.html            # Main application UI
│   └── landing.html          # Public landing page
└── src/
    ├── constants.js          # Program IDs, RPC URLs
    ├── contract/
    │   └── index.js          # Smart contract interaction
    ├── mm/
    │   ├── persistent-bot-manager.js  # 24/7 bot management
    │   ├── market-maker.js   # Trading logic
    │   └── strategies/       # Trading strategies
    │       ├── volume-bot.js
    │       ├── price-reactive.js
    │       ├── grid-bot.js
    │       ├── trend-follower.js
    │       ├── spread-mm.js
    │       └── pump-hunter.js
    ├── trading/
    │   ├── bonding-curve.js  # Pump.fun trading
    │   ├── pumpswap.js       # PumpSwap AMM
    │   └── index.js          # Trade router
    ├── price/
    │   └── tracker.js        # Price monitoring
    └── utils/
        ├── pda.js            # PDA derivation
        └── token-discovery.js # Token detection
```

---

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Create a `.env` file:

```env
RPC_URL=https://api.mainnet-beta.solana.com
PORT=3333
OPERATOR_PRIVATE_KEY=  # Auto-generated on first run
```

### 3. Start Server

```bash
node server.js
```

### 4. Access Application

Open `http://localhost:3333` in your browser.

---

## 🔌 API Endpoints

### Wallet Operations
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/contract/wallets` | GET | Get user's trustless wallets |
| `/api/contract/wallets/:address` | GET | Get wallet details |
| `/api/contract/wallets/:address/balance` | GET | Get real-time balance |
| `/api/contract/create-wallet` | POST | Create new PDA wallet |

### Token Operations
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/contract/wallets/:address/create-token` | POST | Create token via PDA |
| `/api/contract/wallets/:address/tokens` | GET | Get wallet's tokens |

### Trading Operations
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/persistent-bots` | GET | Get all bot statuses |
| `/api/persistent-bots/start` | POST | Start persistent MM |
| `/api/persistent-bots/update-strategy` | POST | Update bot strategy |
| `/api/set-operator` | POST | Set operator for PDA |

### Landing Page
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/landing/tokens` | GET | All public tokens with data |
| `/api/landing/stats` | GET | Platform statistics |

---

## 🤖 Trading Strategies

| Strategy | Description | Best For |
|----------|-------------|----------|
| **VolumeBot** | Generates consistent trading volume | New tokens |
| **PriceReactive** | Responds to price movements | Volatile markets |
| **GridTrading** | Buy low, sell high in ranges | Sideways markets |
| **TrendFollower** | Follows momentum | Trending tokens |
| **SpreadMM** | Traditional market making | Established tokens |
| **PumpHunter** | Aggressive buying on pumps | High-risk plays |

---

## 🔐 Security

- **PDA Wallets** - Funds controlled by smart contract, not private keys
- **Operator Pattern** - Delegate trading without giving ownership
- **Lock Periods** - Lock funds for trust (up to 5 years)
- **On-chain Limits** - Max 50% per trade, slippage protection
- **Rate Limiting** - Prevents rapid trade abuse

---

## 📊 Database Schema

### Tables
- `contract_wallets` - PDA wallet records
- `tokens` - Created token metadata
- `persistent_bots` - Bot configurations
- `bot_logs` - Activity history

---

## 🔗 Smart Contract

**Program ID**: `4ZzKbBw9o1CuVgGVokLNWsgHy9Acnd4EzVH5N6nnbyf5`

See the [contract documentation](https://github.com/DylanPort/MM-Whistle) for full details.

---

## 🛠️ Development

### Requirements
- Node.js 18+
- npm or yarn

### Running in Development

```bash
# Watch mode with auto-restart
npm run dev

# Or with PM2
pm2 start ecosystem.config.cjs
```

---

## 📄 License

MIT License - See [LICENSE](LICENSE)

---

## 🔗 Links

- **Smart Contract**: [github.com/DylanPort/MM-Whistle](https://github.com/DylanPort/MM-Whistle)
- **Whistle Network**: [whistle.ninja](https://whistle.ninja)

