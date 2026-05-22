export type WriteSummary = {
  method: string;
  path: string;
  request_body: unknown;
  requires_confirmation: true;
};

export function ensureConfirmed(confirm: boolean | undefined): boolean {
  return confirm === true;
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /password|token/i.test(key) ? "<redacted>" : redactSecrets(item),
      ]),
    );
  }
  return value;
}

export function createWriteSummary(input: { method: string; path: string; body: unknown }): WriteSummary {
  return {
    method: input.method,
    path: input.path,
    // Dry-run summaries can be shown to users, so secret-like fields are redacted recursively.
    request_body: redactSecrets(input.body),
    requires_confirmation: true,
  };
}
