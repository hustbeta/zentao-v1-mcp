import {
  lstat,
  mkdtemp,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZentaoHttpError, type ZentaoImageUploadRequest } from "../src/zentao/client.js";
import type { ToolRequest, ZentaoRequester } from "../src/tools/queryTools.js";
import {
  changeStoryWithImages,
  computeStoryRevision,
  type StoryImageResult,
} from "../src/tools/storyImageChange.js";
import {
  prepareStoryImages,
  readPreparedImage,
  readStorySnapshot,
  replaceImagePlaceholders,
} from "../src/tools/storyImageWorkflow.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

const MiB = 1024 * 1024;

type ScriptValue = unknown | Error;

type FakeCall =
  | { operation: "request"; request: ToolRequest }
  | { operation: "getToken" }
  | { operation: "login" }
  | { operation: "requestWithToken"; request: ToolRequest; token: string }
  | { operation: "uploadImage"; input: ZentaoImageUploadRequest; token: string };

function scriptedClient(script: {
  request?: ScriptValue[];
  getToken?: ScriptValue[];
  login?: ScriptValue[];
  requestWithToken?: ScriptValue[];
  uploadImage?: ScriptValue[];
}) {
  const queues = Object.fromEntries(
    Object.entries(script).map(([key, values]) => [key, [...values]]),
  ) as Record<string, ScriptValue[]>;
  const calls: FakeCall[] = [];
  const next = async (operation: keyof typeof script): Promise<unknown> => {
    const value = queues[operation]?.shift();
    if (value === undefined) throw new Error(`Unexpected ${operation} call`);
    if (value instanceof Error) throw value;
    return value;
  };

  return {
    calls,
    client: {
      request: async (request: ToolRequest) => {
        calls.push({ operation: "request", request });
        return next("request");
      },
      getToken: async () => {
        calls.push({ operation: "getToken" });
        return next("getToken") as Promise<string>;
      },
      login: async () => {
        calls.push({ operation: "login" });
        return next("login") as Promise<string>;
      },
      requestWithToken: async (request: ToolRequest, token: string) => {
        calls.push({ operation: "requestWithToken", request, token });
        return next("requestWithToken");
      },
      uploadImage: async (input: ZentaoImageUploadRequest, token: string) => {
        calls.push({ operation: "uploadImage", input, token });
        return next("uploadImage");
      },
    },
  };
}

function storyBefore() {
  return {
    id: 9,
    version: 3,
    lastEditedDate: "2026-08-22T10:00:00Z",
    title: "old title",
    spec: "before",
    verify: "old verify",
  };
}

function storyAfter(fileIds: number[], overrides: Record<string, unknown> = {}) {
  return {
    ...storyBefore(),
    version: 4,
    spec: `<p>${fileIds.map((id) => `<img data-file="file-read-${id}" src="rewritten">`).join("")}</p>`,
    ...overrides,
  };
}

function httpError(status: number, body: unknown = { error: "request failed" }) {
  return new ZentaoHttpError({ status, path: "/test", responseBody: body });
}

function expectState(
  result: StoryImageResult,
  expected: {
    status: StoryImageResult["status"];
    phase: StoryImageResult["phase"];
    uploaded: string[];
    failed: Array<{ key?: string; outcome: "known_failure" | "unknown" }>;
    unattempted: string[];
  },
) {
  expect(result.status).toBe(expected.status);
  expect(result.phase).toBe(expected.phase);
  expect(result.uploaded.map((image) => image.key)).toEqual(expected.uploaded);
  expect(result.failed.map(({ key, outcome }) => ({ key, outcome }))).toEqual(expected.failed);
  expect(result.unattempted.map((image) => image.key)).toEqual(expected.unattempted);
  expect(JSON.stringify(result)).not.toMatch(/token-1|token-2|password-secret|cookie-secret|"uid"/i);
}

