import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveChangeStory,
  resolveChangeStoryRequest,
  resolveCreateStoryRequest,
  resolveUpdateStoryRequest,
} from "../src/tools/storyTools.js";

const storyToolTempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(storyToolTempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("story tools", () => {
  it("dry-runs create story without confirm=true", async () => {
    const calls: unknown[] = [];
    const result = await resolveCreateStoryRequest(
      {
        title: "支持发布需求",
        product: 1,
        pri: 2,
        category: "feature",
      },
      async (request) => calls.push(request),
    );

    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({
      method: "POST",
      path: "/stories",
      requires_confirmation: true,
      request_body: { title: "支持发布需求", product: 1, pri: 2, category: "feature" },
    });
  });

  it("sends create story when confirmed", async () => {
    const calls: unknown[] = [];
    await resolveCreateStoryRequest(
      {
        title: "支持发布需求",
        product: 1,
        pri: 2,
        category: "feature",
        spec: "需求描述",
        verify: "验收标准",
        source: "po",
        sourceNote: "产品反馈",
        estimate: 1.5,
        keywords: "mcp,story",
        confirm: true,
      },
      async (request) => calls.push(request),
    );

    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/stories",
      body: {
        title: "支持发布需求",
        product: 1,
        pri: 2,
        category: "feature",
        spec: "需求描述",
        verify: "验收标准",
        source: "po",
        sourceNote: "产品反馈",
        estimate: 1.5,
        keywords: "mcp,story",
      },
    });
  });

  it("requires at least one change field", () => {
    expect(() => resolveChangeStoryRequest({ story_id: 9, confirm: true }, async () => undefined)).toThrow(
      /at least one/,
    );
  });

  it("sends change story when confirmed", async () => {
    const calls: unknown[] = [];
    await resolveChangeStoryRequest(
      {
        story_id: 9,
        title: "调整标题",
        spec: "新版描述",
        verify: "新版验收",
        confirm: true,
      },
      async (request) => calls.push(request),
    );

    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/stories/9/change",
      body: { title: "调整标题", spec: "新版描述", verify: "新版验收" },
    });
  });

  it("keeps the exact legacy dry-run when images are absent or empty", async () => {
    const legacy = await resolveChangeStoryRequest(
      { story_id: 9, spec: "plain" },
      async () => undefined,
    );
    let absentRequests = 0;
    const withoutImages = await resolveChangeStory(
      { story_id: 9, spec: "plain" },
      { request: async () => (absentRequests += 1) },
    );
    let emptyRequests = 0;
    const withEmptyImages = await resolveChangeStory(
      { story_id: 9, spec: "plain", images: [] },
      { request: async () => (emptyRequests += 1) },
    );

    expect(withoutImages).toEqual(legacy);
    expect(withEmptyImages).toEqual(legacy);
    expect({ absentRequests, emptyRequests }).toEqual({ absentRequests: 0, emptyRequests: 0 });
  });

  it("keeps the exact legacy confirmed request and response with absent or empty images", async () => {
    const cases = [
      { story_id: 9, spec: "plain", expected_revision: "ignored-without-images", confirm: true },
      { story_id: 9, spec: "plain", images: [], confirm: true },
    ];

    for (const args of cases) {
      const calls: unknown[] = [];
      const response = { id: 9, title: "adjusted" };
      const result = await resolveChangeStory(args, {
        request: async (request) => {
          calls.push(request);
          return response;
        },
      });

      expect(calls).toEqual([{ method: "POST", path: "/stories/9/change", body: { spec: "plain" } }]);
      expect(result).toBe(response);
    }
  });

  it("rejects non-empty images sent directly to the legacy dispatcher", () => {
    const args = {
      story_id: 9,
      spec: "{{image:ui}}",
      images: [{ key: "ui", path: "/tmp/ui.png" }],
    };

    expect(() => resolveChangeStoryRequest(args, async () => undefined)).toThrow(/image workflow/i);
  });

  it("routes non-empty images to one story preflight read", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zentao-story-tool-"));
    storyToolTempDirs.push(tempDir);
    const absolutePngPath = join(tempDir, "schema-route.png");
    await writeFile(absolutePngPath, new Uint8Array([1]));
    let requests = 0;

    const result = await resolveChangeStory(
      {
        story_id: 9,
        spec: "{{image:ui}}",
        images: [{ key: "ui", path: absolutePngPath }],
      },
      {
        request: async () => {
          requests += 1;
          return {
            id: 9,
            version: 1,
            lastEditedDate: "2026-08-22T10:00:00Z",
            title: "title",
            spec: "before",
            verify: "verify",
          };
        },
      },
    );

    expect(result).toMatchObject({ status: "DRY_RUN", phase: "preflight" });
    expect(requests).toBe(1);
  });

  it("returns REJECTED for image business-rule failures", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zentao-story-tool-invalid-"));
    storyToolTempDirs.push(tempDir);
    const imagePath = join(tempDir, "valid.png");
    await writeFile(imagePath, new Uint8Array([1]));
    const sixImages = Array.from({ length: 6 }, (_, index) => ({ key: `image_${index}`, path: imagePath }));
    const cases = [
      { story_id: 9, images: [{ key: "ui", path: imagePath }] },
      {
        story_id: 9,
        spec: sixImages.map(({ key }) => `{{image:${key}}}`).join(""),
        images: sixImages,
      },
      { story_id: 9, spec: "{{image:bad key}}", images: [{ key: "bad key", path: imagePath }] },
      { story_id: 9, spec: "{{image:missing}}", images: [{ key: "missing", path: join(tempDir, "missing.png") }] },
    ];

    for (const args of cases) {
      let requests = 0;
      const result = await resolveChangeStory(args, {
        request: async () => {
          requests += 1;
          return undefined;
        },
      });
      expect(result).toMatchObject({ status: "REJECTED", phase: "preflight" });
      expect(requests).toBe(0);
    }
  });

  it("requires at least one update field", () => {
    expect(() => resolveUpdateStoryRequest({ story_id: 9, confirm: true }, async () => undefined)).toThrow(
      /at least one/,
    );
  });

  it("sends update story when confirmed", async () => {
    const calls: unknown[] = [];
    await resolveUpdateStoryRequest(
      {
        story_id: 9,
        module: 0,
        source: "customer",
        sourceNote: "客户反馈",
        pri: 4,
        category: "other",
        estimate: 0,
        keywords: "customer",
        confirm: true,
      },
      async (request) => calls.push(request),
    );

    expect(calls[0]).toMatchObject({
      method: "PUT",
      path: "/stories/9",
      body: {
        module: 0,
        source: "customer",
        sourceNote: "客户反馈",
        pri: 4,
        category: "other",
        estimate: 0,
        keywords: "customer",
      },
    });
  });

  it("rejects invalid pri values", () => {
    for (const pri of [0, 5, 1.5]) {
      expect(() =>
        resolveCreateStoryRequest(
          { title: "需求", product: 1, pri, category: "feature" },
          async () => undefined,
        ),
      ).toThrow();
    }
  });

  it("rejects category and source values outside the supported enums", () => {
    expect(() =>
      resolveCreateStoryRequest(
        { title: "需求", product: 1, pri: 1, category: "custom" },
        async () => undefined,
      ),
    ).toThrow();
    expect(() =>
      resolveCreateStoryRequest(
        { title: "需求", product: 1, pri: 1, category: "feature", source: "sales" },
        async () => undefined,
      ),
    ).toThrow();
  });

  it("keeps secret-like unknown fields out of dry-run summaries", async () => {
    const result = await resolveCreateStoryRequest(
      {
        title: "支持发布需求",
        product: 1,
        pri: 2,
        category: "feature",
        token: "hidden-token",
      },
      async () => undefined,
    );

    expect(JSON.stringify(result)).not.toContain("hidden-token");
  });
});
