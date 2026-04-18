/**
 * copy_trade — HTTP-triggered by Turbo pipeline webhook
 *
 * Receives a decoded OrderFilled event row from the pipeline.
 * Determines buy/sell side, looks up market via Gamma, places CLOB order.
 */
import type { TaskContext } from "compose";
import { executeTrade } from "../lib/clob";
import { lookupMarketByTokenId } from "../lib/gamma";
import type { OrderFillRow, Position, Trade, Budget } from "../lib/types";

export async function main(ctx: TaskContext, params?: Record<string, unknown>) {
  console.log("[copy_trade] invoked with params:", JSON.stringify(params));
  if (!params) {
    return { status: "NO_PARAMS" };
  }

  const row = params as unknown as OrderFillRow;

  // Build watched wallet set from env (comma-separated)
  const watchedWallets = new Set(
    (ctx.env.WATCHED_WALLETS || "")
      .split(",")
      .map((w: string) => w.trim().toLowerCase())
      .filter(Boolean)
  );

  // Parse the fill to determine side and token
  const { side, tokenId, whalePrice } = parseFill(row, watchedWallets);
  console.log(`[copy_trade] parsed: side=${side} tokenId=${tokenId.slice(0,15)}... price=${whalePrice}`);
  if (!tokenId) {
    return { status: "SKIP_NO_TOKEN" };
  }

  const tradeAmount = parseFloat(ctx.env.TRADE_AMOUNT_USD || "50");

  // Resolve collections once (ctx.collection returns a Promise)
  const budgetCollection = await ctx.collection<Budget>("budget");
  const positionsCollection = await ctx.collection<Position>("positions");
  const tradesCollection = await ctx.collection<Trade>("trades");

  // Check budget
  const budget = (await budgetCollection.findOne({
    key: "global",
  })) as Budget | null;
  const maxBudget = parseFloat(ctx.env.MAX_BUDGET_USD || "1000");

  if (side === "BUY" && budget && budget.remaining < tradeAmount) {
    console.log(`[copy_trade] BUDGET_EXHAUSTED: remaining=${budget.remaining} need=${tradeAmount}`);
    return { status: "BUDGET_EXHAUSTED" };
  }

  // Look up market via Gamma
  const gammaHost = ctx.env.GAMMA_HOST || "https://gamma-api.polymarket.com";
  const market = await lookupMarketByTokenId(ctx.fetch, gammaHost, tokenId);

  if (!market) {
    console.log(`[copy_trade] MARKET_NOT_FOUND token=${tokenId.slice(0,15)}...`);
    return { status: "MARKET_NOT_FOUND", tokenId };
  }

  if (!market.enableOrderBook) {
    console.log(`[copy_trade] MARKET_CLOSED: ${market.question}`);
    return { status: "MARKET_CLOSED", market: market.question };
  }

  // For sells, check we hold a position
  if (side === "SELL") {
    const position = (await positionsCollection.findOne({
      tokenId,
      status: "open",
    })) as Position | null;

    if (!position || position.size <= 0) {
      console.log(`[copy_trade] NO_POSITION to sell for ${tokenId.slice(0,15)}...`);
      return { status: "NO_POSITION" };
    }
  }

  // Execute CLOB trade via proxy
  const result = await executeTrade(
    ctx,
    ctx.env.PRIVATE_KEY,
    ctx.env.CLOB_HOST || "https://fly-polymarket-proxy.fly.dev",
    tokenId,
    side,
    tradeAmount,
    whalePrice,
    market.tickSize,
    market.negRisk,
    market.feeRateBps
  );

  if (!result.success) {
    console.log(`[copy_trade] TRADE_FAILED: ${side} ${market.question} — ${result.error}`);
    return { status: "TRADE_FAILED", error: result.error, market: market.question };
  }

  console.log(`[copy_trade] TRADE_EXECUTED: ${side} ${market.question} — order ${result.orderId}`);

  // Update positions
  const existingPos = (await positionsCollection.findOne({
    tokenId,
  })) as Position | null;

  if (side === "BUY") {
    const shares = tradeAmount / whalePrice;
    if (existingPos) {
      const newSize = existingPos.size + shares;
      const newAvg =
        (existingPos.avgPrice * existingPos.size + whalePrice * shares) /
        newSize;
      await positionsCollection.setById(existingPos.id, {
        ...existingPos,
        size: newSize,
        avgPrice: newAvg,
      });
    } else {
      await positionsCollection.insertOne({
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
    await budgetCollection.setById("global", {
      key: "global",
      remaining: currentBudget.remaining - tradeAmount,
      totalSpent: currentBudget.totalSpent + tradeAmount,
    });
  } else {
    // Sell: zero out position
    if (existingPos) {
      await positionsCollection.setById(existingPos.id, {
        ...existingPos,
        size: 0,
      });
    }
  }

  // Record trade
  await tradesCollection.insertOne({
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

  return {
    status: "TRADE_EXECUTED",
    side,
    market: market.question,
    orderId: result.orderId,
  };
}

/**
 * Parse an OrderFilled webhook payload to determine trade direction.
 *
 * CTF Exchange OrderFilled:
 *   maker gives makerAsset of makerAmountFilled
 *   taker gives takerAsset of takerAmountFilled
 *   asset_id "0" = USDC (collateral), anything else = CTF share token
 *
 * The side we care about (BUY vs SELL) is the action the WATCHED WALLET is taking.
 * The pipeline filters to trades where maker OR taker is a watched wallet.
 *
 * Price = USDC amount / shares amount (always in [0,1] for valid fills).
 */
function parseFill(
  row: OrderFillRow,
  watchedWallets: Set<string>
): { side: "BUY" | "SELL"; tokenId: string; whalePrice: number } {
  const makerIsWhale = watchedWallets.has(row.maker.toLowerCase());
  const takerIsWhale = watchedWallets.has(row.taker.toLowerCase());

  // Figure out which side is USDC and which is shares
  const makerIsUsdc = row.maker_asset_id === "0";
  const takerIsUsdc = row.taker_asset_id === "0";

  if (!makerIsUsdc && !takerIsUsdc) {
    // Share-for-share swap, shouldn't happen in normal flow
    return { side: "BUY", tokenId: "", whalePrice: 0 };
  }

  // Identify share token and its amount, plus the USDC amount
  const shareTokenId = makerIsUsdc ? row.taker_asset_id : row.maker_asset_id;
  const sharesAmount = makerIsUsdc ? row.taker_amount : row.maker_amount;
  const usdcAmount = makerIsUsdc ? row.maker_amount : row.taker_amount;
  const price = sharesAmount > 0 ? usdcAmount / sharesAmount : 0;

  // Whoever gives USDC is buying shares. Determine if watched wallet is the buyer.
  const usdcGiver = makerIsUsdc ? "maker" : "taker";
  const whaleIsUsdcGiver =
    (usdcGiver === "maker" && makerIsWhale) ||
    (usdcGiver === "taker" && takerIsWhale);

  return {
    side: whaleIsUsdcGiver ? "BUY" : "SELL",
    tokenId: shareTokenId,
    whalePrice: price,
  };
}
