import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { errorText } from "./mcp/result.js";
import { registerBuildTools } from "./tools/buildTools.js";
import { registerGenericTools } from "./tools/genericTools.js";
import { registerQueryTools, type McpServerLike, type ZentaoRequester } from "./tools/queryTools.js";

export type CreatedZentaoMcpServer = {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
  toolNamesForTest(): string[];
};

export function createServer(client: ZentaoRequester): CreatedZentaoMcpServer {
  const mcpServer = new McpServer({
    name: "zentao-v1-mcp",
    version: "0.1.0",
  });
  const registeredToolNames: string[] = [];

  const safeServer: McpServerLike = {
    tool(name, description, paramsSchema, handler) {
      registeredToolNames.push(name);
      mcpServer.tool(name, description, paramsSchema, async (args) => {
        try {
          return await handler(args as Record<string, unknown>);
        } catch (error) {
          // Tool handlers must return MCP errors instead of letting HTTP/config errors terminate stdio.
          return errorText(error instanceof Error ? error.message : String(error));
        }
      });
    },
  };

  registerQueryTools(safeServer, client);
  registerBuildTools(safeServer, client);
  registerGenericTools(safeServer, client);

  return {
    connect: (transport) => mcpServer.connect(transport),
    close: () => mcpServer.close(),
    toolNamesForTest: () => [...registeredToolNames],
  };
}

export async function serveStdio(client: ZentaoRequester): Promise<void> {
  const server = createServer(client);
  await server.connect(new StdioServerTransport());
}
