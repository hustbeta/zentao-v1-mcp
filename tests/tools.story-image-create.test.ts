import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZentaoHttpError, type ZentaoImageUploadRequest } from "../src/zentao/client.js";
import type { ToolRequest } from "../src/tools/queryTools.js";
import { createStoryWithImages } from "../src/tools/storyImageCreate.js";

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
  const queues = Object.fromEntries(Object.entries(script).map(([key, values]) => [key, [...values]])) as Record<string, ScriptValue[]>;
  const calls: FakeCall[] = [];
  const next = async (operation: keyof typeof script): Promise<unknown> => {
    const value = queues[operation]?.shift();
    if (value === undefined) throw new Error("Unexpected " + operation + " call");
    if (value instanceof Error) throw value;
    return value;
  };
  return {
    calls,
    client: {
      request: async (request: ToolRequest) => { calls.push({ operation: "request", request }); return next("request"); },
      getToken: async () => { calls.push({ operation: "getToken" }); return next("getToken") as Promise<string>; },
      login: async () => { calls.push({ operation: "login" }); return next("login") as Promise<string>; },
      requestWithToken: async (request: ToolRequest, token: string) => { calls.push({ operation: "requestWithToken", request, token }); return next("requestWithToken"); },
      uploadImage: async (input: ZentaoImageUploadRequest, token: string) => { calls.push({ operation: "uploadImage", input, token }); return next("uploadImage"); },
    },
  };
}

function httpError(status: number) {
  return new ZentaoHttpError({ status, path: "/stories", responseBody: { error: "request failed" } });
}

function createdStory(fileIDs: number[], overrides: Record<string, unknown> = {}) {
  return { id: 31, version: 1, lastEditedDate: null, title: "new story", spec: fileIDs.map((id) => '<img src="file-read-' + id + '">').join(""), verify: "", ...overrides };
}

