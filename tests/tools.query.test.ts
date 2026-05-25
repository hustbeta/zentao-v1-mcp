import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import {
  filterExecutionBugsForTest,
  readProductsFromExecutionForTest,
  readProductsFromItemsForTest,
} from "../src/tools/bugQuery.js";
import {
  fetchAllPagesForTest,
  listBugsForTest,
  parseBugScopeForTest,
  resolveQueryToolRequest,
} from "../src/tools/queryTools.js";
import { endpoints } from "../src/zentao/endpoints.js";
import { createServer } from "../src/server.js";

describe("query tools", () => {
  it("uses pagination defaults", () => {
    const request = resolveQueryToolRequest("zentao_list_products", {});
    expect(request).toMatchObject({ method: "GET", path: "/products", query: { page: 1, limit: 20 } });
  });

  it("requires exactly one story scope", () => {
    expect(() =>
      resolveQueryToolRequest("zentao_list_stories", { product_id: 1, project_id: 2 }),
    ).toThrow(/exactly one/);
  });

  it("maps story scopes to documented paths", () => {
    expect(resolveQueryToolRequest("zentao_list_stories", { execution_id: 3 }).path).toBe(
      "/executions/3/stories",
    );
  });

  it("requires execution_id for tasks", () => {
    expect(() => resolveQueryToolRequest("zentao_list_tasks", {})).toThrow(/execution_id/);
  });
});

describe("zentao_list_bugs scope validation", () => {
  it("accepts execution scope in the exposed bug schema", () => {
    expect(parseBugScopeForTest({ execution_id: 1510, status: "unclosed" })).toMatchObject({
      execution_id: 1510,
      status: "unclosed",
      page: 1,
      limit: 20,
    });
  });

  it("keeps product-scoped bug listing compatible", () => {
    const request = resolveQueryToolRequest("zentao_list_bugs", {
      product_id: 60,
      page: 1,
      limit: 20,
    });

    expect(request).toEqual({
      method: "GET",
      path: "/products/60/bugs",
      query: { page: 1, limit: 20 },
    });
  });

  it("keeps execution-scoped bug listing out of the single-request resolver", () => {
    expect(() =>
      resolveQueryToolRequest("zentao_list_bugs", {
        execution_id: 1510,
        status: "unclosed",
      }),
    ).toThrow(/advanced bug filters|single-request resolver/);
  });

  it("rejects product-scoped advanced filters in the single-request resolver", () => {
    expect(() =>
      resolveQueryToolRequest("zentao_list_bugs", {
        product_id: 60,
        status: "unclosed",
      }),
    ).toThrow(/advanced bug filters|single-request resolver/);
  });

  it("requires product_id or execution_id", () => {
    expect(() => parseBugScopeForTest({})).toThrow(
      /Expected at least one of: product_id, execution_id/,
    );
  });

  it("points bug-id detail lookups to zentao_get_object when bug list scope is missing", () => {
    expect(() => parseBugScopeForTest({})).toThrow(/zentao_get_object/);
    expect(() => parseBugScopeForTest({})).toThrow(/resource.*bug/i);
    expect(() => parseBugScopeForTest({})).toThrow(/id/);
  });
});

describe("filterExecutionBugs", () => {
  it("filters bugs by execution, status, and assignee", () => {
    const bugs = [
      { id: 1, execution: 1510, status: "active", assignedTo: { account: "zhuxiaokun" } },
      { id: 2, execution: 1510, status: "closed", assignedTo: { account: "zhuxiaokun" } },
      { id: 3, execution: 1511, status: "active", assignedTo: { account: "zhuxiaokun" } },
      { id: 4, execution: 1510, status: "confirmed", assignedTo: { account: "other" } },
    ];

    expect(
      filterExecutionBugsForTest(bugs, {
        execution_id: 1510,
        status: "unclosed",
        assigned_to_account: "zhuxiaokun",
      }),
    ).toEqual([{ id: 1, execution: 1510, status: "active", assignedTo: { account: "zhuxiaokun" } }]);
  });

  it("treats unclosed as everything except closed", () => {
    const bugs = [
      { id: 1, status: "active" },
      { id: 2, status: "confirmed" },
      { id: 3, status: "resolved" },
      { id: 4, status: "closed" },
    ];

    expect(filterExecutionBugsForTest(bugs, { status: "unclosed" })).toEqual([
      { id: 1, status: "active" },
      { id: 2, status: "confirmed" },
      { id: 3, status: "resolved" },
    ]);
  });

  it("returns every bug when status is all", () => {
    const bugs = [
      { id: 1, status: "active" },
      { id: 2, status: "closed" },
    ];

    expect(filterExecutionBugsForTest(bugs, { status: "all" })).toEqual(bugs);
  });

  it("supports object-shaped bug status with code", () => {
    const bugs = [
      { id: 1, status: { code: "active", name: "Active" } },
      { id: 2, status: { code: "closed", name: "Closed" } },
    ];

    expect(filterExecutionBugsForTest(bugs, { status: "active" })).toEqual([
      { id: 1, status: { code: "active", name: "Active" } },
    ]);
  });

  it("filters by exact assignee account when status is all", () => {
    const bugs = [
      { id: 1, assignedTo: { account: "zhuxiaokun" } },
      { id: 2, assignedTo: { account: "other" } },
      { id: 3, assignedTo: null },
    ];

    expect(
      filterExecutionBugsForTest(bugs, { status: "all", assigned_to_account: "zhuxiaokun" }),
    ).toEqual([{ id: 1, assignedTo: { account: "zhuxiaokun" } }]);
  });
});

