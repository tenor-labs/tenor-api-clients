# tenor-api-client

Python client for the [Tenor API](https://tenor-api.tenor.finance/v1/docs): quotes and ready-to-sign payloads for lending and borrowing on Tenor, at a fixed or a variable rate. Tenor never signs, sends or holds a key.

```sh
pip install tenor-api-client
```

Python 3.11+. Sync and async.

## Usage

```python
from tenor_api_client import Tenor

with Tenor(api_key="tnr_sk_live_…") as tenor:
    market = tenor.list_markets(chain_id=8453).data[0]
    maturity = tenor.list_market_maturities(market.market_id, chain_id=8453).data[0]

    quote = tenor.get_quote(body={
        "chain_id": 8453,
        "maturity_id": maturity.maturity_id,
        "action": "lend",
        "size": {"principal": "1000000"},  # 1 USDC, in the token's smallest unit
    })
    print(quote.data.rate)
```

- There is one method per API operation, named after it: `get_quote`, `prepare_lend`, `list_positions`, ….
- Path parameters come first. Query parameters are keywords.
- A body is a model from `tenor_api_client.models` or a dict in the API's format.
- Every method returns a model with `data` and `meta`. `meta` holds `request_id` and, on paged lists, `next_cursor`.
- Fields this client doesn't know yet are kept in `additional_properties`.
- Amounts and rates are strings, as on the wire.

```python
import asyncio
from tenor_api_client import AsyncTenor

async def main() -> None:
    async with AsyncTenor() as tenor:
        chains = await tenor.list_chains()

asyncio.run(main())
```

## Configuration

```python
Tenor(
    api_key="tnr_sk_live_…",  # defaults to $TENOR_API_KEY; reads and quotes work without one
    timeout=30.0,             # per attempt, in seconds
    max_retries=2,            # 429 (after Retry-After), 502, 503, 504 and network errors
    headers={"X-Request-Id": "my-trace-id"},
)
```

## Errors

```python
from tenor_api_client import TenorApiError

try:
    tenor.prepare_lend(body={...})
except TenorApiError as e:
    e.status      # 422
    e.code        # "INSUFFICIENT_LIQUIDITY"
    e.treatment   # "fix_request" | "refetch_state" | "fund_account" | "retry"
    e.details     # as sent by the API
    e.request_id  # quote it when you contact us
```

Branch on `code`, and fall back on `treatment` for codes you don't know. Network failures and timeouts raise `TenorConnectionError`.

## Development

The client is generated from [`openapi/trading-api.json`](https://github.com/tenor-labs/tenor-api-clients/blob/main/openapi/trading-api.json) by `uv run python scripts/generate.py`. The output is git-ignored:

- `src/tenor_api_client/_generated/`: models and one module per endpoint, from [openapi-python-client](https://github.com/openapi-generators/openapi-python-client). The settings are in [`openapi-python-client.yaml`](https://github.com/tenor-labs/tenor-api-clients/blob/main/packages/python/openapi-python-client.yaml).
- `src/tenor_api_client/client.py`: `Tenor` and `AsyncTenor`. The script reads the generated endpoint modules and writes one method per endpoint.

[`templates/literal_enum.py.jinja`](https://github.com/tenor-labs/tenor-api-clients/blob/main/packages/python/templates/literal_enum.py.jinja) overrides one generator template so that an enum value added to the API later is accepted rather than raising. [`_base.py`](https://github.com/tenor-labs/tenor-api-clients/blob/main/packages/python/src/tenor_api_client/_base.py) (config, auth, retries) and [`errors.py`](https://github.com/tenor-labs/tenor-api-clients/blob/main/packages/python/src/tenor_api_client/errors.py) are written by hand.

```sh
uv sync
uv run python scripts/generate.py
uv run pytest            # unit tests
uv run pytest -m live    # read-only calls against prod
uv run pyright && uv run ruff check .
```
