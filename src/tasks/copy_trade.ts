/**
 * copy_trade — called by watch_wallets
 *
 * Looks up the market via Gamma API, places a matching CLOB order,
 * and updates position/trade/budget collections.
 */
import type { TaskContext } from "compose";
import { getClobClient, executeTrade } from "../lib/clob";
import { lookupMarketByTokenId } from "../lib/gamma";
import type {
  CopyTradeParams,
  Position,
  Trade,
  Budget,
} from "../lib/types";

export async function main(ctx: TaskContext, params: CopyTradeParams) {
  const { tokenId, side, whalePrice, eventTxHash } = params;

  // 1. Check budget
  const budget = (await ctx.collection<Budget>("budget").findOne({
    key: "global",
  })) as Budget | null;
  const tradeAmount = parseFloat(ctx.env.TRADE_AMOUNT_USD || "50");

  if (budget && budget.remaining < tradeAmount) {
    ctx.logEvent({ code: "BUDGET_EXHAUSTED", message: "Skipping trade" });
    return;
  }

  // 2. Look up market via Gamma API
  const market = await lookupMarketByTokenId(
    ctx.fetch,
    ctx.env.GAMMA_HOST || "https://gamma-api.polymarket.com",
    tokenId
  );

  if (!market) {
    ctx.logEvent({
      code: "MARKET_NOT_FOUND",
      message: `No market found for token ${tokenId}`,
    });
    return;
  }

  if (!market.enableOrderBook) {
    ctx.logEvent({
      code: "MARKET_CLOSED",
      message: `Order book disabled for ${market.question}`,
    });
    return;
  }

  // 3. For sells, check we actually hold a position
  if (side === "SELL") {
    const position = (await ctx.collection<Position>("positions").findOne({
      tokenId,
      status: "open",
    })) as Position | null;

    if (!position || position.size <= 0) {
      ctx.logEvent({
        code: "NO_POSITION",
        message: `No open position to sell for ${tokenId}`,
      });
      return;
    }
  }

  // 4. Execute CLOB trade
  const client = await getClobClient(
    ctx.env.PRIVATE_KEY,
    ctx.env.CLOB_HOST || "https://clob.polymarket.com"
  );

  const result = await executeTrade(
    client,
    tokenId,
    side,
    side === "BUY" ? tradeAmount : 0, // sell uses position size inside executeTrade
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

  // 5. Update positions collection
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
  } else {
    // Sell: close position
    if (existingPos) {
      await ctx.collection<Position>("positions").setById(existingPos.id, {
        ...existingPos,
        size: 0,
        status: "open", // keep open for potential re-entry
      });
    }
  }

  // 6. Record trade
  await ctx.collection<Trade>("trades").insertOne({
    id: `${eventTxHash}-${tokenId}-${Date.now()}`,
    tokenId,
    side,
    amount: tradeAmount,
    price: whalePrice,
    whalePrice,
    slippage: 0, // TODO: compute actual fill price vs whale price
    orderId: result.orderId,
    eventTxHash,
    timestamp: new Date().toISOString(),
  });

  // 7. Update budget
  if (side === "BUY") {
    const maxBudget = parseFloat(ctx.env.MAX_BUDGET_USD || "1000");
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
  }
}
