import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../../src/server.js";

describe("mcp smoke", () => {
  it("registers fewer than 20 tools", () => {
    const server = createServer({
      request: async () => ({ ok: true }),
    });

    const tools = server.toolNamesForTest();
    expect(tools).toContain("zentao_list_products");
    expect(tools).toContain("zentao_create_build");
    expect(tools.length).toBeLessThan(20);
  });

  it("serves tools/list through MCP transport", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer({
      request: async () => ({ ok: true }),
    });
    const client = new Client({ name: "zentao-v1-mcp-test", version: "0.1.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.listTools();

    expect(result.tools.map((tool) => tool.name)).toContain("zentao_get_object");
    expect(result.tools).toHaveLength(server.toolNamesForTest().length);

    await client.close();
    await server.close();
  });
});
