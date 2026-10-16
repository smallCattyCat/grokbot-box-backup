import { prisma as defaultPrisma } from "@/lib/db";
import {
  loadCourseManifest,
  type CourseManifest
} from "@/lib/autonomy/course-manifest";
import { COURSE_CONTENT_GRAPH_SCHEMA_VERSION } from "@/lib/world/course-content-graph-projector";
import {
  deriveAutonomyActorKey,
  deriveAutonomyThreadKey
} from "@/lib/world/live-event";
import { cmoocStableThreadRef } from "@/lib/forum-adapters/cmooc-api-adapter";
import { loadOrCreateLocalEvidenceSecret } from "@/lib/privacy/local-evidence-hmac";

export const OPERATOR_COURSE_IDENTITY_SCHEMA_VERSION =
  "cmooc.operator-course-identity.v2" as const;

const COURSE_ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_CONTENT_LENGTH = 4_000;

type GraphNodeRow = Readonly<{
  nodeKey: string;
  kind: string;
  ordinal: number | null;
}>;

type MembershipRow = Readonly<{
  forumUserId: string;
  displayName: string;
  user: Readonly<{
    forumUserId: string;
    name: string;
  }>;
}>;

type PostRow = Readonly<{
  forumPostId: string;
  title: string;
  content: string;
  url: string;
  author: Readonly<{
    forumUserId: string;
    name: string;
  }>;
}>;

type UserSnapshotRow = Readonly<{
  forumUserId: string;
  displayName: string;
}>;

type ReplyAuthorRow = Readonly<{
  author: Readonly<{
    forumUserId: string;
    name: string;
  }>;
}>;

export type OperatorIdentitySnapshotRow = Readonly<{
  forumPostId: string;
  rawJson: string;
}>;

type OperatorIdentity = Readonly<{
  displayName: string;
  accountName: string;
}>;

export type OperatorIdentityIndex = Readonly<{
  actorByPlatformId: ReadonlyMap<string, OperatorIdentity>;
  postAuthorByForumPostId: ReadonlyMap<string, OperatorIdentity>;
}>;

export type OperatorCourseIdentityOverlay = Readonly<{
  schemaVersion: typeof OPERATOR_COURSE_IDENTITY_SCHEMA_VERSION;
  courseAlias: string;
  snapshotId: string;
  identityCoverage: Readonly<{
    graphActorCount: number;
    matchedActorCount: number;
    unmatchedActorCount: number;
    sourceIdentityCount: number;
    status: "complete" | "partial" | "unavailable";
  }>;
  actors: ReadonlyArray<Readonly<{
    nodeId: string;
    displayName: string;
    accountName: string;
  }>>;
  threads: ReadonlyArray<Readonly<{
    nodeId: string;
    postRef: string;
    title: string;
    preview: string;
    content: string;
    sourceUrl: string | null;
    author: Readonly<{
      displayName: string;
      accountName: string;
    }>;
  }>>;
  operatorOnly: true;
  containsForumText: true;
  containsIdentity: true;
}>;

type OperatorCourseIdentityDb = Readonly<{
  autonomyCourseManifest: {
    findUnique(args: unknown): Promise<Readonly<{
      alias: string;
      manifestHash: string;
      enabled: boolean;
    }> | null>;
  };
  courseWorldSnapshot: {
    findUnique(args: unknown): Promise<Readonly<{
      id: string;
      courseAlias: string;
    }> | null>;
  };
  courseContentGraphSnapshot: {
    findFirst(args: unknown): Promise<Readonly<{ id: string }> | null>;
  };
  courseGraphNodeProjection: {
    findMany(args: unknown): Promise<GraphNodeRow[]>;
  };
  course: {
    findUnique(args: unknown): Promise<Readonly<{
      id: string;
      status: string;
    }> | null>;
  };
  courseMembership: {
    findMany(args: unknown): Promise<MembershipRow[]>;
  };
  forumPost: {
    findMany(args: unknown): Promise<PostRow[]>;
  };
  forumPostSnapshot: {
    findMany(args: unknown): Promise<OperatorIdentitySnapshotRow[]>;
  };
  forumUserSnapshot: {
    findMany(args: unknown): Promise<UserSnapshotRow[]>;
  };
  forumReply: {
    findMany(args: unknown): Promise<ReplyAuthorRow[]>;
  };
}>;

