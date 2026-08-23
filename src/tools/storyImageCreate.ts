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
    return createFailure(uploaded, "UNKNOWN", "unknown", error instanceof ZentaoHttpError ? error.message : "ZenTao story create result is unknown");
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

async function verifyCreatedStory(args: StoryImageCreateArgs, storyID: number, transport: StoryImageTransport, token: string, uploaded: UploadedStoryImage[]): Promise<StoryImageCreateResult> {
  let value: unknown;
  try {
    value = await transport.requestWithToken({ method: endpoints.story.method, path: renderPath(endpoints.story, { id: storyID }) }, token);
  } catch (error) {
    return { status: "PARTIAL", phase: "verify", story_id: storyID, uploaded, failed: [{ outcome: "unknown", error: error instanceof ZentaoHttpError ? error.message : "ZenTao story verification failed" }], unattempted: [] };
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