describe("story description images", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zentao-v1-mcp-image-"));
  });

  afterEach(async () => {
    vi.mocked(lstat).mockClear();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("accepts an absolute regular file and lets filename declare the type", async () => {
    const source = join(tempDir, "clipboard.bin");
    await writeFile(source, new Uint8Array([0, 1, 2]));

    const [image] = await prepareStoryImages("{{image:ui}}", [
      { key: "ui", path: source, filename: "screen.JPG" },
    ]);

    expect(image).toMatchObject({
      key: "ui",
      path: resolve(source),
      filename: "screen.JPG",
      alt: "screen",
      contentType: "image/jpeg",
      size: 3,
    });
    const stats = await lstat(source);
    expect(image.mtime).toBe(stats.mtime.toISOString());
    expect(image.mtimeMs).toBe(stats.mtimeMs);
  });

  it("rejects missing duplicate undeclared and malformed placeholders before file access", async () => {
    const missing = join(tempDir, "missing.png");

    await expect(prepareStoryImages("no marker", [{ key: "ui", path: missing }])).rejects.toThrow(/ui/);
    await expect(
      prepareStoryImages("{{image:ui}}{{image:ui}}", [{ key: "ui", path: missing }]),
    ).rejects.toThrow(/exactly once/);
    await expect(prepareStoryImages("{{image:other}}", [{ key: "ui", path: missing }])).rejects.toThrow(/other/);
    await expect(prepareStoryImages("{{image:bad key}}", [{ key: "bad-key", path: missing }])).rejects.toThrow(
      /malformed/,
    );
    expect(lstat).not.toHaveBeenCalled();
  });

  it("requires spec when images are present", async () => {
    const source = join(tempDir, "source.png");
    await writeFile(source, new Uint8Array([1]));

    await expect(prepareStoryImages("", [{ key: "ui", path: source }])).rejects.toThrow(/spec is required/);
    expect(lstat).not.toHaveBeenCalled();
  });

  it.each([
    ["relative path", "source.png", false, /absolute/],
    ["glob star", "*.png", true, /glob/],
    ["glob question mark", "screen?.png", true, /glob/],
    ["glob bracket", "screen[1].png", true, /glob/],
  ])("rejects %s", async (_name, pathPart, makeAbsolute, error) => {
    const path = makeAbsolute ? join(tempDir, pathPart) : pathPart;
    await expect(prepareStoryImages("{{image:ui}}", [{ key: "ui", path }])).rejects.toThrow(error);
  });

  it("rejects directories", async () => {
    await expect(prepareStoryImages("{{image:ui}}", [{ key: "ui", path: tempDir, filename: "ui.png" }])).rejects.toThrow(
      /regular file/,
    );
  });

  it("rejects a final symbolic link and still checks the branch without link privileges", async () => {
    const source = join(tempDir, "source.png");
    const link = join(tempDir, "link.png");
    await writeFile(source, new Uint8Array([1]));

    let linkCreated = true;
    try {
      await symlink(source, link, "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES") throw error;
      linkCreated = false;
    }

    if (linkCreated) {
      await expect(prepareStoryImages("{{image:ui}}", [{ key: "ui", path: link }])).rejects.toThrow(/regular file/);
      return;
    }

    const stats = await lstat(source);
    const linkStats = Object.create(stats) as typeof stats;
    linkStats.isSymbolicLink = () => true;
    vi.mocked(lstat).mockResolvedValueOnce(linkStats);
    await expect(prepareStoryImages("{{image:ui}}", [{ key: "ui", path: source }])).rejects.toThrow(/regular file/);
  });

  it("rejects six images before touching the file system", async () => {
    const images = Array.from({ length: 6 }, (_, index) => ({
      key: `image-${index}`,
      path: join(tempDir, `${index}.png`),
    }));
    const spec = images.map((image) => `{{image:${image.key}}}`).join("");

    await expect(prepareStoryImages(spec, images)).rejects.toThrow(/at most 5/i);
    expect(lstat).not.toHaveBeenCalled();
  });

  it("accepts exactly five images in declaration order", async () => {
    const images = await Promise.all(
      Array.from({ length: 5 }, async (_, index) => {
        const path = join(tempDir, `${index}.png`);
        await writeFile(path, new Uint8Array([index]));
        return { key: `image-${index}`, path };
      }),
    );
    const spec = images.map((image) => `{{image:${image.key}}}`).join("");

    const prepared = await prepareStoryImages(spec, images);

    expect(prepared).toHaveLength(5);
    expect(prepared.map((image) => image.key)).toEqual([
      "image-0",
      "image-1",
      "image-2",
      "image-3",
      "image-4",
    ]);
  });

  it("accepts a file exactly 10 MiB large", async () => {
    const source = join(tempDir, "limit.png");
    await writeFile(source, "");
    await truncate(source, 10 * MiB);

    const [prepared] = await prepareStoryImages("{{image:limit}}", [{ key: "limit", path: source }]);

    expect(prepared.size).toBe(10 * MiB);
  });

  it("rejects a file larger than 10 MiB", async () => {
    const source = join(tempDir, "large.png");
    await writeFile(source, "");
    await truncate(source, 10 * MiB + 1);

    await expect(prepareStoryImages("{{image:large}}", [{ key: "large", path: source }])).rejects.toThrow(
      /10 MiB/,
    );
  });

  it("rejects a total larger than 25 MiB", async () => {
    const sizes = [10 * MiB, 10 * MiB, 5 * MiB + 1];
    const images = await Promise.all(
      sizes.map(async (size, index) => {
        const path = join(tempDir, `${index}.png`);
        await writeFile(path, "");
        await truncate(path, size);
        return { key: `image-${index}`, path };
      }),
    );

    await expect(
      prepareStoryImages("{{image:image-0}}{{image:image-1}}{{image:image-2}}", images),
    ).rejects.toThrow(/25 MiB/);
  });

  it("accepts images totaling exactly 25 MiB", async () => {
    const sizes = [10 * MiB, 10 * MiB, 5 * MiB];
    const images = await Promise.all(
      sizes.map(async (size, index) => {
        const path = join(tempDir, `${index}.png`);
        await writeFile(path, "");
        await truncate(path, size);
        return { key: `image-${index}`, path };
      }),
    );

    const prepared = await prepareStoryImages("{{image:image-0}}{{image:image-1}}{{image:image-2}}", images);

    expect(prepared.map((image) => image.size)).toEqual(sizes);
    expect(prepared.reduce((total, image) => total + image.size, 0)).toBe(25 * MiB);
  });

  it.each(["screen.bmp", "screen", "a/b.png", "a\\b.png", "bad\u0000.png", ".", ".."]) (
    "rejects invalid upload filename %j",
    async (filename) => {
      const source = join(tempDir, "source.png");
      await writeFile(source, new Uint8Array([1]));

      await expect(prepareStoryImages("{{image:ui}}", [{ key: "ui", path: source, filename }])).rejects.toThrow(
        /filename/,
      );
    },
  );

  it("uses the authoritative filename extension instead of the source extension", async () => {
    const source = join(tempDir, "source.txt");
    await writeFile(source, new Uint8Array([0x42]));

    const [image] = await prepareStoryImages("{{image:ui}}", [{ key: "ui", path: source, filename: "ok.gif" }]);

    expect(image.contentType).toBe("image/gif");
    expect(image.filename).toBe("ok.gif");
  });

  it("defaults alt from the upload filename and preserves an explicit empty alt", async () => {
    const first = join(tempDir, "first.png");
    const second = join(tempDir, "second.jpg");
    await writeFile(first, new Uint8Array([1]));
    await writeFile(second, new Uint8Array([2]));

    const prepared = await prepareStoryImages("{{image:a}}{{image:b}}", [
      { key: "a", path: first, filename: "first.screen.png" },
      { key: "b", path: second, alt: "" },
    ]);

    expect(prepared.map((image) => image.alt)).toEqual(["first.screen", ""]);
  });

  it.each([
    [
      "duplicate keys",
      "{{image:ui}}",
      [
        { key: "ui", path: "missing-a.png" },
        { key: "ui", path: "missing-b.png" },
      ],
      /unique/,
    ],
    ["invalid key", "{{image:bad key}}", [{ key: "bad key", path: "missing.png" }], /key/],
  ])("rejects %s", async (_name, spec, images, error) => {
    await expect(prepareStoryImages(spec, images)).rejects.toThrow(error);
    expect(lstat).not.toHaveBeenCalled();
  });

  it("reads bytes from the prepared file", async () => {
    const source = join(tempDir, "source.png");
    await writeFile(source, new Uint8Array([3, 2, 1]));
    const [prepared] = await prepareStoryImages("{{image:ui}}", [{ key: "ui", path: source }]);

    const bytes = await readPreparedImage(prepared);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes)).toEqual([3, 2, 1]);
  });

  it("rejects metadata changes found before opening", async () => {
    const source = join(tempDir, "source.png");
    await writeFile(source, new Uint8Array([1]));
    const [prepared] = await prepareStoryImages("{{image:ui}}", [{ key: "ui", path: source }]);
    await truncate(source, 2);

    await expect(readPreparedImage(prepared)).rejects.toThrow(/changed/);
  });

  it("rejects metadata changes found from the opened file handle", async () => {
    const source = join(tempDir, "source.png");
    await writeFile(source, new Uint8Array([1]));
    const [prepared] = await prepareStoryImages("{{image:ui}}", [{ key: "ui", path: source }]);
    const originalStats = await lstat(source);
    await truncate(source, 2);
    vi.mocked(lstat).mockResolvedValueOnce(originalStats);

    await expect(readPreparedImage(prepared)).rejects.toThrow(/changed/);
  });

  it("escapes attributes without rewriting existing html", () => {
    const original = '<p><img src="https://example/a.png"></p>{{image:ui}}';

    expect(
      replaceImagePlaceholders(original, [
        { key: "ui", url: '/file-read-7.png?a=1&b="2"', alt: '<UI & "x">' },
      ]),
    ).toBe(
      '<p><img src="https://example/a.png"></p><img src="/file-read-7.png?a=1&amp;b=&quot;2&quot;" alt="&lt;UI &amp; &quot;x&quot;&gt;">',
    );
  });

  it("escapes all five HTML attribute characters in src and alt", () => {
    expect(replaceImagePlaceholders("{{image:ui}}", [{ key: "ui", url: `&<>"'`, alt: `&<>"'` }])).toBe(
      '<img src="&amp;&lt;&gt;&quot;&#39;" alt="&amp;&lt;&gt;&quot;&#39;">',
    );
  });

  it("treats replacement text as literal content", () => {
    expect(replaceImagePlaceholders("{{image:ui}}", [{ key: "ui", url: "/file-$&.png", alt: "cash" }])).toBe(
      '<img src="/file-$&amp;.png" alt="cash">',
    );
  });

  it("reads a direct ZenTao 17.4 story and normalizes optional snapshot fields", () => {
    expect(readStorySnapshot({ id: 9, title: "Story" })).toEqual({
      id: 9,
      version: null,
      lastEditedDate: null,
      title: "Story",
      spec: "",
      verify: "",
    });
  });

  it.each([
    ["wrapped story", { data: { id: 9, title: "Story" } }],
    ["zero id", { id: 0, title: "Story" }],
    ["fractional id", { id: 1.5, title: "Story" }],
  ])("rejects %s snapshots", (_name, value) => {
    expect(() => readStorySnapshot(value)).toThrow(/story/i);
  });

  it("computes the documented story-only revision", () => {
    expect(
      computeStoryRevision({
        id: 9,
        version: 3,
        lastEditedDate: "2026-08-22T10:00:00Z",
        title: "old",
        spec: "<p>before</p>",
        verify: "check",
      }),
    ).toBe("sha256:c28e37b77502e61df7744e8bf7512e994df45f8b1f24c6984c2570c0360fab56");
  });

  it("defaults alt from the source basename when filename is omitted", async () => {
    const source = join(tempDir, "clipboard.capture.png");
    await writeFile(source, new Uint8Array([1]));

    const [image] = await prepareStoryImages("{{image:ui}}", [{ key: "ui", path: source }]);

    expect(image.filename).toBe(basename(source));
    expect(image.alt).toBe("clipboard.capture");
  });

  it("dry-runs after one story read and returns all prepared images as unattempted", async () => {
    const aPath = join(tempDir, "a.png");
    const bPath = join(tempDir, "b.jpg");
    await writeFile(aPath, new Uint8Array([1]));
    await writeFile(bPath, new Uint8Array([2, 3]));
    const before = storyBefore();
    const fake = scriptedClient({ request: [before] });

    const result = await changeStoryWithImages(
      {
        story_id: 9,
        spec: "{{image:a}}{{image:b}}",
        images: [{ key: "a", path: aPath }, { key: "b", path: bPath }],
      },
      fake.client,
    );

    expectState(result, {
      status: "DRY_RUN",
      phase: "preflight",
      uploaded: [],
      failed: [],
      unattempted: ["a", "b"],
    });
    expect(result.expected_revision).toBe(computeStoryRevision(before));
    expect(result.unattempted).toEqual([
      expect.objectContaining({ key: "a", path: resolve(aPath), filename: "a.png", size: 1, mtime: expect.any(String) }),
      expect.objectContaining({ key: "b", path: resolve(bPath), filename: "b.jpg", size: 2, mtime: expect.any(String) }),
    ]);
    expect(result.unattempted[0]).not.toHaveProperty("mtimeMs");
    expect(result.unattempted[0]).not.toHaveProperty("contentType");
    expect(fake.calls).toEqual([
      { operation: "request", request: { method: "GET", path: "/stories/9" } },
    ]);
  });

  it("rejects a confirmed call without a revision before any remote request", async () => {
    const source = join(tempDir, "source.png");
    await writeFile(source, new Uint8Array([1]));
    const fake = scriptedClient({});

    const result = await changeStoryWithImages(
      { story_id: 9, spec: "{{image:ui}}", images: [{ key: "ui", path: source }], confirm: true },
      fake.client,
    );

    expectState(result, {
      status: "REJECTED",
      phase: "preflight",
      uploaded: [],
      failed: [{ outcome: "known_failure" }],
      unattempted: ["ui"],
    });
    expect(fake.calls).toEqual([]);
  });

  it("does not invent metadata when preflight fails before every file is inspected", async () => {
    const first = join(tempDir, "first.png");
    const missing = join(tempDir, "missing.jpg");
    await writeFile(first, new Uint8Array([1]));
    const fake = scriptedClient({});

    const result = await changeStoryWithImages(
      {
        story_id: 9,
        spec: "{{image:first}}{{image:missing}}",
        images: [{ key: "first", path: first }, { key: "missing", path: missing }],
      },
      fake.client,
    );

    expectState(result, {
      status: "REJECTED",
      phase: "preflight",
      uploaded: [],
      failed: [{ key: "missing", outcome: "known_failure" }],
      unattempted: [],
    });
    expect(fake.calls).toEqual([]);
  });

  it("returns a revision conflict without pinning a token or writing", async () => {
    const source = join(tempDir, "source.png");
    await writeFile(source, new Uint8Array([1]));
    const before = storyBefore();
    const fake = scriptedClient({ request: [before] });

    const result = await changeStoryWithImages(
      {
        story_id: 9,
        spec: "{{image:ui}}",
        images: [{ key: "ui", path: source }],
        expected_revision: "sha256:stale",
        confirm: true,
      },
      fake.client,
    );

    expectState(result, {
      status: "CONFLICT",
      phase: "preflight",
      uploaded: [],
      failed: [],
      unattempted: ["ui"],
    });
    expect(result).toMatchObject({ expected_revision: "sha256:stale", current_revision: computeStoryRevision(before) });
    expect(fake.calls.map((call) => call.operation)).toEqual(["request"]);
  });

  it("rejects a client without the image transport capability", async () => {
    const source = join(tempDir, "source.png");
    await writeFile(source, new Uint8Array([1]));
    const before = storyBefore();
    const calls: ToolRequest[] = [];
    const client: ZentaoRequester = {
      request: async (request) => {
        calls.push(request);
        return before;
      },
    };

    const result = await changeStoryWithImages(
      {
        story_id: 9,
        spec: "{{image:ui}}",
        images: [{ key: "ui", path: source }],
        expected_revision: computeStoryRevision(before),
        confirm: true,
      },
      client,
    );

    expectState(result, {
      status: "REJECTED",
      phase: "preflight",
      uploaded: [],
      failed: [{ outcome: "known_failure" }],
      unattempted: ["ui"],
    });
    expect(calls).toEqual([{ method: "GET", path: "/stories/9" }]);
  });

  it("normalizes ZenTao 17.4 string upload ids, uploads sequentially, changes, then verifies", async () => {
    const aPath = join(tempDir, "a.png");
    const bPath = join(tempDir, "b.jpg");
    await writeFile(aPath, new Uint8Array([1]));
    await writeFile(bPath, new Uint8Array([2]));
    const before = storyBefore();
    const fake = scriptedClient({
      request: [before],
      getToken: ["token-1"],
      // ZenTao 17.4 forwards PHP lastInsertID(), whose JSON representation can be a decimal string.
      uploadImage: [{ id: "101", url: "/file-read-101.png" }, { id: "102", url: "/file-read-102.jpg" }],
      requestWithToken: [{ ok: true }, storyAfter([101, 102])],
    });

    const result = await changeStoryWithImages(
      {
        story_id: 9,
        spec: "{{image:a}}{{image:b}}",
        images: [{ key: "a", path: aPath }, { key: "b", path: bPath }],
        expected_revision: computeStoryRevision(before),
        confirm: true,
      },
      fake.client,
    );

    expectState(result, {
      status: "SUCCESS",
      phase: "verify",
      uploaded: ["a", "b"],
      failed: [],
      unattempted: [],
    });
    expect(result.uploaded.map((image) => image.file_id)).toEqual([101, 102]);
    const uploads = fake.calls.filter((call): call is Extract<FakeCall, { operation: "uploadImage" }> => call.operation === "uploadImage");
    expect(uploads.map((call) => call.input.filename)).toEqual(["a.png", "b.jpg"]);
    expect(uploads.map((call) => Array.from(call.input.bytes))).toEqual([[1], [2]]);
    expect(new Set(uploads.map((call) => call.token))).toEqual(new Set(["token-1"]));
    const uploadUid = uploads[0].input.uid;
    expect(uploads.every((call) => call.input.uid === uploadUid)).toBe(true);
    const pinned = fake.calls.filter((call): call is Extract<FakeCall, { operation: "requestWithToken" }> => call.operation === "requestWithToken");
    expect(pinned.map((call) => call.request.method)).toEqual(["POST", "GET"]);
    expect(pinned[0]).toMatchObject({
      token: "token-1",
      request: {
        method: "POST",
        path: "/stories/9/change",
        body: {
          uid: uploadUid,
          title: "old title",
          verify: "old verify",
          spec: expect.stringContaining("file-read-101"),
        },
      },
    });
    expect(fake.calls.map((call) => call.operation)).toEqual([
      "request",
      "getToken",
      "uploadImage",
      "uploadImage",
      "requestWithToken",
      "requestWithToken",
    ]);
  });

  it("relogs in once only when the first upload has an explicit auth failure", async () => {
    const aPath = join(tempDir, "a.png");
    const bPath = join(tempDir, "b.png");
    await writeFile(aPath, new Uint8Array([1]));
    await writeFile(bPath, new Uint8Array([2]));
    const before = storyBefore();
    const fake = scriptedClient({
      request: [before],
      getToken: ["token-1"],
      login: ["token-2"],
      uploadImage: [
        httpError(401, { error: "unauthorized" }),
        { id: 101, url: "/file-read-101.png" },
        { id: 102, url: "/file-read-102.png" },
      ],
      requestWithToken: [{ ok: true }, storyAfter([101, 102])],
    });

    const result = await changeStoryWithImages(
      {
        story_id: 9,
        spec: "{{image:a}}{{image:b}}",
        images: [{ key: "a", path: aPath }, { key: "b", path: bPath }],
        expected_revision: computeStoryRevision(before),
        confirm: true,
      },
      fake.client,
    );

    expectState(result, {
      status: "SUCCESS",
      phase: "verify",
      uploaded: ["a", "b"],
      failed: [],
      unattempted: [],
    });
    expect(fake.calls.filter((call) => call.operation === "login")).toHaveLength(1);
    const uploads = fake.calls.filter((call): call is Extract<FakeCall, { operation: "uploadImage" }> => call.operation === "uploadImage");
    expect(uploads.map((call) => call.token)).toEqual(["token-1", "token-2", "token-2"]);
    expect(new Set(uploads.map((call) => call.input.uid)).size).toBe(1);
  });

  it("relogs in once when a redacted token field carried the first upload auth failure", async () => {
    const aPath = join(tempDir, "a.png");
    const bPath = join(tempDir, "b.png");
    await writeFile(aPath, new Uint8Array([1]));
    await writeFile(bPath, new Uint8Array([2]));
    const before = storyBefore();
    const redactedAuthError = httpError(400, { token: "invalid token" });
    const fake = scriptedClient({
      request: [before],
      getToken: ["token-1"],
      login: ["token-2"],
      uploadImage: [
        redactedAuthError,
        { id: 101, url: "/file-read-101.png" },
        { id: 102, url: "/file-read-102.png" },
      ],
      requestWithToken: [{ ok: true }, storyAfter([101, 102])],
    });

    const result = await changeStoryWithImages(
      {
        story_id: 9,
        spec: "{{image:a}}{{image:b}}",
        images: [{ key: "a", path: aPath }, { key: "b", path: bPath }],
        expected_revision: computeStoryRevision(before),
        confirm: true,
      },
      fake.client,
    );

    expectState(result, {
      status: "SUCCESS",
      phase: "verify",
      uploaded: ["a", "b"],
      failed: [],
      unattempted: [],
    });
    expect(fake.calls.filter((call) => call.operation === "login")).toHaveLength(1);
    expect(redactedAuthError.authFailure).toBe(true);
    expect(redactedAuthError.responseBody).toEqual({ token: "<redacted>" });
    expect(JSON.stringify(redactedAuthError)).not.toContain("invalid token");
    const uploads = fake.calls.filter((call): call is Extract<FakeCall, { operation: "uploadImage" }> => call.operation === "uploadImage");
    expect(uploads.map((call) => call.token)).toEqual(["token-1", "token-2", "token-2"]);
    expect(new Set(uploads.map((call) => call.input.uid)).size).toBe(1);
  });

  it("rejects without retrying upload when relogin itself fails after a known first-image auth failure", async () => {
    const source = join(tempDir, "source.png");
    await writeFile(source, new Uint8Array([1]));
    const before = storyBefore();
    const fake = scriptedClient({
      request: [before],
      getToken: ["token-1"],
      login: [new Error("password-secret cookie-secret")],
      uploadImage: [httpError(401, { error: "unauthorized" })],
    });

    const result = await changeStoryWithImages(
      {
        story_id: 9,
        spec: "{{image:ui}}",
        images: [{ key: "ui", path: source }],
        expected_revision: computeStoryRevision(before),
        confirm: true,
      },
      fake.client,
    );

    expectState(result, {
      status: "REJECTED",
      phase: "upload",
      uploaded: [],
      failed: [{ key: "ui", outcome: "known_failure" }],
      unattempted: [],
    });
    expect(fake.calls.filter((call) => call.operation === "login")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.operation === "uploadImage")).toHaveLength(1);
  });

  it("does not login or retransmit after a successful upload", async () => {
    const aPath = join(tempDir, "a.png");
    const bPath = join(tempDir, "b.png");
    await writeFile(aPath, new Uint8Array([1]));
    await writeFile(bPath, new Uint8Array([2]));
    const before = storyBefore();
    const fake = scriptedClient({
      request: [before],
      getToken: ["token-1"],
      login: ["token-2"],
      uploadImage: [{ id: 101, url: "/file-read-101.png" }, httpError(401, { error: "unauthorized" })],
    });

    const result = await changeStoryWithImages(
      {
        story_id: 9,
        spec: "{{image:a}}{{image:b}}",
        images: [{ key: "a", path: aPath }, { key: "b", path: bPath }],
        expected_revision: computeStoryRevision(before),
        confirm: true,
      },
      fake.client,
    );

    expectState(result, {
      status: "PARTIAL",
      phase: "upload",
      uploaded: ["a"],
      failed: [{ key: "b", outcome: "known_failure" }],
      unattempted: [],
    });
    expect(fake.calls.filter((call) => call.operation === "login")).toHaveLength(0);
    expect(fake.calls.filter((call) => call.operation === "uploadImage")).toHaveLength(2);
    expect(fake.calls.filter((call) => call.operation === "requestWithToken")).toHaveLength(0);
  });

  it.each([400, 429])("rejects a known first-upload HTTP %i and leaves later images unattempted", async (status) => {
    const aPath = join(tempDir, "a.png");
    const bPath = join(tempDir, "b.png");
    await writeFile(aPath, new Uint8Array([1]));
    await writeFile(bPath, new Uint8Array([2]));
    const before = storyBefore();
    const fake = scriptedClient({
      request: [before],
      getToken: ["token-1"],
      uploadImage: [httpError(status)],
    });

    const result = await changeStoryWithImages(
      {
        story_id: 9,
        spec: "{{image:a}}{{image:b}}",
        images: [{ key: "a", path: aPath }, { key: "b", path: bPath }],
        expected_revision: computeStoryRevision(before),
        confirm: true,
      },
      fake.client,
    );

    expectState(result, {
      status: "REJECTED",
      phase: "upload",
      uploaded: [],
      failed: [{ key: "a", outcome: "known_failure" }],
      unattempted: ["b"],
    });
  });

  it("returns partial when a later upload has a known failure", async () => {
    const aPath = join(tempDir, "a.png");
    const bPath = join(tempDir, "b.png");
    await writeFile(aPath, new Uint8Array([1]));
    await writeFile(bPath, new Uint8Array([2]));
    const before = storyBefore();
    const fake = scriptedClient({
      request: [before],
      getToken: ["token-1"],
      uploadImage: [{ id: 101, url: "/file-read-101.png" }, httpError(400)],
    });

    const result = await changeStoryWithImages(
      {
        story_id: 9,
        spec: "{{image:a}}{{image:b}}",
        images: [{ key: "a", path: aPath }, { key: "b", path: bPath }],
        expected_revision: computeStoryRevision(before),
        confirm: true,
      },
      fake.client,
    );

    expectState(result, {
      status: "PARTIAL",
      phase: "upload",
      uploaded: ["a"],
      failed: [{ key: "b", outcome: "known_failure" }],
      unattempted: [],
    });
  });

  it.each([
    ["network error", new Error("Token token-1 password-secret cookie-secret uid-secret")],
    ["HTTP 408", httpError(408)],
    ["HTTP 500", httpError(500)],
    ["invalid id", { id: 0, url: "/file-read-0.png" }],
    ["missing url", { id: 101, url: "" }],
  ])("returns unknown without retransmitting an upload after %s", async (_name, outcome) => {
    const source = join(tempDir, "source.png");
    await writeFile(source, new Uint8Array([1]));
    const before = storyBefore();
    const fake = scriptedClient({ request: [before], getToken: ["token-1"], uploadImage: [outcome] });

    const result = await changeStoryWithImages(
      {
        story_id: 9,
        spec: "{{image:ui}}",
        images: [{ key: "ui", path: source }],
        expected_revision: computeStoryRevision(before),
        confirm: true,
      },
      fake.client,
    );

    expectState(result, {
      status: "UNKNOWN",
      phase: "upload",
      uploaded: [],
      failed: [{ key: "ui", outcome: "unknown" }],
      unattempted: [],
    });
    expect(fake.calls.filter((call) => call.operation === "uploadImage")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.operation === "requestWithToken")).toHaveLength(0);
  });

  it("keeps later upload inputs unattempted in declaration order", async () => {
    const paths = await Promise.all(
      ["a", "b", "c"].map(async (key, index) => {
        const path = join(tempDir, `${key}.png`);
        await writeFile(path, new Uint8Array([index]));
        return path;
      }),
    );
    const before = storyBefore();
    const fake = scriptedClient({
      request: [before],
      getToken: ["token-1"],
      uploadImage: [{ id: 101, url: "/file-read-101.png" }, new Error("fetch failed")],
    });

    const result = await changeStoryWithImages(
      {
        story_id: 9,
        spec: "{{image:a}}{{image:b}}{{image:c}}",
        images: [
          { key: "a", path: paths[0] },
          { key: "b", path: paths[1] },
          { key: "c", path: paths[2] },
        ],
        expected_revision: computeStoryRevision(before),
        confirm: true,
      },
      fake.client,
    );

    expectState(result, {
      status: "UNKNOWN",
      phase: "upload",
      uploaded: ["a"],
      failed: [{ key: "b", outcome: "unknown" }],
      unattempted: ["c"],
    });
  });

  it("returns partial after all uploads when change has an ordinary 4xx", async () => {
    const source = join(tempDir, "source.png");
    await writeFile(source, new Uint8Array([1]));
    const before = storyBefore();
    const fake = scriptedClient({
      request: [before],
      getToken: ["token-1"],
      uploadImage: [{ id: 101, url: "/file-read-101.png" }],
      requestWithToken: [httpError(400)],
    });

    const result = await changeStoryWithImages(
      {
        story_id: 9,
        spec: "{{image:ui}}",
        images: [{ key: "ui", path: source }],
        expected_revision: computeStoryRevision(before),
        confirm: true,
      },
      fake.client,
    );

    expectState(result, {
      status: "PARTIAL",
      phase: "change",
      uploaded: ["ui"],
      failed: [{ outcome: "known_failure" }],
      unattempted: [],
    });
  });

  it("retries change once after 429 only when a pinned read is still the old snapshot", async () => {
    const source = join(tempDir, "source.png");
    await writeFile(source, new Uint8Array([1]));
    const before = storyBefore();
    const fake = scriptedClient({
      request: [before],
      getToken: ["token-1"],
      uploadImage: [{ id: 101, url: "/file-read-101.png" }],
      requestWithToken: [httpError(429), before, { ok: true }, storyAfter([101])],
    });

    const result = await changeStoryWithImages(
      {
        story_id: 9,
        spec: "{{image:ui}}",
        images: [{ key: "ui", path: source }],
        expected_revision: computeStoryRevision(before),
        confirm: true,
      },
      fake.client,
    );

    expectState(result, {
      status: "SUCCESS",
      phase: "verify",
      uploaded: ["ui"],
      failed: [],
      unattempted: [],
    });
    expect(fake.calls.filter((call) => call.operation === "uploadImage")).toHaveLength(1);
    const pinned = fake.calls.filter((call): call is Extract<FakeCall, { operation: "requestWithToken" }> => call.operation === "requestWithToken");
    expect(pinned.map((call) => call.request.method)).toEqual(["POST", "GET", "POST", "GET"]);
    expect(new Set(pinned.map((call) => call.token))).toEqual(new Set(["token-1"]));
  });

  it("returns success without resending change when a 429 pinned read already finds the target", async () => {
    const source = join(tempDir, "source.png");
    await writeFile(source, new Uint8Array([1]));
    const before = storyBefore();
    const fake = scriptedClient({
      request: [before],
      getToken: ["token-1"],
      uploadImage: [{ id: 101, url: "/file-read-101.png" }],
      requestWithToken: [httpError(429), storyAfter([101])],
    });

    const result = await changeStoryWithImages(
      {
        story_id: 9,
        spec: "{{image:ui}}",
        images: [{ key: "ui", path: source }],
        expected_revision: computeStoryRevision(before),
        confirm: true,
      },
      fake.client,
    );

    expectState(result, {
      status: "SUCCESS",
      phase: "verify",
      uploaded: ["ui"],
      failed: [],
      unattempted: [],
    });
    expect(fake.calls.filter((call) => call.operation === "uploadImage")).toHaveLength(1);
    const pinned = fake.calls.filter((call): call is Extract<FakeCall, { operation: "requestWithToken" }> => call.operation === "requestWithToken");
    expect(pinned.map((call) => call.request.method)).toEqual(["POST", "GET"]);
  });

  it("returns unknown without resending change when the 429 pinned read fails", async () => {
    const source = join(tempDir, "source.png");
    await writeFile(source, new Uint8Array([1]));
    const before = storyBefore();
    const fake = scriptedClient({
      request: [before],
      getToken: ["token-1"],
      uploadImage: [{ id: 101, url: "/file-read-101.png" }],
      requestWithToken: [httpError(429), new Error("password-secret cookie-secret")],
    });

    const result = await changeStoryWithImages(
      {
        story_id: 9,
        spec: "{{image:ui}}",
        images: [{ key: "ui", path: source }],
        expected_revision: computeStoryRevision(before),
        confirm: true,
      },
      fake.client,
    );

    expectState(result, {
      status: "UNKNOWN",
      phase: "change",
      uploaded: ["ui"],
      failed: [{ outcome: "unknown" }],
      unattempted: [],
    });
    expect(fake.calls.filter((call) => call.operation === "uploadImage")).toHaveLength(1);
    const pinned = fake.calls.filter((call): call is Extract<FakeCall, { operation: "requestWithToken" }> => call.operation === "requestWithToken");
    expect(pinned.map((call) => call.request.method)).toEqual(["POST", "GET"]);
  });

  it.each([400, 429])("does not loop when the one safe change retry returns HTTP %i", async (status) => {
    const source = join(tempDir, "source.png");
    await writeFile(source, new Uint8Array([1]));
    const before = storyBefore();
    const fake = scriptedClient({
      request: [before],
      getToken: ["token-1"],
      uploadImage: [{ id: 101, url: "/file-read-101.png" }],
      requestWithToken: [httpError(429), before, httpError(status)],
    });

    const result = await changeStoryWithImages(
      {
        story_id: 9,
        spec: "{{image:ui}}",
        images: [{ key: "ui", path: source }],
        expected_revision: computeStoryRevision(before),
        confirm: true,
      },
      fake.client,
    );

    expectState(result, {
      status: "PARTIAL",
      phase: "change",
      uploaded: ["ui"],
      failed: [{ outcome: "known_failure" }],
      unattempted: [],
    });
    expect(fake.calls.filter((call) => call.operation === "uploadImage")).toHaveLength(1);
    const pinned = fake.calls.filter((call): call is Extract<FakeCall, { operation: "requestWithToken" }> => call.operation === "requestWithToken");
    expect(pinned.map((call) => call.request.method)).toEqual(["POST", "GET", "POST"]);
  });

  it("does not retry change after 429 when the pinned story is a third state", async () => {
    const source = join(tempDir, "source.png");
    await writeFile(source, new Uint8Array([1]));
    const before = storyBefore();
    const fake = scriptedClient({
      request: [before],
      getToken: ["token-1"],
      uploadImage: [{ id: 101, url: "/file-read-101.png" }],
      requestWithToken: [httpError(429), { ...before, version: 4, spec: "edited elsewhere" }],
    });

    const result = await changeStoryWithImages(
      {
        story_id: 9,
        spec: "{{image:ui}}",
        images: [{ key: "ui", path: source }],
        expected_revision: computeStoryRevision(before),
        confirm: true,
      },
      fake.client,
    );

    expectState(result, {
      status: "UNKNOWN",
      phase: "change",
      uploaded: ["ui"],
      failed: [{ outcome: "unknown" }],
      unattempted: [],
    });
    expect(fake.calls.filter((call) => call.operation === "requestWithToken")).toHaveLength(2);
  });

  it.each([
    ["network error", new Error("fetch failed")],
    ["HTTP 408", httpError(408)],
    ["HTTP 500", httpError(500)],
  ])("returns unknown when %s from change disambiguates to the old snapshot", async (_name, changeFailure) => {
    const source = join(tempDir, "source.png");
    await writeFile(source, new Uint8Array([1]));
    const before = storyBefore();
    const fake = scriptedClient({
      request: [before],
      getToken: ["token-1"],
      uploadImage: [{ id: 101, url: "/file-read-101.png" }],
      requestWithToken: [changeFailure, before],
    });

    const result = await changeStoryWithImages(
      {
        story_id: 9,
        spec: "{{image:ui}}",
        images: [{ key: "ui", path: source }],
        expected_revision: computeStoryRevision(before),
        confirm: true,
      },
      fake.client,
    );

    expectState(result, {
      status: "UNKNOWN",
      phase: "change",
      uploaded: ["ui"],
      failed: [{ outcome: "unknown" }],
      unattempted: [],
    });
    expect(fake.calls.filter((call) => call.operation === "uploadImage")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.operation === "requestWithToken")).toHaveLength(2);
  });

  it("accepts the target state found by a pinned read after an unknown change response", async () => {
    const source = join(tempDir, "source.png");
    await writeFile(source, new Uint8Array([1]));
    const before = storyBefore();
    const fake = scriptedClient({
      request: [before],
      getToken: ["token-1"],
      uploadImage: [{ id: 101, url: "/file-read-101.png" }],
      requestWithToken: [new Error("socket closed"), storyAfter([101])],
    });

    const result = await changeStoryWithImages(
      {
        story_id: 9,
        spec: "{{image:ui}}",
        images: [{ key: "ui", path: source }],
        expected_revision: computeStoryRevision(before),
        confirm: true,
      },
      fake.client,
    );

    expectState(result, {
      status: "SUCCESS",
      phase: "verify",
      uploaded: ["ui"],
      failed: [],
      unattempted: [],
    });
    expect(fake.calls.filter((call) => call.operation === "requestWithToken")).toHaveLength(2);
  });

  it("disambiguates an unparseable successful change response without resending change", async () => {
    const source = join(tempDir, "source.png");
    await writeFile(source, new Uint8Array([1]));
    const before = storyBefore();
    const fake = scriptedClient({
      request: [before],
      getToken: ["token-1"],
      uploadImage: [{ id: 101, url: "/file-read-101.png" }],
      requestWithToken: ["not-json", before],
    });

    const result = await changeStoryWithImages(
      {
        story_id: 9,
        spec: "{{image:ui}}",
        images: [{ key: "ui", path: source }],
        expected_revision: computeStoryRevision(before),
        confirm: true,
      },
      fake.client,
    );

    expectState(result, {
      status: "UNKNOWN",
      phase: "change",
      uploaded: ["ui"],
      failed: [{ outcome: "unknown" }],
      unattempted: [],
    });
    expect(fake.calls.filter((call) => call.operation === "requestWithToken")).toHaveLength(2);
  });

  it.each([
    ["network error", new Error("read failed")],
    ["HTTP 408", httpError(408)],
    ["HTTP 429", httpError(429)],
    ["HTTP 502", httpError(502)],
    ["HTTP 503", httpError(503)],
    ["HTTP 504", httpError(504)],
  ])("retries one transient verify GET after %s without logging in", async (_name, verifyFailure) => {
    const source = join(tempDir, "source.png");
    await writeFile(source, new Uint8Array([1]));
    const before = storyBefore();
    const fake = scriptedClient({
      request: [before],
      getToken: ["token-1"],
      login: ["token-2"],
      uploadImage: [{ id: 101, url: "/file-read-101.png" }],
      requestWithToken: [{ ok: true }, verifyFailure, storyAfter([101])],
    });

    const result = await changeStoryWithImages(
      {
        story_id: 9,
        spec: "{{image:ui}}",
        images: [{ key: "ui", path: source }],
        expected_revision: computeStoryRevision(before),
        confirm: true,
      },
      fake.client,
    );

    expectState(result, {
      status: "SUCCESS",
      phase: "verify",
      uploaded: ["ui"],
      failed: [],
      unattempted: [],
    });
    expect(fake.calls.filter((call) => call.operation === "login")).toHaveLength(0);
    const pinned = fake.calls.filter((call): call is Extract<FakeCall, { operation: "requestWithToken" }> => call.operation === "requestWithToken");
    expect(pinned.map((call) => call.request.method)).toEqual(["POST", "GET", "GET"]);
    expect(new Set(pinned.map((call) => call.token))).toEqual(new Set(["token-1"]));
  });

  it.each([400, 500])("does not retry a non-transient verify HTTP %i", async (status) => {
    const source = join(tempDir, "source.png");
    await writeFile(source, new Uint8Array([1]));
    const before = storyBefore();
    const fake = scriptedClient({
      request: [before],
      getToken: ["token-1"],
      uploadImage: [{ id: 101, url: "/file-read-101.png" }],
      requestWithToken: [{ ok: true }, httpError(status)],
    });

    const result = await changeStoryWithImages(
      {
        story_id: 9,
        spec: "{{image:ui}}",
        images: [{ key: "ui", path: source }],
        expected_revision: computeStoryRevision(before),
        confirm: true,
      },
      fake.client,
    );

    expectState(result, {
      status: "PARTIAL",
      phase: "verify",
      uploaded: ["ui"],
      failed: [{ outcome: "known_failure" }],
      unattempted: [],
    });
    expect(fake.calls.filter((call) => call.operation === "requestWithToken")).toHaveLength(2);
  });

  it("returns partial verify after the one read retry also fails", async () => {
    const source = join(tempDir, "source.png");
    await writeFile(source, new Uint8Array([1]));
    const before = storyBefore();
    const fake = scriptedClient({
      request: [before],
      getToken: ["token-1"],
      uploadImage: [{ id: 101, url: "/file-read-101.png" }],
      requestWithToken: [{ ok: true }, httpError(503), httpError(503)],
    });

    const result = await changeStoryWithImages(
      {
        story_id: 9,
        spec: "{{image:ui}}",
        images: [{ key: "ui", path: source }],
        expected_revision: computeStoryRevision(before),
        confirm: true,
      },
      fake.client,
    );

    expectState(result, {
      status: "PARTIAL",
      phase: "verify",
      uploaded: ["ui"],
      failed: [{ outcome: "unknown" }],
      unattempted: [],
    });
  });

  it.each([
    ["missing file id", storyAfter([], { spec: "<img src=rewritten>" })],
    ["residual marker", storyAfter([101], { spec: "file-read-101 {{image:ui}}" })],
    ["wrong title", storyAfter([101], { title: "wrong" })],
    ["wrong verify", storyAfter([101], { verify: "wrong" })],
  ])("returns partial verify for %s", async (_name, after) => {
    const source = join(tempDir, "source.png");
    await writeFile(source, new Uint8Array([1]));
    const before = storyBefore();
    const fake = scriptedClient({
      request: [before],
      getToken: ["token-1"],
      uploadImage: [{ id: 101, url: "/file-read-101.png" }],
      requestWithToken: [{ ok: true }, after],
    });

    const result = await changeStoryWithImages(
      {
        story_id: 9,
        title: "old title",
        spec: "{{image:ui}}",
        verify: "old verify",
        images: [{ key: "ui", path: source }],
        expected_revision: computeStoryRevision(before),
        confirm: true,
      },
      fake.client,
    );

    expectState(result, {
      status: "PARTIAL",
      phase: "verify",
      uploaded: ["ui"],
      failed: [{ outcome: "known_failure" }],
      unattempted: [],
    });
  });
});
