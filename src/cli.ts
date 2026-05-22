#!/usr/bin/env node

import { defaultConfigPath, loadConfig, redactConfig, writeExampleConfig } from "./config.js";

const command = process.argv[2] ?? "serve";
const supportedCommands = ["serve", "init-config", "validate-config", "print-config"];

if (!supportedCommands.includes(command)) {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

try {
  if (command === "init-config") {
    const path = defaultConfigPath();
    writeExampleConfig(path);
    console.error(`Wrote example config: ${path}`);
  } else if (command === "print-config") {
    // print-config is a CLI command, not MCP stdio traffic, so stdout is safe here.
    process.stdout.write(`${JSON.stringify(redactConfig(loadConfig()), null, 2)}\n`);
  } else if (command === "validate-config") {
    const config = redactConfig(loadConfig());
    console.error(`Config OK: ${JSON.stringify(config)}`);
  } else {
    // Serve is wired after the MCP server and HTTP client exist.
    console.error(`zentao-v1-mcp ${command} is not wired yet`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Config error: ${message}`);
  process.exit(1);
}
