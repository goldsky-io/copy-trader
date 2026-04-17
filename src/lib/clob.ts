/**
 * Polymarket CLOB client wrapper.
 * Uses @polymarket/clob-client SDK for EIP-712 signing and order placement.
 */
import { Wallet } from "@ethersproject/wallet";
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import type { TickSize } from "@polymarket/clob-client";
import { CHAIN_ID } from "./types";

let cachedClient: ClobClient | null = null;

/**
 * Get or create an authenticated CLOB client using EOA signing.
 * No proxy wallet — funds live directly on the EOA.
 * Caches the client since API key derivation is expensive.
 */
export async function getClobClient(
  privateKey: string,
  host: string
): Promise<ClobClient> {
  if (cachedClient) return cachedClient;

  const pk = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  const wallet = new Wallet(pk);
  const tempClient = new ClobClient(host, CHAIN_ID, wallet);
  const creds = await tempClient.createOrDeriveApiKey();

  // EOA-mode CLOB client (no funder/proxy arg).
  cachedClient = new ClobClient(host, CHAIN_ID, wallet, creds);
  return cachedClient;
}

export type TradeResult = {
  success: boolean;
  orderId?: string;
  error?: string;
};

/**
 * Execute a FAK (Fill-and-Kill) market order on Polymarket CLOB.
 */
export async function executeTrade(
  client: ClobClient,
  tokenId: string,
  side: "BUY" | "SELL",
  amountUsd: number,
  whalePrice: number,
  tickSize: string,
  negRisk: boolean
): Promise<TradeResult> {
  try {
    // Use the whale's fill price as our entry price. That's the price we want
    // to match for copy-trading — don't chase the current book (which may have
    // moved). CLOB will fill at this price or better (or reject).
    if (!whalePrice || whalePrice <= 0 || whalePrice >= 1) {
      return { success: false, error: `Invalid whale price: ${whalePrice}` };
    }

    // Round to tick size so price is valid on the book
    const tick = parseFloat(tickSize) || 0.01;
    const price = Math.round(whalePrice / tick) * tick;

    // Calculate size (shares) for the configured USD amount
    let shares = Math.floor(amountUsd / price);

    // Enforce CLOB's minimum notional of $1 (most crypto 5m markets require 5 shares)
    const MIN_SHARES = 5;
    if (shares < MIN_SHARES) shares = MIN_SHARES;
    console.log(`[clob] ${side} ${shares} shares @ ${price} (notional=$${(shares*price).toFixed(2)})`);

    const amount = side === "BUY" ? shares * price : shares;

    const resp = await client.createAndPostMarketOrder(
      {
        tokenID: tokenId,
        price,
        amount,
        side: side === "BUY" ? Side.BUY : Side.SELL,
      },
      { tickSize: tickSize as TickSize, negRisk },
      OrderType.FAK
    );

    const result = resp as {
      orderID?: string;
      orderId?: string;
      errorMsg?: string;
      error?: string;
    };
    const orderId = result.orderID || result.orderId;
    const errorMsg = result.errorMsg || result.error;

    if (errorMsg) {
      return { success: false, error: errorMsg, orderId };
    }
    return { success: true, orderId };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
