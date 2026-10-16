import { createHmac } from "node:crypto";

export const CMOOC_EXECUTION_ACCOUNT_ROLE_KEYS = [
  "socratic_guide",
  "evidence_connector",
  "reflection_coach",
  "community_host"
] as const;

export type CmoocExecutionAccountRoleKey =
  (typeof CMOOC_EXECUTION_ACCOUNT_ROLE_KEYS)[number];

export type CmoocExecutionAccountDescriptor = {
  accountRefHash: string;
  credentialRefHash: string;
  roleKey: CmoocExecutionAccountRoleKey;
  courseAliases: string[];
  dailyActionLimit: number;
  cooldownMinutes: number;
  disclosedAi: true;
  containsForumText: false;
};

type PartnerCredential = {
  account: string;
  password: string;
};

type RuntimeCredential = PartnerCredential & {
  credentialRefHash: string;
};

type AccountMetadata = {
  credentialIndex: number;
  roleKey: CmoocExecutionAccountRoleKey;
  courseAliases: string[];
  dailyActionLimit: number;
  cooldownMinutes: number;
  disclosedAi: true;
  containsForumText: false;
};

const METADATA_KEYS = [
  "containsForumText",
  "cooldownMinutes",
  "courseAliases",
  "credentialIndex",
  "dailyActionLimit",
  "disclosedAi",
  "roleKey"
] as const;

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const COURSE_ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{1,79}$/;

function invalidConfig(): never {
  throw new Error("CMOOC_EXECUTION_ACCOUNT_CONFIG_INVALID");
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidConfig();
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === METADATA_KEYS.length &&
    actual.every((key, index) => key === METADATA_KEYS[index])
  );
}

function parseMetadata(value: unknown, credentialCount: number): AccountMetadata {
  const record = objectRecord(value);
  if (!exactKeys(record)) return invalidConfig();
  const credentialIndex = record.credentialIndex;
  const roleKey = record.roleKey;
  const courseAliases = record.courseAliases;
  const dailyActionLimit = record.dailyActionLimit;
  const cooldownMinutes = record.cooldownMinutes;
  if (
    !Number.isSafeInteger(credentialIndex) ||
    Number(credentialIndex) < 0 ||
    Number(credentialIndex) >= credentialCount ||
    typeof roleKey !== "string" ||
    !CMOOC_EXECUTION_ACCOUNT_ROLE_KEYS.includes(
      roleKey as CmoocExecutionAccountRoleKey
    ) ||
    !Array.isArray(courseAliases) ||
    courseAliases.length === 0 ||
    courseAliases.some(
      (alias) =>
        typeof alias !== "string" ||
        !COURSE_ALIAS_PATTERN.test(alias)
    ) ||
    new Set(courseAliases).size !== courseAliases.length ||
    !Number.isSafeInteger(dailyActionLimit) ||
    Number(dailyActionLimit) < 1 ||
    Number(dailyActionLimit) > 5 ||
    !Number.isSafeInteger(cooldownMinutes) ||
    Number(cooldownMinutes) < 0 ||
    Number(cooldownMinutes) > 1_440 ||
    record.disclosedAi !== true ||
    record.containsForumText !== false
  ) {
    return invalidConfig();
  }
  return {
    credentialIndex: Number(credentialIndex),
    roleKey: roleKey as CmoocExecutionAccountRoleKey,
    courseAliases: [...courseAliases] as string[],
    dailyActionLimit: Number(dailyActionLimit),
    cooldownMinutes: Number(cooldownMinutes),
    disclosedAi: true,
    containsForumText: false
  };
}

function evidenceKey(secret: Buffer | string): Buffer {
  const key = Buffer.isBuffer(secret)
    ? Buffer.from(secret)
    : Buffer.from(secret, "utf8");
  if (key.byteLength < 32) return invalidConfig();
  return key;
}

function opaqueReference(input: {
  secret: Buffer;
  domain: "account" | "credential";
  account: string;
}): string {
  return createHmac("sha256", input.secret)
    .update(
      `cmooc.execution-${input.domain}-ref.v1\0${input.account}`,
      "utf8"
    )
    .digest("hex");
}

export class CmoocExecutionAccountRuntime {
  readonly #descriptors: readonly CmoocExecutionAccountDescriptor[];
  readonly #credentialsByAccountRef: ReadonlyMap<string, RuntimeCredential>;