describe("zentao_list_bugs advanced handler", () => {
  it("lists execution bugs through product bugs when product_id is provided", async () => {
    const calls: unknown[] = [];
    const client = {
      async request(request: { path: string; query?: { page?: number; limit?: number } }) {
        calls.push(request);
        if (request.path === "/products/60/bugs" && request.query?.page === 1) {
          return {
            page: 1,
            total: 101,
            limit: 100,
            bugs: Array.from({ length: 100 }, (_, index) => ({
              id: index + 1,
              execution: 1511,
              status: "active",
            })),
          };
        }
        return {
          page: 2,
          total: 101,
          limit: 100,
          bugs: [{ id: 101, execution: 1510, status: "active" }],
        };
      },
    };

    const result = await listBugsForTest(client, {
      product_id: 60,
      execution_id: 1510,
      status: "unclosed",
      page: 1,
      limit: 20,
    });

    expect(calls).toEqual([
      {
        method: "GET",
        path: "/products/60/bugs",
        query: { page: 1, limit: 100 },
      },
      {
        method: "GET",
        path: "/products/60/bugs",
        query: { page: 2, limit: 100 },
      },
    ]);
    expect(result.total).toBe(1);
    expect(result.source).toMatchObject({
      product_id: 60,
      execution_id: 1510,
      product_inference: "provided",
      scanned_total: 101,
      scan_pages: 2,
      scan_limit: 100,
    });
    expect(result.filters).toEqual({ status: "unclosed" });
    expect(result.bugs).toEqual([{ id: 101, execution: 1510, status: "active" }]);
  });

  it("filters product bugs by status without execution_id", async () => {
    const calls: unknown[] = [];
    const client = {
      async request(request: unknown) {
        calls.push(request);
        return {
          page: 1,
          total: 2,
          limit: 100,
          bugs: [
            { id: 1, status: "active" },
            { id: 2, status: "closed" },
          ],
        };
      },
    };

    const result = await listBugsForTest(client, {
      product_id: 60,
      status: "unclosed",
      page: 1,
      limit: 20,
    });

    expect(calls).toEqual([
      {
        method: "GET",
        path: "/products/60/bugs",
        query: { page: 1, limit: 100 },
      },
    ]);
    expect(result.total).toBe(1);
    expect(result.bugs).toEqual([{ id: 1, status: "active" }]);
  });

  it("paginates after filtering all scanned product bugs", async () => {
    const client = {
      async request() {
        return {
          page: 1,
          total: 3,
          limit: 100,
          bugs: [
            { id: 1, status: "active" },
            { id: 2, status: "closed" },
            { id: 3, status: "confirmed" },
          ],
        };
      },
    };

    const result = await listBugsForTest(client, {
      product_id: 60,
      status: "unclosed",
      page: 2,
      limit: 1,
    });

    expect(result.total).toBe(2);
    expect(result.page).toBe(2);
    expect(result.limit).toBe(1);
    expect(result.bugs).toEqual([{ id: 3, status: "confirmed" }]);
  });

  it("filters by assignee without execution_id or status changes", async () => {
    const client = {
      async request() {
        return {
          page: 1,
          total: 3,
          limit: 100,
          bugs: [
            { id: 1, assignedTo: { account: "zhuxiaokun" } },
            { id: 2, assignedTo: { account: "other" } },
            { id: 3, assignedTo: { account: "zhuxiaokun" } },
          ],
        };
      },
    };

    const result = await listBugsForTest(client, {
      product_id: 60,
      assigned_to_account: "zhuxiaokun",
      status: "all",
      page: 1,
      limit: 20,
    });

    expect(result.total).toBe(2);
    expect(result.filters).toEqual({ assigned_to_account: "zhuxiaokun" });
    expect(result.bugs).toEqual([
      { id: 1, assignedTo: { account: "zhuxiaokun" } },
      { id: 3, assignedTo: { account: "zhuxiaokun" } },
    ]);
  });
});

