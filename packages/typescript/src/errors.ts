export type ErrorCategory =
  | "validation"
  | "auth"
  | "not_found"
  | "state"
  | "liquidity"
  | "account"
  | "simulation"
  | "rate_limit"
  | "upstream"
  | "internal";

/** What to do about an error, for codes this client doesn't know yet. */
export type ErrorTreatment = "fix_request" | "refetch_state" | "fund_account" | "retry";

interface ErrorBody {
  error?: {
    code?: string;
    category?: ErrorCategory;
    treatment?: ErrorTreatment;
    message?: string;
    details?: Record<string, unknown>;
    requestId?: string;
  };
}

/** A non-2xx response from the API. Branch on `code`; fall back on `treatment`. */
export class TenorApiError extends Error {
  override readonly name = "TenorApiError";

  constructor(
    readonly status: number,
    readonly code: string,
    readonly category: ErrorCategory,
    readonly treatment: ErrorTreatment,
    message: string,
    readonly details: Record<string, unknown> | undefined,
    readonly requestId: string | undefined,
  ) {
    super(message);
  }

  /** `body` is already camelCased. A body that isn't the API's error shape came from a proxy. */
  static from(response: Response, body: unknown): TenorApiError {
    const error = (body as ErrorBody | undefined)?.error;
    const requestId = error?.requestId ?? response.headers.get("x-request-id") ?? undefined;
    if (error?.code) {
      return new TenorApiError(
        response.status,
        error.code,
        error.category ?? "internal",
        error.treatment ?? "retry",
        error.message ?? error.code,
        error.details,
        requestId,
      );
    }
    const retry = response.status >= 500 || response.status === 429;
    return new TenorApiError(
      response.status,
      `HTTP_${response.status}`,
      retry ? "upstream" : "validation",
      retry ? "retry" : "fix_request",
      `HTTP ${response.status} ${response.statusText}`.trim(),
      undefined,
      requestId,
    );
  }
}

/** The request never got a response: network failure or timeout. */
export class TenorConnectionError extends Error {
  override readonly name = "TenorConnectionError";
}
