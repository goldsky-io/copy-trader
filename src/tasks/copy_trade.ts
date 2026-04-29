/**
 * copy_trade — HTTP-triggered by Turbo pipeline webhook
 *
 * Receives a decoded OrderFilled event row from the pipeline.
 * Determines buy/sell side, looks up market via Gamma, places CLOB order.
 *
 * This task is the attempt log only. The CLOB's risk-delay queue makes
 * the synchronous /order response unreliable for fill outcome (most orders
 * come back status=delayed and resolve async 5–30s later). We record what
 * we tried; reconcile + pull_trades pull on-chain truth into positions and
 * trades collections.
 */
import type { TaskContext } from "compose";
import { privateKeyToAccount } from "viem/accounts";
import { executeTrade } from "../lib/clob";
import { lookupMarketByTokenId } from "../lib/gamma";
import { CONTRACTS } from "../lib/types";
import type { OrderFillRow, TradeAttempt } from "../lib/types";

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

  // Parse the fill to determine side, token, and the whale's USD notional.
  const { side, tokenId, whalePrice, whaleUsd } = parseFill(row, watchedWallets);
  console.log(`[copy_trade] parsed: side=${side} tokenId=${tokenId.slice(0,15)}... price=${whalePrice} whaleUsd=$${whaleUsd.toFixed(2)}`);
  if (!tokenId) {
    return { status: "SKIP_NO_TOKEN" };
  }

  // Dedup: a single whale order can fill against N counterparties in one tx,
  // emitting N OrderFilled events. Without this gate, every leg would spawn
  // its own copy_trade — N parallel BUYs (overspend) or N parallel SELLs
  // (race for the same shares, all but one fail with "balance is not enough").
  // First task to claim the (tx, token, side) tuple proceeds; the rest skip.
  //
  // The gate is the seen_fills INSERT itself, not the findOne. Compose's
  // `insertOne(doc, opts)` only enforces a unique PK when the id is passed via
  // opts — a bare `insertOne({id})` puts the value in the JSON body and gives
  // the row a random UUID PK, so two racing tasks both succeed. Passing
  // `{ id: dedupKey }` in opts makes the INSERT the atomic gate; the race
  // loser sees a unique-constraint throw and bails before placing a CLOB
  // order. Without this, the bot was placing duplicate orders for whale fills
  // with paired BUY/SELL OrderFilled events (FOU-797).
  const dedupKey = `${row.transaction_hash}-${tokenId}-${side}`;
  const seenFills = await ctx.collection<{ id: string }>("seen_fills");
  if (await seenFills.findOne({ id: dedupKey })) {
    console.log(`[copy_trade] SKIP_DUPLICATE_FILL ${dedupKey}`);
    return { status: "SKIP_DUPLICATE_FILL", dedupKey };
  }
  try {
    await seenFills.insertOne({ id: dedupKey }, { id: dedupKey });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      console.log(`[copy_trade] SKIP_DUPLICATE_FILL_RACE ${dedupKey}`);
      return { status: "SKIP_DUPLICATE_FILL", dedupKey };
    }
    throw err;
  }

  // Proportional sizing: scale the trade as a fraction of the whale's USD
  // notional, clamped to [market.minOrderSize, MAX_TRADE_USD]. The flat
  // TRADE_AMOUNT_USD is no longer the trade size; it's only retained as a
  // legacy fallback if WHALE_FRACTION is unset. Resolved after market lookup
  // because we need market.minOrderSize as the per-market floor.
  const whaleFraction = parseFloat(ctx.env.WHALE_FRACTION || "0.01");
  const maxTradeUsd = parseFloat(ctx.env.MAX_TRADE_USD || "25");
  const gammaHost = ctx.env.GAMMA_HOST || "https://gamma-api.polymarket.com";

  // Compute the bot's EOA once. The same address is used for the USDC
  // balance check (BUY) and the position lookup (SELL).
  const pk = ctx.env.PRIVATE_KEY as `0x${string}`;
  const address = privateKeyToAccount(
    pk.startsWith("0x") ? pk : (`0x${pk}` as `0x${string}`)
  ).address;

  // Kick off every independent network call in parallel. Gamma is always
  // needed; the balance check and position lookup are conditional on side.
  // Running them concurrently typically cuts the gating phase from ~3 RTTs
  // to ~1 RTT, which trims hundreds of milliseconds off the median fill.
  const gammaPromise = lookupMarketByTokenId(ctx.fetch, gammaHost, tokenId);
  const balancePromise =
    side === "BUY"
      ? (ctx.fetch("https://polygon-bor-rpc.publicnode.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "eth_call",
            params: [
              {
                to: CONTRACTS.pUsd,
                data:
                  "0x70a08231000000000000000000000000" +
                  address.slice(2).toLowerCase(),
              },
              "latest",
            ],
            id: 1,
          }),
        }) as Promise<{ result?: string }>)
      : Promise.resolve(null);
  // ?asset=tokenId returns just this token's position (≤1 entry), avoiding
  // the limit/sort truncation that previously dropped low-value losers.
  const positionPromise =
    side === "SELL"
      ? (ctx.fetch(
          `https://data-api.polymarket.com/positions?user=${address}&asset=${tokenId}&sizeThreshold=0`
        ) as Promise<Array<{ asset: string; size: number }>>)
      : Promise.resolve(null);

  // Resolve collections (cheap, local) while the network calls are in flight.
  // Note: positions are owned by the reconcile cron (on-chain truth). We only
  // write the attempt log here — what we tried, not what filled.
  const attemptsCollection = await ctx.collection<TradeAttempt>("trade_attempts");

  const [market, balResp, positions] = await Promise.all([
    gammaPromise,
    balancePromise,
    positionPromise,
  ]);

  if (!market) {
    console.log(`[copy_trade] MARKET_NOT_FOUND token=${tokenId.slice(0,15)}...`);
    return { status: "MARKET_NOT_FOUND", tokenId };
  }

  if (!market.enableOrderBook) {
    console.log(`[copy_trade] MARKET_CLOSED: ${market.question}`);
    return { status: "MARKET_CLOSED", market: market.question };
  }

  // Proportional sizing. Scale by the whale's USD notional on this fill,
  // floor at the market's own minimum so no fill is dropped just for being
  // too small, and cap at MAX_TRADE_USD to bound per-trade loss exposure.
  const tradeAmount = Math.min(
    Math.max(whaleUsd * whaleFraction, market.minOrderSize),
    maxTradeUsd
  );
  console.log(
    `[copy_trade] sizing: whaleUsd=$${whaleUsd.toFixed(2)} × ${whaleFraction} → $${tradeAmount.toFixed(2)} (floor=$${market.minOrderSize}, cap=$${maxTradeUsd})`
  );

  // Budget check: read pUSD balance on-chain (source of truth, V2 collateral).
  // We need at least the trade amount plus a small buffer for fees.
  if (side === "BUY") {
    const pUsdBalance = balResp?.result
      ? Number(BigInt(balResp.result)) / 1e6
      : 0;
    const needed = tradeAmount * 1.05;
    if (pUsdBalance < needed) {
      console.log(
        `[copy_trade] BALANCE_LOW: $${pUsdBalance.toFixed(2)} pUSD (need >=$${needed.toFixed(2)})`
      );
      return { status: "BALANCE_LOW", balance: pUsdBalance, needed };
    }
  }

  // NegRisk plumbing skip. In NegRisk markets the exchange auto-routes a
  // single whale order through the cheapest complement tokens, emitting one
  // OrderFilled per leg. In the plumbing legs the whale appears as taker
  // against a regular maker, holding the WRONG complement token only as a
  // stepping stone before the NegRisk Adapter burns the complement set to
  // mint the token the whale actually wanted. The whale's real intent is the
  // final leg where they appear as maker against the exchange contract.
  // Mirroring the plumbing legs has us buying the losing side at high prices.
  if (market.negRisk) {
    const makerIsWhaleNeg = watchedWallets.has(row.maker.toLowerCase());
    const takerIsWhaleNeg = watchedWallets.has(row.taker.toLowerCase());
    if (takerIsWhaleNeg && !makerIsWhaleNeg) {
      console.log(
        `[copy_trade] SKIP_NEGRISK_PLUMBING tx=${row.transaction_hash} token=${tokenId.slice(0, 15)}...`
      );
      return { status: "SKIP_NEGRISK_PLUMBING", txHash: row.transaction_hash };
    }
  }

  // For sells, check we actually hold the share on-chain via Polymarket's
  // data API (source of truth — the local positions collection can drift).
  let sellSize = 0;
  if (side === "SELL") {
    const match = positions?.find(
      (p: { asset: string; size: number }) => p.asset === tokenId
    );
    if (!match || match.size <= 0) {
      console.log(
        `[copy_trade] NO_POSITION to sell for ${tokenId.slice(0, 15)}...`
      );
      return { status: "NO_POSITION" };
    }
    sellSize = match.size;
    console.log(
      `[copy_trade] have ${sellSize} shares on-chain for ${tokenId.slice(0, 15)}...`
    );
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
    market.minOrderSize,
    market.negRisk,
    market.feeRateBps,
    sellSize
  );

  // Classify the synchronous outcome. The CLOB risk-delay queue resolves
  // most orders async, so `delayed` is the common path — the eventual fill
  // (or kill) shows up later via pull_trades reading the on-chain trade tape.
  const isZero = (s?: string) =>
    !s || s === "0" || s === "0.0" || s === "0.00" || parseFloat(s) === 0;
  const filledSync =
    !isZero(result.takingAmount) || !isZero(result.makingAmount);
  let syncStatus: TradeAttempt["syncStatus"];
  if (!result.success) {
    syncStatus = "failed";
  } else if (filledSync) {
    syncStatus = "matched";
  } else {
    syncStatus = "delayed";
  }

  // setById (upsert) instead of insertOne: the seen_fills gate above should
  // already prevent any racing attempt from reaching this line, but if the
  // gate ever slips again we want an idempotent overwrite, not a noisy
  // duplicate-key violation that triggers [PLATFORM_ERROR] monitors (FOU-797).
  await attemptsCollection.setById(dedupKey, {
    tokenId,
    side,
    intendedNotional: tradeAmount,
    whalePrice,
    orderId: result.orderId,
    syncStatus,
    syncError: result.error,
    syncTakingAmount: result.takingAmount,
    syncMakingAmount: result.makingAmount,
    eventTxHash: row.transaction_hash,
    timestamp: new Date().toISOString(),
  });

  if (syncStatus === "failed") {
    console.log(
      `[copy_trade] TRADE_FAILED: ${side} ${market.question} — ${result.error}`
    );
    return {
      status: "TRADE_FAILED",
      error: result.error,
      market: market.question,
    };
  }

  if (syncStatus === "matched") {
    console.log(
      `[copy_trade] TRADE_EXECUTED: ${side} ${market.question} — order ${result.orderId}`
    );
    return {
      status: "TRADE_EXECUTED",
      side,
      market: market.question,
      orderId: result.orderId,
    };
  }

  console.log(
    `[copy_trade] TRADE_SUBMITTED: ${side} ${market.question} — order ${result.orderId} (status=${result.status || "delayed"})`
  );
  return {
    status: "TRADE_SUBMITTED",
    side,
    market: market.question,
    orderId: result.orderId,
    syncStatus: result.status,
  };
}

