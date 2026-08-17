import { createHash } from "node:crypto";
import {
  transformationDefinitionSchema,
  type TransformationDefinition,
} from "@pirh/contracts";
import type { JsonObject, JsonValue } from "@pirh/domain";

export class TransformationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TransformationError";
  }
}
export interface TransformationResult {
  readonly output: JsonObject;
  readonly serialized: string;
  readonly hash: string;
}
function pathSegments(path: string): readonly string[] {
  return path.slice(2).split(".");
}
function readPath(value: JsonValue, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const segment of pathSegments(path)) {
    if (
      current === null ||
      Array.isArray(current) ||
      typeof current !== "object"
    )
      return undefined;
    current = (current as JsonObject)[segment];
  }
  return current;
}
function writePath(
  output: Record<string, JsonValue>,
  path: string,
  value: JsonValue,
): void {
  const parts = pathSegments(path);
  let current = output;
  for (const part of parts.slice(0, -1)) {
    const existing = current[part];
    if (existing === undefined) current[part] = {};
    else if (
      existing === null ||
      Array.isArray(existing) ||
      typeof existing !== "object"
    )
      throw new TransformationError(
        `Target ${path} conflicts with an existing value.`,
      );
    current = current[part] as Record<string, JsonValue>;
  }
  current[parts.at(-1) ?? ""] = value;
}
function primitiveString(value: JsonValue, operation: string): string {
  if (typeof value !== "string")
    throw new TransformationError(`${operation} requires a string value.`);
  return value;
}
function upperSnake(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}
function isoDate(value: string): string {
  if (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
  )
    return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new TransformationError(
      "ISO_DATE requires an ISO date or timestamp.",
    );
  return parsed.toISOString().slice(0, 10);
}
function stable(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stable((value as JsonObject)[key] as JsonValue)}`,
    )
    .join(",")}}`;
}
function operand(
  input: JsonObject,
  value: {
    readonly source?: string | undefined;
    readonly literal?: JsonValue | undefined;
  },
): JsonValue | undefined {
  return value.source === undefined
    ? value.literal
    : readPath(input, value.source);
}
export function executeTransformation(
  definitionInput: unknown,
  input: JsonObject,
): TransformationResult {
  const definition: TransformationDefinition =
    transformationDefinitionSchema.parse(definitionInput);
  const output: Record<string, JsonValue> = {};
  for (const mapping of definition.mappings) {
    let value: JsonValue | undefined;
    if (mapping.transform === "CONCAT") {
      const values = mapping.parts.map((part) => operand(input, part as never));
      if (values.some((part) => part === undefined || part === null))
        value = undefined;
      else
        value = values
          .map((part) => primitiveString(part as JsonValue, "CONCAT"))
          .join(mapping.separator ?? "");
    } else {
      value = operand(input, mapping as never);
      if (value !== undefined && value !== null) {
        if (mapping.transform === "UPPERCASE")
          value = primitiveString(value, "UPPERCASE").toUpperCase();
        if (mapping.transform === "LOWERCASE")
          value = primitiveString(value, "LOWERCASE").toLowerCase();
        if (mapping.transform === "UPPER_SNAKE")
          value = upperSnake(primitiveString(value, "UPPER_SNAKE"));
        if (mapping.transform === "ISO_DATE")
          value = isoDate(primitiveString(value, "ISO_DATE"));
        if (mapping.transform === "ENUM_MAP") {
          const key = typeof value === "string" ? value : stable(value);
          value = (mapping.values[key] ?? mapping.default) as
            | JsonValue
            | undefined;
          if (value === undefined)
            throw new TransformationError(`ENUM_MAP has no value for ${key}.`);
        }
      }
    }
    if (value === undefined || value === null) {
      if (mapping.required)
        throw new TransformationError(
          `Required source for ${mapping.target} is missing.`,
        );
      continue;
    }
    writePath(output, mapping.target, value);
  }
  const serialized = stable(output);
  if (Buffer.byteLength(serialized, "utf8") > 128 * 1024)
    throw new TransformationError(
      "Transformed payload must not exceed 128 KiB.",
    );
  return {
    output,
    serialized,
    hash: createHash("sha256").update(serialized).digest("hex"),
  };
}
