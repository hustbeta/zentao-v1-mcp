import { createHash, randomUUID } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve } from "node:path";
import {
  ZentaoHttpError,
  type ZentaoImageContentType,
  type ZentaoImageUploadRequest,
} from "../zentao/client.js";
import { endpoints, renderPath } from "../zentao/endpoints.js";
import type { ToolRequest, ZentaoRequester } from "./queryTools.js";

export type StoryImageInput = {
  key: string;
  path: string;
  alt?: string;
  filename?: string;
};

export type StoryImageChangeArgs = {
  story_id: number;
  title?: string;
  spec: string;
  verify?: string;
  images: StoryImageInput[];
  expected_revision?: string;
  confirm?: boolean;
};

export type StoryImageStatus = "DRY_RUN" | "SUCCESS" | "CONFLICT" | "PARTIAL" | "UNKNOWN" | "REJECTED";

export type StoryImagePhase = "preflight" | "upload" | "change" | "verify";

export type PreparedStoryImage = {
  key: string;
  path: string;
  filename: string;
  alt: string;
  contentType: ZentaoImageContentType;
  size: number;
  mtime: string;
  mtimeMs: number;
};

export type StorySnapshot = {
  id: number;
  version: number | null;
  lastEditedDate: string | null;
  title: string;
  spec: string;
  verify: string;
};

export type UploadedStoryImage = Omit<PreparedStoryImage, "mtimeMs" | "contentType"> & {
  file_id: number;
  url: string;
};

export type StoryImageFailure = {
  key?: string;
  outcome: "known_failure" | "unknown";
  error: string;
};

export type StoryImageResult = {
  status: StoryImageStatus;
  phase: StoryImagePhase;
  story_id: number;
  expected_revision?: string;
  current_revision?: string;
  uploaded: UploadedStoryImage[];
  failed: StoryImageFailure[];
  unattempted: Array<Omit<PreparedStoryImage, "mtimeMs" | "contentType">>;
};

const MAX_IMAGE_COUNT = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 25 * 1024 * 1024;
const IMAGE_KEY = /^[A-Za-z0-9_-]+$/;
const IMAGE_MARKER = /\{\{image:([A-Za-z0-9_-]+)\}\}/g;
const GLOB_CHARACTER = /[*?\[\]{}]/;
const INVALID_FILENAME_CHARACTER = /[/\\\u0000-\u001f\u007f]/;

type ValidatedImageInput = StoryImageInput & {
  path: string;
  filename: string;
  alt: string;
  contentType: ZentaoImageContentType;
};

type StoryImageTransport = ZentaoRequester & {
  getToken(): Promise<string>;
  login(): Promise<string>;
  requestWithToken(request: ToolRequest, token: string): Promise<unknown>;
  uploadImage(request: ZentaoImageUploadRequest, token: string): Promise<unknown>;
};

