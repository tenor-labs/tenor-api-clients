import asyncio
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx2
import pytest

import tenor_api_client._base as base
from tenor_api_client import AsyncTenor, Tenor, TenorApiError, TenorConnectionError, __version__

CHAINS = json.loads((Path(__file__).parent / "fixtures" / "chains.json").read_text())


def error_body(code: str, treatment: str = "fix_request") -> dict[str, Any]:
    return {
        "error": {
            "code": code,
            "category": "validation",
            "treatment": treatment,
            "message": f"{code} happened",
            "details": {"max_size": "1"},
            "request_id": "req_err",
        }
    }


class Recorder:
    def __init__(self, *responses: httpx2.Response | Exception) -> None:
        self.responses = list(responses)
        self.requests: list[httpx2.Request] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        next_ = self.responses.pop(0)
        if isinstance(next_, Exception):
            raise next_
        return next_


def client(recorder: Callable[[httpx2.Request], httpx2.Response], **kwargs: Any) -> Tenor:
    return Tenor(transport=httpx2.MockTransport(recorder), **kwargs)


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    slept: list[float] = []
    monkeypatch.setattr(base.time, "sleep", slept.append)
    monkeypatch.delenv("TENOR_API_KEY", raising=False)
    return slept


def test_sends_params_by_wire_name_with_the_key() -> None:
    rec = Recorder(httpx2.Response(200, json={"data": [], "meta": CHAINS["meta"]}))
    client(rec, api_key="tnr_sk_test_x").list_markets(chain_id=8453, loan_token="0xabc")

    [request] = rec.requests
    assert (
        str(request.url)
        == "https://trading-api.tenor.finance/v1/markets?chain_id=8453&loan_token=0xabc&listing=listed&include_deprecated=false"
    )
    assert request.headers["x-api-key"] == "tnr_sk_test_x"
    assert request.headers["user-agent"] == f"tenor-api-client-python/{__version__}"


def test_no_key_sends_no_header_and_env_key_is_used(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = Recorder(httpx2.Response(200, json=CHAINS), httpx2.Response(200, json=CHAINS))
    client(rec).list_chains()
    monkeypatch.setenv("TENOR_API_KEY", "tnr_sk_live_env")
    client(rec).list_chains()

    assert "x-api-key" not in rec.requests[0].headers
    assert rec.requests[1].headers["x-api-key"] == "tnr_sk_live_env"


def test_accepts_a_wire_dict_body() -> None:
    rec = Recorder(httpx2.Response(400, json=error_body("INVALID_PARAMS")))
    with pytest.raises(TenorApiError):
        client(rec).get_quote(
            body={
                "chain_id": 8453,
                "maturity_id": "0xm",
                "action": "lend",
                "size": {"amount_at_maturity": "1000"},
            }
        )

    sent = json.loads(rec.requests[0].content)
    assert sent == {
        "chain_id": 8453,
        "maturity_id": "0xm",
        "action": "lend",
        "size": {"amount_at_maturity": "1000"},
    }


def test_parses_the_response() -> None:
    res = client(Recorder(httpx2.Response(200, json=CHAINS))).list_chains()

    assert res.data[0].chain_id == 8453
    assert res.data[0].capabilities.dry_run is True
    assert res.meta.request_id == CHAINS["meta"]["request_id"]


def test_tolerates_new_enum_values_and_fields() -> None:
    body = json.loads(json.dumps(CHAINS))
    body["data"][0]["status"] = "a_status_added_later"
    body["data"][0]["new_field"] = {"x": 1}
    res = client(Recorder(httpx2.Response(200, json=body))).list_chains()

    assert res.data[0].status == "a_status_added_later"
    assert res.data[0].additional_properties["new_field"] == {"x": 1}


def test_raises_tenor_api_error() -> None:
    rec = Recorder(httpx2.Response(422, json=error_body("NO_OFFERS")))
    with pytest.raises(TenorApiError) as info:
        client(rec).list_chains()

    err = info.value
    assert (err.status, err.code, err.category, err.treatment) == (
        422,
        "NO_OFFERS",
        "validation",
        "fix_request",
    )
    assert err.message == "NO_OFFERS happened"
    assert err.details == {"max_size": "1"}
    assert err.request_id == "req_err"


def test_handles_a_body_that_is_not_the_api_error_shape() -> None:
    rec = Recorder(httpx2.Response(502, text="<html>bad gateway</html>", headers={"x-request-id": "req_h"}))
    with pytest.raises(TenorApiError) as info:
        client(rec, max_retries=0).list_chains()

    assert (info.value.code, info.value.treatment, info.value.request_id) == ("HTTP_502", "retry", "req_h")


def test_waits_retry_after_on_429(no_sleep: list[float]) -> None:
    rec = Recorder(
        httpx2.Response(429, json=error_body("RATE_LIMITED", "retry"), headers={"retry-after": "3"}),
        httpx2.Response(200, json=CHAINS),
    )
    client(rec).list_chains()

    assert len(rec.requests) == 2
    assert no_sleep == [3.0]


def test_gives_up_after_max_retries() -> None:
    rec = Recorder(*(httpx2.Response(503, json=error_body("ROUTER_UNAVAILABLE", "retry")) for _ in range(2)))
    with pytest.raises(TenorApiError) as info:
        client(rec, max_retries=1).list_chains()

    assert info.value.code == "ROUTER_UNAVAILABLE"
    assert len(rec.requests) == 2


def test_does_not_retry_other_errors() -> None:
    rec = Recorder(httpx2.Response(400, json=error_body("INVALID_PARAMS")))
    with pytest.raises(TenorApiError):
        client(rec).list_chains()

    assert len(rec.requests) == 1


def test_retries_network_errors_then_raises_connection_error() -> None:
    rec = Recorder(httpx2.ConnectError("refused"), httpx2.ConnectError("refused"))
    with pytest.raises(TenorConnectionError):
        client(rec, max_retries=1).list_chains()

    assert len(rec.requests) == 2


def test_async_client(monkeypatch: pytest.MonkeyPatch) -> None:
    async def no_wait(_: float) -> None:
        return None

    monkeypatch.setattr(base.asyncio, "sleep", no_wait)
    rec = Recorder(
        httpx2.Response(429, json=error_body("RATE_LIMITED", "retry")),
        httpx2.Response(200, json=CHAINS),
        httpx2.Response(404, json=error_body("MARKET_NOT_FOUND")),
    )

    async def run() -> None:
        async with AsyncTenor(transport=httpx2.MockTransport(rec)) as tenor:
            res = await tenor.list_chains()
            assert res.data[0].chain_id == 8453
            with pytest.raises(TenorApiError) as info:
                await tenor.get_market("0xm", chain_id=8453)
            assert info.value.code == "MARKET_NOT_FOUND"

    asyncio.run(run())
    assert [r.url.path for r in rec.requests] == ["/v1/chains", "/v1/chains", "/v1/markets/0xm"]
