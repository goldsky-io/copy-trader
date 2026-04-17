# Polymarket CTF Events Pipeline

Turbo pipeline that watches Polymarket trades for specific wallets and fires a webhook on each fill.

## How It Works

1. Indexes all `OrderFilled` events from the CTF Exchange on Polygon
2. Filters to rows where maker or taker is in your watched wallet list
3. Sends each matching fill as a POST to your Compose app's `copy_trade` endpoint

## Setup

### 1. Configure Watched Wallets

Edit `polymarket-ctf-events.yaml` — find the `watched_fills` transform and replace the placeholder addresses:

```sql
WHERE maker IN ('0xYourWhale1', '0xYourWhale2')
   OR taker IN ('0xYourWhale1', '0xYourWhale2')
```

### 2. Configure Webhook URL

Update the `copy_trade_webhook` sink URL to point at your Compose app:

```yaml
url: https://YOUR_COMPOSE_APP_URL/tasks/copy_trade
```

### 3. Create Auth Secret

```bash
goldsky secret create COMPOSE_AUTH --type httpauth \
  --header "Authorization" --value "Bearer YOUR_COMPOSE_API_TOKEN"
```

### 4. Deploy

```bash
goldsky turbo validate polymarket-ctf-events.yaml
goldsky turbo apply polymarket-ctf-events.yaml
```

## Webhook Payload

Each POST contains a single `OrderFilled` row:

```json
{
  "id": "...",
  "block_number": 12345678,
  "log_index": 42,
  "transaction_hash": "0x...",
  "block_timestamp": "2026-04-16T12:00:00Z",
  "maker": "0x...",
  "taker": "0x...",
  "maker_asset_id": "12345...",
  "taker_asset_id": "0",
  "maker_amount": 100.5,
  "taker_amount": 50.25,
  "fee": 0.5
}
```
