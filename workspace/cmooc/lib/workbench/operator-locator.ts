import { prisma as defaultPrisma } from "@/lib/db";
import { loadCourseManifest } from "@/lib/autonomy/course-manifest";
import { deriveAutonomyThreadKey } from "@/lib/world/live-event";
import { loadOrCreateLocalEvidenceSecret } from "@/lib/privacy/local-evidence-hmac";
import { cmoocStableThreadRef } from "@/lib/forum-adapters/cmooc-api-adapter";
import {
  buildOperatorIdentityIndex,
  type OperatorIdentityIndex,
  type OperatorIdentitySnapshotRow
} from "@/lib/autonomy/operator-course-identity";
import { locateTransientExecutionTarget } from "@/lib/autonomy/execution-target";
import { fetchCmoocPostDetail } from "@/lib/forum/cmooc-api";

export const OPERATOR_COURSE_LOCATOR_SCHEMA_VERSION =
  "cmooc.operator-course-locator.v1" as const;

const COURSE_ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_QUERY_LENGTH = 80;
const MAX_CONTENT_LENGTH = 4_000;
const MAX_RESULTS = 8;
const MAX_TARGET_LOOKUP_POSTS = 1_000;
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u;

type OperatorLocatorManifest = Readonly<{
  alias: string;
  courseId: string;
  manifestHash: string;
  canonicalUrl: string;
  allowedOrigins: readonly string[];
}>;

type OperatorLocatorManifestRow = Readonly<{
  alias: string;
  manifestHash: string;
  enabled: boolean;
}>;

type OperatorLocatorCourseRow = Readonly<{
  id: string;
  name: string;
  sourceUrl: string | null;
  status: string;
  lastSyncedAt: Date | null;
}>;

type OperatorLocatorPostRow = Readonly<{
  forumPostId: string;
  title: string;
  content: string;
  url: string;
  replyCount: number;
  createdAt: Date;
  updatedAt: Date;
  lastReplyAt: Date | null;
  author: Readonly<{
    forumUserId: string;
    name: string;
  }>;
}>;

type OperatorLiveReplyTarget = Readonly<{
  forumPostId: string;
  title: string;
  content: string;
  url: string;
  author: Readonly<{
    forumUserId: string;
    name: string;
  }>;
}>;

export type OperatorLiveReplyTargetReader = (input: Readonly<{
  courseAlias: string;
  courseId: string;
  threadKey: string;
  secret: Buffer | string;
}>) => Promise<OperatorLiveReplyTarget | null>;

export type OperatorLocatorDb = {
  autonomyCourseManifest: {
    findUnique(args: unknown): Promise<OperatorLocatorManifestRow | null>;
  };
  course: {
    findUnique(args: unknown): Promise<OperatorLocatorCourseRow | null>;
  };
  forumPost: {
    findMany(args: unknown): Promise<OperatorLocatorPostRow[]>;
  };
  forumPostSnapshot?: {
    findMany(args: unknown): Promise<OperatorIdentitySnapshotRow[]>;
  };
  workbenchRunRecord?: {
    findUnique(args: unknown): Promise<Readonly<{ id: string }> | null>;
  };
  workbenchArtifactVersionRecord?: {
    findMany(args: unknown): Promise<Array<Readonly<{ sourceRefsJson: string }>>>;
  };
  autonomyDecision?: {
    findUnique(args: unknown): Promise<Readonly<{
      id: string;
      courseAlias: string;
      threadKey: string;
    }> | null>;
  };
};

export type OperatorReplyTarget = Readonly<{
  status: "resolved";
  runId: string;
  decisionRef: string;
  postRef: string;
  title: string;
  preview: string;
  content: string;
  sourceUrl: string | null;
  author: Readonly<{
    displayName: string;
    accountName: string;
  }>;
}> | Readonly<{
  status: "unbound";
  runId: string;
  reasonCode:
    | "no_verified_course_artifact"
    | "target_not_in_local_sync"
    | "target_binding_ambiguous";
}>;

