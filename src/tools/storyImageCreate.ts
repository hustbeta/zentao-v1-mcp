import { createWriteSummary, type WriteSummary } from "../safety.js";
import { ZentaoHttpError } from "../zentao/client.js";
import { endpoints, renderPath } from "../zentao/endpoints.js";
import type { ToolRequest, ZentaoRequester } from "./queryTools.js";
import {
  prepareStoryImages,
  preflightStoryImageFailure,
  publicPreparedImage,
  readStorySnapshot,
  replaceImagePlaceholders,
  uploadStoryImages,
  type PreparedStoryImage,
  type PublicPreparedStoryImage,
  type StoryImageFailure,
  type StoryImageInput,
  type StoryImageTransport,
  type StoryImageUploadResult,
  type StorySnapshot,
  type UploadedStoryImage,
} from "./storyImageWorkflow.js";

export type StoryImageCreateArgs = {
  body: Record<string, unknown>;
  title: string;
  spec: string;
  verify?: string;
  images: StoryImageInput[];
  confirm?: boolean;
};

export type StoryImageCreateStatus = "DRY_RUN" | "SUCCESS" | "PARTIAL" | "UNKNOWN" | "REJECTED";
export type StoryImageCreatePhase = "preflight" | "upload" | "create" | "verify";
export type StoryImageCreateResult = {
  status: StoryImageCreateStatus;
  phase: StoryImageCreatePhase;
  story_id?: number;
  request_summary?: WriteSummary;
  uploaded: UploadedStoryImage[];
  failed: StoryImageFailure[];
  unattempted: PublicPreparedStoryImage[];
};

export async function createStoryWithImages(args: StoryImageCreateArgs, client: ZentaoRequester): Promise<StoryImageCreateResult> {
  let prepared: PreparedStoryImage[];
  try {
    prepared = await prepareStoryImages(args.spec, args.images);
  } catch (error) {
    return { status: "REJECTED", phase: "preflight", uploaded: [], failed: [preflightStoryImageFailure(error, args.images)], unattempted: [] };
  }

  const request = { method: endpoints.createStory.method, path: endpoints.createStory.path, body: args.body };
  // New stories have no prior revision; confirmation therefore repeats local preflight only.
  if (args.confirm !== true) {
    return { status: "DRY_RUN", phase: "preflight", request_summary: createWriteSummary(request), uploaded: [], failed: [], unattempted: prepared.map(publicPreparedImage) };
  }

  const uploadResult = await uploadStoryImages(prepared, client);
  if (!uploadResult.ok) return fromUploadFailure(uploadResult);
  const { transport, token, uid, uploaded } = uploadResult;
  const createRequest: ToolRequest = { method: endpoints.createStory.method, path: endpoints.createStory.path, body: { ...args.body, spec: replaceImagePlaceholders(args.spec, uploaded), uid } };
  let createResponse: unknown;
  try {
    createResponse = await transport.requestWithToken(createRequest, token);
  } catch (error) {
    // Without a trustworthy story id, retrying an unknown create could create a duplicate story.
    const failure = createFailureOutcome(error);
    return createFailure(uploaded, failure.status, failure.outcome, error instanceof ZentaoHttpError ? error.message : "ZenTao story create result is unknown");
  }
  const storyID = readCreatedStoryID(createResponse);
  if (storyID === undefined) return createFailure(uploaded, "UNKNOWN", "unknown", "ZenTao story create response did not include a valid id");
  return verifyCreatedStory(args, storyID, transport, token, uploaded);
}

function fromUploadFailure(result: Exclude<StoryImageUploadResult, { ok: true }>): StoryImageCreateResult {
  return { status: result.status, phase: result.phase, uploaded: result.uploaded, failed: result.failed, unattempted: result.unattempted };
}

function readCreatedStoryID(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const id = (value as Record<string, unknown>).id;
  return Number.isSafeInteger(id) && (id as number) > 0 ? (id as number) : undefined;
}

function createFailure(uploaded: UploadedStoryImage[], status: "PARTIAL" | "UNKNOWN", outcome: StoryImageFailure["outcome"], error: string): StoryImageCreateResult {
  return { status, phase: "create", uploaded, failed: [{ outcome, error }], unattempted: [] };
}

function createFailureOutcome(error: unknown): { status: "PARTIAL" | "UNKNOWN"; outcome: StoryImageFailure["outcome"] } {
  if (error instanceof ZentaoHttpError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) return { status: "PARTIAL", outcome: "known_failure" };
  return { status: "UNKNOWN", outcome: "unknown" };
}

async function verifyCreatedStory(args: StoryImageCreateArgs, storyID: number, transport: StoryImageTransport, token: string, uploaded: UploadedStoryImage[]): Promise<StoryImageCreateResult> {
  const request: ToolRequest = { method: endpoints.story.method, path: renderPath(endpoints.story, { id: storyID }) };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let value: unknown;
    try {
      value = await transport.requestWithToken(request, token);
    } catch (error) {
      const transient = isTransientVerifyFailure(error);
      if (attempt === 0 && transient) continue;
      return { status: "PARTIAL", phase: "verify", story_id: storyID, uploaded, failed: [{ outcome: transient ? "unknown" : "known_failure", error: error instanceof ZentaoHttpError ? error.message : "ZenTao story verification failed" }], unattempted: [] };
    }
    let story: StorySnapshot;
    try {
      story = readStorySnapshot(value);
    } catch {
      return { status: "PARTIAL", phase: "verify", story_id: storyID, uploaded, failed: [{ outcome: "known_failure", error: "ZenTao story verification response was invalid" }], unattempted: [] };
    }
    const matches = story.id === storyID && uploaded.every(({ file_id }) => story.spec.includes(`file-read-${file_id}`)) && !story.spec.includes("{{image:") && story.title === args.title && story.verify === (args.verify ?? "");
    return matches
      ? { status: "SUCCESS", phase: "verify", story_id: storyID, uploaded, failed: [], unattempted: [] }
      : { status: "PARTIAL", phase: "verify", story_id: storyID, uploaded, failed: [{ outcome: "known_failure", error: "ZenTao story verification did not match the requested image create" }], unattempted: [] };
  }
  throw new Error("unreachable");
}

function isTransientVerifyFailure(error: unknown): boolean {
  if (!(error instanceof ZentaoHttpError)) return true;
  return [408, 429, 502, 503, 504].includes(error.status);
}
