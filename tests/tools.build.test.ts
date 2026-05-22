import { describe, expect, it } from "vitest";
import { createWriteSummary, ensureConfirmed } from "../src/safety.js";

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
