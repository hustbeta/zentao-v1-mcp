import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

it("lets a failed login exit naturally with code 1", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "zentao-cli-test-"));
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const stderr: string[] = [];

  try {
    process.argv = [process.execPath, "src/cli.ts", "validate-config", "--login"];
    vi.stubEnv("APPDATA", configHome);
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
    vi.stubEnv("ZENTAO_BASE_URL", "https://zentao.example.com/api.php/v1");
    vi.stubEnv("ZENTAO_ACCOUNT", "test-account");
    vi.stubEnv("ZENTAO_PASSWORD", "test-password");
    vi.stubEnv("ZENTAO_TIMEOUT_SECONDS", "20");
    vi.stubGlobal("fetch", async () => new Response("invalid login", { status: 401 }));
    vi.spyOn(console, "error").mockImplementation((message) => stderr.push(String(message)));
    // Throwing here distinguishes a forced exit from exitCode without terminating the Vitest process.
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    await expect(import("../src/cli.js")).resolves.toBeDefined();

    expect(process.exitCode).toBe(1);
    expect(stderr).toContain(
      "Config error: ZenTao login failed: POST https://zentao.example.com/api.php/v1/tokens returned HTTP 401",
    );
    expect(stderr.join("\n")).not.toMatch(/test-account|test-password|invalid login|UV_HANDLE_CLOSING/);
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(configHome, { recursive: true, force: true });
  }
});