export async function changeStoryWithImages(
  args: StoryImageChangeArgs,
  client: ZentaoRequester,
): Promise<StoryImageResult> {
  let prepared: PreparedStoryImage[];
  try {
    prepared = await prepareStoryImages(args.spec, args.images);
  } catch (error) {
    return makeStoryImageResult(args, "REJECTED", "preflight", {
      failed: [{ key: preflightFailureKey(error, args.images), outcome: "known_failure", error: localError(error) }],
    });
  }

  const allUnattempted = prepared.map(publicPreparedImage);
  if (args.confirm === true && args.expected_revision === undefined) {
    return makeStoryImageResult(args, "REJECTED", "preflight", {
      failed: [{ outcome: "known_failure", error: "expected_revision is required for a confirmed image change" }],
      unattempted: allUnattempted,
    });
  }

  const storyPath = renderPath(endpoints.story, { id: args.story_id });
  let before: StorySnapshot;
  try {
    before = readStorySnapshot(await client.request({ method: endpoints.story.method, path: storyPath }));
  } catch (error) {
    return makeStoryImageResult(args, "REJECTED", "preflight", {
      failed: [{ outcome: "unknown", error: remoteError(error, "Unable to read the ZenTao story before upload") }],
      unattempted: allUnattempted,
    });
  }

  const currentRevision = computeStoryRevision(before);
  if (args.confirm !== true) {
    return makeStoryImageResult(args, "DRY_RUN", "preflight", {
      expectedRevision: currentRevision,
      currentRevision,
      unattempted: allUnattempted,
    });
  }
  if (args.expected_revision !== currentRevision) {
    return makeStoryImageResult(args, "CONFLICT", "preflight", {
      currentRevision,
      unattempted: allUnattempted,
    });
  }
  if (!isStoryImageTransport(client)) {
    return makeStoryImageResult(args, "REJECTED", "preflight", {
      currentRevision,
      failed: [{ outcome: "known_failure", error: "ZenTao client does not support story image uploads" }],
      unattempted: allUnattempted,
    });
  }

  let token: string;
  try {
    token = await client.getToken();
  } catch (error) {
    return makeStoryImageResult(args, "REJECTED", "preflight", {
      currentRevision,
      failed: [{ outcome: "unknown", error: remoteError(error, "Unable to pin a ZenTao session for image upload") }],
      unattempted: allUnattempted,
    });
  }
  const uid = randomUUID();
  const uploaded: UploadedStoryImage[] = [];
  let authRetried = false;

  for (let index = 0; index < prepared.length; index += 1) {
    const image = prepared[index];
    let bytes: Uint8Array;
    try {
      bytes = await readPreparedImage(image);
    } catch (error) {
      return stopAtUpload(args, currentRevision, prepared, uploaded, index, "known_failure", localError(error));
    }

    let response: unknown;
    try {
      response = await client.uploadImage({ uid, bytes, filename: image.filename, contentType: image.contentType }, token);
    } catch (error) {
      if (uploaded.length === 0 && !authRetried && isExplicitAuthFailure(error)) {
        authRetried = true;
        try {
          token = await client.login();
        } catch (loginError) {
          return stopAtUpload(
            args,
            currentRevision,
            prepared,
            uploaded,
            index,
            "known_failure",
            remoteError(loginError, "Unable to renew the ZenTao session before image upload"),
          );
        }
        try {
          response = await client.uploadImage({ uid, bytes, filename: image.filename, contentType: image.contentType }, token);
        } catch (retryError) {
          const outcome = uploadFailureOutcome(retryError);
          return stopAtUpload(
            args,
            currentRevision,
            prepared,
            uploaded,
            index,
            outcome,
            remoteError(retryError, "ZenTao image upload result is unknown"),
          );
        }
      } else {
        const outcome = uploadFailureOutcome(error);
        return stopAtUpload(
          args,
          currentRevision,
          prepared,
          uploaded,
          index,
          outcome,
          remoteError(error, "ZenTao image upload result is unknown"),
        );
      }
    }

    const upload = readUploadResponse(response);
    if (upload === undefined) {
      return stopAtUpload(
        args,
        currentRevision,
        prepared,
        uploaded,
        index,
        "unknown",
        "ZenTao image upload response did not include a valid id and url",
      );
    }
    uploaded.push({ ...publicPreparedImage(image), file_id: upload.id, url: upload.url });
    // ZenTao 17.4 stores a uid album in the Token session; after one success, never relogin or retransmit an unknown upload.
  }

  const target = {
    title: args.title ?? before.title,
    spec: replaceImagePlaceholders(args.spec, uploaded),
    verify: args.verify ?? before.verify,
  };
  const changeRequest: ToolRequest = {
    method: endpoints.changeStory.method,
    path: renderPath(endpoints.changeStory, { story_id: args.story_id }),
    body: { uid, ...target },
  };

  let changeResponse: unknown;
  try {
    changeResponse = await client.requestWithToken(changeRequest, token);
  } catch (error) {
    if (isOrdinary4xx(error) && !isHttpStatus(error, 429)) {
      return changeFailure(args, currentRevision, uploaded, "PARTIAL", "known_failure", remoteError(error, "ZenTao story change failed"));
    }
    if (isHttpStatus(error, 429)) {
      const state = await readPinnedState(client, storyPath, token, before, uploaded, target);
      if (state.kind === "target") return successfulResult(args, currentRevision, uploaded);
      if (state.kind !== "before") {
        return changeFailure(args, currentRevision, uploaded, "UNKNOWN", "unknown", state.error);
      }

      try {
        changeResponse = await client.requestWithToken(changeRequest, token);
      } catch (retryError) {
        if (isOrdinary4xx(retryError)) {
          return changeFailure(
            args,
            currentRevision,
            uploaded,
            "PARTIAL",
            "known_failure",
            remoteError(retryError, "ZenTao story change retry failed"),
          );
        }
        return disambiguateUnknownChange(args, currentRevision, client, storyPath, token, before, uploaded, target);
      }
    } else {
      return disambiguateUnknownChange(args, currentRevision, client, storyPath, token, before, uploaded, target);
    }
  }

  if (!isRecord(changeResponse)) {
    return disambiguateUnknownChange(args, currentRevision, client, storyPath, token, before, uploaded, target);
  }
  return verifyChangedStory(args, currentRevision, client, storyPath, token, uploaded, target);
}