/**
 * Parse an OrderFilled webhook payload to determine trade direction.
 *
 * V2 OrderFilled fields used here:
 *   side = 0 (BUY) or 1 (SELL) from the MAKER's perspective
 *   token_id = the CTF share token (collateral pUSD is implicit)
 *   maker_amount / taker_amount = amounts in their respective tokens
 *
 * For BUY (side=0): maker pays USDC (maker_amount), receives shares (taker_amount)
 * For SELL (side=1): maker pays shares (maker_amount), receives USDC (taker_amount)
 *
 * The pipeline emits two OrderFilled rows per fill — once with the watched wallet
 * as maker, once as taker (its counterparty's mirror). When the watched wallet is
 * taker, its true side is the inverse of `row.side`. The dedup gate downstream
 * collapses both to a single attempt.
 */
function parseFill(
  row: OrderFillRow,
  watchedWallets: Set<string>
): { side: "BUY" | "SELL"; tokenId: string; whalePrice: number; whaleUsd: number } {
  const makerIsWhale = watchedWallets.has(row.maker.toLowerCase());
  const makerSide: "BUY" | "SELL" = row.side === 0 ? "BUY" : "SELL";
  const whaleSide: "BUY" | "SELL" = makerIsWhale
    ? makerSide
    : (makerSide === "BUY" ? "SELL" : "BUY");

  // For BUY (maker perspective): maker_amount = USDC, taker_amount = shares.
  // For SELL: swap.
  const usdcAmount = makerSide === "BUY" ? row.maker_amount : row.taker_amount;
  const sharesAmount = makerSide === "BUY" ? row.taker_amount : row.maker_amount;
  const price = sharesAmount > 0 ? usdcAmount / sharesAmount : 0;

  return {
    side: whaleSide,
    tokenId: row.token_id || "",
    whalePrice: price,
    whaleUsd: usdcAmount,
  };
}

/**
 * Detect the unique-constraint / duplicate-key error thrown by Compose's
 * `insertOne` when a row with the same id already exists. Matches the messages
 * surfaced by both Postgres (cloud) and SQLite (local) collection backends.
 */
function isDuplicateKeyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return (
    msg.includes("duplicate key value") ||
    msg.includes("unique constraint") ||
    msg.includes("UNIQUE constraint failed")
  );
}
