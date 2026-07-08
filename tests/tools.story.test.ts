import { describe, expect, it } from "vitest";
import {
  resolveChangeStoryRequest,
  resolveCreateStoryRequest,
  resolveUpdateStoryRequest,
} from "../src/tools/storyTools.js";

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