const tempDirs: string[] = [];
let tempDir: string;
beforeEach(async () => { tempDir = await mkdtemp(join(tmpdir(), "zentao-story-image-create-")); tempDirs.push(tempDir); });
afterEach(async () => { await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("createStoryWithImages", () => {
  it("dry-runs locally without login, upload, or create", async () => {
    const source = join(tempDir, "screen.png");
    await writeFile(source, new Uint8Array([1]));
    const fake = scriptedClient({});
    const result = await createStoryWithImages({ body: { title: "new story", product: 1, pri: 2, category: "feature", spec: "{{image:ui}}" }, title: "new story", spec: "{{image:ui}}", images: [{ key: "ui", path: source }] }, fake.client);
    expect(result).toMatchObject({ status: "DRY_RUN", phase: "preflight", request_summary: { method: "POST", path: "/stories", request_body: { title: "new story", product: 1, pri: 2, category: "feature", spec: "{{image:ui}}" }, requires_confirmation: true }, uploaded: [], failed: [] });
    expect(result.unattempted.map((image) => image.key)).toEqual(["ui"]);
    expect(fake.calls).toEqual([]);
  });

  it("uploads with one token and uid, creates once, then verifies", async () => {
    const aPath = join(tempDir, "a.png"); const bPath = join(tempDir, "b.jpg");
    await writeFile(aPath, new Uint8Array([1])); await writeFile(bPath, new Uint8Array([2]));
    const fake = scriptedClient({ getToken: ["token-1"], uploadImage: [{ id: "101", url: "/file-read-101.png" }, { id: 102, url: "/file-read-102.jpg" }], requestWithToken: [{ id: 31 }, createdStory([101, 102])] });
    const result = await createStoryWithImages({ body: { title: "new story", product: 1, pri: 2, category: "feature", spec: "{{image:a}}{{image:b}}" }, title: "new story", spec: "{{image:a}}{{image:b}}", images: [{ key: "a", path: aPath }, { key: "b", path: bPath }], confirm: true }, fake.client);
    expect(result).toMatchObject({ status: "SUCCESS", phase: "verify", story_id: 31, failed: [], unattempted: [] });
    expect(fake.calls.map((call) => call.operation)).toEqual(["getToken", "uploadImage", "uploadImage", "requestWithToken", "requestWithToken"]);
    const uploads = fake.calls.filter((call): call is Extract<FakeCall, { operation: "uploadImage" }> => call.operation === "uploadImage");
    const uid = uploads[0].input.uid;
    expect(uploads.every((call) => call.input.uid === uid && call.token === "token-1")).toBe(true);
    const pinned = fake.calls.filter((call): call is Extract<FakeCall, { operation: "requestWithToken" }> => call.operation === "requestWithToken");
    expect(pinned.map((call) => call.request.method)).toEqual(["POST", "GET"]);
    expect(pinned.map((call) => call.token)).toEqual(["token-1", "token-1"]);
    expect(pinned[0].request).toMatchObject({ method: "POST", path: "/stories", body: { uid, title: "new story", product: 1, pri: 2, category: "feature", spec: expect.stringContaining("file-read-101") } });
    expect(pinned[1].request).toEqual({ method: "GET", path: "/stories/31" });
    expect(pinned.some((call) => call.request.path.endsWith("/change"))).toBe(false);
  });

  async function confirmedCreate(requestWithToken: ScriptValue[]) {
    const source = join(tempDir, "source.png"); await writeFile(source, new Uint8Array([1]));
    const fake = scriptedClient({ getToken: ["token-1"], uploadImage: [{ id: 101, url: "/file-read-101.png" }], requestWithToken });
    const result = await createStoryWithImages({ body: { title: "new story", product: 1, pri: 2, category: "feature", spec: "{{image:ui}}" }, title: "new story", spec: "{{image:ui}}", images: [{ key: "ui", path: source }], confirm: true }, fake.client);
    return { fake, result };
  }

  it.each([
    ["ordinary 400", httpError(400), "PARTIAL", "known_failure"], ["ordinary 409", httpError(409), "PARTIAL", "known_failure"], ["HTTP 408", httpError(408), "UNKNOWN", "unknown"], ["HTTP 429", httpError(429), "UNKNOWN", "unknown"], ["HTTP 500", httpError(500), "UNKNOWN", "unknown"], ["network error", new Error("socket closed"), "UNKNOWN", "unknown"],
  ] as const)("classifies %s without retry", async (_name, error, status, outcome) => {
    const { fake, result } = await confirmedCreate([error]);
    expect(result).toMatchObject({ status, phase: "create", uploaded: [{ key: "ui" }], failed: [{ outcome }], unattempted: [] });
    expect(result).not.toHaveProperty("story_id");
    expect(fake.calls.filter((call) => call.operation === "requestWithToken")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.operation === "login")).toHaveLength(0);
    expect(JSON.stringify(result)).not.toMatch(/token-1|password|cookie|"uid"/i);
  });

  it.each([null, "ok", {}, { id: 0 }, { id: "31" }])("returns UNKNOWN/create for invalid response %j", async (response) => {
    const { fake, result } = await confirmedCreate([response]);
    expect(result).toMatchObject({ status: "UNKNOWN", phase: "create", failed: [{ outcome: "unknown" }] });
    expect(result).not.toHaveProperty("story_id");
    expect(fake.calls.filter((call) => call.operation === "requestWithToken")).toHaveLength(1);
  });

  it.each([408, 429, 502, 503, 504])("retries one transient verify HTTP %i with the pinned token", async (status) => {
    const { fake, result } = await confirmedCreate([{ id: 31 }, httpError(status), createdStory([101])]);
    expect(result).toMatchObject({ status: "SUCCESS", phase: "verify", story_id: 31 });
    const pinned = fake.calls.filter((call): call is Extract<FakeCall, { operation: "requestWithToken" }> => call.operation === "requestWithToken");
    expect(pinned.map((call) => call.request.method)).toEqual(["POST", "GET", "GET"]);
    expect(new Set(pinned.map((call) => call.token))).toEqual(new Set(["token-1"]));
    expect(fake.calls.filter((call) => call.operation === "login")).toHaveLength(0);
  });

  it.each([400, 500])("does not retry verify HTTP %i", async (status) => {
    const { fake, result } = await confirmedCreate([{ id: 31 }, httpError(status)]);
    expect(result).toMatchObject({ status: "PARTIAL", phase: "verify", story_id: 31, failed: [{ outcome: "known_failure" }] });
    expect(fake.calls.filter((call) => call.operation === "requestWithToken")).toHaveLength(2);
  });

  it("returns PARTIAL/verify after two transient failures", async () => {
    const { fake, result } = await confirmedCreate([{ id: 31 }, httpError(503), httpError(503)]);
    expect(result).toMatchObject({ status: "PARTIAL", phase: "verify", story_id: 31, failed: [{ outcome: "unknown" }] });
    expect(fake.calls.filter((call) => call.operation === "requestWithToken")).toHaveLength(3);
  });

  it.each([["wrong id", { id: 32 }], ["missing file id", { spec: "<img src=rewritten>" }], ["residual marker", { spec: "file-read-101 {{image:ui}}" }], ["wrong title", { title: "other" }], ["wrong verify", { verify: "other" }]])("returns PARTIAL/verify for %s", async (_name, override) => {
    const { fake, result } = await confirmedCreate([{ id: 31 }, createdStory([101], override)]);
    expect(result).toMatchObject({ status: "PARTIAL", phase: "verify", story_id: 31, failed: [{ outcome: "known_failure" }] });
    expect(fake.calls.filter((call) => call.operation === "requestWithToken")).toHaveLength(2);
  });
});
