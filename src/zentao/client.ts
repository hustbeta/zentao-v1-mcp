import type { ZentaoConfig } from "../config.js";
import { endpoints } from "./endpoints.js";

export type FetchImpl = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ZentaoRequest = {
  method: "GET" | "POST" | "PUT";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

export type ZentaoImageContentType = "image/png" | "image/jpeg" | "image/gif";

export type ZentaoImageUploadRequest = {
  uid: string;
  bytes: Uint8Array;
  filename: string;
  contentType: ZentaoImageContentType;
};

export class ZentaoHttpError extends Error {
  readonly status: number;
  readonly path: string;
  readonly responseBody: unknown;
  readonly authFailure: boolean;

  constructor(input: { status: number; path: string; responseBody: unknown }) {
    super(`ZenTao request failed: ${input.status} ${input.path}`);
    this.status = input.status;
    this.path = input.path;
    // Classify before redaction so callers can retry safely without exposing the raw response body.
    this.authFailure = isAuthFailure(input.status, input.responseBody);
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
    const method = "POST";
    const url = `${this.config.api_base_url}/tokens`;
    let response: { ok: boolean; status: number; body: unknown };
    try {
      response = await this.fetchJson(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          account: this.config.account,
          password: this.config.password,
        }),
      });
    } catch (error) {
      // Transport details are intentionally not displayed because they may contain request context or secrets.
      const reason = error instanceof Error && error.name === "TimeoutError" ? "request timed out" : "network error";
      throw new Error(`ZenTao login failed: ${method} ${url} failed: ${reason}`, { cause: error });
    }

    if (!response.ok) {
      throw new Error(`ZenTao login failed: ${method} ${url} returned HTTP ${response.status}`);
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

  async getToken(): Promise<string> {
    return this.token ?? this.login();
  }

  // Pinned tokens keep the image uid session association and deliberately skip relogin.
  async requestWithToken(request: ZentaoRequest, token: string): Promise<unknown> {
    return this.sendJson(request, token);
  }

  async uploadImage(request: ZentaoImageUploadRequest, token: string): Promise<unknown> {
    const form = new FormData();
    form.append(
      "imgFile",
      new Blob([request.bytes.slice().buffer as ArrayBuffer], { type: request.contentType }),
      request.filename,
    );
    const uploadRequest: ZentaoRequest = {
      method: endpoints.uploadFile.method,
      path: endpoints.uploadFile.path,
      query: { uid: request.uid },
    };
    const response = await this.fetchJson(this.buildUrl(uploadRequest), {
      method: endpoints.uploadFile.method,
      headers: { Token: token },
      body: form,
    });
    if (response.ok) return response.body;
    throw new ZentaoHttpError({
      status: response.status,
      path: endpoints.uploadFile.path,
      responseBody: response.body,
    });
  }

  private async requestWithRetry(request: ZentaoRequest, alreadyRetried: boolean): Promise<unknown> {
    const token = await this.getToken();
    try {
      return await this.sendJson(request, token);
    } catch (error) {
      if (error instanceof ZentaoHttpError && !alreadyRetried && error.authFailure) {
        // Retry exactly once so an expired token can recover without looping on bad credentials.
        this.token = undefined;
        return this.requestWithRetry(request, true);
      }
      throw error;
    }
  }

  private async sendJson(request: ZentaoRequest, token: string): Promise<unknown> {
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

export function isAuthFailure(status: number, body: unknown): boolean {
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
        /password|token|cookie|uid/i.test(key) ? "<redacted>" : redactSecrets(item),
      ]),
    );
  }
  return value;
}
