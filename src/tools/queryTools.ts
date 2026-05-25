import { z } from "zod";
import { jsonText } from "../mcp/result.js";
import { endpoints, renderPath, type Endpoint } from "../zentao/endpoints.js";
import {
  filterExecutionBugs,
  readProductsFromExecution,
  readProductsFromItems,
  uniqueProductId,
  type BugFilters,
} from "./bugQuery.js";

const bugListScopeError =
  'Expected at least one of: product_id, execution_id. If you need one bug by bug id, call zentao_get_object with resource: "bug" and id.';

export type ToolRequest = {
  method: Endpoint["method"];
  path: string;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
};

export type QueryToolName =
  | "zentao_get_current_user"
  | "zentao_list_products"
  | "zentao_list_projects"
  | "zentao_list_executions"
  | "zentao_list_stories"
  | "zentao_list_tasks"
  | "zentao_list_bugs"
  | "zentao_list_builds"
  | "zentao_get_build"
  | "zentao_list_releases"
  | "zentao_get_task_efforts";

export type ZentaoRequester = {
  request(request: ToolRequest): Promise<unknown>;
};

export type McpTextResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

export type McpServerLike = {
  tool(
    name: string,
    description: string,
    paramsSchema: z.ZodRawShape,
    handler: (args: Record<string, unknown>) => Promise<McpTextResult>,
  ): void;
};

const paginationShape = {
  page: z.number().int().positive().default(1).describe("Page number, starting from 1."),
  limit: z.number().int().positive().max(100).default(20).describe("Maximum records to return."),
};

const emptySchema = z.object({});
const paginationSchema = z.object(paginationShape);
const projectScopeSchema = z.object({
  project_id: z.number().int().positive().describe("ZenTao project ID."),
  ...paginationShape,
});
const executionScopeSchema = z.object({
  execution_id: z.number().int().positive().describe("ZenTao execution ID."),
  ...paginationShape,
});
const productScopeSchema = z.object({
  product_id: z.number().int().positive().describe("ZenTao product ID."),
  ...paginationShape,
});
const storyScopeSchema = z.object({
  product_id: z.number().int().positive().optional().describe("ZenTao product ID."),
  project_id: z.number().int().positive().optional().describe("ZenTao project ID."),
  execution_id: z.number().int().positive().optional().describe("ZenTao execution ID."),
  ...paginationShape,
});
const buildScopeSchema = z.object({
  project_id: z.number().int().positive().optional().describe("ZenTao project ID."),
  execution_id: z.number().int().positive().optional().describe("ZenTao execution ID."),
  ...paginationShape,
});
const buildDetailSchema = z.object({
  build_id: z.number().int().positive().describe("ZenTao build ID."),
});
const releaseScopeSchema = z.object({
  product_id: z.number().int().positive().optional().describe("ZenTao product ID."),
  project_id: z.number().int().positive().optional().describe("ZenTao project ID."),
  ...paginationShape,
});
const taskEffortsSchema = z.object({
  task_id: z.number().int().positive().describe("ZenTao task ID."),
});

// MCP-exposed schema for zentao_list_bugs. Advanced filters (execution_id, status,
// assigned_to_account) are valid here but must be handled by the high-level bug
// handler, not the single-request resolver.
const bugScopeSchema = z.object({
  product_id: z.number().int().positive().optional().describe("ZenTao product ID."),
  execution_id: z.number().int().positive().optional().describe("ZenTao execution ID."),
  status: z
    .enum(["all", "unclosed", "active", "confirmed", "resolved", "closed"])
    .default("all")
    .describe(
      "Optional bug status filter. confirmed is observed in real ZenTao list responses but is not declared in the local v1 bug detail document. unclosed means every status except closed.",
    ),
  assigned_to_account: z
    .string()
    .min(1)
    .optional()
    .describe("Optional assignee account filter, such as zhuxiaokun."),
  ...paginationShape,
});

