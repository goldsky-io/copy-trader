/**
 * Minimal Polymarket CLOB client that uses ctx.fetch for all HTTP.
 *
 * V2 cutover (2026-04-28): orders are signed with the V2 EIP-712 domain
 * (`version: "2"`) and the V2 Order struct (timestamp/metadata/builder, no
 * nonce/feeRateBps/taker). ClobAuth signing is unchanged (still v1 domain).
 *
 * The V1 `@polymarket/clob-client` SDK is still used for L1/L2 auth headers
 * because those routines are pure crypto and the V2 SDK is single-bundled
 * with axios baked in — incompatible with Compose's Deno runtime, which
 * has no `--allow-net`. We sign V2 orders manually with viem instead of
 * pulling the V2 SDK.
 *
 * All requests are made to CLOB_HOST, which should point at our Fly.io
 * proxy in Amsterdam (clob.polymarket.com is geo-blocked from US-hosted
 * Compose tasks).
 */
import type { TaskContext } from "compose";
import type { ApiCredsRecord } from "./types";
import { Wallet } from "@ethersproject/wallet";
import { CONTRACTS, CHAIN_ID } from "./types";
import { OrderType } from "@polymarket/clob-client/dist/types.js";
import type { TickSize } from "@polymarket/clob-client/dist/types.js";
import { createL1Headers, createL2Headers } from "@polymarket/clob-client/dist/headers/index.js";

type ApiCreds = { key: string; secret: string; passphrase: string };

let cachedCreds: ApiCreds | null = null;

function normalizePk(pk: string): `0x${string}` {
  return (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;
}

/** EIP-712 domain version is the only thing that bumped (1 → 2) for orders. */
const CTF_EXCHANGE_V2_DOMAIN_NAME = "Polymarket CTF Exchange";
const NEG_RISK_EXCHANGE_V2_DOMAIN_NAME = "Polymarket Neg Risk CTF Exchange";
const CTF_EXCHANGE_V2_DOMAIN_VERSION = "2";

const ORDER_V2_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
    { name: "timestamp", type: "uint256" },
    { name: "metadata", type: "bytes32" },
    { name: "builder", type: "bytes32" },
  ],
} as const;

const BYTES32_ZERO =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

/** EOA signature type — we sign from the EOA private key directly. */
const SIG_TYPE_EOA = 0;

function generateSalt(): string {
  // 64-bit unsigned random salt is enough to avoid collisions; the SDK uses
  // a similar approach. A larger salt makes the typed-data uint256 longer
  // but doesn't change the signing flow.
  return Math.floor(Math.random() * 1e15).toString();
}

/**
 * Fetch (or derive) the L2 API credentials for this wallet.
 *
 * Lookup order:
 *   1. In-process cache (warm worker)
 *   2. Compose collection `apiCreds` (survives cold starts)
 *   3. POST /auth/api-key → on empty result fall back to GET /auth/derive-api-key
 *
 * Cold-start auth used to be the largest single contributor to time-to-fill;
 * persisting to the collection makes the round-trip a one-time cost per wallet.
 */
export async function getApiCreds(
  ctx: TaskContext,
  privateKey: string,
  host: string
): Promise<ApiCreds> {
  if (cachedCreds) return cachedCreds;

  const wallet = new Wallet(normalizePk(privateKey));
  const walletId = wallet.address.toLowerCase();

  const credsCollection = await ctx.collection<ApiCredsRecord>("apiCreds");
  const stored = await credsCollection.findOne({ id: walletId });
  if (stored?.key && stored?.secret && stored?.passphrase) {
    cachedCreds = {
      key: stored.key,
      secret: stored.secret,
      passphrase: stored.passphrase,
    };
    return cachedCreds;
  }

  const l1Headers = await createL1Headers(wallet as any, CHAIN_ID);

  // Try create first; if already exists (empty key), fall back to derive
  let resolved: ApiCreds | null = null;
  try {
    const created = (await ctx.fetch(`${host}/auth/api-key`, {
      method: "POST",
      headers: l1Headers as Record<string, string>,
    })) as { apiKey?: string; secret?: string; passphrase?: string };

    if (created?.apiKey) {
      resolved = {
        key: created.apiKey,
        secret: created.secret!,
        passphrase: created.passphrase!,
      };
    }
  } catch {
    // fall through to derive
  }

  if (!resolved) {
    const derived = (await ctx.fetch(`${host}/auth/derive-api-key`, {
      method: "GET",
      headers: l1Headers as Record<string, string>,
    })) as { apiKey: string; secret: string; passphrase: string };
    resolved = {
      key: derived.apiKey,
      secret: derived.secret,
      passphrase: derived.passphrase,
    };
  }

  cachedCreds = resolved;
  await credsCollection.insertOne({ id: walletId, ...resolved });
  return resolved;
}

