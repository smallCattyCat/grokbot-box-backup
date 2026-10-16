import { createHash } from "node:crypto";
import { CANONICAL_HASH_ALGORITHM } from "./schemas";

export type CanonicalJsonValue =
  | null
  | boolean
  | string
  | number
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

function canonicalizeValue(value: unknown, path: string): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new Error(
        `Canonical JSON 只接受安全整数，非法位置：${path}`
      );
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        throw new Error(`Canonical JSON 不接受稀疏数组：${path}[${index}]`);
      }
    }
    return `[${value
      .map((item, index) => canonicalizeValue(item, `${path}[${index}]`))
      .join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Canonical JSON 只接受普通对象：${path}`);
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => {
        const child = record[key];
        if (child === undefined) {
          throw new Error(
            `Canonical JSON 不接受 undefined：${path}.${key}`
          );
        }
        return `${JSON.stringify(key)}:${canonicalizeValue(
          child,
          `${path}.${key}`
        )}`;
      })
      .join(",")}}`;
  }
  throw new Error(`Canonical JSON 不接受 ${typeof value}：${path}`);
}

export function canonicalJson(value: CanonicalJsonValue): string {
  return canonicalizeValue(value, "$");
}

export function canonicalProtocolHash(
  schemaVersion: string,
  value: CanonicalJsonValue
): string {
  if (!schemaVersion.trim()) {
    throw new Error("协议哈希缺少 schemaVersion。");
  }
  if (
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    "schemaVersion" in value &&
    value.schemaVersion !== schemaVersion
  ) {
    throw new Error(
      "协议哈希域与对象 schemaVersion 不一致。"
    );
  }
  const domain = `${CANONICAL_HASH_ALGORITHM}\0${schemaVersion}\0`;
  return createHash("sha256")
    .update(domain, "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

export function canonicalHashList(
  domain: string,
  hashes: readonly string[]
): string {
  const normalized = [...hashes].sort();
  return createHash("sha256")
    .update(`${CANONICAL_HASH_ALGORITHM}\0${domain}\0`, "utf8")
    .update(normalized.join("\n"), "utf8")
    .digest("hex");
}
