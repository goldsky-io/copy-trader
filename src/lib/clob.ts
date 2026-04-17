/**
 * Polymarket CLOB client wrapper.
 * Uses @polymarket/clob-client SDK for EIP-712 signing and order placement.
 */
import { Wallet } from "@ethersproject/wallet";
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import type { TickSize } from "@polymarket/clob-client";
import { CHAIN_ID, PROXY_WALLET_ADDRESS } from "./types";

const SIGNATURE_TYPE_GNOSIS_SAFE = 2;

let cachedClient: ClobClient | null = null;

/**
 * Get or create an authenticated CLOB client.
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

  cachedClient = new ClobClient(
    host,
    CHAIN_ID,
    wallet,
    creds,
    SIGNATURE_TYPE_GNOSIS_SAFE,
    PROXY_WALLET_ADDRESS
  );
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
  tickSize: string,
  negRisk: boolean
): Promise<TradeResult> {
  try {
    // Get current price to calculate shares
    const priceResp = await client.getPrice(
      tokenId,
      side === "BUY" ? Side.BUY : Side.SELL
    );
    const price = parseFloat(priceResp?.price);
    if (!price || price <= 0 || price >= 1) {
      return { success: false, error: `Invalid price: ${priceResp?.price}` };
    }

    // Calculate size (shares). BUY amount = shares * price. SELL amount = shares.
    let shares = Math.floor(amountUsd / price);

    // Enforce $1 minimum notional
    if (price * shares < 1) {
      shares = Math.ceil(1 / price);
    }
    if (shares < 1) {
      return { success: false, error: "Trade too small" };
    }

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
