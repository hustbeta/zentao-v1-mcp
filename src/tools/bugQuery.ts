// ZenTao v1 documents only product-scoped bug listing. Execution-scoped bug
// queries are implemented by resolving the product and filtering product bugs
// locally, so agents can use one stable MCP call without discovering this flow.

export type BugStatusFilter =
  | "all"
  | "unclosed"
  | "active"
  | "confirmed"
  | "resolved"
  | "closed";

export type BugFilters = {
  execution_id?: number;
  status: BugStatusFilter;
  assigned_to_account?: string;
};

export function filterExecutionBugs(bugs: unknown[], filters: BugFilters): unknown[] {
  return bugs.filter((bug) => matchesBugFilters(bug, filters));
}

function matchesBugFilters(bug: unknown, filters: BugFilters): boolean {
  if (filters.execution_id !== undefined && getBugExecution(bug) !== filters.execution_id) {
    return false;
  }

  const status = getBugStatusCode(bug);
  if (filters.status === "unclosed") {
    if (status === "closed") return false;
  } else if (filters.status !== "all") {
    if (status !== filters.status) return false;
  }

  if (
    filters.assigned_to_account !== undefined &&
    getAssignedToAccount(bug) !== filters.assigned_to_account
  ) {
    return false;
  }

  return true;
}

// Real ZenTao list responses return status as a plain string (e.g. "active",
// "confirmed"). The Bug detail document instead suggests an object form like
// { code, name }. Accept both so filtering works against either shape.
export function getBugStatusCode(bug: unknown): string | undefined {
  if (!bug || typeof bug !== "object") return undefined;
  const status = (bug as { status?: unknown }).status;
  if (typeof status === "string") return status;
  if (status && typeof status === "object" && "code" in status) {
    const code = (status as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

export function getAssignedToAccount(bug: unknown): string | undefined {
  if (!bug || typeof bug !== "object") return undefined;
  const assignedTo = (bug as { assignedTo?: unknown }).assignedTo;
  if (assignedTo && typeof assignedTo === "object" && "account" in assignedTo) {
    const account = (assignedTo as { account?: unknown }).account;
    return typeof account === "string" ? account : undefined;
  }
  return undefined;
}

export function getBugExecution(bug: unknown): number | undefined {
  if (!bug || typeof bug !== "object") return undefined;
  const execution = (bug as { execution?: unknown }).execution;
  return parsePositiveInteger(execution);
}

// ZenTao documents story.product/build.product as numeric IDs, while some
// observed payloads expose product objects. Accept both shapes and ignore
// malformed values so inference can fall back instead of failing early.
export function readProductsFromItems(items: unknown[]): number[] {
  const ids: number[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const value = (item as { product?: unknown }).product;
    const id = parseProductLike(value);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

// execution.products is an observed fast path in current ZenTao deployments,
// but it is not declared in the local v1 document. Treat it as optional and
// fall back to documented execution story/build scans before giving up.
export function readProductsFromExecution(execution: unknown): number[] {
  if (!execution || typeof execution !== "object") return [];
  const products = (execution as { products?: unknown }).products;
  if (!Array.isArray(products)) return [];
  const ids: number[] = [];
  for (const entry of products) {
    const id = parseProductLike(entry);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

export function uniqueProductId(ids: number[]): number | undefined {
  if (ids.length === 0) return undefined;
  const unique = new Set(ids);
  return unique.size === 1 ? ids[0] : undefined;
}

function parseProductLike(value: unknown): number | undefined {
  const direct = parsePositiveInteger(value);
  if (direct !== undefined) return direct;
  if (value && typeof value === "object" && "id" in value) {
    return parsePositiveInteger((value as { id?: unknown }).id);
  }
  return undefined;
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

export function filterExecutionBugsForTest(bugs: unknown[], filters: BugFilters): unknown[] {
  return filterExecutionBugs(bugs, filters);
}

export function readProductsFromExecutionForTest(execution: unknown): number[] {
  return readProductsFromExecution(execution);
}

export function readProductsFromItemsForTest(items: unknown[]): number[] {
  return readProductsFromItems(items);
}