// Internal product-scoped single-request schema used by resolveQueryToolRequest
// for zentao_list_bugs. Kept separate from productScopeSchema to avoid changing
// other product-scoped query tools.
const bugProductRequestSchema = z.object({
  product_id: z.number().int().positive().describe("ZenTao product ID."),
  ...paginationShape,
});

const toolSchemas = {
  zentao_get_current_user: emptySchema,
  zentao_list_products: paginationSchema,
  zentao_list_projects: paginationSchema,
  zentao_list_executions: projectScopeSchema,
  zentao_list_stories: storyScopeSchema,
  zentao_list_tasks: executionScopeSchema,
  zentao_list_bugs: bugScopeSchema,
  zentao_list_builds: buildScopeSchema,
  zentao_get_build: buildDetailSchema,
  zentao_list_releases: releaseScopeSchema,
  zentao_get_task_efforts: taskEffortsSchema,
} satisfies Record<QueryToolName, z.AnyZodObject>;

const toolDescriptions: Record<QueryToolName, string> = {
  zentao_get_current_user: "Get the authenticated ZenTao user profile.",
  zentao_list_products:
    'List ZenTao products. Returns paginated product records. If the user provides a product ID and asks for detail, use zentao_get_object with resource: "product".',
  zentao_list_projects:
    'List ZenTao projects. Returns paginated project records. If the user provides a project ID and asks for detail, use zentao_get_object with resource: "project".',
  zentao_list_executions:
    'List executions under a ZenTao project. If the user provides an execution ID and asks for detail, use zentao_get_object with resource: "execution".',
  zentao_list_stories:
    'List stories by exactly one product, project, or execution scope. If the user provides a story ID and asks for detail, use zentao_get_object with resource: "story".',
  zentao_list_tasks:
    'List tasks under a ZenTao execution. If the user provides a task ID and asks for task detail, use zentao_get_object with resource: "task"; use zentao_get_task_efforts only for task effort logs.',
  zentao_list_bugs:
    'List bugs under a ZenTao product, with optional local filtering by execution, status, and assignee. This is for scoped bug lists, not one bug id; for bug id detail, use zentao_get_object with resource: "bug" and id. Execution-scoped filtering scans product bugs because ZenTao v1 documents product-scoped bug listing only.',
  zentao_list_builds: "List builds by exactly one project or execution scope.",
  zentao_get_build: "Get one ZenTao build by ID.",
  zentao_list_releases: "List releases by exactly one product or project scope.",
  zentao_get_task_efforts: "Get effort logs for one ZenTao task.",
};

export const queryToolNames = Object.keys(toolSchemas) as QueryToolName[];