describe("zentao_list_bugs product inference", () => {
  it("infers product_id from observed execution.products when it is uniquely available", async () => {
    const calls: unknown[] = [];
    const client = {
      async request(request: { path: string; query?: { page?: number; limit?: number } }) {
        calls.push(request);
        if (request.path === "/executions/1510") {
          return { id: 1510, products: [{ id: 60, name: "HW虚拟机" }] };
        }
        if (request.path === "/products/60/bugs") {
          return { page: 1, total: 0, limit: 100, bugs: [] };
        }
        throw new Error(`unexpected path ${request.path}`);
      },
    };

    const result = await listBugsForTest(client, {
      execution_id: 1510,
      status: "unclosed",
      page: 1,
      limit: 20,
    });

    expect(result.source).toMatchObject({
      product_id: 60,
      product_inference: "execution_products",
    });
    expect(calls).toContainEqual({ method: "GET", path: "/executions/1510" });
    expect(calls).not.toContainEqual(
      expect.objectContaining({ path: "/executions/1510/stories" }),
    );
    expect(calls).not.toContainEqual(
      expect.objectContaining({ path: "/executions/1510/builds" }),
    );
  });

  it("falls back to execution stories after observed execution.products is unavailable", async () => {
    const calls: unknown[] = [];
    const client = {
      async request(request: { path: string; query?: { page?: number; limit?: number } }) {
        calls.push(request);
        if (request.path === "/executions/1510") {
          return { id: 1510 };
        }
        if (request.path === "/executions/1510/stories" && request.query?.page === 1) {
          return {
            page: 1,
            total: 101,
            limit: 100,
            stories: Array.from({ length: 100 }, (_, index) => ({
              id: index + 1,
              product: 60,
            })),
          };
        }
        if (request.path === "/executions/1510/stories" && request.query?.page === 2) {
          return {
            page: 2,
            total: 101,
            limit: 100,
            stories: [{ id: 101, product: 60 }],
          };
        }
        if (request.path === "/products/60/bugs") {
          return { page: 1, total: 0, limit: 100, bugs: [] };
        }
        throw new Error(`unexpected path ${request.path}`);
      },
    };

    const result = await listBugsForTest(client, {
      execution_id: 1510,
      status: "unclosed",
      page: 1,
      limit: 20,
    });

    expect(result.source.product_id).toBe(60);
    expect(result.source.product_inference).toBe("execution_stories");
    expect(calls).toContainEqual({ method: "GET", path: "/executions/1510" });
    expect(calls).toContainEqual({
      method: "GET",
      path: "/executions/1510/stories",
      query: { page: 1, limit: 100 },
    });
    expect(calls).toContainEqual({
      method: "GET",
      path: "/executions/1510/stories",
      query: { page: 2, limit: 100 },
    });
  });

  it("falls back to execution stories when GET /executions/{id} fails", async () => {
    // The plan treats execution.products as an observed-but-undocumented fast
    // path. A request-level failure must not abort inference; it must fall
    // through to the documented stories scan. The fake throws on unexpected
    // paths so that any accidental swallow of documented endpoint errors would
    // surface as an "unexpected path" failure here.
    const calls: unknown[] = [];
    const client = {
      async request(request: { path: string; query?: { page?: number; limit?: number } }) {
        calls.push(request);
        if (request.path === "/executions/1510") {
          throw new Error("ZenTao request failed: 500 /executions/1510");
        }
        if (request.path === "/executions/1510/stories" && request.query?.page === 1) {
          return {
            page: 1,
            total: 1,
            limit: 100,
            stories: [{ id: 1, product: 60 }],
          };
        }
        if (request.path === "/products/60/bugs") {
          return { page: 1, total: 0, limit: 100, bugs: [] };
        }
        throw new Error(`unexpected path ${request.path}`);
      },
    };

    const result = await listBugsForTest(client, {
      execution_id: 1510,
      status: "unclosed",
      page: 1,
      limit: 20,
    });

    expect(result.source.product_id).toBe(60);
    expect(result.source.product_inference).toBe("execution_stories");
    expect(calls).toContainEqual({ method: "GET", path: "/executions/1510" });
    expect(calls).toContainEqual({
      method: "GET",
      path: "/executions/1510/stories",
      query: { page: 1, limit: 100 },
    });
  });

  it("falls back to execution builds when stories yield no product", async () => {
    const client = {
      async request(request: { path: string; query?: { page?: number; limit?: number } }) {
        if (request.path === "/executions/1510") return { id: 1510 };
        if (request.path === "/executions/1510/stories") {
          return { page: 1, total: 0, limit: 100, stories: [] };
        }
        if (request.path === "/executions/1510/builds" && request.query?.page === 1) {
          return { total: 1, builds: [{ id: 1, product: 60 }] };
        }
        if (request.path === "/products/60/bugs") {
          return { page: 1, total: 0, limit: 100, bugs: [] };
        }
        throw new Error(`unexpected path ${request.path}`);
      },
    };

    const result = await listBugsForTest(client, {
      execution_id: 1510,
      status: "unclosed",
      page: 1,
      limit: 20,
    });

    expect(result.source.product_id).toBe(60);
    expect(result.source.product_inference).toBe("execution_builds");
  });

  it("extracts product_id from documented numeric IDs and object IDs", () => {
    expect(
      readProductsFromExecutionForTest({ products: [60, "60", { id: 60 }, { id: "60" }] }),
    ).toEqual([60, 60, 60, 60]);
    expect(readProductsFromItemsForTest([{ product: 60 }, { product: { id: 60 } }])).toEqual([
      60, 60,
    ]);
    expect(
      readProductsFromItemsForTest([{ product: 0 }, { product: "abc" }, { product: {} }]),
    ).toEqual([]);
  });

  it("rejects multiple products from execution.products as not uniquely inferable", async () => {
    const client = {
      async request(request: { path: string }) {
        if (request.path === "/executions/1510") {
          return { id: 1510, products: [{ id: 60 }, { id: 61 }] };
        }
        if (request.path === "/executions/1510/stories") {
          return { page: 1, total: 0, limit: 100, stories: [] };
        }
        if (request.path === "/executions/1510/builds") {
          return { total: 0, builds: [] };
        }
        throw new Error(`unexpected path ${request.path}`);
      },
    };

    await expect(
      listBugsForTest(client, {
        execution_id: 1510,
        status: "unclosed",
        page: 1,
        limit: 20,
      }),
    ).rejects.toThrow(/Could not infer a unique product_id/);
  });

  it("asks for product_id when execution product cannot be inferred", async () => {
    const client = {
      async request(request: { path: string }) {
        if (request.path === "/executions/1510") return { id: 1510, products: [] };
        if (request.path === "/executions/1510/stories")
          return { page: 1, total: 0, limit: 100, stories: [] };
        if (request.path === "/executions/1510/builds")
          return { page: 1, total: 0, limit: 100, builds: [] };
        throw new Error(`unexpected path ${request.path}`);
      },
    };

    await expect(
      listBugsForTest(client, {
        execution_id: 1510,
        status: "unclosed",
        page: 1,
        limit: 20,
      }),
    ).rejects.toThrow(/Could not infer a unique product_id/);
  });

  it("returns an MCP error when execution product inference fails", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer({
      async request(request: { path: string }) {
        if (request.path === "/executions/1510") return { id: 1510, products: [] };
        if (request.path === "/executions/1510/stories")
          return { page: 1, total: 0, limit: 100, stories: [] };
        if (request.path === "/executions/1510/builds") return { total: 0, builds: [] };
        throw new Error(`unexpected path ${request.path}`);
      },
    });
    const client = new Client({ name: "zentao-v1-mcp-test", version: "0.1.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({
      name: "zentao_list_bugs",
      arguments: { execution_id: 1510, status: "unclosed" },
    });

    expect(result.isError).toBe(true);
    const content = Array.isArray(result.content) ? result.content : [];
    const first = content[0];
    const text = first && first.type === "text" ? first.text : "";
    expect(text).toMatch(/Could not infer a unique product_id/);

    await client.close();
    await server.close();
  });
});

describe("fetchAllPages pagination fallback", () => {
  it("continues scanning when total exists but response page and limit are missing", async () => {
    const calls: unknown[] = [];
    const client = {
      async request(request: { path: string; query?: { page?: number; limit?: number } }) {
        calls.push(request);
        if (request.query?.page === 1) {
          return {
            total: 101,
            builds: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })),
          };
        }
        return { total: 101, builds: [{ id: 101 }] };
      },
    };

    const result = await fetchAllPagesForTest(client, {
      endpoint: endpoints.executionBuilds,
      pathParams: { execution_id: 1510 },
      listKey: "builds",
    });

    expect(calls.map((call) => (call as { query?: { page?: number } }).query?.page)).toEqual([1, 2]);
    expect(result.items).toHaveLength(101);
    expect(result.scan_pages).toBe(2);
    expect(result.scan_limit).toBe(100);
    expect(result.scanned_total).toBe(101);
  });
});