export type OperatorCourseLocator = Readonly<{
  schemaVersion: typeof OPERATOR_COURSE_LOCATOR_SCHEMA_VERSION;
  course: Readonly<{
    alias: string;
    name: string;
    sourceUrl: string | null;
    syncedAt: string | null;
  }>;
  query: string;
  replyTarget: OperatorReplyTarget | null;
  items: ReadonlyArray<Readonly<{
    postRef: string;
    title: string;
    preview: string;
    content: string;
    sourceUrl: string | null;
    author: Readonly<{
      displayName: string;
      accountName: string;
    }>;
    replyCount: number;
    createdAt: string;
    lastActivityAt: string;
  }>>;
  operatorOnly: true;
  containsForumText: true;
  containsIdentity: true;
}>;

export class OperatorLocatorError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "OperatorLocatorError";
    this.code = code;
    this.status = status;
  }
}

function exactObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OperatorLocatorError(
      "OPERATOR_LOCATOR_INPUT_INVALID",
      "课程定位请求无效。"
    );
  }
  return value as Record<string, unknown>;
}

export function parseOperatorLocatorRequest(value: unknown): Readonly<{
  courseAlias: string;
  query: string;
  runId?: string;
  snapshotId?: string;
}> {
  const record = exactObject(value);
  const allowedKeys = new Set(["courseAlias", "query", "runId", "snapshotId"]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new OperatorLocatorError(
      "OPERATOR_LOCATOR_INPUT_INVALID",
      "课程定位请求包含未知字段。"
    );
  }
  if (
    typeof record.courseAlias !== "string" ||
    !COURSE_ALIAS_PATTERN.test(record.courseAlias)
  ) {
    throw new OperatorLocatorError(
      "OPERATOR_LOCATOR_COURSE_INVALID",
      "课程别名无效。"
    );
  }
  if (record.query !== undefined && typeof record.query !== "string") {
    throw new OperatorLocatorError(
      "OPERATOR_LOCATOR_QUERY_INVALID",
      "课程定位关键词无效。"
    );
  }
  for (const key of ["runId", "snapshotId"] as const) {
    if (
      record[key] !== undefined &&
      (typeof record[key] !== "string" || !SAFE_RUN_ID_PATTERN.test(record[key]))
    ) {
      throw new OperatorLocatorError(
        "OPERATOR_LOCATOR_TARGET_INVALID",
        "课程运营目标引用无效。"
      );
    }
  }
  const query = (record.query ?? "").trim();
  if (Array.from(query).length > MAX_QUERY_LENGTH) {
    throw new OperatorLocatorError(
      "OPERATOR_LOCATOR_QUERY_TOO_LONG",
      `课程定位关键词不能超过 ${MAX_QUERY_LENGTH} 个字符。`
    );
  }
  return {
    courseAlias: record.courseAlias,
    query,
    ...(typeof record.runId === "string" ? { runId: record.runId } : {}),
    ...(typeof record.snapshotId === "string" ? { snapshotId: record.snapshotId } : {})
  };
}

function boundedText(value: string, limit: number): string {
  const normalized = value.replace(/\u0000/gu, "").trim();
  const chars = Array.from(normalized);
  return chars.length <= limit ? normalized : chars.slice(0, limit).join("");
}

function contentPreview(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const chars = Array.from(normalized);
  return chars.length <= 220 ? normalized : `${chars.slice(0, 219).join("")}…`;
}

function platformUserRef(value: string): string {
  const normalized = boundedText(value, 160);
  return normalized.startsWith("real-user-id-")
    ? normalized.slice("real-user-id-".length)
    : normalized;
}

function postThreadRefs(post: Pick<OperatorLocatorPostRow, "forumPostId" | "url">): string[] {
  const refs = new Set<string>();
  const stored = boundedText(post.forumPostId, 160);
  if (stored) refs.add(stored);
  try {
    refs.add(cmoocStableThreadRef(post.url));
  } catch {
    // Local and legacy rows may not use the numeric cMOOC thread reference.
  }
  return [...refs];
}

function operatorAuthor(input: {
  identityIndex: OperatorIdentityIndex;
  post: Pick<OperatorLocatorPostRow, "forumPostId" | "author">;
}): Readonly<{ displayName: string; accountName: string }> {
  const raw = input.identityIndex.postAuthorByForumPostId.get(
    input.post.forumPostId
  );
  return {
    displayName:
      raw?.displayName ??
      (boundedText(input.post.author.name, 120) || "未命名成员"),
    accountName:
      raw?.accountName ?? platformUserRef(input.post.author.forumUserId)
  };
}

