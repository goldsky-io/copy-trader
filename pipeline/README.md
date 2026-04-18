# Polymarket CTF Events Pipeline

Goldsky Turbo pipeline that watches Polymarket's CTF Exchange on Polygon for `OrderFilled` events from specified wallets and fires a webhook to the Compose app's `copy_trade` task.

## Flow

1. Source: `matic.raw_logs`, filtered to `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` (CTF Exchange)
2. Decode `OrderFilled` events (maker/taker are indexed on this contract)
3. Flatten into a tabular transform: `maker`, `taker`, asset IDs, amounts
4. Filter to the watched wallet list
5. Webhook sink: one POST per matching fill to the Compose `copy_trade` task

## Setup

### 1. Update watched wallets

Edit `polymarket-ctf-events.yaml` — the `watched_fills` transform has two IN lists (one for maker, one for taker). Both must include every wallet you want to watch.

### 2. Create the webhook auth secret

```bash
goldsky secret create --name COMPOSE_WEBHOOK_AUTH \
  --value '{"type": "httpauth", "secretKey": "Authorization", "secretValue": "Bearer YOUR_COMPOSE_API_TOKEN"}'
```

### 3. Update the webhook URL

In the sink definition, set `url` to match your Compose app's task endpoint:

```yaml
sinks:
  copy_trade_webhook:
    url: https://api.goldsky.com/api/admin/compose/v1/<your-app-name>/tasks/copy_trade
```

### 4. Deploy

```bash
goldsky turbo validate polymarket-ctf-events.yaml
goldsky turbo apply polymarket-ctf-events.yaml
```

## Webhook payload

Each POST body contains a single `OrderFilled` row (via `one_row_per_request: true`):

```json
{
  "id": "...",
  "block_number": 85660000,
  "log_index": 42,
  "transaction_hash": "0x...",
  "block_timestamp": "2026-04-17T20:25:00Z",
  "maker": "0x...",
  "taker": "0x...",
  "maker_asset_id": "123...",    // "0" = USDC, otherwise CTF share token ID
  "taker_asset_id": "0",
  "maker_amount": 1.0,             // already divided by 1e6
  "taker_amount": 0.55,
  "fee": 0
}
```

## Runtime requirements

`skip_on_error: true` on webhook sinks is supported by `streamling/releases/v6.27.0+` (ref: [streamling#662](https://github.com/goldsky-io/streamling/pull/662)). Older Turbo versions reject the field.

`OrderFilled` has three indexed params (`orderHash`, `maker`, `taker`). Getting the ABI wrong here drops every event silently — the decoder emits `InvalidData` for mismatched indexed/non-indexed layouts. The yaml in this folder is correct.
