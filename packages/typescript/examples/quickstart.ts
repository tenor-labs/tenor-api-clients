import { Tenor, TenorApiError } from "@tenor-labs/api-client";

// No key needed. A key (TENOR_API_KEY or { apiKey }) raises the rate limits.
const tenor = new Tenor();

const { data: markets } = await tenor.listMarkets({ chainId: 8453 });
const market = markets[0]!;
const { data: maturities } = await tenor.listMarketMaturities({ marketId: market.marketId, chainId: 8453 });

try {
  const { data: quote } = await tenor.getQuote({
    chainId: 8453,
    maturityId: maturities[0]!.maturityId,
    action: "lend",
    size: { principal: "1000000000" },
  });
  console.log(quote);
} catch (err) {
  if (err instanceof TenorApiError) console.error(err.code, err.treatment, err.requestId);
  else throw err;
}
