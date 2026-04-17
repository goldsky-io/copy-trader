# Polymarket CTF Events Pipeline

Standalone Turbo pipeline that indexes Polymarket trade events on Polygon.

## Events Indexed

- **OrderFilled** — from CTF Exchange (`0x4bFb...982E`). Every matched trade with maker, taker, asset IDs, amounts, and fees.
- **ConditionResolution** — from ConditionalTokens (`0x4D97...6045`). Market resolution events with condition ID and payout numerators.

## Deploy

```bash
# Create Postgres secret
goldsky secret create POSTGRES_SECRET --value "postgresql://user:pass@host:5432/db"

# Validate config
goldsky turbo validate polymarket-ctf-events.yaml

# Deploy
goldsky turbo apply polymarket-ctf-events.yaml
```

## Sink Tables

### `order_fills`

| Column | Type | Description |
|--------|------|-------------|
| id | VARCHAR | Unique event ID |
| block_number | BIGINT | Block number |
| log_index | INT | Log index within block |
| transaction_hash | VARCHAR | Transaction hash |
| block_timestamp | TIMESTAMP | Block timestamp |
| maker | VARCHAR | Maker address |
| taker | VARCHAR | Taker address |
| maker_asset_id | VARCHAR | Maker's asset (token ID or "0" for USDC) |
| taker_asset_id | VARCHAR | Taker's asset (token ID or "0" for USDC) |
| maker_amount | DOUBLE | Maker amount (USDC-scaled, divided by 1e6) |
| taker_amount | DOUBLE | Taker amount (USDC-scaled, divided by 1e6) |
| fee | DOUBLE | Fee amount (USDC-scaled) |

### `resolutions`

| Column | Type | Description |
|--------|------|-------------|
| id | VARCHAR | Unique event ID |
| block_number | BIGINT | Block number |
| log_index | INT | Log index within block |
| transaction_hash | VARCHAR | Transaction hash |
| block_timestamp | TIMESTAMP | Block timestamp |
| condition_id | VARCHAR | Condition ID (bytes32) |
