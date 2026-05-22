import { describe, expect, it } from "vitest";
import { loadConfigFromSources, redactConfig } from "../src/config.js";

describe("config", () => {
  it("normalizes base_url and loads file values", () => {
    const config = loadConfigFromSources({
      fileConfig: {
        base_url: "https://zentao.example.com/",
        account: "demo",
        password: "secret",
        timeout_seconds: 20,
      },
      env: {},
    });

    expect(config).toMatchObject({
      base_url: "https://zentao.example.com",
      api_base_url: "https://zentao.example.com/api.php/v1",
      account: "demo",
      timeout_seconds: 20,
    });
  });

  it("lets environment variables override file values", () => {
    const config = loadConfigFromSources({
      fileConfig: {
        base_url: "https://old.example.com",
        account: "old",
        password: "old-secret",
        timeout_seconds: 20,
      },
      env: {
        ZENTAO_BASE_URL: "https://new.example.com",
        ZENTAO_ACCOUNT: "new",
        ZENTAO_PASSWORD: "new-secret",
        ZENTAO_TIMEOUT_SECONDS: "5",
      },
    });

    expect(config.base_url).toBe("https://new.example.com");
    expect(config.account).toBe("new");
    expect(config.password).toBe("new-secret");
    expect(config.timeout_seconds).toBe(5);
  });

  it("rejects missing required fields", () => {
    expect(() => loadConfigFromSources({ fileConfig: {}, env: {} })).toThrow(
      /base_url.*account.*password/s,
    );
  });

  it("redacts password and token-like fields", () => {
    expect(
      JSON.stringify(
        redactConfig({
          base_url: "https://zentao.example.com",
          api_base_url: "https://zentao.example.com/api.php/v1",
          account: "demo",
          password: "secret",
          timeout_seconds: 20,
        }),
      ),
    ).not.toContain("secret");
  });
});
