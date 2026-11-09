import { afterEach, describe, expect, it, vi } from "vitest";
import { Tenor, TenorApiError, TenorConnectionError, VERSION } from "../src/index.ts";

interface Call {
  url: URL;
  init: RequestInit;
}

function mockFetch(...responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: URL, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const ok = (data: unknown) => json(200, { data, meta: { request_id: "req_1", generated_at: "2026-11-09T00:00:00Z" } });

const errorBody = (code: string, treatment = "fix_request") => ({
  error: { code, category: "validation", treatment, message: `${code} happened`, details: { max_size: "1" }, request_id: "req_err" },
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("requests", () => {
  it("sends path and query params by their wire names, and the key", async () => {
    const { fetch, calls } = mockFetch(ok({ market_id: "m/1", loan_token: { address: "0x1" } }));
    const tenor = new Tenor({ apiKey: "tnr_sk_test_x", fetch });
    const res = await tenor.getMarket({ marketId: "m/1", chainId: 8453, includeDeprecated: "true" });

    const { url, init } = calls[0]!;
    expect(url.toString()).toBe(
      "https://trading-api.tenor.finance/v1/markets/m%2F1?chain_id=8453&include_deprecated=true",
    );
    expect(init.method).toBe("GET");
    expect(init.body).toBeNull();
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("tnr_sk_test_x");
    expect(headers["User-Agent"]).toBe(`tenor-api-client-typescript/${VERSION}`);
    expect(res.data.marketId).toBe("m/1");
    expect(res.meta.requestId).toBe("req_1");
  });

  it("sends a snake_case body and returns camelCase", async () => {
    const { fetch, calls } = mockFetch(ok({ chain_id: 8453, maturity_id: "0xm", effective_rate: "0.05" }));
    const tenor = new Tenor({ fetch });
    const res = await tenor.getQuote({
      chainId: 8453,
      maturityId: "0xm",
      action: "lend",
      size: { amountAtMaturity: "1000" },
    });

    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      chain_id: 8453,
      maturity_id: "0xm",
      action: "lend",
      size: { amount_at_maturity: "1000" },
    });
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(res.data).toMatchObject({ chainId: 8453, maturityId: "0xm" });
  });

  it("skips unset query params and sends no key when there is none", async () => {
    vi.stubEnv("TENOR_API_KEY", "");
    const { fetch, calls } = mockFetch(ok([]));
    await new Tenor({ fetch }).listMarkets({ chainId: 8453, loanToken: undefined } as { chainId: number });

    expect(calls[0]!.url.search).toBe("?chain_id=8453");
    expect((calls[0]!.init.headers as Record<string, string>)["X-Api-Key"]).toBeUndefined();
  });

  it("reads the key from TENOR_API_KEY", async () => {
    vi.stubEnv("TENOR_API_KEY", "tnr_sk_live_env");
    const { fetch, calls } = mockFetch(ok({}));
    await new Tenor({ fetch }).getAccess();

    expect((calls[0]!.init.headers as Record<string, string>)["X-Api-Key"]).toBe("tnr_sk_live_env");
  });

  it("uses a custom base URL", async () => {
    const { fetch, calls } = mockFetch(ok([]));
    await new Tenor({ baseUrl: "http://localhost:3001/", fetch }).listChains();

    expect(calls[0]!.url.toString()).toBe("http://localhost:3001/v1/chains");
  });
});

describe("errors", () => {
  it("throws TenorApiError with the camelCased error", async () => {
    const { fetch } = mockFetch(json(422, errorBody("NO_OFFERS")));
    const err = await new Tenor({ fetch }).listChains().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TenorApiError);
    expect(err).toMatchObject({
      status: 422,
      code: "NO_OFFERS",
      category: "validation",
      treatment: "fix_request",
      message: "NO_OFFERS happened",
      // Free-form, so its keys stay as the API sent them.
      details: { max_size: "1" },
      requestId: "req_err",
    });
  });

  it("handles a body that isn't the API's error shape", async () => {
    const { fetch } = mockFetch(
      new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway", headers: { "x-request-id": "req_h" } }),
    );
    const err = await new Tenor({ fetch, maxRetries: 0 }).listChains().catch((e: unknown) => e);

    expect(err).toMatchObject({ status: 502, code: "HTTP_502", treatment: "retry", requestId: "req_h" });
  });
});

describe("retries", () => {
  it("waits Retry-After on 429, then succeeds", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = mockFetch(json(429, errorBody("RATE_LIMITED", "retry"), { "retry-after": "3" }), ok([]));
    const pending = new Tenor({ fetch }).listChains();

    await vi.advanceTimersByTimeAsync(2_900);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toMatchObject({ data: [] });
    expect(calls).toHaveLength(2);
  });

  it("gives up after maxRetries", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = mockFetch(
      json(503, errorBody("ROUTER_UNAVAILABLE", "retry")),
      json(503, errorBody("ROUTER_UNAVAILABLE", "retry")),
    );
    const pending = new Tenor({ fetch, maxRetries: 1 }).listChains().catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    expect(await pending).toMatchObject({ status: 503, code: "ROUTER_UNAVAILABLE" });
    expect(calls).toHaveLength(2);
  });

  it("does not retry other errors", async () => {
    const { fetch, calls } = mockFetch(json(400, errorBody("INVALID_PARAMS")));
    await new Tenor({ fetch }).listChains().catch(() => undefined);

    expect(calls).toHaveLength(1);
  });

  it("retries network errors, then throws TenorConnectionError", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = mockFetch(new TypeError("fetch failed"), new TypeError("fetch failed"));
    const pending = new Tenor({ fetch, maxRetries: 1 }).listChains().catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    const err = await pending;
    expect(err).toBeInstanceOf(TenorConnectionError);
    expect((err as Error).message).toBe("GET /v1/chains failed");
    expect(calls).toHaveLength(2);
  });

  it("does not retry when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch, calls } = mockFetch(new DOMException("aborted", "AbortError"));
    const err = await new Tenor({ fetch }).listChains({}, { signal: controller.signal }).catch((e: unknown) => e);

    expect((err as Error).name).toBe("AbortError");
    expect(calls).toHaveLength(1);
  });
});
