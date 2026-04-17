# bot-composer

Polymarket whale copy-trading bot powered by Goldsky Compose + Turbo.

Watch any wallet on Polymarket. When they trade, you trade. Automatically.

## How It Works

1. **Turbo pipeline** indexes Polymarket OrderFilled events on Polygon, filtered to your watched wallets
2. **Webhook sink** fires each matching fill directly to the Compose app's `copy_trade` task
3. `copy_trade` looks up the market, places a matching CLOB order, updates position/budget
4. `redeem` task (cron) auto-redeems winning shares when markets resolve

No polling. No database in the middle. Pipeline detects the trade → webhook fires → bot copies.

## Prerequisites

- [Goldsky CLI](https://docs.goldsky.com/get-started) installed and authenticated
- A Polymarket account with USDC deposited
- Your wallet's private key (the EOA behind your Polymarket proxy wallet)

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Watched Wallets

Edit `pipeline/polymarket-ctf-events.yaml` and replace the placeholder addresses in the `watched_fills` transform with the wallets you want to copy:

```sql
WHERE maker IN ('0xYourWhale1', '0xYourWhale2')
   OR taker IN ('0xYourWhale1', '0xYourWhale2')
```

### 3. Deploy the Compose App

```bash
# Set secrets
goldsky compose secret set PRIVATE_KEY --value "0x..."

# Edit compose.yaml env vars (TRADE_AMOUNT_USD, MAX_BUDGET_USD)
# Then deploy
goldsky compose deploy
```

Note your Compose app URL — you'll need it for the pipeline webhook.

### 4. Deploy the Turbo Pipeline

```bash
# Create auth secret for the webhook (your Compose API token)
goldsky secret create COMPOSE_AUTH --type httpauth \
  --header "Authorization" --value "Bearer YOUR_COMPOSE_API_TOKEN"

# Update the webhook URL in pipeline/polymarket-ctf-events.yaml
# Then deploy
goldsky turbo apply pipeline/polymarket-ctf-events.yaml
```

### 5. Approve USDC (one-time)

If you haven't traded on Polymarket before, approve USDC for:
- `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` (CTF Exchange)
- `0xC5d563A36AE78145C45a50134d48A1215220f80a` (NegRisk Exchange)
- `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` (ConditionalTokens — for redemption)

## Architecture

```
Polygon (on-chain)
  │
  └─ CTF Exchange: OrderFilled events
     │
     ▼
Turbo Pipeline
  │ decode → filter to watched wallets → webhook
  ▼
Compose App
  ├─ copy_trade (HTTP) — Gamma lookup → CLOB FAK order → update collections
  └─ redeem (cron 5min) — check Gamma for resolutions → redeem on-chain
```

## Configuration

| Env Var | Description | Default |
|---------|-------------|---------|
| `TRADE_AMOUNT_USD` | Fixed USD amount per copy trade | `50` |
| `MAX_BUDGET_USD` | Total budget cap | `1000` |
| `CLOB_HOST` | Polymarket CLOB API | `https://clob.polymarket.com` |
| `GAMMA_HOST` | Polymarket Gamma API | `https://gamma-api.polymarket.com` |

## Finding Whale Wallets

- [Polymarket Leaderboard](https://polymarket.com/leaderboard) — top traders by profit
- [Polygonscan](https://polygonscan.com/token/0x4D97DCd97eC945f40cF65F87097ACe5EA0476045) — browse ConditionalTokens holders

## Safety

- **Budget cap** — stops all trading when `MAX_BUDGET_USD` is exhausted
- **Fail-safe** — CLOB failures are logged and skipped, never retried
- **$1 minimum** — enforces Polymarket's minimum order size