export function resolveQueryToolRequest(toolName: QueryToolName, args: unknown): ToolRequest {
  switch (toolName) {
    case "zentao_get_current_user":
      toolSchemas[toolName].parse(args);
      return { method: endpoints.currentUser.method, path: endpoints.currentUser.path };
    case "zentao_list_products":
      return listRequest(endpoints.products, toolSchemas[toolName].parse(args));
    case "zentao_list_projects":
      return listRequest(endpoints.projects, toolSchemas[toolName].parse(args));
    case "zentao_list_executions": {
      const parsed = toolSchemas[toolName].parse(args);
      return listRequest(endpoints.projectExecutions, parsed, { project_id: parsed.project_id });
    }
    case "zentao_list_stories": {
      const parsed = toolSchemas[toolName].parse(args);
      const scope = exactlyOneScope(parsed, ["product_id", "project_id", "execution_id"]);
      const endpoint =
        scope === "product_id"
          ? endpoints.productStories
          : scope === "project_id"
            ? endpoints.projectStories
            : endpoints.executionStories;
      return listRequest(endpoint, parsed, { [scope]: parsed[scope] });
    }
    case "zentao_list_tasks": {
      const parsed = toolSchemas[toolName].parse(args);
      return listRequest(endpoints.executionTasks, parsed, { execution_id: parsed.execution_id });
    }
    case "zentao_list_bugs": {
      // Advanced filters must short-circuit before any Zod parse below: Zod strips
      // unknown fields, so a late check would silently miss execution_id/status/
      // assigned_to_account and return an unfiltered product bug list.
      assertNoBugAdvancedFilters(args);
      const parsed = bugProductRequestSchema.parse(args);
      return listRequest(endpoints.productBugs, parsed, { product_id: parsed.product_id });
    }
    case "zentao_list_builds": {
      const parsed = toolSchemas[toolName].parse(args);
      const scope = exactlyOneScope(parsed, ["project_id", "execution_id"]);
      const endpoint = scope === "project_id" ? endpoints.projectBuilds : endpoints.executionBuilds;
      return listRequest(endpoint, parsed, { [scope]: parsed[scope] });
    }
    case "zentao_get_build": {
      const parsed = toolSchemas[toolName].parse(args);
      return { method: endpoints.build.method, path: renderPath(endpoints.build, { id: parsed.build_id }) };
    }
    case "zentao_list_releases": {
      const parsed = toolSchemas[toolName].parse(args);
      const scope = exactlyOneScope(parsed, ["product_id", "project_id"]);
      const endpoint = scope === "product_id" ? endpoints.productReleases : endpoints.projectReleases;
      return listRequest(endpoint, parsed, { [scope]: parsed[scope] });
    }
    case "zentao_get_task_efforts": {
      const parsed = toolSchemas[toolName].parse(args);
      return {
        method: endpoints.taskEfforts.method,
        path: renderPath(endpoints.taskEfforts, { task_id: parsed.task_id }),
      };
    }
  }
}

export function registerQueryTools(server: McpServerLike, client: ZentaoRequester): void {
  for (const toolName of queryToolNames) {
    server.tool(toolName, toolDescriptions[toolName], toolSchemas[toolName].shape, async (args) => {
      if (toolName === "zentao_list_bugs") {
        const parsed = bugScopeSchema.parse(args);
        atLeastOneBugScope(parsed);

        if (isPlainProductBugList(parsed, args)) {
          const request = resolveQueryToolRequest(toolName, {
            product_id: parsed.product_id,
            page: parsed.page,
            limit: parsed.limit,
          });
          return jsonText(await client.request(request));
        }

        return jsonText(await listBugs(client, parsed));
      }

      const request = resolveQueryToolRequest(toolName, args);
      return jsonText(await client.request(request));
    });
  }
}

type BugScope = z.infer<typeof bugScopeSchema>;

// Pure product-scoped bug listing keeps its raw ZenTao response. bugScopeSchema
// defaults status to "all" even if the caller does not set it, so we also need
// to inspect the raw args to distinguish "default all" from "explicit status".
function isPlainProductBugList(parsed: BugScope, rawArgs: unknown): boolean {
  if (parsed.product_id === undefined) return false;
  if (parsed.execution_id !== undefined) return false;
  if (parsed.assigned_to_account !== undefined) return false;
  if (!rawArgs || typeof rawArgs !== "object") return true;
  const raw = rawArgs as Record<string, unknown>;
  return raw.status === undefined;
}

export type ListBugsResult = {
  page: number;
  total: number;
  limit: number;
  source: {
    product_id: number;
    execution_id?: number;
    product_inference: "provided" | "execution_products" | "execution_stories" | "execution_builds";
    scanned_total: number;
    scan_pages: number;
    scan_limit: number;
  };
  filters: Partial<Pick<BugFilters, "assigned_to_account">> & { status?: BugScope["status"] };
  bugs: unknown[];
};

