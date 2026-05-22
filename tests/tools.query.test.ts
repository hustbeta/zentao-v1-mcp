import { describe, expect, it } from "vitest";
import { resolveQueryToolRequest } from "../src/tools/queryTools.js";

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
