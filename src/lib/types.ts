/** Polymarket contract addresses on Polygon */
export const CONTRACTS = {
  ctfExchange: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
  negRiskExchange: "0xC5d563A36AE78145C45a50134d48A1215220f80a",
  conditionalTokens: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  usdc: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
} as const;

export const PROXY_WALLET_ADDRESS =
  "0x51bD8791e9De5147ECbE6b3b9376a2369b3A4C09";
export const CHAIN_ID = 137;

/** Row from the Turbo pipeline's order_fills sink */
export type OrderFillRow = {
  id: string;
  block_number: number;
  log_index: number;
  transaction_hash: string;
  block_timestamp: string;
  maker: string;
  taker: string;
  maker_asset_id: string;
  taker_asset_id: string;
  maker_amount: number;
  taker_amount: number;
  fee: number;
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

/** Trade record in collections */
export type Trade = {
  id: string;
  tokenId: string;
  side: "BUY" | "SELL";
  amount: number;
  price: number;
  whalePrice: number;
  slippage: number;
  orderId?: string;
  eventTxHash: string;
  timestamp: string;
};

/** Budget tracker */
export type Budget = {
  key: string;
  remaining: number;
  totalSpent: number;
};

/** Gamma API market info needed for trading */
export type MarketInfo = {
  tokenId: string;
  conditionId: string;
  question: string;
  tickSize: string;
  negRisk: boolean;
  enableOrderBook: boolean;
  closed: boolean;
  outcomePrices: [number, number];
  clobTokenIds: [string, string];
};

