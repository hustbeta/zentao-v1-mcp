import { z } from "zod";
import { jsonText } from "../mcp/result.js";
import { endpoints, renderPath, type Endpoint } from "../zentao/endpoints.js";

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

const toolSchemas = {
  zentao_get_current_user: emptySchema,
  zentao_list_products: paginationSchema,
  zentao_list_projects: paginationSchema,
  zentao_list_executions: projectScopeSchema,
  zentao_list_stories: storyScopeSchema,
  zentao_list_tasks: executionScopeSchema,
  zentao_list_bugs: productScopeSchema,
  zentao_list_builds: buildScopeSchema,
  zentao_get_build: buildDetailSchema,
  zentao_list_releases: releaseScopeSchema,
  zentao_get_task_efforts: taskEffortsSchema,
} satisfies Record<QueryToolName, z.AnyZodObject>;

const toolDescriptions: Record<QueryToolName, string> = {
  zentao_get_current_user: "Get the authenticated ZenTao user profile.",
  zentao_list_products: "List ZenTao products. Returns paginated product records.",
  zentao_list_projects: "List ZenTao projects. Returns paginated project records.",
  zentao_list_executions: "List executions under a ZenTao project.",
  zentao_list_stories: "List stories by exactly one product, project, or execution scope.",
  zentao_list_tasks: "List tasks under a ZenTao execution.",
  zentao_list_bugs: "List bugs under a ZenTao product.",
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
      const parsed = toolSchemas[toolName].parse(args);
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
      const request = resolveQueryToolRequest(toolName, args);
      return jsonText(await client.request(request));
    });
  }
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