export async function prepareStoryImages(
  spec: string,
  images: StoryImageInput[],
): Promise<PreparedStoryImage[]> {
  if (spec.length === 0) throw new Error("spec is required when images are present");
  if (images.length > MAX_IMAGE_COUNT) throw new Error("At most 5 images are allowed");

  const declaredKeys = new Set<string>();
  for (const image of images) {
    if (!IMAGE_KEY.test(image.key)) throw new Error(`Invalid image key: ${image.key}`);
    if (declaredKeys.has(image.key)) throw new Error(`Image keys must be unique: ${image.key}`);
    declaredKeys.add(image.key);
  }

  const remainder = spec.replace(IMAGE_MARKER, "");
  if (remainder.includes("{{image:")) throw new Error("Image placeholder is malformed");

  const markerCounts = new Map<string, number>();
  for (const match of spec.matchAll(IMAGE_MARKER)) {
    const key = match[1];
    if (!declaredKeys.has(key)) throw new Error(`Image placeholder has no declaration: ${key}`);
    markerCounts.set(key, (markerCounts.get(key) ?? 0) + 1);
  }
  for (const key of declaredKeys) {
    if (markerCounts.get(key) !== 1) throw new Error(`Image placeholder must occur exactly once: ${key}`);
  }

  const validated = images.map(validateImageInput);
  const prepared: PreparedStoryImage[] = [];
  let totalSize = 0;
  for (const image of validated) {
    const stats = await lstat(image.path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Image path must be a regular file: ${image.key}`);
    }
    if (stats.size > MAX_IMAGE_BYTES) throw new Error(`Image exceeds 10 MiB: ${image.key}`);
    totalSize += stats.size;
    if (totalSize > MAX_TOTAL_IMAGE_BYTES) throw new Error("Images exceed the 25 MiB total limit");

    prepared.push({
      ...image,
      size: stats.size,
      mtime: stats.mtime.toISOString(),
      mtimeMs: stats.mtimeMs,
    });
  }
  return prepared;
}

function validateImageInput(image: StoryImageInput): ValidatedImageInput {
  if (!isAbsolute(image.path)) throw new Error(`Image path must be absolute: ${image.key}`);
  if (GLOB_CHARACTER.test(image.path)) throw new Error(`Image path must not contain glob characters: ${image.key}`);

  const normalizedPath = resolve(image.path);
  const filename = image.filename ?? basename(normalizedPath);
  if (filename.length === 0 || filename === "." || filename === ".." || INVALID_FILENAME_CHARACTER.test(filename)) {
    throw new Error(`Invalid image filename: ${filename}`);
  }

  // The upload filename deliberately overrides the source extension and declares MIME without inspecting content.
  const contentType = contentTypeForFilename(filename);
  const extension = extname(filename);
  return {
    ...image,
    path: normalizedPath,
    filename,
    alt: image.alt ?? basename(filename, extension),
    contentType,
  };
}

function contentTypeForFilename(filename: string): ZentaoImageContentType {
  switch (extname(filename).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    default:
      throw new Error(`Unsupported image filename: ${filename}`);
  }
}

export async function readPreparedImage(image: PreparedStoryImage): Promise<Uint8Array> {
  const pathStats = await lstat(image.path);
  assertPreparedFileUnchanged(image, pathStats);

  const handle = await open(image.path, "r");
  try {
    // Reading and checking through one handle prevents a path swap between the final metadata check and the read.
    const handleStats = await handle.stat();
    assertPreparedFileUnchanged(image, handleStats);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function assertPreparedFileUnchanged(
  image: PreparedStoryImage,
  stats: { isFile(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number },
): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size !== image.size ||
    stats.mtimeMs !== image.mtimeMs
  ) {
    throw new Error(`Prepared image changed before upload: ${image.key}`);
  }
}

export function readStorySnapshot(value: unknown): StorySnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("ZenTao story response must be a direct object");
  }
  const story = value as Record<string, unknown>;
  if (!Number.isInteger(story.id) || (story.id as number) <= 0) throw new Error("ZenTao story id must be positive");
  if (story.title !== undefined && typeof story.title !== "string") throw new Error("ZenTao story title is invalid");
  if (story.version !== undefined && story.version !== null && !Number.isInteger(story.version)) {
    throw new Error("ZenTao story version is invalid");
  }
  if (story.lastEditedDate !== undefined && story.lastEditedDate !== null && typeof story.lastEditedDate !== "string") {
    throw new Error("ZenTao story lastEditedDate is invalid");
  }
  if (story.spec !== undefined && story.spec !== null && typeof story.spec !== "string") {
    throw new Error("ZenTao story spec is invalid");
  }
  if (story.verify !== undefined && story.verify !== null && typeof story.verify !== "string") {
    throw new Error("ZenTao story verify is invalid");
  }

  return {
    id: story.id as number,
    version: (story.version as number | null | undefined) ?? null,
    lastEditedDate: (story.lastEditedDate as string | null | undefined) ?? null,
    title: (story.title as string | undefined) ?? "",
    spec: (story.spec as string | null | undefined) ?? "",
    verify: (story.verify as string | null | undefined) ?? "",
  };
}

export function computeStoryRevision(story: StorySnapshot): string {
  const snapshot = [story.id, story.version, story.lastEditedDate, story.title, story.spec, story.verify];
  return `sha256:${createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")}`;
}

export function replaceImagePlaceholders(
  spec: string,
  uploaded: Array<{ key: string; url: string; alt: string }>,
): string {
  let rendered = spec;
  for (const image of uploaded) {
    const tag = `<img src="${escapeHtmlAttribute(image.url)}" alt="${escapeHtmlAttribute(image.alt)}">`;
    rendered = rendered.replace(`{{image:${image.key}}}`, () => tag);
  }
  return rendered;
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function makeStoryImageResult(
  args: StoryImageChangeArgs,
  status: StoryImageStatus,
  phase: StoryImagePhase,
  values: {
    expectedRevision?: string;
    currentRevision?: string;
    uploaded?: UploadedStoryImage[];
    failed?: StoryImageFailure[];
    unattempted?: Array<Omit<PreparedStoryImage, "mtimeMs" | "contentType">>;
  } = {},
): StoryImageResult {
  return {
    status,
    phase,
    story_id: args.story_id,
    expected_revision: values.expectedRevision ?? args.expected_revision,
    current_revision: values.currentRevision,
    uploaded: values.uploaded ?? [],
    failed: values.failed ?? [],
    unattempted: values.unattempted ?? [],
  };
}

function publicPreparedImage(
  image: PreparedStoryImage,
): Omit<PreparedStoryImage, "mtimeMs" | "contentType"> {
  return {
    key: image.key,
    path: image.path,
    filename: image.filename,
    alt: image.alt,
    size: image.size,
    mtime: image.mtime,
  };
}

function preflightFailureKey(error: unknown, images: StoryImageInput[]): string | undefined {
  if (isRecord(error) && typeof error.path === "string") {
    const failedPath = resolve(error.path);
    const failed = images.find((image) => resolve(image.path) === failedPath);
    if (failed) return failed.key;
  }
  if (error instanceof Error) {
    return images.find((image) => error.message.endsWith(`: ${image.key}`))?.key;
  }
  return undefined;
}

function localError(error: unknown): string {
  return error instanceof Error ? error.message : "Story image validation failed";
}

function remoteError(error: unknown, fallback: string): string {
  return error instanceof ZentaoHttpError ? error.message : fallback;
}

function isStoryImageTransport(client: ZentaoRequester): client is StoryImageTransport {
  const candidate = client as Partial<StoryImageTransport>;
  return (
    typeof candidate.getToken === "function" &&
    typeof candidate.login === "function" &&
    typeof candidate.requestWithToken === "function" &&
    typeof candidate.uploadImage === "function"
  );
}

function isExplicitAuthFailure(error: unknown): boolean {
  return error instanceof ZentaoHttpError && error.authFailure;
}

function isHttpStatus(error: unknown, status: number): boolean {
  return error instanceof ZentaoHttpError && error.status === status;
}

function isOrdinary4xx(error: unknown): boolean {
  return error instanceof ZentaoHttpError && error.status >= 400 && error.status < 500 && error.status !== 408;
}

function uploadFailureOutcome(error: unknown): StoryImageFailure["outcome"] {
  return isOrdinary4xx(error) ? "known_failure" : "unknown";
}

function stopAtUpload(
  args: StoryImageChangeArgs,
  currentRevision: string,
  prepared: PreparedStoryImage[],
  uploaded: UploadedStoryImage[],
  failedIndex: number,
  outcome: StoryImageFailure["outcome"],
  error: string,
): StoryImageResult {
  const status = outcome === "unknown" ? "UNKNOWN" : uploaded.length === 0 ? "REJECTED" : "PARTIAL";
  return makeStoryImageResult(args, status, "upload", {
    currentRevision,
    uploaded,
    failed: [{ key: prepared[failedIndex].key, outcome, error }],
    unattempted: prepared.slice(failedIndex + 1).map(publicPreparedImage),
  });
}

function readUploadResponse(value: unknown): { id: number; url: string } | undefined {
  if (!isRecord(value)) return undefined;
  // ZenTao 17.4 returns PHP lastInsertID(), so successful uploads can encode the ID as a decimal string.
  const id = typeof value.id === "string" && /^[1-9]\d*$/.test(value.id) ? Number(value.id) : value.id;
  if (!Number.isSafeInteger(id) || (id as number) <= 0) return undefined;
  if (typeof value.url !== "string" || value.url.trim().length === 0) return undefined;
  return { id: id as number, url: value.url };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type TargetStory = { title: string; spec: string; verify: string };

function storyMatchesTarget(story: StorySnapshot, uploaded: UploadedStoryImage[], target: TargetStory): boolean {
  return (
    uploaded.every(({ file_id }) => story.spec.includes(`file-read-${file_id}`)) &&
    !story.spec.includes("{{image:") &&
    story.title === target.title &&
    story.verify === target.verify
  );
}

function storiesAreEqual(left: StorySnapshot, right: StorySnapshot): boolean {
  return (
    left.id === right.id &&
    left.version === right.version &&
    left.lastEditedDate === right.lastEditedDate &&
    left.title === right.title &&
    left.spec === right.spec &&
    left.verify === right.verify
  );
}

type PinnedState =
  | { kind: "target" }
  | { kind: "before" }
  | { kind: "other"; error: string };

async function readPinnedState(
  client: StoryImageTransport,
  storyPath: string,
  token: string,
  before: StorySnapshot,
  uploaded: UploadedStoryImage[],
  target: TargetStory,
): Promise<PinnedState> {
  let snapshot: StorySnapshot;
  try {
    snapshot = readStorySnapshot(await client.requestWithToken({ method: endpoints.story.method, path: storyPath }, token));
  } catch (error) {
    return { kind: "other", error: remoteError(error, "Unable to determine whether the ZenTao story changed") };
  }
  if (storyMatchesTarget(snapshot, uploaded, target)) return { kind: "target" };
  if (storiesAreEqual(snapshot, before)) return { kind: "before" };
  return { kind: "other", error: "ZenTao story state differs from both the original and requested states" };
}

function successfulResult(
  args: StoryImageChangeArgs,
  currentRevision: string,
  uploaded: UploadedStoryImage[],
): StoryImageResult {
  return makeStoryImageResult(args, "SUCCESS", "verify", { currentRevision, uploaded });
}

function changeFailure(
  args: StoryImageChangeArgs,
  currentRevision: string,
  uploaded: UploadedStoryImage[],
  status: "PARTIAL" | "UNKNOWN",
  outcome: StoryImageFailure["outcome"],
  error: string,
): StoryImageResult {
  return makeStoryImageResult(args, status, "change", {
    currentRevision,
    uploaded,
    failed: [{ outcome, error }],
  });
}

async function disambiguateUnknownChange(
  args: StoryImageChangeArgs,
  currentRevision: string,
  client: StoryImageTransport,
  storyPath: string,
  token: string,
  before: StorySnapshot,
  uploaded: UploadedStoryImage[],
  target: TargetStory,
): Promise<StoryImageResult> {
  const state = await readPinnedState(client, storyPath, token, before, uploaded, target);
  if (state.kind === "target") return successfulResult(args, currentRevision, uploaded);
  return changeFailure(
    args,
    currentRevision,
    uploaded,
    "UNKNOWN",
    "unknown",
    state.kind === "other" ? state.error : "ZenTao story change result remains unknown",
  );
}

async function verifyChangedStory(
  args: StoryImageChangeArgs,
  currentRevision: string,
  client: StoryImageTransport,
  storyPath: string,
  token: string,
  uploaded: UploadedStoryImage[],
  target: TargetStory,
): Promise<StoryImageResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let value: unknown;
    try {
      value = await client.requestWithToken({ method: endpoints.story.method, path: storyPath }, token);
    } catch (error) {
      const transient = isTransientVerifyFailure(error);
      if (attempt === 0 && transient) continue;
      return makeStoryImageResult(args, "PARTIAL", "verify", {
        currentRevision,
        uploaded,
        failed: [{ outcome: transient ? "unknown" : "known_failure", error: remoteError(error, "ZenTao story verification failed") }],
      });
    }

    let after: StorySnapshot;
    try {
      after = readStorySnapshot(value);
    } catch {
      return makeStoryImageResult(args, "PARTIAL", "verify", {
        currentRevision,
        uploaded,
        failed: [{ outcome: "known_failure", error: "ZenTao story verification response was invalid" }],
      });
    }
    if (storyMatchesTarget(after, uploaded, target)) return successfulResult(args, currentRevision, uploaded);
    return makeStoryImageResult(args, "PARTIAL", "verify", {
      currentRevision,
      uploaded,
      failed: [{ outcome: "known_failure", error: "ZenTao story verification did not match the requested image change" }],
    });
  }
  throw new Error("unreachable");
}

function isTransientVerifyFailure(error: unknown): boolean {
  if (!(error instanceof ZentaoHttpError)) return true;
  return [408, 429, 502, 503, 504].includes(error.status);
}
