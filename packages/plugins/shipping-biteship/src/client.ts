/**
 * Thin Biteship HTTP client. Wraps `fetch` with auth, error mapping, and
 * timeouts; deliberately small so tests can stub a single `fetch` impl
 * and assert the request body Biteship will receive.
 *
 * Why no SDK: the surface mt-commerce uses (rates + orders + tracking
 * read) is three endpoints. Pulling in a vendor SDK would multiply our
 * bundle size and make the plugin harder to audit.
 */

const SANDBOX_HOST = "https://api.biteship.com";
const PRODUCTION_HOST = "https://api.biteship.com";

/**
 * Note on hosts: Biteship serves sandbox and production from the same
 * host; the keys themselves carry the environment selector (`test_*`
 * vs `live_*`). We keep the `mode` knob and a host abstraction so that
 * if Biteship ever splits hosts (or the operator routes through a
 * regional proxy), the change lands in this file alone.
 */

export interface BiteshipClientOptions {
  readonly apiKey: string;
  readonly mode?: "sandbox" | "production";
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}

/**
 * Error type the client throws on a non-2xx response. Carries the HTTP
 * status and Biteship's error body so callers can branch (e.g. surface
 * a 400 about an unsupported postal code as a domain `ValidationError`
 * upstream).
 */
export class BiteshipError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "BiteshipError";
  }
}

export interface BiteshipRequestInit {
  readonly path: string;
  readonly method: "GET" | "POST";
  readonly body?: Record<string, unknown>;
  readonly query?: Record<string, string | number | undefined>;
  /** Per-request timeout in ms. Defaults to 15s. */
  readonly timeoutMs?: number;
}

export class BiteshipClient {
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;

  constructor(private readonly opts: BiteshipClientOptions) {
    if (!opts.apiKey) {
      throw new Error(
        "@mt-commerce/plugin-shipping-biteship: apiKey is required.",
      );
    }
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.base =
      opts.baseUrl ??
      (opts.mode === "production" ? PRODUCTION_HOST : SANDBOX_HOST);
  }

  async request<T>(init: BiteshipRequestInit): Promise<T> {
    const url = this.buildUrl(init.path, init.query);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? 15_000);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: init.method,
        headers: {
          authorization: this.opts.apiKey,
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    let parsed: unknown;
    const text = await response.text();
    if (text.length === 0) {
      parsed = {};
    } else {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new BiteshipError(
          `Biteship returned non-JSON body (status ${response.status}).`,
          response.status,
          text,
        );
      }
    }

    if (!response.ok) {
      const message =
        readStringField(parsed, "error") ??
        `Biteship request failed with status ${response.status}.`;
      throw new BiteshipError(message, response.status, parsed);
    }

    // Biteship wraps every successful response in `{ success: true, ... }`.
    // If `success` is explicitly `false` despite a 2xx status, treat it as
    // an error so callers do not silently consume a failed response.
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "success" in parsed &&
      (parsed as { success?: unknown }).success === false
    ) {
      const message =
        readStringField(parsed, "error") ?? "Biteship reported success=false.";
      throw new BiteshipError(message, response.status, parsed);
    }

    return parsed as T;
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): string {
    const url = new URL(path, this.base);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }
}

function readStringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = (value as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