export type TradeResult = {
  success: boolean;
  orderId?: string;
  error?: string;
  status?: string;
  takingAmount?: string;
  makingAmount?: string;
};

type V2Order = {
  salt: string;
  maker: string;
  signer: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  side: 0 | 1;
  signatureType: number;
  timestamp: string;
  metadata: string;
  builder: string;
};

/**
 * Build the V2 EIP-712 typed-data envelope for an order. Returned shape
 * matches what `_signTypedData` expects on an ethers Wallet.
 */
function buildOrderTypedData(order: V2Order, negRisk: boolean) {
  return {
    domain: {
      name: negRisk
        ? NEG_RISK_EXCHANGE_V2_DOMAIN_NAME
        : CTF_EXCHANGE_V2_DOMAIN_NAME,
      version: CTF_EXCHANGE_V2_DOMAIN_VERSION,
      chainId: CHAIN_ID,
      verifyingContract: negRisk
        ? CONTRACTS.negRiskExchange
        : CONTRACTS.ctfExchange,
    },
    types: ORDER_V2_TYPES,
    primaryType: "Order" as const,
    message: order,
  };
}

/**
 * Round to the market's `tickSize` and clamp inside (tickSize, 1-tickSize).
 * Polymarket rejects 0 and >=1 prices — and also fractions inside a tick.
 */
function roundPrice(price: number, tickSize: number): number {
  return Math.max(
    tickSize,
    Math.min(Math.round(price / tickSize) * tickSize, 1 - tickSize)
  );
}

/** USDC/pUSD precision is 6 decimals. */
function toUnits6(x: number): string {
  return BigInt(Math.round(x * 1e6)).toString();
}

/**
 * Build, sign, and submit a FAK (Fill-and-Kill) market order to the CLOB.
 * All HTTP goes through ctx.fetch to the host → proxy → CLOB.
 */
