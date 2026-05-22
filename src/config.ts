import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export type RawConfig = Partial<{
  base_url: string;
  account: string;
  password: string;
  timeout_seconds: number;
}>;

export type ZentaoConfig = {
  base_url: string;
  api_base_url: string;
  account: string;
  password: string;
  timeout_seconds: number;
};

const RawConfigSchema = z.object({
  base_url: z.string().url(),
  account: z.string().min(1),
  password: z.string().min(1),
  timeout_seconds: z.number().int().positive().default(20),
});

export function defaultConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string {
  if (platform === "win32") {
    const appData = env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "zentao-v1-mcp", "config.json");
  }

  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "zentao-v1-mcp", "config.json");
}

export function loadConfigFromSources(input: {
  fileConfig: RawConfig;
  env: NodeJS.ProcessEnv;
}): ZentaoConfig {
  const merged: RawConfig = {
    ...input.fileConfig,
    base_url: input.env.ZENTAO_BASE_URL ?? input.fileConfig.base_url,
    account: input.env.ZENTAO_ACCOUNT ?? input.fileConfig.account,
    password: input.env.ZENTAO_PASSWORD ?? input.fileConfig.password,
    timeout_seconds: input.env.ZENTAO_TIMEOUT_SECONDS
      ? Number(input.env.ZENTAO_TIMEOUT_SECONDS)
      : input.fileConfig.timeout_seconds,
  };

  const missing = ["base_url", "account", "password"].filter((key) => {
    const value = merged[key as keyof RawConfig];
    return value === undefined || value === "";
  });
  if (missing.length > 0) {
    throw new Error(`Missing required config fields: ${missing.join(", ")}`);
  }

  const parsed = RawConfigSchema.parse(merged);
  const baseUrl = parsed.base_url.replace(/\/+$/, "");

  return {
    ...parsed,
    base_url: baseUrl,
    // ZenTao RESTful API v1 docs use this fixed prefix; endpoint registry paths stay relative to it.
    api_base_url: `${baseUrl}/api.php/v1`,
  };
}

export function readConfigFile(path = defaultConfigPath()): RawConfig {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as RawConfig;
}

export function writeExampleConfig(path = defaultConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        base_url: "https://zentao.example.com",
        account: "your-account",
        password: "your-password",
        timeout_seconds: 20,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export function loadConfig(path = defaultConfigPath(), env = process.env): ZentaoConfig {
  return loadConfigFromSources({ fileConfig: readConfigFile(path), env });
}

export function redactConfig(
  config: ZentaoConfig,
): Omit<ZentaoConfig, "password"> & { password: string } {
  return { ...config, password: "<redacted>" };
}
