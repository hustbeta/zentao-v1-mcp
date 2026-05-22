#!/usr/bin/env node

import { defaultConfigPath, loadConfig, redactConfig, writeExampleConfig } from "./config.js";
import { serveStdio } from "./server.js";
import { ZentaoClient } from "./zentao/client.js";

const command = process.argv[2] ?? "serve";
const args = process.argv.slice(3);
const supportedCommands = ["serve", "init-config", "validate-config", "print-config"];

if (!supportedCommands.includes(command)) {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (command === "init-config") {
    const path = defaultConfigPath();
    writeExampleConfig(path);
    console.error(`Wrote example config: ${path}`);
  } else if (command === "print-config") {
    // print-config is a CLI command, not MCP stdio traffic, so stdout is safe here.
    process.stdout.write(`${JSON.stringify(redactConfig(loadConfig()), null, 2)}\n`);
  } else if (command === "validate-config") {
    const config = loadConfig();
    if (args.includes("--login")) {
      await new ZentaoClient({ config }).login();
    }
    console.error(`Config OK: ${JSON.stringify(redactConfig(config))}`);
    if (args.includes("--login")) {
      console.error("Login OK");
    }
  } else {
    await serveStdio(new ZentaoClient({ config: loadConfig() }));
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Config error: ${message}`);
  process.exit(1);
}
