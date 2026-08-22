import { z } from "zod";
import { jsonText } from "../mcp/result.js";
import { createWriteSummary, ensureConfirmed } from "../safety.js";
import { endpoints, renderPath } from "../zentao/endpoints.js";
import type { McpServerLike, ToolRequest, ZentaoRequester } from "./queryTools.js";
import { changeStoryWithImages, type StoryImageChangeArgs } from "./storyImageChange.js";

type Dispatch = (request: ToolRequest) => Promise<unknown> | unknown;

// ZenTao v1 story docs expose a small fixed category/source set; keep write tools enum-bound.
const storyCategorySchema = z.enum(["feature", "interface", "performance", "safe", "experience", "improve", "other"]);
const storySourceSchema = z.enum(["customer", "user", "po", "market"]);

// Story priority is documented as 1..4; reject wider integers before dispatching a write.
const storyPrioritySchema = z.number().int().min(1).max(4);

const createStoryFieldShape = {
  title: z.string().min(1).describe("Story title."),
  product: z.number().int().positive().describe("ZenTao product ID."),
  pri: storyPrioritySchema.describe("Story priority, 1 through 4."),
  category: storyCategorySchema.describe("Story category."),
  spec: z.string().min(1).optional().describe("Story spec."),
  verify: z.string().min(1).optional().describe("Story verification notes."),
  source: storySourceSchema.optional().describe("Story source."),
  sourceNote: z.string().min(1).optional().describe("Story source note."),
  estimate: z.number().nonnegative().optional().describe("Story estimate."),
  keywords: z.string().min(1).optional().describe("Story keywords."),
};

const changeStoryFieldShape = {
  title: createStoryFieldShape.title.optional(),
  spec: createStoryFieldShape.spec,
  verify: createStoryFieldShape.verify,
};

const storyImageSchema = z.object({
  key: z.string().min(1).describe("Placeholder key used by {{image:key}}."),
  path: z.string().min(1).describe("Absolute local Windows image path."),
  alt: z.string().optional().describe("Image alt text; defaults from the upload filename."),
  filename: z.string().min(1).optional().describe("Authoritative upload filename and declared image type."),
});

const updateStoryFieldShape = {
  module: z.number().int().nonnegative().optional().describe("ZenTao module ID; 0 means no module."),
  source: createStoryFieldShape.source,
  sourceNote: createStoryFieldShape.sourceNote,
  pri: createStoryFieldShape.pri.optional(),
  category: createStoryFieldShape.category.optional(),
  estimate: createStoryFieldShape.estimate,
  keywords: createStoryFieldShape.keywords,
};

const createStorySchema = z.object({
  ...createStoryFieldShape,
  confirm: z.boolean().optional().describe("Must be true to send the write request."),
});

const changeStorySchema = z.object({
  story_id: z.number().int().positive().describe("ZenTao story ID."),
  ...changeStoryFieldShape,
  images: z.array(storyImageSchema).optional().describe("Local images referenced by {{image:key}} placeholders."),
  expected_revision: z.string().optional().describe("Required with confirm=true when images are present."),
  confirm: z.boolean().optional().describe("Must be true to send the write request."),
});

const updateStorySchema = z.object({
  story_id: z.number().int().positive().describe("ZenTao story ID."),
  ...updateStoryFieldShape,
  confirm: z.boolean().optional().describe("Must be true to send the write request."),
});

type CreateStoryArgs = z.infer<typeof createStorySchema>;
type ChangeStoryArgs = z.infer<typeof changeStorySchema>;
type UpdateStoryArgs = z.infer<typeof updateStorySchema>;

const createStoryFieldNames = [
  "title",
  "product",
  "pri",
  "category",
  "spec",
  "verify",
  "source",
  "sourceNote",
  "estimate",
  "keywords",
] as const;

const changeStoryFieldNames = ["title", "spec", "verify"] as const;
const updateStoryFieldNames = ["module", "source", "sourceNote", "pri", "category", "estimate", "keywords"] as const;

