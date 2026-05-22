import { describe, expect, it } from "vitest";
import { createWriteSummary, ensureConfirmed } from "../src/safety.js";
import { resolveCreateBuildRequest, resolveUpdateBuildRequest } from "../src/tools/buildTools.js";

describe("write safety", () => {
  it("blocks writes without confirm=true", () => {
    expect(ensureConfirmed(false)).toEqual(false);
  });

  it("allows writes with confirm=true", () => {
    expect(ensureConfirmed(true)).toEqual(true);
  });

  it("returns redacted dry-run summary", () => {
    const summary = createWriteSummary({
      method: "POST",
      path: "/projects/1/builds",
      body: { name: "build-1", token: "hidden" },
    });

    expect(summary.requires_confirmation).toBe(true);
    expect(JSON.stringify(summary)).not.toContain("hidden");
  });
});

describe("build tools", () => {
  it("dry-runs create build without confirm=true", async () => {
    const calls: unknown[] = [];
    const result = await resolveCreateBuildRequest(
      {
        project_id: 1,
        execution: 2,
        product: 3,
        name: "build-1",
        builder: "admin",
      },
      async (request) => calls.push(request),
    );

    expect(calls).toHaveLength(0);
    expect(JSON.stringify(result)).toContain("requires_confirmation");
  });

  it("sends create build when confirmed", async () => {
    const calls: unknown[] = [];
    await resolveCreateBuildRequest(
      {
        project_id: 1,
        execution: 2,
        product: 3,
        name: "build-1",
        builder: "admin",
        confirm: true,
      },
      async (request) => calls.push(request),
    );

    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/projects/1/builds",
      body: { execution: 2, product: 3, name: "build-1", builder: "admin" },
    });
  });

  it("accepts numeric branch IDs for create build", async () => {
    const calls: unknown[] = [];
    await resolveCreateBuildRequest(
      {
        project_id: 1,
        execution: 2,
        product: 3,
        name: "build-1",
        builder: "admin",
        branch: 0,
        confirm: true,
      },
      async (request) => calls.push(request),
    );

    expect(calls[0]).toMatchObject({
      body: { branch: 0 },
    });
  });

  it("requires at least one update field", () => {
    expect(() => resolveUpdateBuildRequest({ build_id: 9, confirm: true }, async () => undefined)).toThrow(
      /at least one/,
    );
  });

  it("accepts numeric branch IDs for update build", async () => {
    const calls: unknown[] = [];
    await resolveUpdateBuildRequest(
      {
        build_id: 9,
        branch: 0,
        confirm: true,
      },
      async (request) => calls.push(request),
    );

    expect(calls[0]).toMatchObject({
      method: "PUT",
      path: "/builds/9",
      body: { branch: 0 },
    });
  });
});
