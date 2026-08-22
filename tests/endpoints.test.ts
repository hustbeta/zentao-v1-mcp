import { describe, expect, it } from "vitest";
import { endpointKeys, endpoints, renderPath } from "../src/zentao/endpoints.js";

describe("endpoint registry", () => {
  it("contains only first-version write endpoints", () => {
    const writes = Object.entries(endpoints).filter(([, value]) => value.method !== "GET");
    expect(writes.map(([key]) => key).sort()).toEqual([
      "changeStory",
      "createBuild",
      "createStory",
      "token",
      "updateBuild",
      "updateStory",
      "uploadFile",
    ]);
    expect(endpoints.uploadFile).toEqual({ method: "POST", path: "/files" });
  });

  it("renders path templates", () => {
    expect(renderPath(endpoints.projectBuilds, { project_id: 12 })).toBe("/projects/12/builds");
    expect(renderPath(endpoints.build, { id: 3 })).toBe("/builds/3");
  });

  it("fails when a required path parameter is missing", () => {
    expect(() => renderPath(endpoints.projectBuilds, {})).toThrow(/project_id/);
  });

  it("exposes stable endpoint keys", () => {
    expect(endpointKeys).toContain("productStories");
    expect(endpointKeys).toContain("taskEfforts");
  });
});
