import { z } from "zod";
import { jsonText } from "../mcp/result.js";
import { endpoints, renderPath, type Endpoint } from "../zentao/endpoints.js";
import type { McpServerLike, ToolRequest, ZentaoRequester } from "./queryTools.js";

const listResourceKeys = [
  "users",
  "departments",
  "programs",
  "product_plans",
  "product_testcases",
  "testtasks",
  "project_testtasks",
  "feedbacks",
  "tickets",
] as const;

const getResourceKeys = [
  "user",
  "department",
  "program",
  "product_plan",
  "product",
  "project",
  "execution",
  "story",
  "task",
  "bug",
  "testcase",
  "testtask",
  "feedback",
  "ticket",
] as const;

type ListResource = (typeof listResourceKeys)[number];
type GetResource = (typeof getResourceKeys)[number];

const listResources = {
  users: { endpoint: endpoints.users, scope: "none" },
  departments: { endpoint: endpoints.departments, scope: "none" },
  programs: { endpoint: endpoints.programs, scope: "none" },
  product_plans: { endpoint: endpoints.productPlans, scope: "product_id" },
  product_testcases: { endpoint: endpoints.productTestcases, scope: "product_id" },
  testtasks: { endpoint: endpoints.testtasks, scope: "none" },
  project_testtasks: { endpoint: endpoints.projectTesttasks, scope: "project_id" },
  feedbacks: { endpoint: endpoints.feedbacks, scope: "none" },
  tickets: { endpoint: endpoints.tickets, scope: "none" },
} satisfies Record<ListResource, { endpoint: Endpoint; scope: "none" | "product_id" | "project_id" }>;

const getResources = {
  user: endpoints.user,
  department: endpoints.department,
  program: endpoints.program,
  product_plan: endpoints.productPlan,
  product: endpoints.product,
  project: endpoints.project,
  execution: endpoints.execution,
  story: endpoints.story,
  task: endpoints.task,
  bug: endpoints.bug,
  testcase: endpoints.testcase,
  testtask: endpoints.testtask,
  feedback: endpoints.feedback,
  ticket: endpoints.ticket,
} satisfies Record<GetResource, Endpoint>;

const paginationShape = {
  page: z.number().int().positive().default(1).describe("Page number, starting from 1."),
  limit: z.number().int().positive().max(100).default(20).describe("Maximum records to return."),
};

const listSchema = z.object({
  resource: z.enum(listResourceKeys).describe("Constrained list resource."),
  product_id: z.number().int().positive().optional().describe("ZenTao product ID for product-scoped lists."),
  project_id: z.number().int().positive().optional().describe("ZenTao project ID for project-scoped lists."),
  execution_id: z.number().int().positive().optional().describe("Reserved; rejected by generic list resources."),
  ...paginationShape,
});

const getSchema = z.object({
  resource: z.enum(getResourceKeys).describe("Constrained detail resource."),
  id: z.number().int().positive().describe("ZenTao object ID."),
});

type GenericListArgs = z.infer<typeof listSchema>;
type GenericGetArgs = z.infer<typeof getSchema>;

export function resolveGenericListRequest(args: GenericListArgs): ToolRequest {
  const parsed = parseListArgs(args);
  const definition = listResources[parsed.resource];
  const pathParams = pathParamsForList(parsed, definition.scope);

  return {
    method: definition.endpoint.method,
    path: renderPath(definition.endpoint, pathParams),
    query: { page: parsed.page, limit: parsed.limit },
  };
}

export function resolveGenericGetRequest(args: GenericGetArgs): ToolRequest {
  const parsed = parseGetArgs(args);
  const endpoint = getResources[parsed.resource];

  return {
    method: endpoint.method,
    path: renderPath(endpoint, { id: parsed.id }),
  };
}

export function registerGenericTools(server: McpServerLike, client: ZentaoRequester): void {
  server.tool(
    "zentao_list_objects",
    "List low-frequency ZenTao resources through a constrained resource enum.",
    listSchema.shape,
    async (args) => jsonText(await client.request(resolveGenericListRequest(args as GenericListArgs))),
  );

  server.tool(
    "zentao_get_object",
    "Get one low-frequency ZenTao object through a constrained resource enum.",
    getSchema.shape,
    async (args) => jsonText(await client.request(resolveGenericGetRequest(args as GenericGetArgs))),
  );
}

function parseListArgs(args: GenericListArgs): GenericListArgs {
  const result = listSchema.safeParse(args);
  if (!result.success) {
    throw unsupportedResourceError(args.resource);
  }
  return result.data;
}

function parseGetArgs(args: GenericGetArgs): GenericGetArgs {
  const result = getSchema.safeParse(args);
  if (!result.success) {
    throw unsupportedResourceError(args.resource);
  }
  return result.data;
}

function pathParamsForList(
  parsed: GenericListArgs,
  scope: "none" | "product_id" | "project_id",
): Record<string, number | undefined> {
  if (scope === "product_id") {
    if (parsed.product_id === undefined) throw new Error("product_id is required");
    rejectUnexpectedParentIds(parsed, ["project_id", "execution_id"]);
    return { product_id: parsed.product_id };
  }

  if (scope === "project_id") {
    if (parsed.project_id === undefined) throw new Error("project_id is required");
    rejectUnexpectedParentIds(parsed, ["product_id", "execution_id"]);
    return { project_id: parsed.project_id };
  }

  rejectUnexpectedParentIds(parsed, ["product_id", "project_id", "execution_id"]);
  return {};
}

function rejectUnexpectedParentIds(parsed: GenericListArgs, keys: Array<keyof GenericListArgs>): void {
  const present = keys.filter((key) => parsed[key] !== undefined);
  if (present.length > 0) {
    // Generic tools are enum constrained; parent IDs are only accepted where the mapped endpoint needs them.
    throw new Error(`${parsed.resource} must not receive parent IDs: ${present.join(", ")}`);
  }
}

function unsupportedResourceError(resource: unknown): Error {
  return new Error(`Unsupported resource: ${String(resource)}`);
}
