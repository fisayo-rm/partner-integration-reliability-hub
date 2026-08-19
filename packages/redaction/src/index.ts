import { createHash } from "node:crypto";

export const redacted = "[REDACTED]";
const sensitiveName =
  /(?:authorization|proxy-authorization|cookie|api[-_]?key|token|secret|signature|hmac|password|credential|set-cookie|client_secret)/i;
const safeResponseHeaders = new Set([
  "content-type",
  "content-length",
  "retry-after",
  "x-request-id",
]);

export function tenantSafeId(value: string): string {
  return `tn_${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

export function redactJson<T>(value: T, paths: readonly string[] = []): T {
  const cloned = structuredClone(value) as T;
  if (cloned === null || typeof cloned !== "object") return cloned;
  for (const path of paths) {
    const parts = path
      .replace(/^\$\.?/, "")
      .split(".")
      .filter(Boolean);
    let cursor: Record<string, unknown> | undefined = cloned as Record<
      string,
      unknown
    >;
    for (const part of parts.slice(0, -1)) {
      const next: unknown = cursor?.[part];
      cursor =
        next !== null && typeof next === "object" && !Array.isArray(next)
          ? (next as Record<string, unknown>)
          : undefined;
    }
    const last = parts.at(-1);
    if (cursor !== undefined && last !== undefined && last in cursor)
      cursor[last] = redacted;
  }
  return redactUnknown(cloned) as T;
}

export function redactHeaders(
  headers: Readonly<Record<string, unknown>>,
  options: {
    readonly allowlist?: ReadonlySet<string>;
    readonly sensitiveNames?: readonly string[];
  } = {},
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  const configured = new Set(
    (options.sensitiveNames ?? []).map((name) => name.toLowerCase()),
  );
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (options.allowlist !== undefined && !options.allowlist.has(normalized))
      continue;
    if (configured.has(normalized) || sensitiveName.test(normalized)) {
      result[normalized] = redacted;
      continue;
    }
    if (typeof value === "string") result[normalized] = bounded(value);
  }
  return result;
}

export function redactResponseHeaders(
  headers: Readonly<Record<string, unknown>>,
) {
  return redactHeaders(headers, { allowlist: safeResponseHeaders });
}

export function redactError(error: unknown): Readonly<Record<string, unknown>> {
  if (error instanceof Error)
    return {
      name: error.name,
      message: bounded(redactText(error.message)),
      ...(error.stack === undefined
        ? {}
        : { stack: bounded(redactText(error.stack), 4_096) }),
    };
  return { value: redactUnknown(error) };
}

export function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") return bounded(redactText(value));
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactUnknown);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (sensitiveName.test(key)) result[key] = redacted;
    else if (key === "headers" && entry !== null && typeof entry === "object")
      result[key] = redactHeaders(entry as Record<string, unknown>);
    else if (/^(?:body|rawBody|payload|request)$/i.test(key))
      result[key] = "[OMITTED]";
    else result[key] = redactUnknown(entry);
  }
  return result;
}

export function redactText(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*)([^\s,;]+)/gi, `$1${redacted}`)
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, `$1${redacted}`)
    .replace(/(basic\s+)[A-Za-z0-9+/=]+/gi, `$1${redacted}`)
    .replace(
      /((?:api[-_]?key|token|secret|signature|password)\s*[:=]\s*)[^\s,;]+/gi,
      `$1${redacted}`,
    );
}

export function bounded(value: string, max = 2_048): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