async function readLiveReplyTarget(
  input: Parameters<OperatorLiveReplyTargetReader>[0]
): Promise<OperatorLiveReplyTarget | null> {
  const manifest = await loadCourseManifest(input.courseAlias);
  if (manifest.courseId !== input.courseId) return null;
  const located = await locateTransientExecutionTarget({
    manifest,
    threadKey: input.threadKey,
    secret: input.secret
  });
  const detail = await fetchCmoocPostDetail({
    postUrl: located.target.postUrl,
    token: located.target.token,
    expectedCourseId: input.courseId
  });
  if (!detail) return null;
  return {
    forumPostId: located.target.threadRef,
    title: detail.title,
    content: detail.content,
    url: located.target.postUrl,
    author: {
      forumUserId: detail.authorPlatformId ?? "",
      name: detail.authorName
    }
  };
}

function projectReplyTarget(input: {
  runId: string;
  decisionRef: string;
  post: OperatorLiveReplyTarget;
  allowedOrigins: readonly string[];
  identityIndex?: OperatorIdentityIndex;
}): OperatorReplyTarget {
  const content = boundedText(input.post.content, MAX_CONTENT_LENGTH);
  return {
    status: "resolved",
    runId: input.runId,
    decisionRef: input.decisionRef,
    postRef: boundedText(input.post.forumPostId, 160),
    title: boundedText(input.post.title, 240) || "未命名讨论",
    preview: contentPreview(content),
    content,
    sourceUrl: safeOperatorUrl(input.post.url, input.allowedOrigins),
    author: input.identityIndex
      ? operatorAuthor({ identityIndex: input.identityIndex, post: input.post })
      : {
          displayName:
            boundedText(input.post.author.name, 120) || "未命名成员",
          accountName: platformUserRef(input.post.author.forumUserId)
        }
  };
}

