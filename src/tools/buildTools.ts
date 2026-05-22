import { z } from "zod";
import { jsonText } from "../mcp/result.js";
import { createWriteSummary, ensureConfirmed } from "../safety.js";
import { endpoints, renderPath } from "../zentao/endpoints.js";
import type { McpServerLike, ToolRequest, ZentaoRequester } from "./queryTools.js";

type Dispatch = (request: ToolRequest) => Promise<unknown> | unknown;

const buildFieldShape = {
  execution: z.number().int().positive().optional().describe("ZenTao execution ID."),
  product: z.number().int().positive().optional().describe("ZenTao product ID."),
  name: z.string().min(1).optional().describe("Build name."),
  builder: z.string().min(1).optional().describe("Build creator account."),
  branch: z.string().min(1).optional().describe("Product branch."),
  date: z.string().min(1).optional().describe("Build date accepted by ZenTao."),
  scmPath: z.string().min(1).optional().describe("Source code path."),
  filePath: z.string().min(1).optional().describe("Build artifact path."),
  desc: z.string().min(1).optional().describe("Build description."),
};

const createBuildSchema = z.object({
  project_id: z.number().int().positive().describe("ZenTao project ID."),
  execution: z.number().int().positive().describe("ZenTao execution ID."),
  product: z.number().int().positive().describe("ZenTao product ID."),
  name: z.string().min(1).describe("Build name."),
  builder: z.string().min(1).describe("Build creator account."),
  branch: buildFieldShape.branch,
  date: buildFieldShape.date,
  scmPath: buildFieldShape.scmPath,
  filePath: buildFieldShape.filePath,
  desc: buildFieldShape.desc,
  confirm: z.boolean().optional().describe("Must be true to send the write request."),
});

const updateBuildSchema = z.object({
  build_id: z.number().int().positive().describe("ZenTao build ID."),
  ...buildFieldShape,
  confirm: z.boolean().optional().describe("Must be true to send the write request."),
});

type CreateBuildArgs = z.infer<typeof createBuildSchema>;
type UpdateBuildArgs = z.infer<typeof updateBuildSchema>;

const updateFieldNames = [
  "execution",
  "product",
  "name",
  "builder",
  "branch",
  "date",
  "scmPath",
  "filePath",
  "desc",
] as const;

export function resolveCreateBuildRequest(args: CreateBuildArgs, dispatch: Dispatch) {
  const parsed = createBuildSchema.parse(args);
  const path = renderPath(endpoints.createBuild, { project_id: parsed.project_id });
  const body = pickDefined(parsed, updateFieldNames);
  const request = { method: endpoints.createBuild.method, path, body };

  if (!ensureConfirmed(parsed.confirm)) {
    return createWriteSummary(request);
  }

  return dispatch(request);
}

export function resolveUpdateBuildRequest(args: UpdateBuildArgs, dispatch: Dispatch) {
  const parsed = updateBuildSchema.parse(args);
  const path = renderPath(endpoints.updateBuild, { build_id: parsed.build_id });
  // 708_修改版本.md does not document a body; first version only mirrors create-build fields.
  const body = pickDefined(parsed, updateFieldNames);
  if (Object.keys(body).length === 0) {
    throw new Error("update build requires at least one update field");
  }

  const request = { method: endpoints.updateBuild.method, path, body };
  if (!ensureConfirmed(parsed.confirm)) {
    return createWriteSummary(request);
  }

  return dispatch(request);
}

export function registerBuildTools(server: McpServerLike, client: ZentaoRequester): void {
  server.tool(
    "zentao_create_build",
    "Create a ZenTao build. Without confirm=true, returns a dry-run summary instead of writing.",
    createBuildSchema.shape,
    async (args) => jsonText(await resolveCreateBuildRequest(args as CreateBuildArgs, (request) => client.request(request))),
  );

  server.tool(
    "zentao_update_build",
    "Update a ZenTao build. Without confirm=true, returns a dry-run summary instead of writing.",
    updateBuildSchema.shape,
    async (args) => jsonText(await resolveUpdateBuildRequest(args as UpdateBuildArgs, (request) => client.request(request))),
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
