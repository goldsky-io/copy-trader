/**
 * Polymarket contract addresses on Polygon.
 *
 * V2 cutover: 2026-04-28 ~11:00 UTC. CLOBv2 introduced new exchange contracts,
 * a new collateral token (pUSD), and a CollateralOnramp wrap step. Legacy V1
 * exchanges are dead: V1-signed orders and V1 SDKs no longer accepted.
 *
 * Trading collateral: pUSD. USDC.e is only relevant as the "unwrapped" form,
 * which the CollateralOnramp wraps 1:1 into pUSD on demand.
 */
export const CONTRACTS = {
  // V2 exchanges
  ctfExchange: "0xE111180000d2663C0091e4f400237545B87B996B",
  negRiskExchange: "0xe2222d279d744050d28e00520010520000310F59",
  // Adapter the NegRisk exchange routes share transfers through. Still needs
  // ConditionalTokens approval; USDC approval is no longer relevant here since
  // pUSD is the collateral on V2.
  negRiskAdapter: "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
  conditionalTokens: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  // Collateral
  pUsd: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
  usdcE: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  collateralOnramp: "0x93070a847efEf7F70739046A929D47a521F5B8ee",
  collateralOfframp: "0x2957922Eb93258b93368531d39fAcCA3B4dC5854",
} as const;

export const CHAIN_ID = 137;

/** Row from the Turbo pipeline's order_fills sink (V2 OrderFilled).
 *  V2 dropped the maker/taker asset_id pair and added an explicit `side`.
 *  The single `token_id` is the CTF share token; collateral (pUSD) is implicit. */
export type OrderFillRow = {
  id: string;
  block_number: number;
  log_index: number;
  transaction_hash: string;
  block_timestamp: string;
  maker: string;
  taker: string;
  side: number;          // 0 = BUY, 1 = SELL (from maker's perspective)
  token_id: string;
  maker_amount: number;
  taker_amount: number;
};

/** Position tracked in collections */
export type Position = {
  id: string; // tokenId
  tokenId: string;
  conditionId: string;
  side: "YES" | "NO";
  size: number;
  avgPrice: number;
  status: "open" | "redeemed";
};

/**
 * What we attempted, not what filled. Written by copy_trade once per
 * /order submission. The CLOB's risk-delay queue means the synchronous
 * response can't tell us whether a delayed order ultimately matched or got
 * killed — the trade tape (chain_trades) is the source of truth for fills.
 */
export type TradeAttempt = {
  id: string; // `${eventTxHash}-${tokenId}-${side}`
  tokenId: string;
  side: "BUY" | "SELL";
  intendedNotional: number;
  whalePrice: number;
  signedPrice?: number;
  orderId?: string;
  syncStatus: "matched" | "delayed" | "failed";
  syncError?: string;
  syncTakingAmount?: string;
  syncMakingAmount?: string;
  eventTxHash: string;
  timestamp: string;
};

/**
 * Trade pulled from Polymarket's data-api /trades endpoint. This is the
 * fill ledger — every row here corresponds to an on-chain CTF transfer
 * the wallet was a party to. Keyed by `${transactionHash}-${asset}-${side}`
 * so reruns are idempotent.
 */
export type ChainTrade = {
  id: string;
  transactionHash: string;
  asset: string; // tokenId
  conditionId?: string;
  title?: string;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  outcome?: string;
  outcomeIndex?: number;
  timestamp: number; // unix seconds
};

/** Budget tracker */
export type Budget = {
  key: string;
  remaining: number;
  totalSpent: number;
};

/** Persistent CLOB L2 API credentials (cached across cold starts) */
export type ApiCredsRecord = {
  id: string;       // wallet EOA, lowercased
  key: string;
  secret: string;
  passphrase: string;
};

/** Gamma API market info needed for trading */
export type MarketInfo = {
  tokenId: string;
  conditionId: string;
  question: string;
  tickSize: string;
  minOrderSize: number;
  negRisk: boolean;
  enableOrderBook: boolean;
  closed: boolean;
  feeRateBps: number;
  outcomePrices: [number, number];
  clobTokenIds: [string, string];
};