export async function executeTrade(
  ctx: TaskContext,
  privateKey: string,
  host: string,
  tokenId: string,
  side: "BUY" | "SELL",
  amountUsd: number,
  whalePrice: number,
  tickSize: string,
  minOrderSize: number,
  negRisk: boolean,
  // Kept for signature compatibility; V2 has no per-order feeRateBps. The bot
  // pays the market fee defined on-chain by the exchange, surfaced via the
  // exchange's getMarketFee() call. We accept the param to avoid touching
  // every caller, then ignore it.
  _feeRateBps: number,
  sellSize?: number
): Promise<TradeResult> {
  try {
    if (!whalePrice || whalePrice <= 0 || whalePrice >= 1) {
      return { success: false, error: `Invalid whale price: ${whalePrice}` };
    }

    const tick = parseFloat(tickSize) || 0.01;
    const tickedWhalePrice = Math.round(whalePrice / tick) * tick;

    // Slippage: the book has typically moved past the whale's fill price by
    // the time our order arrives (5–15s after the whale's tx, plus risk-delay
    // queueing). A FAK at the whale's exact price often dies "unmatched". We
    // pay several ticks over (BUY) / under (SELL) to actually cross the spread.
    const slippageTicks = 8;
    const rawPrice =
      side === "BUY"
        ? tickedWhalePrice + slippageTicks * tick
        : tickedWhalePrice - slippageTicks * tick;
    const price = roundPrice(rawPrice, tick);

    // For BUY: target `amountUsd` notional, but never below the per-market
    // share floor (CLOB rejects orders smaller than `orderMinSize`). At high
    // prices ($0.95+) this can mean a sub-$1 trade — that's fine.
    // For SELL: sell everything we hold (mirrors the whale exiting).
    const shares =
      side === "SELL"
        ? Math.floor(sellSize ?? 0)
        : Math.max(minOrderSize, Math.floor(amountUsd / price));

    if (shares < 1) {
      return { success: false, error: `size too small (${shares})` };
    }

    // V2: makerAmount/takerAmount are 6-decimal raw units of pUSD (or shares
    // for the SELL side). The struct doesn't care which — the chain side
    // figures out which leg is collateral from `side` + the known tokenIds.
    //
    // BUY:  makerAmount = USD spent, takerAmount = shares received
    // SELL: makerAmount = shares offered, takerAmount = USD received
    const usd = shares * price;
    const makerAmount =
      side === "BUY" ? toUnits6(usd) : toUnits6(shares);
    const takerAmount =
      side === "BUY" ? toUnits6(shares) : toUnits6(usd);

    const wallet = new Wallet(normalizePk(privateKey));

    console.log(
      `[clob] ${side} ${shares} shares @ ${price} (whale=${whalePrice.toFixed(4)}, +${slippageTicks}tk, notional=$${usd.toFixed(2)})`
    );

    const order: V2Order = {
      salt: generateSalt(),
      maker: wallet.address,
      signer: wallet.address,
      tokenId,
      makerAmount,
      takerAmount,
      side: side === "BUY" ? 0 : 1,
      signatureType: SIG_TYPE_EOA,
      timestamp: Date.now().toString(),
      metadata: BYTES32_ZERO,
      builder: BYTES32_ZERO,
    };

    const typedData = buildOrderTypedData(order, negRisk);

    // Sign + fetch L2 creds in parallel — independent crypto.
    const [signature, creds] = await Promise.all([
      (wallet as any)._signTypedData(
        typedData.domain,
        { Order: ORDER_V2_TYPES.Order },
        typedData.message
      ) as Promise<string>,
      getApiCreds(ctx, privateKey, host),
    ]);

    // Wire format mirrors the V2 SDK's orderToJsonV2: numeric salt, wide
    // passthrough fields. The CLOB validates the signature against the typed
    // data (11 fields above); the extra wire fields (taker, expiration) are
    // tolerated.
    const body = {
      deferExec: false,
      postOnly: false,
      order: {
        salt: parseInt(order.salt, 10),
        maker: order.maker,
        signer: order.signer,
        taker: "0x0000000000000000000000000000000000000000",
        tokenId: order.tokenId,
        makerAmount: order.makerAmount,
        takerAmount: order.takerAmount,
        side: side, // wire side is the string "BUY"/"SELL"
        signatureType: order.signatureType,
        timestamp: order.timestamp,
        expiration: "0",
        metadata: order.metadata,
        builder: order.builder,
        signature,
      },
      owner: creds.key,
      orderType: OrderType.FAK,
    };
    const bodyStr = JSON.stringify(body);

    const l2Headers = await createL2Headers(
      wallet as any,
      creds,
      { method: "POST", requestPath: "/order", body: bodyStr }
    );

    const resp = (await ctx.fetch(`${host}/order`, {
      method: "POST",
      headers: {
        ...l2Headers,
        "Content-Type": "application/json",
      } as Record<string, string>,
      body: bodyStr,
    })) as {
      success?: boolean;
      orderID?: string;
      orderId?: string;
      errorMsg?: string;
      error?: string;
      status?: string;
      takingAmount?: string;
      makingAmount?: string;
      transactionsHashes?: string[];
    };

    const orderId = resp.orderID || resp.orderId;
    const errorMsg = resp.errorMsg || resp.error;
    const status = resp.status || "";
    const takingAmount = resp.takingAmount ?? "";
    const makingAmount = resp.makingAmount ?? "";

    console.log(
      `[clob] /order resp: success=${resp.success} status=${status} ` +
        `taking=${takingAmount || "—"} making=${makingAmount || "—"} ` +
        `err=${errorMsg || "—"} orderId=${orderId?.slice(0, 12) || "—"}`
    );

    if (errorMsg) {
      return { success: false, error: errorMsg, orderId, status };
    }
    if (resp.success === false) {
      return {
        success: false,
        error: `success=false status=${status}`,
        orderId,
        status,
        takingAmount,
        makingAmount,
      };
    }

    return {
      success: true,
      orderId,
      status,
      takingAmount,
      makingAmount,
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export type { TickSize };
