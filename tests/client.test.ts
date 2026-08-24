import { describe, expect, it } from "vitest";
import { ZentaoClient, ZentaoHttpError } from "../src/zentao/client.js";

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

  it("reports the full login URL and status without response secrets", async () => {
    const config = testConfig();
    const client = new ZentaoClient({
      config,
      fetchImpl: async () =>
        jsonResponse({ account: config.account, password: config.password, detail: "login body" }, 401),
    });

    let caught: unknown;
    try {
      await client.login();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      "ZenTao login failed: POST https://zentao.example.com/api.php/v1/tokens returned HTTP 401",
    );
    expect((caught as Error).message).not.toContain(config.account);
    expect((caught as Error).message).not.toContain(config.password);
    expect((caught as Error).message).not.toContain("login body");
  });

  it.each([
    ["Error", "network error"],
    ["TimeoutError", "request timed out"],
  ] as const)("reports the login URL for %s failures", async (name, reason) => {
    const config = testConfig();
    const transportError = new Error(`${config.account} ${config.password} raw transport detail`);
    transportError.name = name;
    const client = new ZentaoClient({
      config,
      fetchImpl: async () => {
        throw transportError;
      },
    });

    let caught: unknown;
    try {
      await client.login();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      `ZenTao login failed: POST https://zentao.example.com/api.php/v1/tokens failed: ${reason}`,
    );
    expect((caught as Error).message).not.toContain(config.account);
    expect((caught as Error).message).not.toContain(config.password);
    expect((caught as Error).message).not.toContain("raw transport detail");
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

  it("re-logins once when auth text is only in a token field", async () => {
    let tokenCalls = 0;
    let productCalls = 0;
    const fetchImpl = async (url: string | URL | Request) => {
      if (String(url).endsWith("/tokens")) {
        tokenCalls += 1;
        return jsonResponse({ token: `token-${tokenCalls}` });
      }
      productCalls += 1;
      return productCalls === 1
        ? jsonResponse({ token: "invalid token" }, 400)
        : jsonResponse({ ok: true });
    };

    const client = new ZentaoClient({ config: testConfig(), fetchImpl });

    await expect(client.request({ method: "GET", path: "/products" })).resolves.toEqual({ ok: true });
    expect(tokenCalls).toBe(2);
    expect(productCalls).toBe(2);
  });

  it("keeps JSON headers and body for ordinary POST requests", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ZentaoClient({
      config: testConfig(),
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return String(url).endsWith("/tokens") ? jsonResponse({ token: "abc" }) : jsonResponse({ ok: true });
      },
    });

    await client.request({ method: "POST", path: "/stories", body: { name: "demo" } });

    expect(calls[1].init?.headers).toEqual({ "content-type": "application/json", Token: "abc" });
    expect(calls[1].init?.body).toBe(JSON.stringify({ name: "demo" }));
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

  it("uploads imgFile with a pinned Token and native FormData", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ZentaoClient({
      config: testConfig(),
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ id: 41, url: "/file-read-41.png" });
      },
    });

    await client.uploadImage(
      {
        uid: "operation-1",
        bytes: new Uint8Array([1, 2, 3]),
        filename: "screen.png",
        contentType: "image/png",
      },
      "fixed-token",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://zentao.example.com/api.php/v1/files?uid=operation-1");
    expect(calls[0].init?.headers).toEqual({ Token: "fixed-token" });
    expect(calls[0].init?.headers).not.toHaveProperty("content-type");
    const form = calls[0].init?.body as FormData;
    const file = form.get("imgFile") as File;
    expect(file.name).toBe("screen.png");
    expect(file.type).toBe("image/png");
    expect(await file.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);
  });

  it("does not login or retry requestWithToken after auth failure", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ZentaoClient({
      config: testConfig(),
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ error: "unauthorized" }, 401);
      },
    });

    await expect(
      client.requestWithToken({ method: "POST", path: "/stories/9/change", body: {} }, "expired"),
    ).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://zentao.example.com/api.php/v1/stories/9/change");
    expect(calls[0].init?.headers).toEqual({ "content-type": "application/json", Token: "expired" });
    expect(calls[0].init?.body).toBe(JSON.stringify({}));
  });

  it("redacts nested password token cookie and uid fields from pinned request errors", async () => {
    const client = new ZentaoClient({
      config: testConfig(),
      fetchImpl: async () =>
        jsonResponse(
          {
            Password: "password-secret",
            nested: {
              TOKEN: "token-secret",
              Cookie: "cookie-secret",
              uId: "uid-secret",
              note: "keep-me",
            },
            items: [{ UID: "nested-uid-secret", value: 7 }],
            safe: "visible",
          },
          400,
        ),
    });

    let caught: unknown;
    try {
      await client.requestWithToken({ method: "GET", path: "/stories/9" }, "fixed-token");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ZentaoHttpError);
    expect((caught as ZentaoHttpError).responseBody).toEqual({
      Password: "<redacted>",
      nested: {
        TOKEN: "<redacted>",
        Cookie: "<redacted>",
        uId: "<redacted>",
        note: "keep-me",
      },
      items: [{ UID: "<redacted>", value: 7 }],
      safe: "visible",
    });
  });

  it("does not login or retry uploadImage after auth failure", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ZentaoClient({
      config: testConfig(),
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ error: "unauthorized" }, 401);
      },
    });

    await expect(
      client.uploadImage(
        { uid: "operation-1", bytes: new Uint8Array([1]), filename: "screen.png", contentType: "image/png" },
        "expired",
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://zentao.example.com/api.php/v1/files?uid=operation-1");
  });
});
