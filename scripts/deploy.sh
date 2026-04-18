#!/usr/bin/env bash
# End-to-end deploy for copy-trader.
# Run from the repo root: ./scripts/deploy.sh

set -euo pipefail

APP_NAME=$(grep '^name:' compose.yaml | head -1 | awk -F'"' '{print $2}')

echo "→ Deploying Compose app '$APP_NAME'..."
goldsky compose deploy

echo ""
echo "→ Checking COMPOSE_WEBHOOK_AUTH secret..."
if ! goldsky secret list 2>/dev/null | grep -q "COMPOSE_WEBHOOK_AUTH"; then
  echo "  Secret missing. Create it:"
  echo ""
  echo "  goldsky secret create --name COMPOSE_WEBHOOK_AUTH \\"
  echo "    --value '{\"type\": \"httpauth\", \"secretKey\": \"Authorization\", \"secretValue\": \"Bearer YOUR_COMPOSE_API_TOKEN\"}'"
  echo ""
  exit 1
else
  echo "  ✓ COMPOSE_WEBHOOK_AUTH exists"
fi

echo ""
echo "→ Applying Turbo pipeline..."
goldsky turbo apply pipeline/polymarket-ctf-events.yaml

echo ""
echo "→ Waiting for Compose app to be healthy..."
until goldsky compose status -n "$APP_NAME" --json 2>&1 | grep -q "RUNNING"; do
  sleep 5
done
echo "  ✓ RUNNING"

echo ""
echo "→ Done. Next steps:"
echo "  1. Fund the wallet with USDC.e on Polygon"
echo "  2. Run setup_approvals (once wallet is funded):"
echo "     curl -X POST -H 'Authorization: Bearer \$COMPOSE_TOKEN' \\"
echo "       https://api.goldsky.com/api/admin/compose/v1/$APP_NAME/tasks/setup_approvals"
echo "  3. Check status:"
echo "     curl -sS -X POST -H 'Authorization: Bearer \$COMPOSE_TOKEN' \\"
echo "       https://api.goldsky.com/api/admin/compose/v1/$APP_NAME/tasks/status | jq"
