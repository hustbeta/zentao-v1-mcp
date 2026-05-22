export function jsonText(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

export function errorText(message: string, details?: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: message, details }, null, 2) }],
  };
}
