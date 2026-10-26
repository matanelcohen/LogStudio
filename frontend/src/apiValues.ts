export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("The server returned an invalid object.");
  return value as Record<string, unknown>;
}

export function text(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`The server returned an invalid ${name}.`);
  return value;
}

export function nullableText(value: unknown, name: string): string | null {
  return value === null ? null : text(value, name);
}

export function count(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`The server returned an invalid ${name}.`);
  return value;
}

export function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`The server returned an invalid ${name}.`);
  return value;
}

export function timestamp(value: unknown, name: string): string {
  const result = text(value, name);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`The server returned an invalid ${name}.`);
  return result;
}
