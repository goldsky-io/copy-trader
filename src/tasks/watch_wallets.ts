/**
 * watch_wallets — cron task (every 5s)
 *
 * Polls the Turbo pipeline's Postgres sink for new OrderFilled events
 * from watched wallets. Calls copy_trade for each new fill.
 */
import type { TaskContext } from "compose";
import pg from "pg";
import type { OrderFillRow, Cursor, Budget, CopyTradeParams } from "../lib/types";

export async function main(ctx: TaskContext) {
  const wallets = (ctx.env.COPY_WALLETS || "")
    .split(",")
    .map((w: string) => w.trim().toLowerCase())
    .filter(Boolean);

  if (!wallets.length) {
    ctx.logEvent({ code: "NO_WALLETS", message: "No wallets configured" });
    return;
  }

  // Check budget
  const budget = (await ctx.collection<Budget>("budget").findOne({
    key: "global",
  })) as Budget | null;
  if (budget && budget.remaining <= 0) {
    ctx.logEvent({ code: "BUDGET_EXHAUSTED", message: "Max budget reached" });
    return;
  }

  // Get cursor
  const cursor = (await ctx.collection<Cursor>("cursor").findOne({
    key: "order_fills",
  })) as Cursor | null;
  const lastBlock = cursor?.block_number ?? 0;
  const lastLog = cursor?.log_index ?? 0;

  // Query pipeline sink for new fills from watched wallets
  const client = new pg.Client(ctx.env.POSTGRES_URL);
  try {
    await client.connect();
    const { rows } = await client.query<OrderFillRow>(
      `SELECT * FROM order_fills
       WHERE (block_number, log_index) > ($1, $2)
         AND (LOWER(maker) = ANY($3) OR LOWER(taker) = ANY($3))
       ORDER BY block_number, log_index
       LIMIT 50`,
      [lastBlock, lastLog, wallets]
    );

    if (!rows.length) return;

    const tradeAmount = parseFloat(ctx.env.TRADE_AMOUNT_USD || "50");
    const seen = new Set<string>(); // dedup across wallets for same market

    for (const row of rows) {
      const { side, tokenId, whalePrice } = parseFill(row, wallets);
      if (!tokenId) continue;

      // Dedup: skip if we already saw this token in this batch
      const dedupeKey = `${tokenId}-${side}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      // Check budget before each trade
      const currentBudget = (await ctx.collection<Budget>("budget").findOne({
        key: "global",
      })) as Budget | null;
      if (currentBudget && currentBudget.remaining < tradeAmount) {
        ctx.logEvent({
          code: "BUDGET_LOW",
          message: `Budget ${currentBudget.remaining} < trade amount ${tradeAmount}`,
        });
        break;
      }

      const params: CopyTradeParams = {
        tokenId,
        side,
        whalePrice,
        eventTxHash: row.transaction_hash,
      };

      ctx.logEvent({
        code: "COPY_DETECTED",
        message: `Whale ${side} on ${tokenId} at ${whalePrice.toFixed(4)}`,
        data: params,
      });

      await ctx.callTask("copy_trade", params);

      // Advance cursor after each successful trade
      await ctx.collection<Cursor>("cursor").setById("order_fills", {
        key: "order_fills",
        block_number: row.block_number,
        log_index: row.log_index,
      });
    }
  } finally {
    await client.end();
  }
}

/**
 * Parse an OrderFilled row to determine:
 * - Whether a watched wallet was buying or selling
 * - Which token ID to trade
 * - What price the whale got
 *
 * In Polymarket's CTF Exchange, an OrderFilled has maker and taker.
 * The maker_asset_id/taker_asset_id tell us which side is shares vs USDC.
 * A "0" asset ID represents USDC (collateral).
 */
function parseFill(
  row: OrderFillRow,
  wallets: string[]
): { side: "BUY" | "SELL"; tokenId: string; whalePrice: number } {
  const makerIsWatched = wallets.includes(row.maker.toLowerCase());
  const takerIsWatched = wallets.includes(row.taker.toLowerCase());

  if (!makerIsWatched && !takerIsWatched) {
    return { side: "BUY", tokenId: "", whalePrice: 0 };
  }

  // Determine which side the whale is on and what they're trading
  // maker_asset_id = what the maker is giving away
  // taker_asset_id = what the taker is giving away
  // If the watched wallet is the maker giving away USDC (asset 0), they're buying shares
  // If the watched wallet is the maker giving away shares (non-0), they're selling shares

  if (makerIsWatched) {
    // Maker is our whale
    if (row.maker_asset_id === "0") {
      // Whale (maker) is giving USDC, receiving shares → whale is BUYING
      const tokenId = row.taker_asset_id;
      const price =
        row.maker_amount > 0 ? row.taker_amount / row.maker_amount : 0;
      return { side: "BUY", tokenId, whalePrice: price };
    } else {
      // Whale (maker) is giving shares, receiving USDC → whale is SELLING
      const tokenId = row.maker_asset_id;
      const price =
        row.maker_amount > 0 ? row.taker_amount / row.maker_amount : 0;
      return { side: "SELL", tokenId, whalePrice: price };
    }
  } else {
    // Taker is our whale
    if (row.taker_asset_id === "0") {
      // Whale (taker) is giving USDC, receiving shares → whale is BUYING
      const tokenId = row.maker_asset_id;
      const price =
        row.taker_amount > 0 ? row.maker_amount / row.taker_amount : 0;
      return { side: "BUY", tokenId, whalePrice: price };
    } else {
      // Whale (taker) is giving shares, receiving USDC → whale is SELLING
      const tokenId = row.taker_asset_id;
      const price =
        row.taker_amount > 0 ? row.maker_amount / row.taker_amount : 0;
      return { side: "SELL", tokenId, whalePrice: price };
    }
  }
}
