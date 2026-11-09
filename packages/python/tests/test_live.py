import pytest

from tenor_api_client import Tenor, TenorApiError

pytestmark = pytest.mark.live
BASE = 8453


@pytest.fixture(scope="module")
def tenor() -> Tenor:
    return Tenor(api_key="")


def test_reads_the_catalog(tenor: Tenor) -> None:
    chains = tenor.list_chains()
    assert BASE in [c.chain_id for c in chains.data]
    assert chains.meta.request_id.startswith("req_")

    market = tenor.list_markets(chain_id=BASE).data[0]
    maturity = tenor.list_market_maturities(market.market_id, chain_id=BASE).data[0]
    assert maturity.time_to_maturity_s > 0

    depth = tenor.get_market_depth(maturity.maturity_id, chain_id=BASE)
    assert depth.data.maturity_id == maturity.maturity_id


def test_keeps_map_keys_in_health(tenor: Tenor) -> None:
    assert str(BASE) in tenor.get_health().checks.rpc.additional_properties


def test_raises_tenor_api_error(tenor: Tenor) -> None:
    with pytest.raises(TenorApiError) as info:
        tenor.get_market("0x" + "0" * 64, chain_id=BASE)
    assert (info.value.status, info.value.code) == (404, "MARKET_NOT_FOUND")
