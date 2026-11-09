# @tenor-labs/api-client

TypeScript client for the [Tenor Trading API](https://trading-api.tenor.finance/v1/docs): quotes and ready-to-sign payloads for lending and borrowing on Tenor, at a fixed or a variable rate. Tenor never signs, sends or holds a key.

```sh
npm install @tenor-labs/api-client
```

Node 20.3+, or any runtime with `fetch` and `AbortSignal.any`. No dependencies.

## Usage

```ts
import { Tenor, TenorApiError } from "@tenor-labs/api-client";

const tenor = new Tenor({ apiKey: process.env.TENOR_API_KEY });

const { data: markets } = await tenor.listMarkets({ chainId: 8453 });
const { data: maturities } = await tenor.listMarketMaturities({ marketId: markets[0].marketId, chainId: 8453 });

const { data: quote } = await tenor.getQuote({
  chainId: 8453,
  maturityId: maturities[0].maturityId,
  action: "lend",
  size: { principal: "1000000" }, // 1 USDC, in the token's smallest unit
});
```

- There is one method per API operation, named after it: `getQuote`, `prepareLend`, `listPositions`, ….
- A method takes a single object: the path and query parameters for a read, or the body for a `POST`.
- Every method returns `{ data, meta }`. `meta` holds `requestId` and, on paged lists, `nextCursor`.
- Fields are camelCase, the API's snake_case renamed: `maturityId` for `maturity_id`. Enum values are unchanged, e.g. `walletKind: "delegated_eoa"`.
- Free-form maps keep their keys as the API sends them: error `details`, ABI `args` in `onchain`, and the per-chain `checks` in `getHealth`.
- Amounts and rates are strings, as on the wire.

## Configuration

```ts
new Tenor({
  apiKey: "tnr_sk_live_…", // defaults to process.env.TENOR_API_KEY; reads and quotes work without one
  timeout: 30_000,         // per attempt, in ms
  maxRetries: 2,           // 429 (after Retry-After), 502, 503, 504 and network errors
  headers: { "X-Request-Id": "my-trace-id" },
});

// Per call
await tenor.listChains({}, { signal: AbortSignal.timeout(5_000), headers: { "X-Request-Id": "…" } });
```

Keep keys on your servers. Never ship a key to a browser or an app.

## Errors

```ts
try {
  await tenor.prepareLend({ /* … */ });
} catch (err) {
  if (err instanceof TenorApiError) {
    err.status;    // 422
    err.code;      // "INSUFFICIENT_LIQUIDITY"
    err.treatment; // "fix_request" | "refetch_state" | "fund_account" | "retry"
    err.details;   // as sent by the API
    err.requestId; // quote it when you contact us
  }
}
```

Branch on `code`, and fall back on `treatment` for codes you don't know. Network failures and timeouts throw `TenorConnectionError`.

## Paging

```ts
let cursor: string | undefined;
do {
  const page = await tenor.listPositions({ wallet, chainId: 8453, cursor });
  // …
  cursor = page.meta.nextCursor ?? undefined;
} while (cursor);
```

## Development

The client is generated from [`openapi/trading-api.json`](https://github.com/tenor-labs/tenor-api-clients/blob/main/openapi/trading-api.json) by `npm run generate`, which writes `src/gen/` (git-ignored):

- `types.gen.ts`: request and response types from [hey-api](https://heyapi.dev). It reads a copy of the spec with every field renamed to camelCase.
- `operations.gen.ts`: the route of every operation, plus, for each schema, which keys to rename. Free-form maps are marked so their keys are never renamed.
- `client.gen.ts`: the `Tenor` class, one method per operation.

The rest is written by hand. [`src/runtime.ts`](https://github.com/tenor-labs/tenor-api-clients/blob/main/packages/typescript/src/runtime.ts) sends the request, retries, and renames keys between camelCase and the API's snake_case. [`src/errors.ts`](https://github.com/tenor-labs/tenor-api-clients/blob/main/packages/typescript/src/errors.ts) holds the error classes. Both are small, and the generator script is [`scripts/generate.ts`](https://github.com/tenor-labs/tenor-api-clients/blob/main/packages/typescript/scripts/generate.ts).

```sh
npm run generate
npm test             # unit tests
npm run test:live    # read-only calls against prod
npm run check        # typecheck, test, build
```

[`test/casing.test.ts`](https://github.com/tenor-labs/tenor-api-clients/blob/main/packages/typescript/test/casing.test.ts) builds a sample value for every request and response in the spec. It checks that the camelCase version matches the generated types and that converting it back gives the original.