function bounded(value: string, limit: number): string {
  const normalized = value.replace(/\u0000/gu, "").trim();
  const chars = Array.from(normalized);
  return chars.length <= limit ? normalized : chars.slice(0, limit).join("");
}

function preview(value: string): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  const chars = Array.from(compact);
  return chars.length <= 220 ? compact : `${chars.slice(0, 219).join("")}…`;
}

function safeUrl(value: string, allowedOrigins: readonly string[]): string | null {
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

function sortedNodes(rows: readonly GraphNodeRow[], kind: "actor" | "thread") {
  return rows
    .filter((row) => row.kind === kind)
    .sort(
      (left, right) =>
        (left.ordinal ?? Number.MAX_SAFE_INTEGER) -
          (right.ordinal ?? Number.MAX_SAFE_INTEGER) ||
        left.nodeKey.localeCompare(right.nodeKey)
    );
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function platformUserRef(value: string): string {
  const normalized = bounded(value, 160);
  return normalized.startsWith("real-user-id-")
    ? normalized.slice("real-user-id-".length)
    : normalized;
}

function rawIdentity(value: unknown): OperatorIdentity | null {
  const candidate = record(value);
  if (!candidate) return null;
  const accountName =
    typeof candidate.authorPlatformId === "string"
      ? bounded(candidate.authorPlatformId, 160)
      : "";
  const displayName =
    typeof candidate.authorName === "string"
      ? bounded(candidate.authorName, 120)
      : "";
  if (!accountName || !displayName) return null;
  return Object.freeze({ displayName, accountName });
}

function addIdentityCandidate(
  target: Map<string, OperatorIdentity>,
  rawAccountName: string,
  rawDisplayName: string
): void {
  const accountName = platformUserRef(rawAccountName);
  const displayName = bounded(rawDisplayName, 120);
  if (!accountName || !displayName || target.has(accountName)) return;
  target.set(accountName, Object.freeze({ accountName, displayName }));
}

/**
 * Reconstruct the operator-only identity directory from the latest raw forum
 * ingestion snapshots. Rows are expected newest-first; the first observation
 * wins so an older display name cannot overwrite the latest platform value.
 * The returned maps never enter the safe world model or agent transport.
 */
export function buildOperatorIdentityIndex(
  snapshots: readonly OperatorIdentitySnapshotRow[]
): OperatorIdentityIndex {
  const actorByPlatformId = new Map<string, OperatorIdentity>();
  const postAuthorByForumPostId = new Map<string, OperatorIdentity>();
  for (const snapshot of snapshots) {
    let root: Record<string, unknown> | null = null;
    try {
      root = record(JSON.parse(snapshot.rawJson) as unknown);
    } catch {
      continue;
    }
    if (!root) continue;
    const detail = record(root.detail);
    const postAuthor =
      rawIdentity(detail) ?? rawIdentity(root.listedAuthor);
    if (postAuthor) {
      actorByPlatformId.set(
        postAuthor.accountName,
        actorByPlatformId.get(postAuthor.accountName) ?? postAuthor
      );
      if (!postAuthorByForumPostId.has(snapshot.forumPostId)) {
        postAuthorByForumPostId.set(snapshot.forumPostId, postAuthor);
      }
    }
    const comments = Array.isArray(detail?.comments)
      ? detail.comments
      : [];
    for (const comment of comments) {
      const identity = rawIdentity(comment);
      if (identity && !actorByPlatformId.has(identity.accountName)) {
        actorByPlatformId.set(identity.accountName, identity);
      }
    }
  }
  return Object.freeze({ actorByPlatformId, postAuthorByForumPostId });
}

function threadRefs(post: PostRow): string[] {
  const refs = new Set<string>();
  const stored = bounded(post.forumPostId, 160);
  if (stored) refs.add(stored);
  try {
    refs.add(cmoocStableThreadRef(post.url));
  } catch {
    // Legacy/local fixtures may use a non-platform post reference. The stored
    // reference remains a valid candidate for those rows.
  }
  return [...refs];
}

export function buildOperatorCourseIdentityOverlay(input: {
  courseAlias: string;
  snapshotId: string;
  courseRef: string;
  secret: Buffer | string;
  allowedOrigins: readonly string[];
  graphNodes: readonly GraphNodeRow[];
  memberships: readonly MembershipRow[];
  posts: readonly PostRow[];
  identitySnapshots?: readonly OperatorIdentitySnapshotRow[];
  userSnapshots?: readonly UserSnapshotRow[];
  replyAuthors?: readonly ReplyAuthorRow[];
}): OperatorCourseIdentityOverlay {
  const actorNodeIds = new Map(
    sortedNodes(input.graphNodes, "actor").map((row, index) => [
      row.nodeKey,
      `actor-${String(index + 1).padStart(3, "0")}`
    ])
  );
  const threadNodeIds = new Map(
    sortedNodes(input.graphNodes, "thread").map((row, index) => [
      row.nodeKey,
      `thread-${String(index + 1).padStart(3, "0")}`
    ])
  );

  const identityIndex = buildOperatorIdentityIndex(
    input.identitySnapshots ?? []
  );
  const actorCandidates = new Map<string, OperatorIdentity>(
    identityIndex.actorByPlatformId
  );
  for (const snapshot of input.userSnapshots ?? []) {
    addIdentityCandidate(
      actorCandidates,
      snapshot.forumUserId,
      snapshot.displayName
    );
  }
  for (const membership of input.memberships) {
    addIdentityCandidate(
      actorCandidates,
      membership.forumUserId || membership.user.forumUserId,
      membership.displayName || membership.user.name
    );
  }
  for (const reply of input.replyAuthors ?? []) {
    addIdentityCandidate(
      actorCandidates,
      reply.author.forumUserId,
      reply.author.name
    );
  }
  for (const post of input.posts) {
    addIdentityCandidate(
      actorCandidates,
      post.author.forumUserId,
      post.author.name
    );
  }
  const actorsByNodeId = new Map<string, OperatorIdentity & { nodeId: string }>();
  for (const identity of actorCandidates.values()) {
    const actorKey = deriveAutonomyActorKey({
      secret: input.secret,
      courseRef: input.courseRef,
      actorRef: identity.accountName
    });
    const nodeId = actorNodeIds.get(actorKey);
    if (!nodeId || actorsByNodeId.has(nodeId)) continue;
    actorsByNodeId.set(nodeId, {
      nodeId,
      displayName: identity.displayName,
      accountName: identity.accountName
    });
  }
  const actors = [...actorsByNodeId.values()]
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const graphActorCount = actorNodeIds.size;
  const matchedActorCount = actors.length;
  const identityCoverage = Object.freeze({
    graphActorCount,
    matchedActorCount,
    unmatchedActorCount: Math.max(0, graphActorCount - matchedActorCount),
    sourceIdentityCount: actorCandidates.size,
    status: (
      graphActorCount === 0 || matchedActorCount === graphActorCount
        ? "complete"
        : matchedActorCount > 0
          ? "partial"
          : "unavailable"
    ) as "complete" | "partial" | "unavailable"
  });

  const threads = input.posts.flatMap((post) => {
    const nodeId = threadRefs(post).map((threadRef) =>
      threadNodeIds.get(deriveAutonomyThreadKey({
        secret: input.secret,
        courseRef: input.courseRef,
        threadRef
      }))
    ).find((candidate): candidate is string => Boolean(candidate));
    if (!nodeId) return [];
    const content = bounded(post.content, MAX_CONTENT_LENGTH);
    const rawAuthor =
      identityIndex.postAuthorByForumPostId.get(post.forumPostId);
    return [{
      nodeId,
      postRef: bounded(post.forumPostId, 160),
      title: bounded(post.title, 240) || "未命名讨论",
      preview: preview(content),
      content,
      sourceUrl: safeUrl(post.url, input.allowedOrigins),
      author: {
        displayName:
          rawAuthor?.displayName ??
          (bounded(post.author.name, 120) || "未命名成员"),
        accountName:
          rawAuthor?.accountName ??
          platformUserRef(post.author.forumUserId)
      }
    }];
  }).sort((left, right) => left.nodeId.localeCompare(right.nodeId));

  return Object.freeze({
    schemaVersion: OPERATOR_COURSE_IDENTITY_SCHEMA_VERSION,
    courseAlias: input.courseAlias,
    snapshotId: input.snapshotId,
    identityCoverage,
    actors: Object.freeze(actors.map((actor) => Object.freeze(actor))),
    threads: Object.freeze(threads.map((thread) => Object.freeze(thread))),
    operatorOnly: true,
    containsForumText: true,
    containsIdentity: true
  });
}

export async function loadOperatorCourseIdentityOverlay(input: {
  courseAlias: string;
  snapshotId: string;
  prisma?: OperatorCourseIdentityDb;
  loadManifest?: (alias: string) => Promise<CourseManifest>;
  loadSecret?: () => Promise<Buffer>;
}): Promise<OperatorCourseIdentityOverlay> {
  if (
    !COURSE_ALIAS_PATTERN.test(input.courseAlias) ||
    !SAFE_ID_PATTERN.test(input.snapshotId)
  ) {
    throw new Error("OPERATOR_COURSE_IDENTITY_INPUT_INVALID");
  }
  const db = input.prisma ?? (defaultPrisma as unknown as OperatorCourseIdentityDb);
  const manifestLoader = input.loadManifest ?? loadCourseManifest;
  const [storedManifest, manifest, world] = await Promise.all([
    db.autonomyCourseManifest.findUnique({
      where: { alias: input.courseAlias },
      select: { alias: true, manifestHash: true, enabled: true }
    }),
    manifestLoader(input.courseAlias),
    db.courseWorldSnapshot.findUnique({
      where: { id: input.snapshotId },
      select: { id: true, courseAlias: true }
    })
  ]);
  if (
    !storedManifest?.enabled ||
    storedManifest.alias !== input.courseAlias ||
    storedManifest.manifestHash !== manifest.manifestHash ||
    !SHA256_PATTERN.test(storedManifest.manifestHash) ||
    !world ||
    world.courseAlias !== input.courseAlias
  ) {
    throw new Error("OPERATOR_COURSE_IDENTITY_BINDING_MISMATCH");
  }
  const [graph, course] = await Promise.all([
    db.courseContentGraphSnapshot.findFirst({
      where: {
        worldSnapshotId: world.id,
        courseAlias: input.courseAlias,
        schemaVersion: COURSE_CONTENT_GRAPH_SCHEMA_VERSION
      },
      select: { id: true }
    }),
    db.course.findUnique({
      where: { platformCourseId: manifest.courseId },
      select: { id: true, status: true }
    })
  ]);
  if (!graph || !course || course.status !== "active") {
    throw new Error("OPERATOR_COURSE_IDENTITY_SOURCE_UNAVAILABLE");
  }
  const [
    graphNodes,
    memberships,
    posts,
    identitySnapshots,
    userSnapshots,
    replyAuthors,
    secret
  ] = await Promise.all([
    db.courseGraphNodeProjection.findMany({
      where: { graphSnapshotId: graph.id, kind: { in: ["actor", "thread"] } },
      select: { nodeKey: true, kind: true, ordinal: true }
    }),
    db.courseMembership.findMany({
      where: { courseId: course.id },
      select: {
        forumUserId: true,
        displayName: true,
        user: { select: { forumUserId: true, name: true } }
      }
    }),
    db.forumPost.findMany({
      where: { courseId: course.id },
      select: {
        forumPostId: true,
        title: true,
        content: true,
        url: true,
        author: { select: { forumUserId: true, name: true } }
      }
    }),
    db.forumPostSnapshot.findMany({
      where: { courseId: course.id },
      select: { forumPostId: true, rawJson: true },
      orderBy: { createdAt: "desc" },
      take: 2_000
    }),
    db.forumUserSnapshot.findMany({
      where: { courseId: course.id },
      select: { forumUserId: true, displayName: true },
      orderBy: { createdAt: "desc" },
      take: 5_000
    }),
    db.forumReply.findMany({
      where: { courseId: course.id },
      select: {
        author: { select: { forumUserId: true, name: true } }
      }
    }),
    (input.loadSecret ?? loadOrCreateLocalEvidenceSecret)()
  ]);
  return buildOperatorCourseIdentityOverlay({
    courseAlias: input.courseAlias,
    snapshotId: input.snapshotId,
    courseRef: manifest.courseId,
    secret,
    allowedOrigins: manifest.allowedOrigins,
    graphNodes,
    memberships,
    posts,
    identitySnapshots,
    userSnapshots,
    replyAuthors
  });
}
