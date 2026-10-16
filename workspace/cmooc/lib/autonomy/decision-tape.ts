import type {
  PrismaClient,
  Prisma
} from "@prisma/client";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";

export const DECISION_TAPE_ENTRY_SCHEMA_VERSION =
  "cmooc.decision-tape-entry.v1" as const;

const FORBIDDEN_KEYS = new Set([
  "courseId",
  "platformCourseRef",
  "stableThreadRef",
  "threadRef",
  "authorRef",
  "actorRef",
  "eventRef",
  "canonicalUrl",
  "locator",
  "url",
  "title",
  "content",
  "body",
  "text",
  "cookie",
  "token",
  "password",
  "raw"
]);

const DECISION_TAPE_PAYLOAD_SCHEMA_VERSION =
  `${DECISION_TAPE_ENTRY_SCHEMA_VERSION}.payload` as const;

function decisionTapePayloadHash(
  payload: CanonicalJsonValue
): string {
  return canonicalProtocolHash(
    DECISION_TAPE_PAYLOAD_SCHEMA_VERSION,
    {
      schemaVersion: DECISION_TAPE_PAYLOAD_SCHEMA_VERSION,
      payload
    }
  );
}

function assertRedacted(
  value: unknown,
  path: string[] = []
): asserts value is CanonicalJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return;
  }
  if (typeof value === "string") {
    if (
      value.length > 512 ||
      /https?:\/\//i.test(value) ||
      /\b(?:Satoken|Bearer)\b/i.test(value)
    ) {
      throw new Error(
        `Decision Tape 字符串字段 ${path.join(".")} 未通过去正文边界。`
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertRedacted(item, [...path, String(index)])
    );
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new Error(
          `Decision Tape 禁止字段：${[...path, key].join(".")}。`
        );
      }
      assertRedacted(item, [...path, key]);
    }
    return;
  }
  throw new Error("Decision Tape 只接受规范 JSON。");
}

export async function appendDecisionTapeEntry(input: {
  prisma: PrismaClient | Prisma.TransactionClient;
  invocationId: string;
  kind: string;
  payload: CanonicalJsonValue;
}): Promise<{
  sequence: number;
  entryHash: string;
  payloadHash: string;
}> {
  assertRedacted(input.payload);
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(input.kind)) {
    throw new Error("Decision Tape 条目类型格式无效。");
  }
  const invocation =
    await input.prisma.scheduledInvocation.findUnique({
      where: { id: input.invocationId },
      select: { id: true }
    });
  if (!invocation) {
    throw new Error("DECISION_TAPE_INVOCATION_NOT_FOUND");
  }
  const previous = await input.prisma.decisionTapeEntry.findFirst({
    where: { invocationId: input.invocationId },
    orderBy: { sequence: "desc" },
    select: { sequence: true, entryHash: true }
  });
  const sequence = (previous?.sequence ?? 0) + 1;
  const payloadHash = decisionTapePayloadHash(input.payload);
  const entryHash = canonicalProtocolHash(
    DECISION_TAPE_ENTRY_SCHEMA_VERSION,
    {
      schemaVersion: DECISION_TAPE_ENTRY_SCHEMA_VERSION,
      invocationId: input.invocationId,
      sequence,
      kind: input.kind,
      payloadHash,
      previousEntryHash: previous?.entryHash ?? null,
      containsForumText: false
    }
  );
  await input.prisma.decisionTapeEntry.create({
    data: {
      invocationId: input.invocationId,
      sequence,
      kind: input.kind,
      payloadHash,
      previousEntryHash: previous?.entryHash ?? null,
      entryHash,
      payloadJson: JSON.stringify(input.payload),
      containsForumText: false
    }
  });
  return { sequence, entryHash, payloadHash };
}

export async function verifyDecisionTape(input: {
  prisma: PrismaClient;
  invocationId: string;
}): Promise<{
  valid: boolean;
  entryCount: number;
  headHash: string | null;
}> {
  const entries = await input.prisma.decisionTapeEntry.findMany({
    where: { invocationId: input.invocationId },
    orderBy: { sequence: "asc" }
  });
  let previousEntryHash: string | null = null;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (
      entry.sequence !== index + 1 ||
      entry.previousEntryHash !== previousEntryHash ||
      entry.containsForumText
    ) {
      return {
        valid: false,
        entryCount: entries.length,
        headHash: previousEntryHash
      };
    }
    const payload = JSON.parse(entry.payloadJson) as CanonicalJsonValue;
    assertRedacted(payload);
    const payloadHash = decisionTapePayloadHash(payload);
    const entryHash = canonicalProtocolHash(
      DECISION_TAPE_ENTRY_SCHEMA_VERSION,
      {
        schemaVersion: DECISION_TAPE_ENTRY_SCHEMA_VERSION,
        invocationId: input.invocationId,
        sequence: entry.sequence,
        kind: entry.kind,
        payloadHash,
        previousEntryHash,
        containsForumText: false
      }
    );
    if (
      entry.payloadHash !== payloadHash ||
      entry.entryHash !== entryHash
    ) {
      return {
        valid: false,
        entryCount: entries.length,
        headHash: previousEntryHash
      };
    }
    previousEntryHash = entry.entryHash;
  }
  return {
    valid: true,
    entryCount: entries.length,
    headHash: previousEntryHash
  };
}
