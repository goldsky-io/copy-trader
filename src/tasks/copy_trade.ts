/**
 * copy_trade — HTTP-triggered by Turbo pipeline webhook
 *
 * Receives a decoded OrderFilled event row from the pipeline.
 * Determines buy/sell side, looks up market via Gamma, places CLOB order.
 */
import type { TaskContext } from "compose";
import { getClobClient, executeTrade } from "../lib/clob";
import { lookupMarketByTokenId } from "../lib/gamma";
import type { OrderFillRow, Position, Trade, Budget } from "../lib/types";

export async function main(ctx: TaskContext, params?: Record<string, unknown>) {
  if (!params) {
    ctx.logEvent({ code: "NO_PARAMS", message: "No webhook payload" });
    return;
  }

  const row = params as unknown as OrderFillRow;

  // Parse the fill to determine side and token
  const { side, tokenId, whalePrice } = parseFill(row);
  if (!tokenId) {
    ctx.logEvent({ code: "SKIP", message: "Could not parse fill" });
    return;
  }

  const tradeAmount = parseFloat(ctx.env.TRADE_AMOUNT_USD || "50");

  // Check budget
  const budget = (await ctx.collection<Budget>("budget").findOne({
    key: "global",
  })) as Budget | null;
  const maxBudget = parseFloat(ctx.env.MAX_BUDGET_USD || "1000");

  if (side === "BUY" && budget && budget.remaining < tradeAmount) {
    ctx.logEvent({ code: "BUDGET_EXHAUSTED", message: "Skipping trade" });
    return;
  }

  // Look up market via Gamma
  const gammaHost = ctx.env.GAMMA_HOST || "https://gamma-api.polymarket.com";
  const market = await lookupMarketByTokenId(ctx.fetch, gammaHost, tokenId);

  if (!market) {
    ctx.logEvent({
      code: "MARKET_NOT_FOUND",
      message: `No market for token ${tokenId}`,
    });
    return;
  }

  if (!market.enableOrderBook) {
    ctx.logEvent({
      code: "MARKET_CLOSED",
      message: `Order book disabled: ${market.question}`,
    });
    return;
  }

  // For sells, check we hold a position
  if (side === "SELL") {
    const position = (await ctx.collection<Position>("positions").findOne({
      tokenId,
      status: "open",
    })) as Position | null;

    if (!position || position.size <= 0) {
      ctx.logEvent({
        code: "NO_POSITION",
        message: `No position to sell for ${tokenId}`,
      });
      return;
    }
  }

  // Execute CLOB trade
  const client = await getClobClient(
    ctx.env.PRIVATE_KEY,
    ctx.env.CLOB_HOST || "https://clob.polymarket.com"
  );

  const result = await executeTrade(
    client,
    tokenId,
    side,
    tradeAmount,
    market.tickSize,
    market.negRisk
  );

  if (!result.success) {
    ctx.logEvent({
      code: "TRADE_FAILED",
      message: `${side} failed: ${result.error}`,
      data: { tokenId, market: market.question },
    });
    return;
  }

  ctx.logEvent({
    code: "TRADE_EXECUTED",
    message: `${side} ${tokenId} — order ${result.orderId}`,
    data: { market: market.question, side, orderId: result.orderId },
  });

  // Update positions
  const existingPos = (await ctx.collection<Position>("positions").findOne({
    tokenId,
  })) as Position | null;

  if (side === "BUY") {
    const shares = tradeAmount / whalePrice;
    if (existingPos) {
      const newSize = existingPos.size + shares;
      const newAvg =
        (existingPos.avgPrice * existingPos.size + whalePrice * shares) /
        newSize;
      await ctx.collection<Position>("positions").setById(existingPos.id, {
        ...existingPos,
        size: newSize,
        avgPrice: newAvg,
      });
    } else {
      await ctx.collection<Position>("positions").insertOne({
        id: tokenId,
        tokenId,
        conditionId: market.conditionId,
        side: market.clobTokenIds[0] === tokenId ? "YES" : "NO",
        size: shares,
        avgPrice: whalePrice,
        status: "open",
      });
    }

    // Decrement budget
    const currentBudget = budget || {
      key: "global",
      remaining: maxBudget,
      totalSpent: 0,
    };
    await ctx.collection<Budget>("budget").setById("global", {
      key: "global",
      remaining: currentBudget.remaining - tradeAmount,
      totalSpent: currentBudget.totalSpent + tradeAmount,
    });
  } else {
    // Sell: zero out position
    if (existingPos) {
      await ctx.collection<Position>("positions").setById(existingPos.id, {
        ...existingPos,
        size: 0,
      });
    }
  }

  // Record trade
  await ctx.collection<Trade>("trades").insertOne({
    id: `${row.transaction_hash}-${tokenId}-${Date.now()}`,
    tokenId,
    side,
    amount: tradeAmount,
    price: whalePrice,
    whalePrice,
    slippage: 0,
    orderId: result.orderId,
    eventTxHash: row.transaction_hash,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Parse an OrderFilled webhook payload to determine trade direction.
 *
 * maker_asset_id/taker_asset_id: "0" means USDC (collateral).
 * If a wallet is giving USDC, they're buying shares.
 * If a wallet is giving shares, they're selling.
 */
function parseFill(row: OrderFillRow): {
  side: "BUY" | "SELL";
  tokenId: string;
  whalePrice: number;
} {
  // The pipeline already filtered to watched wallets, so one of maker/taker
  // is a watched wallet. We just need to figure out the direction.

  // Check maker side first
  if (row.maker_asset_id === "0") {
    // Maker giving USDC → maker is BUYING shares
    const tokenId = row.taker_asset_id;
    const price = row.maker_amount > 0 ? row.taker_amount / row.maker_amount : 0;
    return { side: "BUY", tokenId, whalePrice: price };
  } else if (row.taker_asset_id === "0") {
    // Taker giving USDC → taker is BUYING, maker is SELLING
    const tokenId = row.maker_asset_id;
    const price = row.taker_amount > 0 ? row.maker_amount / row.taker_amount : 0;
    return { side: "SELL", tokenId, whalePrice: price };
  }

  // Neither side is USDC — share-for-share swap (unlikely, skip)
  return { side: "BUY", tokenId: "", whalePrice: 0 };
}
