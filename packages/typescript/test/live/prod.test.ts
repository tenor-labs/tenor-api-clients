import { expect, it } from "vitest";
import { Tenor, TenorApiError } from "../../src/index.ts";

const tenor = new Tenor({ apiKey: "" });
const BASE = 8453;

it("reads the catalog", async () => {
  const chains = await tenor.listChains();
  expect(chains.data.map((c) => c.chainId)).toContain(BASE);
  expect(chains.meta.requestId).toMatch(/^req_/);

  const markets = await tenor.listMarkets({ chainId: BASE });
  const market = markets.data[0]!;
  expect(market.marketId).toMatch(/^0x/);

  const maturities = await tenor.listMarketMaturities({ marketId: market.marketId, chainId: BASE });
  const maturity = maturities.data[0]!;
  expect(maturity.timeToMaturityS).toBeGreaterThan(0);

  const depth = await tenor.getMarketDepth({ maturityId: maturity.maturityId, chainId: BASE });
  expect(depth.data.maturityId).toBe(maturity.maturityId);
});

it("keeps map keys in health", async () => {
  const health = await tenor.getHealth();
  expect(Object.keys(health.checks.rpc)).toContain(String(BASE));
});

it("throws TenorApiError", async () => {
  const err = await tenor.getMarket({ marketId: `0x${"0".repeat(64)}`, chainId: BASE }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(TenorApiError);
  expect(err).toMatchObject({ status: 404, code: "MARKET_NOT_FOUND", treatment: "fix_request" });
});
