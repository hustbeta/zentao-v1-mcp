import type { ZentaoConfig } from "../config.js";

export type FetchImpl = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ZentaoRequest = {
  method: "GET" | "POST" | "PUT";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

export class ZentaoHttpError extends Error {
  readonly status: number;
  readonly path: string;
  readonly responseBody: unknown;

  constructor(input: { status: number; path: string; responseBody: unknown }) {
    super(`ZenTao request failed: ${input.status} ${input.path}`);
    this.status = input.status;
    this.path = input.path;
    this.responseBody = redactSecrets(input.responseBody);
  }
}

export class ZentaoClient {
  private readonly config: ZentaoConfig;
  private readonly fetchImpl: FetchImpl;
  private token: string | undefined;

  constructor(input: { config: ZentaoConfig; fetchImpl?: FetchImpl }) {
    this.config = input.config;
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  async login(): Promise<string> {
    const response = await this.fetchJson(`${this.config.api_base_url}/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account: this.config.account,
        password: this.config.password,
      }),
    });

    if (!response.ok) {
      throw new ZentaoHttpError({
        status: response.status,
        path: "/tokens",
        responseBody: response.body,
      });
    }

    if (!isTokenResponse(response.body)) {
      throw new Error("ZenTao login response did not include token");
    }

    this.token = response.body.token;
    return this.token;
  }

  async request(request: ZentaoRequest): Promise<unknown> {
    return this.requestWithRetry(request, false);
  }

  private async requestWithRetry(request: ZentaoRequest, alreadyRetried: boolean): Promise<unknown> {
    const token = this.token ?? (await this.login());
    const response = await this.fetchJson(this.buildUrl(request), {
      method: request.method,
      headers: {
        "content-type": "application/json",
        Token: token,
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });

    if (response.ok) {
      return response.body;
    }

    if (!alreadyRetried && isAuthFailure(response.status, response.body)) {
      // Retry exactly once so an expired token can recover without looping on bad credentials.
      this.token = undefined;
      return this.requestWithRetry(request, true);
    }

    throw new ZentaoHttpError({
      status: response.status,
      path: request.path,
      responseBody: response.body,
    });
  }

  private buildUrl(request: ZentaoRequest): string {
    const url = new URL(`${this.config.api_base_url}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async fetchJson(
    url: string,
    init: RequestInit,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const response = await this.fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(this.config.timeout_seconds * 1000),
    });

    const text = await response.text();
    const body = text.length === 0 ? null : parseJsonOrText(text);
    return { ok: response.ok, status: response.status, body };
  }
}

function parseJsonOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isTokenResponse(value: unknown): value is { token: string } {
  return Boolean(
    value &&
      typeof value === "object" &&
      "token" in value &&
      typeof (value as { token: unknown }).token === "string",
  );
}

function isAuthFailure(status: number, body: unknown): boolean {
  if (status === 401 || status === 403) return true;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return /unauthorized|unauthenticated|invalid token|token expired/i.test(text);
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /password|token/i.test(key) ? "<redacted>" : redactSecrets(item),
      ]),
    );
  }
  return value;
}