async function listBugs(client: ZentaoRequester, parsed: BugScope): Promise<ListBugsResult> {
  const { productId, productInference } =
    parsed.product_id !== undefined
      ? { productId: parsed.product_id, productInference: "provided" as const }
      : await resolveProductIdForExecution(client, parsed.execution_id as number);

  const scan = await fetchAllPages(client, {
    endpoint: endpoints.productBugs,
    pathParams: { product_id: productId },
    listKey: "bugs",
  });

  const filters: BugFilters = {
    execution_id: parsed.execution_id,
    status: parsed.status,
    assigned_to_account: parsed.assigned_to_account,
  };
  const filteredBugs = filterExecutionBugs(scan.items, filters);
  const total = filteredBugs.length;
  const start = (parsed.page - 1) * parsed.limit;
  const pageBugs = filteredBugs.slice(start, start + parsed.limit);

  const responseFilters: ListBugsResult["filters"] = {};
  if (parsed.status !== "all") responseFilters.status = parsed.status;
  if (parsed.assigned_to_account !== undefined) {
    responseFilters.assigned_to_account = parsed.assigned_to_account;
  }

  const source: ListBugsResult["source"] = {
    product_id: productId,
    product_inference: productInference,
    scanned_total: scan.scanned_total,
    scan_pages: scan.scan_pages,
    scan_limit: scan.scan_limit,
  };
  if (parsed.execution_id !== undefined) source.execution_id = parsed.execution_id;

  return {
    page: parsed.page,
    total,
    limit: parsed.limit,
    source,
    filters: responseFilters,
    bugs: pageBugs,
  };
}

async function resolveProductIdForExecution(
  client: ZentaoRequester,
  executionId: number,
): Promise<{
  productId: number;
  productInference: "execution_products" | "execution_stories" | "execution_builds";
}> {
  // execution.products is an observed-but-undocumented fast path. Per the plan,
  // a request-level failure here must fall through to the documented
  // stories/builds fallback rather than abort inference. Swallow the error and
  // let readProductsFromExecution(undefined) return [] naturally. The
  // documented stories/builds requests below intentionally do not catch, so a
  // real outage there surfaces instead of being misreported as "could not
  // infer a unique product_id".
  let execution: unknown;
  try {
    execution = await client.request({
      method: endpoints.execution.method,
      path: renderPath(endpoints.execution, { id: executionId }),
    });
  } catch {
    execution = undefined;
  }
  const fromExecution = uniqueProductId(readProductsFromExecution(execution));
  if (fromExecution !== undefined) {
    return { productId: fromExecution, productInference: "execution_products" };
  }

  const stories = await fetchAllPages(client, {
    endpoint: endpoints.executionStories,
    pathParams: { execution_id: executionId },
    listKey: "stories",
  });
  const fromStories = uniqueProductId(readProductsFromItems(stories.items));
  if (fromStories !== undefined) {
    return { productId: fromStories, productInference: "execution_stories" };
  }

  const builds = await fetchAllPages(client, {
    endpoint: endpoints.executionBuilds,
    pathParams: { execution_id: executionId },
    listKey: "builds",
  });
  const fromBuilds = uniqueProductId(readProductsFromItems(builds.items));
  if (fromBuilds !== undefined) {
    return { productId: fromBuilds, productInference: "execution_builds" };
  }

  throw new Error(
    `Could not infer a unique product_id for execution_id=${executionId}. Pass product_id with execution_id for a deterministic execution-scoped bug query.`,
  );
}

function listRequest(
  endpoint: Endpoint,
  parsed: { page: number; limit: number },
  pathParams: Record<string, string | number | undefined> = {},
): ToolRequest {
  return {
    method: endpoint.method,
    path: renderPath(endpoint, pathParams),
    query: { page: parsed.page, limit: parsed.limit },
  };
}

function exactlyOneScope<T extends string>(
  parsed: Partial<Record<T, unknown>>,
  keys: readonly T[],
): T {
  const present = keys.filter((key) => parsed[key] !== undefined);
  if (present.length !== 1) {
    // Explicit scope fields keep MCP calls readable and prevent ambiguous endpoint selection.
    throw new Error(`Expected exactly one of: ${keys.join(", ")}`);
  }
  return present[0];
}

