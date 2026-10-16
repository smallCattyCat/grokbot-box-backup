import Ajv2020, {
  type AnySchemaObject,
  type ErrorObject,
  type ValidateFunction
} from "ajv/dist/2020";
import { canonicalProtocolHash, type CanonicalJsonValue } from "./canonical-hash";
import {
  PROTOCOL_SCHEMAS,
  type ProtocolSchemaName
} from "./schemas";
import type { ProtocolTypeMap } from "./types";

export class ProtocolValidationError extends Error {
  readonly schemaName: ProtocolSchemaName;
  readonly errors: readonly ErrorObject[];

  constructor(
    schemaName: ProtocolSchemaName,
    errors: readonly ErrorObject[]
  ) {
    const details = errors
      .map((error) =>
        `${error.instancePath || "/"} ${error.message || "校验失败"}`
      )
      .join("；");
    super(`协议对象 ${schemaName} 校验失败：${details}`);
    this.name = "ProtocolValidationError";
    this.schemaName = schemaName;
    this.errors = errors;
  }
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  allowUnionTypes: true
});

const validators = Object.fromEntries(
  Object.entries(PROTOCOL_SCHEMAS).map(([name, schema]) => [
    name,
    ajv.compile(schema as AnySchemaObject)
  ])
) as Record<ProtocolSchemaName, ValidateFunction>;

export function validateProtocolObject<K extends ProtocolSchemaName>(
  schemaName: K,
  value: unknown
): value is ProtocolTypeMap[K] {
  return Boolean(validators[schemaName](value));
}

export function parseProtocolObject<K extends ProtocolSchemaName>(
  schemaName: K,
  value: unknown
): ProtocolTypeMap[K] {
  const validator = validators[schemaName];
  if (!validator(value)) {
    throw new ProtocolValidationError(
      schemaName,
      validator.errors ? [...validator.errors] : []
    );
  }
  return value as ProtocolTypeMap[K];
}

export function validateAndHashProtocolObject<K extends ProtocolSchemaName>(
  schemaName: K,
  value: unknown
): {
  value: ProtocolTypeMap[K];
  hash: string;
} {
  const parsed = parseProtocolObject(schemaName, value);
  return {
    value: parsed,
    hash: canonicalProtocolHash(
      parsed.schemaVersion,
      parsed as CanonicalJsonValue
    )
  };
}
