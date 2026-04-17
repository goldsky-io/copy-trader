# bot-composer

Polymarket whale copy-trading bot powered by Goldsky Compose + Turbo.

Watch any wallet on Polymarket. When they trade, you trade. Automatically.

## How It Works

1. **Turbo pipeline** indexes Polymarket trade events on Polygon into Postgres
2. **Compose app** polls for new trades from your watched wallets every 5 seconds
3. When a watched wallet buys or sells, the bot places a matching order via Polymarket's CLOB API
4. When markets resolve, winning shares are auto-redeemed on-chain

## Prerequisites

- [Goldsky CLI](https://docs.goldsky.com/get-started) installed and authenticated
- A Polymarket account with USDC deposited
- Your wallet's private key (the EOA behind your Polymarket proxy wallet)
- A Postgres database (or use Goldsky-managed sinks)

## Setup

### 1. Deploy the Turbo Pipeline

```bash
# Create a Postgres secret for the pipeline sink
goldsky secret create POSTGRES_SECRET --value "postgresql://user:pass@host:5432/db"

# Deploy the pipeline
goldsky turbo apply pipeline/polymarket-ctf-events.yaml
```

This indexes all Polymarket `OrderFilled` and `ConditionResolution` events on Polygon.

### 2. Approve USDC (one-time)

Your Polymarket proxy wallet needs USDC approval for the CTF Exchange contracts. If you've traded on Polymarket before, this is likely already done. If not, approve via Polygonscan or your wallet:

- Approve `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` (CTF Exchange)
- Approve `0xC5d563A36AE78145C45a50134d48A1215220f80a` (NegRisk Exchange)
- Approve `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` (ConditionalTokens — for redemption)

### 3. Install Dependencies

```bash
npm install
```

### 4. Configure and Deploy

```bash
# Set secrets
goldsky compose secret set PRIVATE_KEY --value "0x..."
goldsky compose secret set POSTGRES_URL --value "postgresql://..."

# Deploy (edit compose.yaml env vars first)
goldsky compose deploy
```

### 5. Configure Watched Wallets

Edit `compose.yaml` and set the `COPY_WALLETS` env var to a comma-separated list of wallet addresses you want to copy:

```yaml
env:
  cloud:
    COPY_WALLETS: "0xWhaleAddress1,0xWhaleAddress2"
    TRADE_AMOUNT_USD: "50"
    MAX_BUDGET_USD: "1000"
```

## Finding Whale Wallets

- [Polymarket Leaderboard](https://polymarket.com/leaderboard) — top traders by profit
- [Polygonscan](https://polygonscan.com/token/0x4D97DCd97eC945f40cF65F87097ACe5EA0476045) — browse ConditionalTokens holders
- Twitter/X — prominent traders often share their Polymarket profiles

## Architecture

```
Polygon (on-chain)
  │
  ├─ CTF Exchange: OrderFilled events
  └─ ConditionalTokens: ConditionResolution events
  │
  ▼
Turbo Pipeline (polymarket-ctf-events)
  │ decodes + filters events → Postgres
  ▼
Compose App (bot-composer)
  ├─ watch_wallets (cron 5s) — polls Postgres, detects whale trades
  ├─ copy_trade (called) — places matching CLOB order
  └─ redeem (cron 5min) — auto-redeems resolved positions
```

## Configuration

| Env Var | Description | Default |
|---------|-------------|---------|
| `COPY_WALLETS` | Comma-separated wallet addresses to copy | Required |
| `TRADE_AMOUNT_USD` | Fixed USD amount per trade | `50` |
| `MAX_BUDGET_USD` | Total budget cap | `1000` |
| `CLOB_HOST` | Polymarket CLOB API | `https://clob.polymarket.com` |
| `GAMMA_HOST` | Polymarket Gamma API | `https://gamma-api.polymarket.com` |

## Safety

- **Budget cap** — stops all trading when `MAX_BUDGET_USD` is exhausted
- **Dedup** — cursor-based event tracking prevents double-trades
- **Fail-safe** — CLOB failures are logged and skipped, never retried into a moved market
- **$1 minimum** — enforces Polymarket's minimum order size
