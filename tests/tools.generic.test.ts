import { describe, expect, it } from "vitest";
import {
  registerGenericTools,
  resolveGenericGetRequest,
  resolveGenericListRequest,
} from "../src/tools/genericTools.js";
import type { McpServerLike, ZentaoRequester } from "../src/tools/queryTools.js";

type RegisteredTool = {
  name: string;
  description: string;
  paramsSchema: Parameters<McpServerLike["tool"]>[2];
};

describe("generic tools", () => {
  it("lists scoped product plans", () => {
    expect(resolveGenericListRequest({ resource: "product_plans", product_id: 5 }).path).toBe(
      "/products/5/plans",
    );
  });

  it("rejects parent IDs for unscoped lists", () => {
    expect(() => resolveGenericListRequest({ resource: "users", product_id: 1 })).toThrow(
      /must not receive/,
    );
  });

  it("gets constrained detail resources", () => {
    expect(resolveGenericGetRequest({ resource: "ticket", id: 9 }).path).toBe("/tickets/9");
  });

  it("describes get-object as an ID detail lookup for common resources", () => {
    const registeredTools: RegisteredTool[] = [];
    const server: McpServerLike = {
      tool(name, description, paramsSchema) {
        registeredTools.push({ name, description, paramsSchema });
      },
    };
    const client: ZentaoRequester = { request: async () => ({}) };

    registerGenericTools(server, client);

    const getTool = registeredTools.find((tool) => tool.name === "zentao_get_object");
    expect(getTool).toBeDefined();
    if (getTool === undefined) throw new Error("zentao_get_object was not registered");

    expect(getTool.description).toContain("by ID");
    expect(getTool.description).toContain("bug");
    expect(getTool.description).toContain("story");
    expect(getTool.description).toContain("task");
    expect(getTool.description).toContain("execution");
    expect(getTool.paramsSchema.resource.description).toContain("bug");
    expect(getTool.paramsSchema.resource.description).toContain("ticket");
  });

  it("rejects unsupported resources before HTTP dispatch", () => {
    expect(() => resolveGenericGetRequest({ resource: "raw_path", id: 1 } as never)).toThrow(
      /unsupported/i,
    );
  });

  it("preserves parameter validation errors for supported resources", () => {
    expect(() => resolveGenericListRequest({ resource: "users", page: 0 })).toThrow(/greater than 0/i);
  });
});
