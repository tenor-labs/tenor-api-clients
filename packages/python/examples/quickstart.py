from tenor_api_client import Tenor, TenorApiError

# Reads and quotes work without a key. Prepares need one: TENOR_API_KEY or Tenor(api_key=...).
with Tenor() as tenor:
    market = tenor.list_markets(chain_id=8453).data[0]
    maturity = tenor.list_market_maturities(market.market_id, chain_id=8453).data[0]

    try:
        quote = tenor.get_quote(
            body={
                "chain_id": 8453,
                "maturity_id": maturity.maturity_id,
                "action": "lend",
                "size": {"principal": "1000000"},
            }
        )
        print(quote.data.rate, quote.data.size.amount_at_maturity)
    except TenorApiError as e:
        print(e.code, e.treatment, e.request_id)