function safeOperatorUrl(
  value: string | null,
  allowedOrigins: readonly string[]
): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      !allowedOrigins.includes(parsed.origin)
    ) {
      return null;
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function validManifest(input: {
  requestedAlias: string;
  stored: OperatorLocatorManifestRow | null;
  loaded: OperatorLocatorManifest;
}): void {
  if (
    !input.stored ||
    !input.stored.enabled ||
    input.stored.alias !== input.requestedAlias ||
    input.loaded.alias !== input.requestedAlias ||
    !SHA256_PATTERN.test(input.stored.manifestHash) ||
    input.stored.manifestHash !== input.loaded.manifestHash
  ) {
    throw new OperatorLocatorError(
      "OPERATOR_LOCATOR_MANIFEST_MISMATCH",
      "课程配置与当前运营数据不一致，请刷新课程配置后重试。",
      409
    );
  }
}

function decisionRefs(rows: readonly Readonly<{ sourceRefsJson: string }>[]): string[] {
  const refs = new Set<string>();
  for (const row of rows) {
    let value: unknown;
    try {
      value = JSON.parse(row.sourceRefsJson);
    } catch {
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const ref = item as Record<string, unknown>;
      if (
        ref.kind === "decision" &&
        typeof ref.id === "string" &&
        ref.id.startsWith("decision:") &&
        SAFE_RUN_ID_PATTERN.test(ref.id.slice("decision:".length))
      ) {
        refs.add(ref.id);
      }
    }
  }
  return [...refs];
}

async function resolveReplyTarget(input: {
  runId: string | undefined;
  courseAlias: string;
  courseId: string;
  allowedOrigins: readonly string[];
  db: OperatorLocatorDb;
  identityIndex: OperatorIdentityIndex;
  evidenceSecret?: Buffer | string;
  liveTargetReader?: OperatorLiveReplyTargetReader;
}): Promise<OperatorReplyTarget | null> {
  if (!input.runId) return null;
  if (
    !input.db.workbenchRunRecord ||
    !input.db.workbenchArtifactVersionRecord ||
    !input.db.autonomyDecision
  ) {
    return {
      status: "unbound",
      runId: input.runId,
      reasonCode: "no_verified_course_artifact"
    };
  }
  const [run, artifacts] = await Promise.all([
    input.db.workbenchRunRecord.findUnique({
      where: { id: input.runId },
      select: { id: true }
    }),
    input.db.workbenchArtifactVersionRecord.findMany({
      where: {
        runId: input.runId,
        artifactKind: {
          in: [
            "facilitation_intent",
            "facilitation_reply_draft",
            "facilitation_delivery_bundle"
          ]
        }
      },
      select: { sourceRefsJson: true },
      orderBy: { createdAt: "desc" },
      take: 12
    })
  ]);
  if (!run) {
    return {
      status: "unbound",
      runId: input.runId,
      reasonCode: "no_verified_course_artifact"
    };
  }
  const refs = decisionRefs(artifacts);
  if (refs.length === 0) {
    return {
      status: "unbound",
      runId: input.runId,
      reasonCode: "no_verified_course_artifact"
    };
  }
  if (refs.length !== 1) {
    return {
      status: "unbound",
      runId: input.runId,
      reasonCode: "target_binding_ambiguous"
    };
  }
  const decisionRef = refs[0]!;
  const decision = await input.db.autonomyDecision.findUnique({
    where: { id: decisionRef.slice("decision:".length) },
    select: { id: true, courseAlias: true, threadKey: true }
  });
  if (!decision || decision.courseAlias !== input.courseAlias) {
    return {
      status: "unbound",
      runId: input.runId,
      reasonCode: "target_binding_ambiguous"
    };
  }
  const [posts, secret] = await Promise.all([
    input.db.forumPost.findMany({
      where: { course: { platformCourseId: input.courseId } },
      orderBy: { updatedAt: "desc" },
      take: MAX_TARGET_LOOKUP_POSTS,
      select: {
        forumPostId: true,
        title: true,
        content: true,
        url: true,
        replyCount: true,
        createdAt: true,
        updatedAt: true,
        lastReplyAt: true,
        author: { select: { forumUserId: true, name: true } }
      }
    }),
    input.evidenceSecret
      ? Promise.resolve(input.evidenceSecret)
      : loadOrCreateLocalEvidenceSecret()
  ]);
  const matches = posts.filter((post) =>
    postThreadRefs(post).some((threadRef) =>
      deriveAutonomyThreadKey({
        secret,
        courseRef: input.courseId,
        threadRef
      }) === decision.threadKey
    )
  );
  if (matches.length === 0) {
    const live = await (
      input.liveTargetReader ?? readLiveReplyTarget
    )({
      courseAlias: input.courseAlias,
      courseId: input.courseId,
      threadKey: decision.threadKey,
      secret
    }).catch(() => null);
    if (live) {
      return projectReplyTarget({
        runId: input.runId,
        decisionRef,
        post: live,
        allowedOrigins: input.allowedOrigins
      });
    }
  }
  if (matches.length !== 1) {
    return {
      status: "unbound",
      runId: input.runId,
      reasonCode: matches.length === 0
        ? "target_not_in_local_sync"
        : "target_binding_ambiguous"
    };
  }
  const post = matches[0]!;
  return projectReplyTarget({
    runId: input.runId,
    decisionRef,
    post,
    allowedOrigins: input.allowedOrigins,
    identityIndex: input.identityIndex
  });
}

export async function loadOperatorCourseLocator(input: {
  courseAlias: string;
  query?: string;
  runId?: string;
  snapshotId?: string;
  limit?: number;
  prisma?: OperatorLocatorDb;
  loadManifest?: (alias: string) => Promise<OperatorLocatorManifest>;
  evidenceSecret?: Buffer | string;
  liveTargetReader?: OperatorLiveReplyTargetReader;
}): Promise<OperatorCourseLocator> {
  const parsed = parseOperatorLocatorRequest({
    courseAlias: input.courseAlias,
    query: input.query ?? "",
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.snapshotId ? { snapshotId: input.snapshotId } : {})
  });
  const db = input.prisma ?? (defaultPrisma as unknown as OperatorLocatorDb);
  const manifestLoader = input.loadManifest ?? (async (alias: string) => {
    const manifest = await loadCourseManifest(alias);
    return {
      alias: manifest.alias,
      courseId: manifest.courseId,
      manifestHash: manifest.manifestHash,
      canonicalUrl: manifest.canonicalUrl,
      allowedOrigins: manifest.allowedOrigins
    };
  });

  const [storedManifest, manifest] = await Promise.all([
    db.autonomyCourseManifest.findUnique({
      where: { alias: parsed.courseAlias },
      select: { alias: true, manifestHash: true, enabled: true }
    }),
    manifestLoader(parsed.courseAlias)
  ]);
  validManifest({ requestedAlias: parsed.courseAlias, stored: storedManifest, loaded: manifest });

  const course = await db.course.findUnique({
    where: { platformCourseId: manifest.courseId },
    select: {
      id: true,
      name: true,
      sourceUrl: true,
      status: true,
      lastSyncedAt: true
    }
  });
  if (!course || course.status !== "active") {
    throw new OperatorLocatorError(
      "OPERATOR_LOCATOR_COURSE_UNAVAILABLE",
      "当前课程尚未同步到运营工作区。",
      404
    );
  }

  const requestedLimit = Number.isInteger(input.limit) ? input.limit ?? MAX_RESULTS : MAX_RESULTS;
  const limit = Math.max(1, Math.min(MAX_RESULTS, requestedLimit));
  const identitySnapshots = db.forumPostSnapshot
    ? await db.forumPostSnapshot.findMany({
        where: { courseId: course.id },
        select: { forumPostId: true, rawJson: true },
        orderBy: { createdAt: "desc" },
        take: 2_000
      })
    : [];
  const identityIndex = buildOperatorIdentityIndex(identitySnapshots);
  const matchingPlatformAccountRefs = parsed.query
    ? [...identityIndex.actorByPlatformId.values()]
        .filter((identity) =>
          identity.displayName.includes(parsed.query) ||
          identity.accountName.includes(parsed.query)
        )
        .flatMap((identity) => [
          identity.accountName,
          `real-user-id-${identity.accountName}`
        ])
    : [];
  const [posts, replyTarget] = await Promise.all([
    db.forumPost.findMany({
    where: {
      courseId: course.id,
      ...(parsed.query
        ? {
            OR: [
              { title: { contains: parsed.query } },
              { content: { contains: parsed.query } },
              { author: { name: { contains: parsed.query } } },
              { author: { forumUserId: { contains: parsed.query } } },
              ...(matchingPlatformAccountRefs.length > 0
                ? [{ author: { forumUserId: { in: matchingPlatformAccountRefs } } }]
                : [])
            ]
          }
        : {})
    },
    orderBy: [{ lastReplyAt: "desc" }, { updatedAt: "desc" }],
    take: limit,
    select: {
      forumPostId: true,
      title: true,
      content: true,
      url: true,
      replyCount: true,
      createdAt: true,
      updatedAt: true,
      lastReplyAt: true,
      author: { select: { forumUserId: true, name: true } }
    }
    }),
    resolveReplyTarget({
      runId: parsed.runId,
      courseAlias: parsed.courseAlias,
      courseId: manifest.courseId,
      allowedOrigins: manifest.allowedOrigins,
      db,
      identityIndex,
      evidenceSecret: input.evidenceSecret,
      liveTargetReader: input.liveTargetReader
    })
  ]);

  return {
    schemaVersion: OPERATOR_COURSE_LOCATOR_SCHEMA_VERSION,
    course: {
      alias: parsed.courseAlias,
      name: boundedText(course.name, 160) || parsed.courseAlias,
      sourceUrl:
        safeOperatorUrl(course.sourceUrl, manifest.allowedOrigins) ??
        safeOperatorUrl(manifest.canonicalUrl, manifest.allowedOrigins),
      syncedAt: course.lastSyncedAt?.toISOString() ?? null
    },
    query: parsed.query,
    replyTarget,
    items: posts.map((post) => {
      const content = boundedText(post.content, MAX_CONTENT_LENGTH);
      return {
        postRef: boundedText(post.forumPostId, 160),
        title: boundedText(post.title, 240) || "未命名讨论",
        preview: contentPreview(content),
        content,
        sourceUrl: safeOperatorUrl(post.url, manifest.allowedOrigins),
        author: operatorAuthor({ identityIndex, post }),
        replyCount: Math.max(0, post.replyCount),
        createdAt: post.createdAt.toISOString(),
        lastActivityAt: (post.lastReplyAt ?? post.updatedAt).toISOString()
      };
    }),
    operatorOnly: true,
    containsForumText: true,
    containsIdentity: true
  };
}
