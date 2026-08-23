import { randomUUID } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve } from "node:path";
import {
  ZentaoHttpError,
  type ZentaoImageContentType,
  type ZentaoImageUploadRequest,
} from "../zentao/client.js";
import type { ToolRequest, ZentaoRequester } from "./queryTools.js";

export type StoryImageInput = {
  key: string;
  path: string;
  alt?: string;
  filename?: string;
};

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

export type PublicPreparedStoryImage = Omit<PreparedStoryImage, "mtimeMs" | "contentType">;

export type StorySnapshot = {
  id: number;
  version: number | null;
  lastEditedDate: string | null;
  title: string;
  spec: string;
  verify: string;
};

export type UploadedStoryImage = PublicPreparedStoryImage & {
  file_id: number;
  url: string;
};

export type StoryImageFailure = {
  key?: string;
  outcome: "known_failure" | "unknown";
  error: string;
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

export type StoryImageTransport = ZentaoRequester & {
  getToken(): Promise<string>;
  login(): Promise<string>;
  requestWithToken(request: ToolRequest, token: string): Promise<unknown>;
  uploadImage(request: ZentaoImageUploadRequest, token: string): Promise<unknown>;
};

export type StoryImageUploadResult =
  | { ok: true; transport: StoryImageTransport; token: string; uid: string; uploaded: UploadedStoryImage[] }
  | {
      ok: false;
      phase: "preflight" | "upload";
      status: "REJECTED" | "PARTIAL" | "UNKNOWN";
      uploaded: UploadedStoryImage[];
      failed: StoryImageFailure[];
      unattempted: PublicPreparedStoryImage[];
    };

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

export function publicPreparedImage(
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

export function preflightStoryImageFailure(error: unknown, images: StoryImageInput[]): StoryImageFailure {
  return {
    key: preflightFailureKey(error, images),
    outcome: "known_failure",
    error: localError(error),
  };
}

export function remoteError(error: unknown, fallback: string): string {
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

export function isOrdinary4xx(error: unknown): boolean {
  return error instanceof ZentaoHttpError && error.status >= 400 && error.status < 500 && error.status !== 408;
}

function uploadFailureOutcome(error: unknown): StoryImageFailure["outcome"] {
  return isOrdinary4xx(error) ? "known_failure" : "unknown";
}

export async function uploadStoryImages(
  prepared: PreparedStoryImage[],
  client: ZentaoRequester,
): Promise<StoryImageUploadResult> {
  const unattempted = prepared.map(publicPreparedImage);
  if (!isStoryImageTransport(client)) {
    return {
      ok: false,
      phase: "preflight",
      status: "REJECTED",
      uploaded: [],
      failed: [{ outcome: "known_failure", error: "ZenTao client does not support story image uploads" }],
      unattempted,
    };
  }
  let token: string;
  try {
    token = await client.getToken();
  } catch (error) {
    return {
      ok: false,
      phase: "preflight",
      status: "REJECTED",
      uploaded: [],
      failed: [{ outcome: "unknown", error: remoteError(error, "Unable to pin a ZenTao session for image upload") }],
      unattempted,
    };
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
      return stoppedUpload(prepared, uploaded, index, "known_failure", localError(error));
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
          return stoppedUpload(prepared, uploaded, index, "known_failure", remoteError(loginError, "Unable to renew the ZenTao session before image upload"));
        }
        try {
          response = await client.uploadImage({ uid, bytes, filename: image.filename, contentType: image.contentType }, token);
        } catch (retryError) {
          return stoppedUpload(prepared, uploaded, index, uploadFailureOutcome(retryError), remoteError(retryError, "ZenTao image upload result is unknown"));
        }
      } else {
        return stoppedUpload(prepared, uploaded, index, uploadFailureOutcome(error), remoteError(error, "ZenTao image upload result is unknown"));
      }
    }
    const normalized = readUploadResponse(response);
    if (normalized === undefined) {
      return stoppedUpload(prepared, uploaded, index, "unknown", "ZenTao image upload response did not include a valid id and url");
    }
    uploaded.push({ ...publicPreparedImage(image), file_id: normalized.id, url: normalized.url });
    // ZenTao 17.4 stores the uid album in the Token session; after one successful upload, never relogin or retransmit an upload whose result is unknown.
  }
  return { ok: true, transport: client, token, uid, uploaded };
}

function stoppedUpload(
  prepared: PreparedStoryImage[],
  uploaded: UploadedStoryImage[],
  index: number,
  outcome: StoryImageFailure["outcome"],
  error: string,
): StoryImageUploadResult {
  return {
    ok: false,
    phase: "upload",
    status: outcome === "unknown" ? "UNKNOWN" : uploaded.length === 0 ? "REJECTED" : "PARTIAL",
    uploaded,
    failed: [{ key: prepared[index].key, outcome, error }],
    unattempted: prepared.slice(index + 1).map(publicPreparedImage),
  };
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
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}
