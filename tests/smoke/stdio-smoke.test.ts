import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../../src/server.js";
import { ZentaoHttpError } from "../../src/zentao/client.js";

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

  it("returns redacted HTTP error details from tool handlers", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer({
      request: async () => {
        throw new ZentaoHttpError({
          status: 404,
          path: "/products",
          responseBody: { error: "not found", token: "hidden-token" },
        });
      },
    });
    const client = new Client({ name: "zentao-v1-mcp-test", version: "0.1.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: "zentao_list_products", arguments: {} });
    const payload = JSON.parse(result.content[0].type === "text" ? result.content[0].text : "{}");

    expect(result.isError).toBe(true);
    expect(payload.details).toMatchObject({
      status: 404,
      path: "/products",
      responseBody: { error: "not found", token: "<redacted>" },
    });
    expect(JSON.stringify(payload)).not.toContain("hidden-token");

    await client.close();
    await server.close();
  });
});
