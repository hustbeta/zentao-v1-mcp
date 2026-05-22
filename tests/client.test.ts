import { describe, expect, it } from "vitest";
import { ZentaoClient } from "../src/zentao/client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function testConfig() {
  return {
    base_url: "https://zentao.example.com",
    api_base_url: "https://zentao.example.com/api.php/v1",
    account: "demo",
    password: "secret",
    timeout_seconds: 20,
  };
}

describe("ZentaoClient", () => {
  it("logs in and sends Token header", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/tokens")) return jsonResponse({ token: "abc" });
      return jsonResponse({ ok: true });
    };

    const client = new ZentaoClient({
      config: testConfig(),
      fetchImpl,
    });

    await client.request({ method: "GET", path: "/products" });

    expect(calls[0].url).toBe("https://zentao.example.com/api.php/v1/tokens");
    expect(calls[1].init?.headers).toMatchObject({ Token: "abc" });
  });

  it("re-logins once after an auth-style response", async () => {
    let productCalls = 0;
    let tokenCalls = 0;
    const fetchImpl = async (url: string | URL | Request) => {
      if (String(url).endsWith("/tokens")) {
        tokenCalls += 1;
        return jsonResponse({ token: `token-${tokenCalls}` });
      }
      productCalls += 1;
      return productCalls === 1 ? jsonResponse({ error: "unauthorized" }, 401) : jsonResponse({ ok: true });
    };

    const client = new ZentaoClient({
      config: testConfig(),
      fetchImpl,
    });

    await expect(client.request({ method: "GET", path: "/products" })).resolves.toEqual({ ok: true });
    expect(tokenCalls).toBe(2);
    expect(productCalls).toBe(2);
  });

  it("adds query parameters to requests", async () => {
    const urls: string[] = [];
    const fetchImpl = async (url: string | URL | Request) => {
      urls.push(String(url));
      if (String(url).endsWith("/tokens")) return jsonResponse({ token: "abc" });
      return jsonResponse({ ok: true });
    };

    const client = new ZentaoClient({
      config: testConfig(),
      fetchImpl,
    });

    await client.request({ method: "GET", path: "/products", query: { page: 1, limit: 20 } });

    expect(urls[1]).toBe("https://zentao.example.com/api.php/v1/products?page=1&limit=20");
  });
});
