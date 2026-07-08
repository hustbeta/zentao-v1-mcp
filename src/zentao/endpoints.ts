export type HttpMethod = "GET" | "POST" | "PUT";

export type Endpoint = {
  method: HttpMethod;
  path: string;
  resultKey?: string;
};

// This handwritten registry is the first-version safety boundary: local API docs include
// more mutating endpoints, but MCP tools may only dispatch paths explicitly listed here.
export const endpoints = {
  token: { method: "POST", path: "/tokens" },
  currentUser: { method: "GET", path: "/user" },
  users: { method: "GET", path: "/users" },
  user: { method: "GET", path: "/users/{id}" },
  departments: { method: "GET", path: "/departments" },
  department: { method: "GET", path: "/departments/{id}" },
  programs: { method: "GET", path: "/programs" },
  program: { method: "GET", path: "/programs/{id}" },
  products: { method: "GET", path: "/products" },
  product: { method: "GET", path: "/products/{id}" },
  productPlans: { method: "GET", path: "/products/{product_id}/plans" },
  productPlan: { method: "GET", path: "/productplans/{id}" },
  productReleases: { method: "GET", path: "/products/{product_id}/releases" },
  projectReleases: { method: "GET", path: "/projects/{project_id}/releases" },
  productStories: { method: "GET", path: "/products/{product_id}/stories" },
  projectStories: { method: "GET", path: "/projects/{project_id}/stories" },
  executionStories: { method: "GET", path: "/executions/{execution_id}/stories" },
  story: { method: "GET", path: "/stories/{id}" },
  createStory: { method: "POST", path: "/stories" },
  changeStory: { method: "POST", path: "/stories/{story_id}/change" },
  updateStory: { method: "PUT", path: "/stories/{story_id}" },
  projects: { method: "GET", path: "/projects" },
  project: { method: "GET", path: "/projects/{id}" },
  projectBuilds: { method: "GET", path: "/projects/{project_id}/builds" },
  executionBuilds: { method: "GET", path: "/executions/{execution_id}/builds" },
  createBuild: { method: "POST", path: "/projects/{project_id}/builds" },
  build: { method: "GET", path: "/builds/{id}" },
  updateBuild: { method: "PUT", path: "/builds/{build_id}" },
  projectExecutions: { method: "GET", path: "/projects/{project_id}/executions" },
  execution: { method: "GET", path: "/executions/{id}" },
  executionTasks: { method: "GET", path: "/executions/{execution_id}/tasks" },
  task: { method: "GET", path: "/tasks/{id}" },
  taskEfforts: { method: "GET", path: "/tasks/{task_id}/estimate" },
  productBugs: { method: "GET", path: "/products/{product_id}/bugs" },
  bug: { method: "GET", path: "/bugs/{id}" },
  productTestcases: { method: "GET", path: "/products/{product_id}/testcases" },
  testcase: { method: "GET", path: "/testcases/{id}" },
  testtasks: { method: "GET", path: "/testtasks" },
  projectTesttasks: { method: "GET", path: "/projects/{project_id}/testtasks" },
  testtask: { method: "GET", path: "/testtasks/{id}" },
  feedbacks: { method: "GET", path: "/feedbacks" },
  feedback: { method: "GET", path: "/feedbacks/{id}" },
  tickets: { method: "GET", path: "/tickets" },
  ticket: { method: "GET", path: "/tickets/{id}" },
} as const satisfies Record<string, Endpoint>;

export type EndpointKey = keyof typeof endpoints;

export const endpointKeys = Object.keys(endpoints) as EndpointKey[];

export function renderPath(
  endpoint: Endpoint,
  params: Record<string, string | number | undefined>,
): string {
  return endpoint.path.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const value = params[key];
    if (value === undefined || value === "") {
      throw new Error(`Missing path parameter: ${key}`);
    }

    return encodeURIComponent(String(value));
  });
}
