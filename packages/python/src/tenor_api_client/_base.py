from __future__ import annotations

import asyncio
import os
import random
import time
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, Self, TypeVar

import httpx2

from ._generated.client import AuthenticatedClient
from ._generated.types import Response
from ._version import __version__
from .errors import TenorApiError, TenorConnectionError

DEFAULT_BASE_URL = "https://trading-api.tenor.finance"

_RETRYABLE = {429, 502, 503, 504}

M = TypeVar("M")


def as_model(model: type[M], value: M | Mapping[str, Any]) -> M:
    """Request bodies can be passed as a model or as a dict in the API's wire format."""
    if isinstance(value, Mapping):
        return model.from_dict(value)  # type: ignore[attr-defined]
    return value


def _headers(api_key: str | None, extra: Mapping[str, str] | None) -> dict[str, str]:
    key = api_key if api_key is not None else os.environ.get("TENOR_API_KEY")
    headers = {"User-Agent": f"tenor-api-client-python/{__version__}", **(extra or {})}
    if key:
        headers["X-Api-Key"] = key
    return headers


def _delay(attempt: int, response: httpx2.Response | None) -> float:
    if response is not None:
        try:
            seconds = float(response.headers.get("retry-after", ""))
            if seconds > 0:
                return min(seconds, 60.0)
        except ValueError:
            pass
    return min(0.5 * 2**attempt, 8.0) * random.uniform(0.75, 1.25)


def _unwrap(response: Response[Any]) -> Any:
    if 200 <= response.status_code < 300:
        return response.parsed
    raise TenorApiError.from_response(response.status_code, response.headers, response.content)


class _RetryTransport(httpx2.BaseTransport):
    """Retries 429, 502, 503, 504 and network errors. Every call is payload-only, so a retry is safe."""

    def __init__(self, inner: httpx2.BaseTransport, max_retries: int) -> None:
        self._inner = inner
        self._max_retries = max_retries

    def handle_request(self, request: httpx2.Request) -> httpx2.Response:
        for attempt in range(self._max_retries + 1):
            last = attempt == self._max_retries
            try:
                response = self._inner.handle_request(request)
            except httpx2.TransportError:
                if last:
                    raise
                time.sleep(_delay(attempt, None))
                continue
            if response.status_code not in _RETRYABLE or last:
                return response
            response.read()
            response.close()
            time.sleep(_delay(attempt, response))
        raise AssertionError("unreachable")

    def close(self) -> None:
        self._inner.close()


class _AsyncRetryTransport(httpx2.AsyncBaseTransport):
    def __init__(self, inner: httpx2.AsyncBaseTransport, max_retries: int) -> None:
        self._inner = inner
        self._max_retries = max_retries

    async def handle_async_request(self, request: httpx2.Request) -> httpx2.Response:
        for attempt in range(self._max_retries + 1):
            last = attempt == self._max_retries
            try:
                response = await self._inner.handle_async_request(request)
            except httpx2.TransportError:
                if last:
                    raise
                await asyncio.sleep(_delay(attempt, None))
                continue
            if response.status_code not in _RETRYABLE or last:
                return response
            await response.aread()
            await response.aclose()
            await asyncio.sleep(_delay(attempt, response))
        raise AssertionError("unreachable")

    async def aclose(self) -> None:
        await self._inner.aclose()


class BaseClient:
    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
        max_retries: int = 2,
        headers: Mapping[str, str] | None = None,
        transport: httpx2.BaseTransport | None = None,
    ) -> None:
        """``api_key`` defaults to the ``TENOR_API_KEY`` environment variable. Reads and quotes work
        without one. ``timeout`` is per attempt, in seconds."""
        self.base_url = base_url.rstrip("/")
        self._client = AuthenticatedClient(base_url=self.base_url, token="")
        self._client.set_httpx_client(
            httpx2.Client(
                base_url=self.base_url,
                headers=_headers(api_key, headers),
                timeout=timeout,
                transport=_RetryTransport(transport or httpx2.HTTPTransport(), max_retries),
            )
        )

    def _call(self, endpoint: Callable[..., Response[Any]], **kwargs: Any) -> Any:
        try:
            response = endpoint(client=self._client, **kwargs)
        except httpx2.TransportError as e:
            raise TenorConnectionError(f"{type(e).__name__}: {e}") from e
        return _unwrap(response)

    def close(self) -> None:
        self._client.get_httpx_client().close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


class AsyncBaseClient:
    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
        max_retries: int = 2,
        headers: Mapping[str, str] | None = None,
        transport: httpx2.AsyncBaseTransport | None = None,
    ) -> None:
        """``api_key`` defaults to the ``TENOR_API_KEY`` environment variable. Reads and quotes work
        without one. ``timeout`` is per attempt, in seconds."""
        self.base_url = base_url.rstrip("/")
        self._client = AuthenticatedClient(base_url=self.base_url, token="")
        self._client.set_async_httpx_client(
            httpx2.AsyncClient(
                base_url=self.base_url,
                headers=_headers(api_key, headers),
                timeout=timeout,
                transport=_AsyncRetryTransport(transport or httpx2.AsyncHTTPTransport(), max_retries),
            )
        )

    async def _call(self, endpoint: Callable[..., Awaitable[Response[Any]]], **kwargs: Any) -> Any:
        try:
            response = await endpoint(client=self._client, **kwargs)
        except httpx2.TransportError as e:
            raise TenorConnectionError(f"{type(e).__name__}: {e}") from e
        return _unwrap(response)

    async def close(self) -> None:
        await self._client.get_async_httpx_client().aclose()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()
