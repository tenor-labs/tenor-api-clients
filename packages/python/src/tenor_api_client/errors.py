from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any


class TenorApiError(Exception):
    """A non-2xx response from the API. Branch on ``code``; fall back on ``treatment``
    (``fix_request``, ``refetch_state``, ``fund_account`` or ``retry``) for codes you don't know."""

    def __init__(
        self,
        status: int,
        code: str,
        category: str,
        treatment: str,
        message: str,
        details: dict[str, Any] | None = None,
        request_id: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.category = category
        self.treatment = treatment
        self.message = message
        self.details = details
        self.request_id = request_id

    def __repr__(self) -> str:
        return f"TenorApiError(status={self.status}, code={self.code!r}, message={self.message!r})"

    @classmethod
    def from_response(cls, status: int, headers: Mapping[str, str], content: bytes) -> TenorApiError:
        try:
            error = json.loads(content)["error"]
        except (ValueError, KeyError, TypeError):
            error = None
        request_id = headers.get("x-request-id")
        if isinstance(error, dict) and error.get("code"):
            return cls(
                status,
                error["code"],
                error.get("category", "internal"),
                error.get("treatment", "retry"),
                error.get("message", error["code"]),
                error.get("details"),
                error.get("request_id", request_id),
            )
        # Not the API's error shape: the response came from a proxy.
        retry = status >= 500 or status == 429
        return cls(
            status,
            f"HTTP_{status}",
            "upstream" if retry else "validation",
            "retry" if retry else "fix_request",
            f"HTTP {status}",
            None,
            request_id,
        )


class TenorConnectionError(Exception):
    """The request never got a response: network failure or timeout."""
