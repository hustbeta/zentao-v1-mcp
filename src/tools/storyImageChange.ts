import { createHash } from "node:crypto";
import { ZentaoHttpError } from "../zentao/client.js";
import { endpoints, renderPath } from "../zentao/endpoints.js";
import type { ToolRequest, ZentaoRequester } from "./queryTools.js";
import {
  prepareStoryImages,
  preflightStoryImageFailure,
  publicPreparedImage,
  isOrdinary4xx,
  readStorySnapshot,
  remoteError,
  replaceImagePlaceholders,
  uploadStoryImages,
  type PreparedStoryImage,
  type StoryImageFailure,
  type StoryImageInput,
  type StoryImageTransport,
  type StorySnapshot,
  type UploadedStoryImage,
} from "./storyImageWorkflow.js";

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

export async function changeStoryWithImages(
  args: StoryImageChangeArgs,
  client: ZentaoRequester,
): Promise<StoryImageResult> {
  let prepared: PreparedStoryImage[];
  try {
    prepared = await prepareStoryImages(args.spec, args.images);
  } catch (error) {
    return makeStoryImageResult(args, "REJECTED", "preflight", {
      failed: [preflightStoryImageFailure(error, args.images)],
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
  const uploadResult = await uploadStoryImages(prepared, client);
  if (!uploadResult.ok) {
    return makeStoryImageResult(args, uploadResult.status, uploadResult.phase, {
      currentRevision,
      uploaded: uploadResult.uploaded,
      failed: uploadResult.failed,
      unattempted: uploadResult.unattempted,
    });
  }
  const { transport, token, uid, uploaded } = uploadResult;

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
    changeResponse = await transport.requestWithToken(changeRequest, token);
  } catch (error) {
    if (isOrdinary4xx(error) && !isHttpStatus(error, 429)) {
      return changeFailure(args, currentRevision, uploaded, "PARTIAL", "known_failure", remoteError(error, "ZenTao story change failed"));
    }
    if (isHttpStatus(error, 429)) {
      const state = await readPinnedState(transport, storyPath, token, before, uploaded, target);
      if (state.kind === "target") return successfulResult(args, currentRevision, uploaded);
      if (state.kind !== "before") {
        return changeFailure(args, currentRevision, uploaded, "UNKNOWN", "unknown", state.error);
      }

      try {
        changeResponse = await transport.requestWithToken(changeRequest, token);
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
        return disambiguateUnknownChange(args, currentRevision, transport, storyPath, token, before, uploaded, target);
      }
    } else {
      return disambiguateUnknownChange(args, currentRevision, transport, storyPath, token, before, uploaded, target);
    }
  }

  if (!isRecord(changeResponse)) {
    return disambiguateUnknownChange(args, currentRevision, transport, storyPath, token, before, uploaded, target);
  }
  return verifyChangedStory(args, currentRevision, transport, storyPath, token, uploaded, target);
}

export function computeStoryRevision(story: StorySnapshot): string {
  const snapshot = [story.id, story.version, story.lastEditedDate, story.title, story.spec, story.verify];
  return `sha256:${createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")}`;
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

function isHttpStatus(error: unknown, status: number): boolean {
  return error instanceof ZentaoHttpError && error.status === status;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
