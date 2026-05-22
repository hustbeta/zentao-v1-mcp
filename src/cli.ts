#!/usr/bin/env node

const command = process.argv[2] ?? "serve";
const supportedCommands = ["serve", "init-config", "validate-config", "print-config"];

if (!supportedCommands.includes(command)) {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

// The first task only proves the package entrypoint compiles; later tasks wire real command behavior.
console.error(`zentao-v1-mcp ${command} is not wired yet`);
