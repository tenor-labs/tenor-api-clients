import { TenorApiError, TenorConnectionError } from "./errors.js";
import { SHAPES } from "./gen/operations.gen.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://trading-api.tenor.finance";

export interface ClientOptions {
  /** Defaults to the `TENOR_API_KEY` environment variable. Reads and quotes work without one. */
  apiKey?: string;
  baseUrl?: string;
  /** Per attempt, in milliseconds. */
  timeout?: number;
  /** Retries on 429, 502, 503, 504 and network errors. */
  maxRetries?: number;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeout?: number;
  headers?: Record<string, string>;
}

/** See scripts/generate.ts. */
export type Shape = 0 | string | { o?: Record<string, [string, Shape]>; m?: Shape } | { a: Shape };

export interface Operation {
  method: string;
  path: string;
  query: Record<string, string>;
  pathParams: Record<string, string>;
  body: Shape;
  response: Shape;
}

const RETRYABLE = new Set([429, 502, 503, 504]);

export class BaseClient {
  readonly baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #timeout: number;
  readonly #maxRetries: number;
  readonly #headers: Record<string, string>;
  readonly #fetch: typeof fetch;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#apiKey = options.apiKey ?? globalThis.process?.env?.TENOR_API_KEY;
    this.#timeout = options.timeout ?? 30_000;
    this.#maxRetries = options.maxRetries ?? 2;
    this.#headers = options.headers ?? {};
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  protected async request<T>(op: Operation, params: object, options: RequestOptions = {}): Promise<T> {
    const input = params as Record<string, unknown>;
    let path = op.path;
    for (const [name, wire] of Object.entries(op.pathParams)) {
      path = path.replace(`{${wire}}`, encodeURIComponent(String(input[name])));
    }
    const url = new URL(this.baseUrl + path);
    for (const [name, wire] of Object.entries(op.query)) {
      if (input[name] !== undefined && input[name] !== null) url.searchParams.set(wire, String(input[name]));
    }
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": `tenor-api-client-typescript/${VERSION}`,
      ...this.#headers,
      ...options.headers,
    };
    if (this.#apiKey) headers["X-Api-Key"] = this.#apiKey;
    let body: string | null = null;
    if (op.method !== "GET") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(toWire(op.body, params));
    }

    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(options.timeout ?? this.#timeout);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await this.#fetch(url, { method: op.method, headers, body, signal });
      } catch (cause) {
        if (options.signal?.aborted) throw cause;
        if (attempt < this.#maxRetries) {
          await sleep(backoff(attempt));
          continue;
        }
        const reason = timeout.aborted ? "timed out" : "failed";
        throw new TenorConnectionError(`${op.method} ${path} ${reason}`, { cause });
      }
      const text = await response.text();
      if (response.ok) return fromWire(op.response, text ? JSON.parse(text) : undefined) as T;
      if (RETRYABLE.has(response.status) && attempt < this.#maxRetries) {
        await sleep(retryAfter(response) ?? backoff(attempt));
        continue;
      }
      throw TenorApiError.from(response, fromWire("ErrorResponse", parseJson(text)));
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function backoff(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 8_000) * (0.75 + Math.random() / 2);
}

function retryAfter(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 60) * 1000 : undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- camelCase ↔ wire ----------

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

type Resolved = Exclude<Shape, string>;
type Fields = Record<string, [string, Shape]>;
const inverted = new WeakMap<Fields, Fields>();

function invert(fields: Fields): Fields {
  let out = inverted.get(fields);
  if (!out) {
    out = Object.fromEntries(Object.entries(fields).map(([wire, [name, shape]]) => [name, [wire, shape]]));
    inverted.set(fields, out);
  }
  return out;
}

function convert(shape: Shape, value: unknown, toCamel: boolean): unknown {
  if (shape === 0 || value === null || typeof value !== "object") return value;
  const node: Resolved = typeof shape === "string" ? (SHAPES[shape] as Resolved) : shape;
  if (node === 0) return value;
  if ("a" in node) return Array.isArray(value) ? value.map((v) => convert(node.a, v, toCamel)) : value;
  if (Array.isArray(value)) return value;
  const fields = node.o ?? {};
  const known = toCamel ? fields : invert(fields);
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    const hit = known[key];
    if (hit) out[hit[0]] = convert(hit[1], v, toCamel);
    else if (node.m !== undefined) out[key] = convert(node.m, v, toCamel);
    // A field newer than this client: rename it, leave its value alone.
    else out[toCamel ? camel(key) : snake(key)] = v;
  }
  return out;
}

export const fromWire = (shape: Shape, value: unknown) => convert(shape, value, true);
export const toWire = (shape: Shape, value: unknown) => convert(shape, value, false);