  constructor(input: {
    descriptors: CmoocExecutionAccountDescriptor[];
    credentialsByAccountRef: Map<string, RuntimeCredential>;
  }) {
    this.#descriptors = input.descriptors.map((descriptor) => ({
      ...descriptor,
      courseAliases: [...descriptor.courseAliases]
    }));
    this.#credentialsByAccountRef = new Map(input.credentialsByAccountRef);
  }

  listDescriptors(courseAlias?: string): CmoocExecutionAccountDescriptor[] {
    if (
      courseAlias !== undefined &&
      !COURSE_ALIAS_PATTERN.test(courseAlias)
    ) {
      return invalidConfig();
    }
    return this.#descriptors
      .filter(
        (descriptor) =>
          courseAlias === undefined ||
          descriptor.courseAliases.includes(courseAlias)
      )
      .map((descriptor) => ({
        ...descriptor,
        courseAliases: [...descriptor.courseAliases]
      }));
  }

  resolveCredential(accountRefHash: string): RuntimeCredential {
    if (!HASH_PATTERN.test(accountRefHash)) {
      throw new Error("CMOOC_EXECUTION_ACCOUNT_NOT_CONFIGURED");
    }
    const credential = this.#credentialsByAccountRef.get(accountRefHash);
    if (!credential) {
      throw new Error("CMOOC_EXECUTION_ACCOUNT_NOT_CONFIGURED");
    }
    return { ...credential };
  }

  toJSON() {
    return {
      schemaVersion: "cmooc.execution-account-pool-summary.v1",
      accounts: this.listDescriptors(),
      containsForumText: false
    } as const;
  }
}

export function buildCmoocExecutionAccountRuntime(input: {
  metadataJson: string;
  credentials: PartnerCredential[];
  secret: Buffer | string;
}): CmoocExecutionAccountRuntime {
  if (
    typeof input.metadataJson !== "string" ||
    input.metadataJson.length === 0 ||
    !Array.isArray(input.credentials) ||
    input.credentials.length === 0 ||
    input.credentials.some(
      (credential) =>
        !credential ||
        typeof credential.account !== "string" ||
        credential.account.length === 0 ||
        credential.account !== credential.account.trim() ||
        typeof credential.password !== "string" ||
        credential.password.length === 0
    )
  ) {
    return invalidConfig();
  }
  let rawMetadata: unknown;
  try {
    rawMetadata = JSON.parse(input.metadataJson) as unknown;
  } catch {
    return invalidConfig();
  }
  if (!Array.isArray(rawMetadata) || rawMetadata.length === 0) {
    return invalidConfig();
  }
  const metadata = rawMetadata.map((entry) =>
    parseMetadata(entry, input.credentials.length)
  );
  if (new Set(metadata.map((entry) => entry.credentialIndex)).size !== metadata.length) {
    return invalidConfig();
  }
  const key = evidenceKey(input.secret);
  const descriptors: CmoocExecutionAccountDescriptor[] = [];
  const credentialsByAccountRef = new Map<string, RuntimeCredential>();
  for (const entry of metadata) {
    const credential = input.credentials[entry.credentialIndex];
    const accountRefHash = opaqueReference({
      secret: key,
      domain: "account",
      account: credential.account
    });
    const credentialRefHash = opaqueReference({
      secret: key,
      domain: "credential",
      account: credential.account
    });
    if (
      !HASH_PATTERN.test(accountRefHash) ||
      !HASH_PATTERN.test(credentialRefHash) ||
      credentialsByAccountRef.has(accountRefHash)
    ) {
      return invalidConfig();
    }
    descriptors.push({
      accountRefHash,
      credentialRefHash,
      roleKey: entry.roleKey,
      courseAliases: [...entry.courseAliases],
      dailyActionLimit: entry.dailyActionLimit,
      cooldownMinutes: entry.cooldownMinutes,
      disclosedAi: true,
      containsForumText: false
    });
    credentialsByAccountRef.set(accountRefHash, {
      account: credential.account,
      password: credential.password,
      credentialRefHash
    });
  }
  return new CmoocExecutionAccountRuntime({
    descriptors,
    credentialsByAccountRef
  });
}
