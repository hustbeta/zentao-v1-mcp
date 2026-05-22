import { describe, expect, it } from "vitest";
import { resolveGenericGetRequest, resolveGenericListRequest } from "../src/tools/genericTools.js";

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

  it("rejects unsupported resources before HTTP dispatch", () => {
    expect(() => resolveGenericGetRequest({ resource: "raw_path", id: 1 } as never)).toThrow(
      /unsupported/i,
    );
  });

  it("preserves parameter validation errors for supported resources", () => {
    expect(() => resolveGenericListRequest({ resource: "users", page: 0 })).toThrow(/greater than 0/i);
  });
});