function atLeastOneBugScope(
  parsed: Partial<Record<"product_id" | "execution_id", unknown>>,
): void {
  if (parsed.product_id === undefined && parsed.execution_id === undefined) {
    // A bare "bug 123" user request is a detail lookup, not a scoped list query.
    throw new Error(bugListScopeError);
  }
}

function assertNoBugAdvancedFilters(args: unknown): void {
  if (!args || typeof args !== "object") return;
  const input = args as Record<string, unknown>;
  if (
    input.execution_id !== undefined ||
    input.status !== undefined ||
    input.assigned_to_account !== undefined
  ) {
    throw new Error(
      "zentao_list_bugs advanced bug filters must be handled by the high-level bug handler, not the single-request resolver.",
    );
  }
}

export type FetchAllPagesOptions = {
  endpoint: Endpoint;
  pathParams: Record<string, string | number>;
  listKey: string;
  scanLimit?: number;
  maxPages?: number;
};

export type FetchAllPagesResult = {
  items: unknown[];
  scanned_total: number;
  scan_pages: number;
  scan_limit: number;
};

// Internal scan page size for advanced bug filtering and execution product
// inference. ZenTao paginated list endpoints cap limit at 100, so we always scan
// at the maximum allowed page size to minimize round trips.
const DEFAULT_SCAN_LIMIT = 100;
const DEFAULT_MAX_PAGES = 1000;

async function fetchAllPages(
  client: ZentaoRequester,
  options: FetchAllPagesOptions,
): Promise<FetchAllPagesResult> {
  const scanLimit = options.scanLimit ?? DEFAULT_SCAN_LIMIT;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const items: unknown[] = [];
  let pageIndex = 1;
  let scannedTotal: number | undefined;

  while (pageIndex <= maxPages) {
    const response = await client.request({
      method: options.endpoint.method,
      path: renderPath(options.endpoint, options.pathParams),
      query: { page: pageIndex, limit: scanLimit },
    });

    const list = readListFromResponse(response, options.listKey);
    items.push(...list);

    const total = readNonNegativeInteger(response, "total");
    if (total !== undefined) scannedTotal = total;

    // GET /executions/{id}/builds in the local v1 doc only declares total and
    // builds. Fall back to the request page/limit so scanning still progresses
    // past page 1 when the response omits pagination metadata.
    const respPage = readNonNegativeInteger(response, "page") ?? pageIndex;
    const respLimit = readNonNegativeInteger(response, "limit") ?? scanLimit;

    if (total !== undefined) {
      if (respPage * respLimit >= total) break;
    } else if (list.length < scanLimit) {
      break;
    }

    pageIndex += 1;
  }

  return {
    items,
    scanned_total: scannedTotal ?? items.length,
    scan_pages: pageIndex,
    scan_limit: scanLimit,
  };
}

function readListFromResponse(response: unknown, listKey: string): unknown[] {
  if (!response || typeof response !== "object") return [];
  const value = (response as Record<string, unknown>)[listKey];
  return Array.isArray(value) ? value : [];
}

function readNonNegativeInteger(response: unknown, key: string): number | undefined {
  if (!response || typeof response !== "object") return undefined;
  const value = (response as Record<string, unknown>)[key];
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

export function parseBugScopeForTest(args: unknown): z.infer<typeof bugScopeSchema> {
  const parsed = bugScopeSchema.parse(args);
  atLeastOneBugScope(parsed);
  return parsed;
}

export async function fetchAllPagesForTest(
  client: ZentaoRequester,
  options: FetchAllPagesOptions,
): Promise<FetchAllPagesResult> {
  return fetchAllPages(client, options);
}

export async function listBugsForTest(
  client: ZentaoRequester,
  args: unknown,
): Promise<ListBugsResult> {
  const parsed = bugScopeSchema.parse(args);
  atLeastOneBugScope(parsed);
  return listBugs(client, parsed);
}