export function resolveCreateStoryRequest(args: CreateStoryArgs, dispatch: Dispatch) {
  const parsed = createStorySchema.parse(args);
  const body = pickDefined(parsed, createStoryFieldNames);
  const request = { method: endpoints.createStory.method, path: endpoints.createStory.path, body };

  if (!ensureConfirmed(parsed.confirm)) {
    return createWriteSummary(request);
  }

  return dispatch(request);
}

export function resolveChangeStoryRequest(args: ChangeStoryArgs, dispatch: Dispatch) {
  const parsed = changeStorySchema.parse(args);
  if (parsed.images?.length) {
    throw new Error("non-empty images must use the story image workflow");
  }
  const path = renderPath(endpoints.changeStory, { story_id: parsed.story_id });
  const body = pickDefined(parsed, changeStoryFieldNames);
  if (Object.keys(body).length === 0) {
    throw new Error("change story requires at least one update field");
  }

  const request = { method: endpoints.changeStory.method, path, body };
  if (!ensureConfirmed(parsed.confirm)) {
    return createWriteSummary(request);
  }

  return dispatch(request);
}

export async function resolveChangeStory(args: ChangeStoryArgs, client: ZentaoRequester) {
  const parsed = changeStorySchema.parse(args);
  const images = parsed.images;
  // Empty and absent image arrays deliberately retain the legacy JSON request and result shapes.
  if (!images?.length) {
    return resolveChangeStoryRequest(parsed, (request) => client.request(request));
  }

  const imageArgs: StoryImageChangeArgs = { ...parsed, spec: parsed.spec ?? "", images };
  return changeStoryWithImages(imageArgs, client);
}

export function resolveUpdateStoryRequest(args: UpdateStoryArgs, dispatch: Dispatch) {
  const parsed = updateStorySchema.parse(args);
  const path = renderPath(endpoints.updateStory, { story_id: parsed.story_id });
  const body = pickDefined(parsed, updateStoryFieldNames);
  if (Object.keys(body).length === 0) {
    throw new Error("update story requires at least one update field");
  }

  const request = { method: endpoints.updateStory.method, path, body };
  if (!ensureConfirmed(parsed.confirm)) {
    return createWriteSummary(request);
  }

  return dispatch(request);
}

export function registerStoryTools(server: McpServerLike, client: ZentaoRequester): void {
  server.tool(
    "zentao_create_story",
    "Create a ZenTao story. Without confirm=true, returns a dry-run summary instead of writing.",
    createStorySchema.shape,
    async (args) =>
      jsonText(await resolveCreateStoryRequest(args as CreateStoryArgs, (request) => client.request(request))),
  );

  // ZenTao separates story content changes from metadata updates; keeping separate tools avoids split writes.
  server.tool(
    "zentao_change_story",
    "Change ZenTao story title/spec/verify fields. Local images use {{image:key}} placeholders, and confirmed image changes require the revision returned by dry-run. Without confirm=true, returns a dry-run summary instead of writing.",
    changeStorySchema.shape,
    async (args) => jsonText(await resolveChangeStory(args as ChangeStoryArgs, client)),
  );

  server.tool(
    "zentao_update_story",
    "Update ZenTao story metadata fields. Without confirm=true, returns a dry-run summary instead of writing.",
    updateStorySchema.shape,
    async (args) =>
      jsonText(await resolveUpdateStoryRequest(args as UpdateStoryArgs, (request) => client.request(request))),
  );
}

function pickDefined<T extends Record<string, unknown>, K extends readonly (keyof T)[]>(
  value: T,
  keys: K,
): Partial<Pick<T, K[number]>> {
  return Object.fromEntries(
    keys.flatMap((key) => (value[key] === undefined ? [] : [[key, value[key]]])),
  ) as Partial<Pick<T, K[number]>>;
}
