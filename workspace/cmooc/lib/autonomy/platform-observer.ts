import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import {
  cmoocStableThreadRef
} from "@/lib/forum-adapters/cmooc-api-adapter";
import {
  createCmoocCommentPageCursor,
  createCmoocTopicPageCursor,
  fetchCmoocCommentPage,
  fetchCmoocCourseColumns,
  fetchCmoocCourseMembers,
  fetchCmoocPostCore,
  fetchCmoocSketchPostPage,
  getCmoocApiToken,
  type CmoocApiComment,
  type CmoocApiPageReceipt,
  type CmoocApiScannedPost,
  type CmoocCourseMemberType
} from "@/lib/forum/cmooc-api";
import type {
  LiveUiEventEvidence,
  LiveUiObservationReceipt
} from "@/lib/ui-agent/live-observation";
import {
  inspectCmoocUiReadiness
} from "@/lib/platform-readiness/cmooc-ui-readiness";
import {
  deriveAutonomyActorKey,
  deriveAutonomyCourseKey,
  LiveEventNormalizationError,
  normalizeObservedThread,
  type NormalizedCourseEvent
} from "@/lib/world/live-event";
import {
  CONTROLLED_COURSE_CONCEPT_TAXONOMY_VERSION,
  createCourseStructureEdgeFact,
  createCourseStructureNodeFact,
  deriveCourseGraphNodeKey,
  deriveCourseGraphRevisionHash,
  extractControlledConceptSignals,
  extractHashedResourceSignals,
  hashCourseStructureFactSet,
  type CourseStructureFact
} from "@/lib/world/course-structure-fact";
import {
  COURSE_MANIFEST_SCHEMA_VERSION,
  type CourseManifest,
  type CourseManifestV1
} from "./course-manifest";
import {
  computeCourseRoleEvidenceMac
} from "./role-attestation";
import type {
  OperatorIdentityObservation,
  OperatorIdentitySource
} from "./operator-identity-sync";
import {
  analyzeTransientSemanticEvidence,
  type AutonomySemanticEvidenceReceipt
} from "./transient-semantic-evidence";
import {
  openCmoocBrowserCommentCompanion,
  type CmoocBrowserCommentCompanion,
  type CmoocBrowserCommentCompanionReceipt
} from "./cmooc-browser-comment-companion";

export const COURSE_SCAN_COVERAGE_SCHEMA_VERSION =
  "cmooc.course-scan-coverage.v5" as const;
export const COURSE_SCAN_CURSOR_SCHEMA_VERSION =
  "cmooc.course-scan-cursor.v2" as const;

/**
 * The CMOOC hybrid observer is deliberately a v1-only implementation. A
 * generic v2 manifest must be dispatched through an explicitly registered or
 * injected observer instead of silently using CMOOC endpoints.
 */
export function isCmoocV1Manifest(
  manifest: CourseManifest
): manifest is CourseManifestV1 {
  return (
    manifest.schemaVersion === COURSE_MANIFEST_SCHEMA_VERSION &&
    manifest.platformId === "cmooc.bnu" &&
    manifest.adapterId === "cmooc.api.v2"
  );
}

export function assertCmoocV1Manifest(
  manifest: CourseManifest
): asserts manifest is CourseManifestV1 {
  if (!isCmoocV1Manifest(manifest)) {
    throw new Error("CMOOC_OBSERVER_REQUIRES_CMOOC_V1_MANIFEST");
  }
}

export type CourseScanResumeCursor = {
  schemaVersion: typeof COURSE_SCAN_CURSOR_SCHEMA_VERSION;
  scopeCursors: Record<string, string>;
  observedByScope: Record<string, number>;
  completedTopicScopes: string[];
  containsForumText: false;
};

export type ObservedThreadBundle = {
  threadKey: string;
  authorKey: string | null;
  targetVersionHash: string;
  events: NormalizedCourseEvent[];
  kernelObservation: LiveUiObservationReceipt;
  kernelObservationHash: string;
  semanticEvidence?: AutonomySemanticEvidenceReceipt;
  semanticEvidenceHash?: string;
};

export type CourseScanCoverage = {
  schemaVersion: typeof COURSE_SCAN_COVERAGE_SCHEMA_VERSION;
  observedAt: string;
  sourceKind:
    | "cmooc_api_plus_read_only_browser"
    | "platform_connector_read_only";
  apiReadAuthStatus: "authenticated" | "anonymous";
  uiStatus: "overview_ready" | "shell_only" | "blocked" | "failed";
  uiEvidenceHash: string;
  courseShellDetected: boolean;
  categoryCount: number;
  categoryCompletedCount: number;
  pageRequestCount: number;
  discoveredThreadCount: number;
  attemptedDetailCount: number;
  completedDetailCount: number;
  failedTargetCount: number;
  observedEventCount: number;
  truncatedThreadListing: boolean;
  incompleteCommentThreadCount: number;
  complete: boolean;
  failureCodeCounts: Record<string, number>;
  recoveryCodeCounts: Record<string, number>;
  roleRegistryStatus: "complete" | "unavailable";
  roleRegistryMemberCount: number;
  roleRegistrySnapshotHash: string | null;
  expectedThreadCount?: number | null;
  expectedCommentCount?: number | null;
  nextCursor?: string | null;
  paginationTruncated?: boolean;
  paginationFailureCount?: number;
  columnPagination?: CourseScanPaginationReceipt;
  topicPagination?: CourseScanPaginationReceipt[];
  commentPagination?: CourseScanPaginationReceipt[];
  containsForumText: false;
};

export type CourseScanPaginationReceipt = {
  scopeKey: string;
  expected: number | null;
  observed: number;
  countDomain?: "items" | "root_comments";
  observedEventCount?: number;
  nextCursor: string | null;
  truncation: boolean;
  failure: string | null;
  pageRequestCount: number;
  transport?: "cmooc_api_current" | "ui_native_infinite_scroll";
  apiPageRequestCount?: number;
  companionAttemptCount?: number;
  companionFailedAttemptCount?: number;
  companionFailureCodes?: string[];
  companionReceipt?: CmoocBrowserCommentCompanionReceipt;
  containsForumText: false;
};

export type CourseScanObservation = {
  coverage: CourseScanCoverage;
  coverageHash: string;
  sourceReceiptHash: string;
  threads: ObservedThreadBundle[];
  structureFacts?: CourseStructureFact[];
  structureFactSetHash?: string;
};

export interface AutonomyCourseObserver {
  observe(input: {
    manifest: CourseManifest;
    secret: Buffer | string;
    observedAt: string;
    resumeCursor?: CourseScanResumeCursor;
    onProgress?: (
      cursor: CourseScanResumeCursor
    ) => Promise<void>;
  }): Promise<CourseScanObservation>;
}

export interface CmoocHybridObserverDependencies {
  inspectReadiness: typeof inspectCmoocUiReadiness;
  getToken: typeof getCmoocApiToken;
  fetchColumns: typeof fetchCmoocCourseColumns;
  fetchMembers: typeof fetchCmoocCourseMembers;
  fetchTopicPage: typeof fetchCmoocSketchPostPage;
  fetchPostCore: typeof fetchCmoocPostCore;
  fetchCommentPage: typeof fetchCmoocCommentPage;
  openCommentCompanion: typeof openCmoocBrowserCommentCompanion;
  recordOperatorIdentities(input: {
    courseAlias: string;
    courseRef: string;
    observedAt: string;
    identities: readonly OperatorIdentityObservation[];
  }): Promise<void>;
}

const DEFAULT_OBSERVER_DEPENDENCIES: CmoocHybridObserverDependencies = {
  inspectReadiness: inspectCmoocUiReadiness,
  getToken: getCmoocApiToken,
  fetchColumns: fetchCmoocCourseColumns,
  fetchMembers: fetchCmoocCourseMembers,
  fetchTopicPage: fetchCmoocSketchPostPage,
  fetchPostCore: fetchCmoocPostCore,
  fetchCommentPage: fetchCmoocCommentPage,
  openCommentCompanion: openCmoocBrowserCommentCompanion,
  recordOperatorIdentities: async () => undefined
};

type SafePagedResult<T> = {
  items: T[];
  receipt: Omit<CourseScanPaginationReceipt, "scopeKey">;
};

export async function collectCmoocPages<T>(input: {
  initialCursor: string;
  maxItems: number;
  maxPageRequests?: number;
  observedBefore?: number;
  itemKey: (item: T) => string;
  fetchPage: (cursor: string) => Promise<{
    items: T[];
    receipt: CmoocApiPageReceipt;
  }>;
  classifyFailure?: (error: unknown) => string;
  onCheckpoint?: (checkpoint: {
    requestCursor: string;
    nextCursor: string | null;
    observedAdded: number;
    expected: number | null;
    failure: string | null;
  }) => Promise<void>;
}): Promise<SafePagedResult<T>> {
  if (
    !Number.isSafeInteger(input.maxItems) ||
    input.maxItems < 1
  ) {
    throw new Error("CMOOC_PAGE_COLLECTION_LIMIT_INVALID");
  }
  if (
    input.maxPageRequests !== undefined &&
    (!Number.isSafeInteger(input.maxPageRequests) ||
      input.maxPageRequests < 1)
  ) {
    throw new Error("CMOOC_PAGE_REQUEST_LIMIT_INVALID");
  }
  const observedBefore = input.observedBefore ?? 0;
  if (
    !Number.isSafeInteger(observedBefore) ||
    observedBefore < 0
  ) {
    throw new Error("CMOOC_PAGE_COLLECTION_OFFSET_INVALID");
  }
  const items: T[] = [];
  const itemKeys = new Set<string>();
  const requestedCursors = new Set<string>();
  const pageFingerprints = new Set<string>();
  let cursor = input.initialCursor;
  let expected: number | null = null;
  let nextCursor: string | null = cursor;
  let failure: string | null = null;
  let pageRequestCount = 0;

  while (items.length < input.maxItems) {
    if (requestedCursors.has(cursor)) {
      failure = "cursor_cycle";
      nextCursor = cursor;
      break;
    }
    requestedCursors.add(cursor);
    let page: {
      items: T[];
      receipt: CmoocApiPageReceipt;
    };
    try {
      page = await input.fetchPage(cursor);
      pageRequestCount += 1;
    } catch (error) {
      pageRequestCount += 1;
      failure =
        input.classifyFailure?.(error) ?? "page_read_failed";
      nextCursor = cursor;
      await input.onCheckpoint?.({
        requestCursor: cursor,
        nextCursor: cursor,
        observedAdded: 0,
        expected,
        failure
      });
      break;
    }
    if (page.receipt.requestCursor !== cursor) {
      failure = "cursor_receipt_mismatch";
      nextCursor = cursor;
      break;
    }
    if (
      expected !== null &&
      page.receipt.expected !== null &&
      expected !== page.receipt.expected
    ) {
      failure = "expected_count_changed";
      nextCursor = cursor;
      break;
    }
    expected ??= page.receipt.expected;
    const pageKeys = page.items.map(input.itemKey);
    if (pageKeys.some((key) => !key)) {
      failure = "page_item_key_missing";
      nextCursor = cursor;
      break;
    }
    const fingerprint = canonicalProtocolHash(
      "cmooc.pagination-page-set.v1",
      [...pageKeys].sort()
    );
    if (pageFingerprints.has(fingerprint)) {
      failure = "duplicate_page";
      nextCursor = cursor;
      break;
    }
    pageFingerprints.add(fingerprint);
    if (pageKeys.some((key) => itemKeys.has(key))) {
      failure = "page_item_overlap";
      nextCursor = cursor;
      break;
    }
    let added = 0;
    for (let index = 0; index < page.items.length; index += 1) {
      const item = page.items[index];
      const key = pageKeys[index];
      if (itemKeys.has(key)) continue;
      if (items.length >= input.maxItems) {
        nextCursor = cursor;
        break;
      }
      itemKeys.add(key);
      items.push(item);
      added += 1;
    }
    if (
      items.length >= input.maxItems &&
      (page.receipt.nextCursor !== null ||
        added < page.items.length)
    ) {
      nextCursor =
        added < page.items.length
          ? cursor
          : page.receipt.nextCursor;
      await input.onCheckpoint?.({
        requestCursor: cursor,
        nextCursor,
        observedAdded:
          added < page.items.length ? 0 : added,
        expected,
        failure: null
      });
      break;
    }
    nextCursor = page.receipt.nextCursor;
    await input.onCheckpoint?.({
      requestCursor: cursor,
      nextCursor,
      observedAdded: added,
      expected,
      failure: null
    });
    if (nextCursor === null) break;
    if (
      input.maxPageRequests !== undefined &&
      pageRequestCount >= input.maxPageRequests
    ) {
      break;
    }
    if (added === 0) {
      failure = "duplicate_page";
      nextCursor = cursor;
      break;
    }
    cursor = nextCursor;
  }
  if (
    failure === null &&
    expected !== null &&
    observedBefore + items.length < expected &&
    nextCursor === null
  ) {
    failure = "expected_count_not_observed";
    nextCursor = input.initialCursor;
  }

  return {
    items,
    receipt: {
      expected,
      observed: items.length,
      nextCursor,
      truncation: nextCursor !== null || failure !== null,
      failure,
      pageRequestCount,
      containsForumText: false
    }
  };
}

function emptyCourseScanCursor(): CourseScanResumeCursor {
  return {
    schemaVersion: COURSE_SCAN_CURSOR_SCHEMA_VERSION,
    scopeCursors: {},
    observedByScope: {},
    completedTopicScopes: [],
    containsForumText: false
  };
}

export function parseCourseScanResumeCursor(
  value: unknown
): CourseScanResumeCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (
    raw.schemaVersion !== COURSE_SCAN_CURSOR_SCHEMA_VERSION ||
    raw.containsForumText !== false ||
    !raw.scopeCursors ||
    typeof raw.scopeCursors !== "object" ||
    Array.isArray(raw.scopeCursors) ||
    !raw.observedByScope ||
    typeof raw.observedByScope !== "object" ||
    Array.isArray(raw.observedByScope) ||
    !Array.isArray(raw.completedTopicScopes)
  ) {
    return null;
  }
  const scopeCursors: Record<string, string> = {};
  for (const [scopeKey, cursor] of Object.entries(
    raw.scopeCursors as Record<string, unknown>
  )) {
    if (
      !/^[a-f0-9]{64}$/.test(scopeKey) ||
      typeof cursor !== "string" ||
      !cursor.startsWith("cmooc.page.v1.") ||
      cursor.length > 1_024
    ) {
      return null;
    }
    scopeCursors[scopeKey] = cursor;
  }
  const observedByScope: Record<string, number> = {};
  for (const [scopeKey, count] of Object.entries(
    raw.observedByScope as Record<string, unknown>
  )) {
    if (
      !/^[a-f0-9]{64}$/.test(scopeKey) ||
      !Number.isSafeInteger(count) ||
      Number(count) < 0
    ) {
      return null;
    }
    observedByScope[scopeKey] = Number(count);
  }
  const completedTopicScopes = [
    ...new Set(
      raw.completedTopicScopes.filter(
        (scope): scope is string =>
          typeof scope === "string" &&
          /^[a-f0-9]{64}$/.test(scope)
      )
    )
  ].sort();
  if (
    completedTopicScopes.length !==
    raw.completedTopicScopes.length
  ) {
    return null;
  }
  return {
    schemaVersion: COURSE_SCAN_CURSOR_SCHEMA_VERSION,
    scopeCursors,
    observedByScope,
    completedTopicScopes,
    containsForumText: false
  };
}

function cloneCourseScanCursor(
  value?: CourseScanResumeCursor
): CourseScanResumeCursor {
  const parsed = parseCourseScanResumeCursor(value);
  return parsed
    ? {
        ...parsed,
        scopeCursors: { ...parsed.scopeCursors },
        observedByScope: { ...parsed.observedByScope },
        completedTopicScopes: [
          ...parsed.completedTopicScopes
        ]
      }
    : emptyCourseScanCursor();
}

function incrementCode(
  target: Record<string, number>,
  code: string
): void {
  target[code] = (target[code] ?? 0) + 1;
}

function errorCode(
  error: unknown,
  fallback: string,
  paginationScope?: "topic" | "comment"
): string {
  if (error instanceof LiveEventNormalizationError) {
    return error.code;
  }
  if (!(error instanceof Error)) return fallback;
  const message = error.message.toUpperCase();
  if (message.includes("TIME")) return "invalid_event_time";
  if (message.includes("AUTH") || message.includes("TOKEN")) {
    return "read_auth_unavailable";
  }
  if (message.includes("CMOOC_PAGE_POSITION_MISMATCH")) {
    return paginationScope === "topic"
      ? "topic_pagination_position_ignored"
      : "comment_pagination_position_ignored";
  }
  if (message.includes("PARENT")) return "event_parent_unresolved";
  if (message.includes("LIMIT") || message.includes("上限")) {
    return "scan_limit_exceeded";
  }
  if (message.includes("COURSE")) return "course_scope_mismatch";
  return fallback;
}

const RETRYABLE_COMMENT_COMPANION_FAILURES = new Set([
  "BROWSER_RUNTIME_FAILED",
  "BROWSER_RUNTIME_TIMEOUT",
  "BROWSER_SESSION_CLOSED",
  "BROWSER_SESSION_FAILED",
  "BROWSER_SESSION_TIMEOUT",
  "DOM_INSPECTION_FAILED",
  "DOM_INSPECTION_TIMEOUT",
  "NAVIGATION_TIMEOUT",
  "NAVIGATION_FAILED",
  "NATIVE_SCROLL_FAILED",
  "NATIVE_SCROLL_TIMEOUT",
  "INITIAL_COMMENT_RESPONSE_TIMEOUT",
  "NEXT_COMMENT_PAGE_TIMEOUT",
  "NEXT_COMMENT_PAGE_REQUEST_NOT_OBSERVED",
  "DETAIL_RESPONSE_TIMEOUT",
  "COURSE_ID_UNVERIFIED"
]);

export function classifyCmoocCommentCompanionFailure(
  error: unknown
): { code: string; retryable: boolean } {
  const message =
    error instanceof Error ? error.message.toUpperCase() : "";
  const matched = message.match(
    /CMOOC_BROWSER_COMMENT_COMPANION_([A-Z0-9_]+)/
  );
  const rawCode = (matched?.[1] ?? "UNKNOWN_ERROR").replace(
    /_AFTER_\d+_OF_\d+$/,
    ""
  );
  return {
    code: rawCode.toLowerCase(),
    retryable:
      RETRYABLE_COMMENT_COMPANION_FAILURES.has(rawCode)
  };
}

function eventEvidence(
  events: NormalizedCourseEvent[]
): LiveUiEventEvidence[] {
  return events.map((event) => ({
    eventKey: event.eventKey,
    actorKey: event.actorKey,
    parentEventKey: event.parentEventKey,
    createdAt: event.occurredAt,
    actorRelation: event.actorRelation,
    actorRelationBasis:
      event.actorRelation === "thread_author"
        ? "stable_actor_match"
        : event.actorRelation === "unknown"
          ? "unavailable"
          : "course_role_registry"
  }));
}

export function buildKernelObservation(input: {
  manifest: CourseManifest;
  baselineEvidenceHash: string;
  courseShellDetected: boolean;
  categoryCount: number;
  visibleCardCount: number;
  thread: ReturnType<typeof normalizeObservedThread>;
  observedAt: string;
  completeComments: boolean;
  secret: Buffer | string;
  roleByActorKey: ReadonlyMap<string, CmoocCourseMemberType>;
}): {
  receipt: LiveUiObservationReceipt;
  receiptHash: string;
} {
  const events = eventEvidence(input.thread.events);
  const eventSetHash = canonicalProtocolHash(
    "cmooc.live-event-evidence-set.v1",
    {
      schemaVersion: "cmooc.live-event-evidence-set.v1",
      events
    } as unknown as CanonicalJsonValue
  );
  const latestEventAt = events
    .map((event) => event.createdAt)
    .sort(
      (left, right) =>
        Date.parse(left) - Date.parse(right) ||
        left.localeCompare(right)
    )
    .at(-1) ?? null;
  const commentEvents = events.filter(
    (event) => event.parentEventKey !== null
  );
  const memberType = input.thread.authorKey
    ? input.roleByActorKey.get(input.thread.authorKey) ?? null
    : null;
  const authorRole =
    memberType === "LEARNER"
      ? ("learner" as const)
      : memberType === "CREATOR"
        ? ("creator" as const)
        : memberType === "HELPER"
          ? ("helper" as const)
          : ("unknown" as const);
  const authorRoleEvidenceExpiresAt =
    authorRole !== "unknown"
      ? new Date(
          Date.parse(input.observedAt) + 10 * 60_000
        ).toISOString()
      : null;
  const authorRoleEvidenceHash =
    authorRole !== "unknown" &&
    input.thread.authorKey &&
    authorRoleEvidenceExpiresAt
      ? computeCourseRoleEvidenceMac({
          secret: input.secret,
          courseKey: input.thread.courseKey,
          threadKey: input.thread.threadKey,
          authorKey: input.thread.authorKey,
          role: authorRole,
          evidenceAsOf: input.observedAt,
          expiresAt: authorRoleEvidenceExpiresAt,
          targetVersionHash: input.thread.targetVersionHash
        })
      : null;
  const semanticReviewReady =
    input.courseShellDetected &&
    input.completeComments &&
    input.thread.authorKey !== null &&
    authorRole !== "unknown" &&
    events.every((event) => event.actorRelation !== "unknown");
  const receiptWithoutKey: Omit<
    LiveUiObservationReceipt,
    "observationKey"
  > = {
    schemaVersion: "cmooc.live-ui-observation-receipt.v1",
    baselineEvidenceHash: input.baselineEvidenceHash,
    driverKind: "deterministic_browser",
    driverSessionKey: canonicalProtocolHash(
      "cmooc.autonomy-observer-session.v1",
      {
        manifestHash: input.manifest.manifestHash,
        observedAt: input.observedAt
      }
    ),
    attestationLevel: "target_only",
    targetLocatorHash: canonicalProtocolHash(
      "cmooc.ui-target-locator.v1",
      input.manifest.canonicalUrl
    ),
    surfaceLocatorHash: canonicalProtocolHash(
      "cmooc.autonomy-api-detail-surface.v1",
      {
        threadKey: input.thread.threadKey,
        courseManifestHash: input.manifest.manifestHash
      }
    ),
    courseKey: input.thread.courseKey,
    threadKey: input.thread.threadKey,
    authorKey: input.thread.authorKey,
    authorRole,
    authorRoleEvidenceHash,
    authorRoleEvidenceExpiresAt,
    observedAt: input.observedAt,
    evidenceAsOf: input.observedAt,
    temporalEvidenceStatus: semanticReviewReady
      ? "live_prefix_observed"
      : "as_of_unverified",
    contentRevisionStatus: semanticReviewReady
      ? "live_target_fingerprint_observed"
      : "final_export_revision_unknown",
    captureStatus: semanticReviewReady
      ? "semantic_ready"
      : "structural_observed",
    safeToAdvanceToSemanticReview: semanticReviewReady,
    courseShellDetected: input.courseShellDetected,
    categoryTabCount: input.categoryCount,
    visibleCardCount: input.visibleCardCount,
    detailObservation: "detail_observed",
    targetVersionHash: input.thread.targetVersionHash,
    eventSetHash,
    eventEvidence: events,
    eventCount: events.length,
    commentCount: commentEvents.length,
    externalCommentCount: events.filter(
      (event) => event.actorRelation === "external_human"
    ).length,
    selfCommentCount: events.filter(
      (event) =>
        event.parentEventKey !== null &&
        event.actorRelation === "thread_author"
    ).length,
    uniqueExternalAuthorCount: new Set(
      events
        .filter(
          (event) =>
            event.actorRelation === "external_human" &&
            event.actorKey !== null
        )
        .map((event) => event.actorKey)
    ).size,
    replyEdgeCount: commentEvents.length,
    maxReplyDepth: Math.max(
      0,
      ...input.thread.events.map((event) => event.depth)
    ),
    latestEventAt,
    commentCompleteness: input.completeComments
      ? "complete"
      : "visible_only",
    identityBasis:
      input.thread.authorKey
        ? "stable_platform_ref"
        : "unavailable",
    versionBasis: "current_fingerprint",
    actions: [
      {
        sequence: 1,
        action: "navigate",
        outcome: input.courseShellDetected ? "verified" : "blocked",
        postcondition: "target_url_verified",
        postconditionVerified: input.courseShellDetected
      },
      {
        sequence: 2,
        action: "observe_course",
        outcome: input.courseShellDetected ? "verified" : "blocked",
        postcondition: "course_shell_present",
        postconditionVerified: input.courseShellDetected
      },
      {
        sequence: 3,
        action: "open_card",
        outcome: semanticReviewReady ? "verified" : "unknown_timeout",
        postcondition: "detail_state_changed",
        postconditionVerified: semanticReviewReady
      }
    ],
    networkGuardAttached: false,
    guardReceiptHash: null,
    guardObservedAt: null,
    guardExpiresAt: null,
    requestedMutationCount: 0,
    blockedMutationCount: 0,
    sentMutationCount: 0,
    realPublishEnabled: false,
    externalWriteAttempted: false,
    containsForumText: false
  };
  const observationKey = canonicalProtocolHash(
    "cmooc.live-ui-observation-receipt.v1",
    receiptWithoutKey as unknown as CanonicalJsonValue
  );
  const receipt: LiveUiObservationReceipt = {
    ...receiptWithoutKey,
    observationKey
  };
  return {
    receipt,
    receiptHash: canonicalProtocolHash(
      receipt.schemaVersion,
      receipt as unknown as CanonicalJsonValue
    )
  };
}

export class CmoocHybridShadowObserver
  implements AutonomyCourseObserver
{
  readonly #dependencies: CmoocHybridObserverDependencies;

  constructor(
    dependencies: Partial<CmoocHybridObserverDependencies> = {}
  ) {
    this.#dependencies = {
      ...DEFAULT_OBSERVER_DEPENDENCIES,
      ...dependencies
    };
  }

  async observe(input: {
    manifest: CourseManifest;
    secret: Buffer | string;
    observedAt: string;
    resumeCursor?: CourseScanResumeCursor;
    onProgress?: (
      cursor: CourseScanResumeCursor
    ) => Promise<void>;
  }): Promise<CourseScanObservation> {
    assertCmoocV1Manifest(input.manifest);
    const observedAt = new Date(input.observedAt).toISOString();
    const scanCursor = cloneCourseScanCursor(
      input.resumeCursor
    );
    const emitProgress = () =>
      input.onProgress?.(cloneCourseScanCursor(scanCursor));
    const checkpointScope = async (inputValue: {
      scopeKey: string;
      nextCursor: string | null;
      observedAdded: number;
      completedTopic?: boolean;
    }) => {
      scanCursor.observedByScope[inputValue.scopeKey] =
        (scanCursor.observedByScope[inputValue.scopeKey] ?? 0) +
        inputValue.observedAdded;
      if (inputValue.nextCursor) {
        scanCursor.scopeCursors[inputValue.scopeKey] =
          inputValue.nextCursor;
      } else {
        delete scanCursor.scopeCursors[inputValue.scopeKey];
      }
      if (inputValue.completedTopic) {
        scanCursor.completedTopicScopes = [
          ...new Set([
            ...scanCursor.completedTopicScopes,
            inputValue.scopeKey
          ])
        ].sort();
      }
      await emitProgress();
    };
    const failureCodeCounts: Record<string, number> = {};
    const recoveryCodeCounts: Record<string, number> = {};
    let uiStatus: CourseScanCoverage["uiStatus"] = "failed";
    let uiEvidenceHash = canonicalProtocolHash(
      "cmooc.ui-readiness-unavailable.v1",
      {
        manifestHash: input.manifest.manifestHash,
        observedAt,
        status: "unavailable"
      }
    );
    let courseShellDetected = false;
    let visibleCardCount = 0;
    try {
      const readiness = await this.#dependencies.inspectReadiness({
        targetInput: input.manifest.canonicalUrl,
        observedAt
      });
      uiStatus = readiness.receipt.status;
      uiEvidenceHash = readiness.evidenceHash;
      courseShellDetected =
        readiness.receipt.courseShellDetected;
      visibleCardCount = readiness.receipt.visibleCardCount;
    } catch {
      incrementCode(failureCodeCounts, "ui_readiness_failed");
    }

    const courseKey = deriveAutonomyCourseKey({
      secret: input.secret,
      courseRef: input.manifest.courseId
    });
    const structureFactsByKey = new Map<
      string,
      CourseStructureFact
    >();
    const addStructureFact = (fact: CourseStructureFact) => {
      const existing = structureFactsByKey.get(fact.factKey);
      if (
        existing &&
        JSON.stringify(existing) !== JSON.stringify(fact)
      ) {
        throw new Error("COURSE_STRUCTURE_FACT_KEY_CONFLICT");
      }
      structureFactsByKey.set(fact.factKey, fact);
    };
    addStructureFact(
      createCourseStructureNodeFact({
        courseKey,
        subjectKey: courseKey,
        subjectKind: "course",
        revisionHash: input.manifest.manifestHash,
        attributes: {
          source: "course_manifest"
        }
      })
    );
    const token = await this.#dependencies
      .getToken()
      .catch(() => null);
    const operatorIdentities = new Map<
      string,
      OperatorIdentityObservation
    >();
    const sourcePriority: Record<OperatorIdentitySource, number> = {
      course_member: 1,
      post_author: 2,
      reply_author: 3
    };
    const recordOperatorIdentity = (identity: {
      platformAccountId?: string | null;
      displayName?: string | null;
      memberType?: CmoocCourseMemberType | null;
      source: OperatorIdentitySource;
    }) => {
      const platformAccountId = String(
        identity.platformAccountId ?? ""
      ).trim();
      const displayName = Array.from(
        String(identity.displayName ?? "")
          .replace(/\s+/gu, " ")
          .trim()
      ).slice(0, 120).join("");
      if (
        !platformAccountId ||
        !displayName ||
        displayName === "真实论坛用户"
      ) {
        return;
      }
      const actorKey = deriveAutonomyActorKey({
        secret: input.secret,
        courseRef: input.manifest.courseId,
        actorRef: platformAccountId
      });
      const existing = operatorIdentities.get(actorKey);
      const source =
        existing &&
        sourcePriority[existing.source] > sourcePriority[identity.source]
          ? existing.source
          : identity.source;
      operatorIdentities.set(actorKey, Object.freeze({
        actorKey,
        platformAccountId,
        displayName:
          source === identity.source
            ? displayName
            : existing?.displayName ?? displayName,
        memberType:
          identity.memberType ?? existing?.memberType ?? null,
        source
      }));
    };
    const roleByActorKey = new Map<
      string,
      CmoocCourseMemberType
    >();
    let roleRegistryStatus:
      CourseScanCoverage["roleRegistryStatus"] = "unavailable";
    let roleRegistrySnapshotHash: string | null = null;
    try {
      const members = await this.#dependencies.fetchMembers({
        courseId: input.manifest.courseId,
        token
      });
      for (const member of members) {
        const actorKey = deriveAutonomyActorKey({
          secret: input.secret,
          courseRef: input.manifest.courseId,
          actorRef: member.actorPlatformId
        });
        roleByActorKey.set(actorKey, member.memberType);
        recordOperatorIdentity({
          platformAccountId: member.actorPlatformId,
          displayName: member.displayName,
          memberType: member.memberType,
          source: "course_member"
        });
      }
      roleRegistryStatus = "complete";
      roleRegistrySnapshotHash = canonicalProtocolHash(
        "cmooc.course-role-registry-snapshot.v1",
        {
          schemaVersion:
            "cmooc.course-role-registry-snapshot.v1",
          observedAt,
          entries: [...roleByActorKey]
            .map(([actorKey, memberType]) => ({
              actorKey,
              memberType
            }))
            .sort(
              (left, right) =>
                left.actorKey.localeCompare(right.actorKey) ||
                left.memberType.localeCompare(right.memberType)
            ),
          containsForumText: false
        } as unknown as CanonicalJsonValue
      );
    } catch {
      incrementCode(
        failureCodeCounts,
        "role_registry_unavailable"
      );
    }
    for (const [actorKey, memberType] of roleByActorKey) {
      addStructureFact(
        createCourseStructureNodeFact({
          courseKey,
          subjectKey: actorKey,
          subjectKind: "actor",
          revisionHash: deriveCourseGraphRevisionHash({
            secret: input.secret,
            courseRef: input.manifest.courseId,
            scope: "actor_role",
            versionMaterial: `${actorKey}\0${memberType}`
          }),
          occurredAt: observedAt,
          attributes: {
            role: memberType.toLocaleLowerCase("en-US"),
            source: "course_role_registry"
          }
        })
      );
    }
    const columns = await this.#dependencies.fetchColumns({
      courseId: input.manifest.courseId,
      token
    });
    if (columns.length === 0) {
      throw new Error("COURSE_SCAN_NO_EXPLICIT_COLUMNS");
    }
    const columnKeys = new Map<string, string>();
    for (let index = 0; index < columns.length; index += 1) {
      const column = columns[index];
      const columnKey = deriveCourseGraphNodeKey({
        secret: input.secret,
        courseRef: input.manifest.courseId,
        kind: "column",
        sourceRef: column.columnId
      });
      columnKeys.set(column.columnId, columnKey);
      const columnRevisionHash =
        deriveCourseGraphRevisionHash({
          secret: input.secret,
          courseRef: input.manifest.courseId,
          scope: "course_column",
          versionMaterial: [
            column.columnId,
            column.columnName,
            column.columnType,
            column.innerType,
            String(column.columnSort),
            column.guidanceCaption ?? ""
          ].join("\0")
        });
      const ordinal =
        Number.isSafeInteger(column.columnSort) &&
        column.columnSort >= 0
          ? column.columnSort
          : index;
      addStructureFact(
        createCourseStructureNodeFact({
          courseKey,
          subjectKey: columnKey,
          subjectKind: "column",
          revisionHash: columnRevisionHash,
          ordinal,
          attributes: {
            guidance_present:
              Boolean(column.guidanceCaption?.trim()),
            source: "course_columns"
          }
        })
      );
      addStructureFact(
        createCourseStructureEdgeFact({
          courseKey,
          sourceKey: courseKey,
          sourceKind: "course",
          targetKey: columnKey,
          targetKind: "column",
          kind: "contains",
          revisionHash: columnRevisionHash,
          ordinal,
          attributes: {
            evidence_count: 1,
            source: "course_columns",
            weight: 1
          }
        })
      );
    }
    const topicScopeKeys = columns.map((column) =>
      canonicalProtocolHash(
        "cmooc.course-column-scope.v1",
        {
          manifestHash: input.manifest.manifestHash,
          columnRefHash: canonicalProtocolHash(
            "cmooc.column-ref.v1",
            column.columnId
          )
        }
      )
    );
    if (
      topicScopeKeys.every((scopeKey) =>
        scanCursor.completedTopicScopes.includes(scopeKey)
      )
    ) {
      for (const scopeKey of topicScopeKeys) {
        delete scanCursor.scopeCursors[scopeKey];
        delete scanCursor.observedByScope[scopeKey];
      }
      scanCursor.completedTopicScopes = [];
      await emitProgress();
    }
    const uniquePosts = new Map<
      string,
      CmoocApiScannedPost
    >();
    const threadColumnKeys = new Map<
      string,
      Set<string>
    >();
    const topicPagination: CourseScanPaginationReceipt[] = [];
    const commentPagination: CourseScanPaginationReceipt[] = [];
    let pageRequestCount = 0;
    let truncatedThreadListing = false;
    let completedColumns = 0;
    for (
      let columnIndex = 0;
      columnIndex < columns.length;
      columnIndex += 1
    ) {
      const column = columns[columnIndex];
      const remaining =
        input.manifest.scan.maxThreadsPerTick - uniquePosts.size;
      const pageSize = Math.min(
        input.manifest.scan.pageSize,
        Math.max(1, remaining)
      );
      const scopeKey = topicScopeKeys[columnIndex];
      const firstPageCursor = createCmoocTopicPageCursor({
        forumListUrl: input.manifest.canonicalUrl,
        expectedCourseId: input.manifest.courseId,
        columnId: column.columnId,
        pageSize
      });
      if (
        scanCursor.completedTopicScopes.includes(scopeKey)
      ) {
        completedColumns += 1;
        topicPagination.push({
          scopeKey,
          expected: null,
          observed:
            scanCursor.observedByScope[scopeKey] ?? 0,
          nextCursor: null,
          truncation: false,
          failure: null,
          pageRequestCount: 0,
          containsForumText: false
        });
        continue;
      }
      const initialCursor =
        scanCursor.scopeCursors[scopeKey] ?? firstPageCursor;
      if (!scanCursor.scopeCursors[scopeKey]) {
        scanCursor.observedByScope[scopeKey] = 0;
      }
      const observedBefore =
        scanCursor.observedByScope[scopeKey] ?? 0;
      if (remaining <= 0) {
        truncatedThreadListing = true;
        topicPagination.push({
          scopeKey,
          expected: null,
          observed: 0,
          nextCursor: initialCursor,
          truncation: true,
          failure: null,
          pageRequestCount: 0,
          containsForumText: false
        });
        continue;
      }
      const collected = await collectCmoocPages({
        initialCursor,
        maxItems: remaining,
        observedBefore,
        itemKey: (post: CmoocApiScannedPost) =>
          cmoocStableThreadRef(post.url),
        fetchPage: (cursor) =>
          this.#dependencies.fetchTopicPage({
            forumListUrl: input.manifest.canonicalUrl,
            expectedCourseId: input.manifest.courseId,
            pageSize,
            cursor,
            token,
            columnId: column.columnId,
            columnName: column.columnName
          }),
          classifyFailure: (error) =>
            errorCode(error, "topic_page_failed", "topic"),
        onCheckpoint: (checkpoint) =>
          checkpointScope({
            scopeKey,
            nextCursor: checkpoint.nextCursor,
            observedAdded: checkpoint.observedAdded
          })
      });
      const paginationReceipt: CourseScanPaginationReceipt = {
        scopeKey,
        ...collected.receipt,
        observed:
          scanCursor.observedByScope[scopeKey] ??
          collected.receipt.observed
      };
      topicPagination.push(paginationReceipt);
      pageRequestCount += paginationReceipt.pageRequestCount;
      truncatedThreadListing ||= paginationReceipt.truncation;
      if (paginationReceipt.failure) {
        incrementCode(
          failureCodeCounts,
          paginationReceipt.failure
        );
      }
      for (const post of collected.items) {
        const ref = cmoocStableThreadRef(post.url);
        const memberships =
          threadColumnKeys.get(ref) ?? new Set<string>();
        const columnKey = columnKeys.get(column.columnId);
        if (!columnKey) {
          throw new Error("COURSE_COLUMN_KEY_MISSING");
        }
        memberships.add(columnKey);
        threadColumnKeys.set(ref, memberships);
        if (!uniquePosts.has(ref)) {
          uniquePosts.set(ref, post);
        }
      }
      if (
        !paginationReceipt.truncation &&
        paginationReceipt.failure === null
      ) {
        completedColumns += 1;
        await checkpointScope({
          scopeKey,
          nextCursor: null,
          observedAdded: 0,
          completedTopic: true
        });
      } else {
        if (paginationReceipt.nextCursor) {
          scanCursor.scopeCursors[scopeKey] =
            paginationReceipt.nextCursor;
        }
        await emitProgress();
      }
    }

    const threads: ObservedThreadBundle[] = [];
    let incompleteCommentThreadCount = 0;
    let commentCompanion: CmoocBrowserCommentCompanion | null = null;
    let commentCompanionUnavailable: Error | null = null;
    let commentCompanionOpenFailureCount = 0;
    let commentCompanionSessionRestartCount = 0;
    const requireCommentCompanion = async () => {
      if (commentCompanion) return commentCompanion;
      if (commentCompanionUnavailable) {
        throw commentCompanionUnavailable;
      }
      try {
        commentCompanion =
          await this.#dependencies.openCommentCompanion({
            allowedOrigin: new URL(
              input.manifest.canonicalUrl
            ).origin,
            timeoutMs: 30_000,
            browserChannel:
              commentCompanionSessionRestartCount > 0 ||
              commentCompanionOpenFailureCount > 0
                ? "system_chrome"
                : "bundled_chromium"
          });
        return commentCompanion;
      } catch (reason) {
        const failure =
          reason instanceof Error
            ? reason
            : new Error(
                "CMOOC_BROWSER_COMMENT_COMPANION_UNAVAILABLE"
              );
        commentCompanionOpenFailureCount += 1;
        const classification =
          classifyCmoocCommentCompanionFailure(failure);
        if (
          !classification.retryable ||
          commentCompanionOpenFailureCount >= 2
        ) {
          commentCompanionUnavailable = failure;
        }
        throw failure;
      }
    };
    try {
    for (const [threadRef, post] of uniquePosts) {
      const commentPageSize = Math.min(
        10,
        input.manifest.scan.pageSize,
        input.manifest.scan.maxCommentsPerThread
      );
      // Keep every thread independently bounded. A position mismatch on one
      // thread must not suppress pagination on otherwise independent threads,
      // while the manifest's per-thread comment limit still prevents an
      // unbounded sequence of page requests.
      const commentPageRequestLimit = Math.max(
        1,
        input.manifest.scan.maxCommentsPerThread
      );
      const firstCommentCursor = createCmoocCommentPageCursor({
          postUrl: post.url,
          expectedCourseId: input.manifest.courseId,
          pageSize: commentPageSize
        });
      const commentScopeKey = canonicalProtocolHash(
        "cmooc.comment-pagination-scope.v1",
        {
          manifestHash: input.manifest.manifestHash,
          threadRefHash: canonicalProtocolHash(
            "cmooc.thread-ref.v1",
            threadRef
          )
        }
      );
      // A recovered comment scan always rebuilds a complete prefix from page
      // one. Persisted offsets alone cannot prove cross-run uniqueness or
      // resolve a child whose parent lived on an earlier page.
      const initialCommentCursor = firstCommentCursor;
      scanCursor.observedByScope[commentScopeKey] = 0;
      const commentsObservedBefore = 0;
      let stagedCommentReceipt:
        | CourseScanPaginationReceipt
        | null = null;
      const stagedSecondaryFailureCodes = new Set<string>();
      let incompleteRecorded = false;
      try {
        const detail = await this.#dependencies.fetchPostCore({
          postUrl: post.url,
          token,
          expectedCourseId: input.manifest.courseId
        });
        if (!detail) {
          throw new Error("THREAD_DETAIL_NOT_FOUND");
        }
        if (
          detail.courseId &&
          detail.courseId !== input.manifest.courseId
        ) {
          throw new Error("CMOOC_COURSE_REF_MISMATCH");
        }
        let collectedComments = await collectCmoocPages({
          initialCursor: initialCommentCursor,
          maxItems:
            input.manifest.scan.maxCommentsPerThread,
          maxPageRequests: commentPageRequestLimit,
          observedBefore: commentsObservedBefore,
          itemKey: (comment: CmoocApiComment) => comment.id,
          fetchPage: (cursor) =>
            this.#dependencies.fetchCommentPage({
              postUrl: post.url,
              expectedCourseId: input.manifest.courseId,
              pageSize: commentPageSize,
              cursor,
              token,
              preserveStructuralTombstones: true
            }),
          classifyFailure: (error) =>
            errorCode(error, "comment_page_failed", "comment"),
          onCheckpoint: (checkpoint) =>
            checkpointScope({
              scopeKey: commentScopeKey,
              nextCursor: checkpoint.nextCursor,
              observedAdded: checkpoint.observedAdded
            })
        });
        const apiCommentPageRequestCount =
          collectedComments.receipt.pageRequestCount;
        let commentTransport:
          | "cmooc_api_current"
          | "ui_native_infinite_scroll" =
          "cmooc_api_current";
        let companionReceipt:
          | CmoocBrowserCommentCompanionReceipt
          | undefined;
        let companionAttemptCount = 0;
        let companionFailedAttemptCount = 0;
        const companionFailureCodes: string[] = [];
        if (
          collectedComments.receipt.failure ===
          "comment_pagination_position_ignored"
        ) {
          for (let attempt = 1; attempt <= 2; attempt += 1) {
            companionAttemptCount = attempt;
            let attemptedCompanion:
              | CmoocBrowserCommentCompanion
              | null = null;
            try {
              const companion = await requireCommentCompanion();
              attemptedCompanion = companion;
              const recovered = await companion.readThread({
                postUrl: post.url,
                expectedCourseId: input.manifest.courseId,
                maxComments:
                  input.manifest.scan.maxCommentsPerThread
              });
              companionReceipt = recovered.receipt;
              commentTransport = "ui_native_infinite_scroll";
              collectedComments = {
                items: recovered.items,
                receipt: {
                  expected:
                    recovered.receipt.expectedRootComments,
                  observed:
                    recovered.receipt.observedRootComments,
                  nextCursor: null,
                  truncation: false,
                  failure: null,
                  pageRequestCount:
                    apiCommentPageRequestCount +
                    recovered.receipt.pageRequestCount,
                  containsForumText: false
                }
              };
              incrementCode(
                recoveryCodeCounts,
                "comment_browser_companion_recovered"
              );
              if (companionFailedAttemptCount > 0) {
                incrementCode(
                  recoveryCodeCounts,
                  "comment_browser_companion_retry_recovered"
                );
              }
              break;
            } catch (error) {
              companionFailedAttemptCount += 1;
              const classification =
                classifyCmoocCommentCompanionFailure(error);
              companionFailureCodes.push(classification.code);
              if (
                classification.code ===
                "browser_session_closed"
              ) {
                const closedCompanion = attemptedCompanion;
                commentCompanion = null;
                await closedCompanion
                  ?.close()
                  .catch(() => undefined);
                if (
                  commentCompanionSessionRestartCount >= 1
                ) {
                  commentCompanionUnavailable =
                    error instanceof Error
                      ? error
                      : new Error(
                          "CMOOC_BROWSER_COMMENT_COMPANION_BROWSER_SESSION_CLOSED"
                        );
                } else {
                  commentCompanionSessionRestartCount += 1;
                }
              }
              if (
                attempt === 1 &&
                classification.retryable &&
                commentCompanionUnavailable === null
              ) {
                continue;
              }
              stagedSecondaryFailureCodes.add(
                "comment_browser_companion_failed"
              );
              break;
            }
          }
        }
        const expectedCommentCount =
          collectedComments.receipt.expected ??
          detail.commentCount ??
          post.commentCount ??
          null;
        const observedRootCommentCount =
          collectedComments.items.filter(
            (comment) => (comment.depth ?? 0) === 0
          ).length;
        scanCursor.observedByScope[commentScopeKey] =
          observedRootCommentCount;
        let commentFailure =
          collectedComments.receipt.failure;
        let commentTruncation =
          collectedComments.receipt.truncation;
        const structuralTombstoneCount =
          collectedComments.items.filter(
            (comment) =>
              comment.contentStatus === "empty_or_deleted"
          ).length;
        if (structuralTombstoneCount > 0) {
          stagedSecondaryFailureCodes.add(
            "comment_content_censored"
          );
          commentFailure ??= "comment_content_censored";
          commentTruncation = true;
        }
        if (
          expectedCommentCount !== null &&
          observedRootCommentCount < expectedCommentCount &&
          collectedComments.receipt.nextCursor === null
        ) {
          commentFailure ??= "comment_count_mismatch";
          commentTruncation = true;
        }
        const commentReceipt: CourseScanPaginationReceipt = {
          scopeKey: commentScopeKey,
          ...collectedComments.receipt,
          observed: observedRootCommentCount,
          countDomain: "root_comments",
          observedEventCount: collectedComments.items.length,
          expected: expectedCommentCount,
          nextCursor:
            commentFailure === "comment_count_mismatch" ||
            commentFailure ===
              "comment_pagination_position_ignored"
              ? firstCommentCursor
              : collectedComments.receipt.nextCursor,
          truncation: commentTruncation,
          failure: commentFailure,
          transport: commentTransport,
          apiPageRequestCount: apiCommentPageRequestCount,
          ...(companionAttemptCount > 0
            ? {
                companionAttemptCount,
                companionFailedAttemptCount,
                ...(companionFailureCodes.length > 0
                  ? {
                      companionFailureCodes: [
                        ...companionFailureCodes
                      ]
                    }
                  : {})
              }
            : {}),
          ...(companionReceipt
            ? { companionReceipt }
            : {})
        };
        stagedCommentReceipt = commentReceipt;
        pageRequestCount += commentReceipt.pageRequestCount;
        if (commentReceipt.nextCursor) {
          scanCursor.scopeCursors[commentScopeKey] =
            commentReceipt.nextCursor;
        } else {
          delete scanCursor.scopeCursors[commentScopeKey];
        }
        if (
          commentFailure === "comment_count_mismatch" ||
          commentFailure ===
            "comment_pagination_position_ignored"
        ) {
          scanCursor.observedByScope[commentScopeKey] = 0;
        }
        await emitProgress();
        const completeComments =
          !commentReceipt.truncation &&
          commentReceipt.failure === null &&
          structuralTombstoneCount === 0 &&
          (commentReceipt.expected === null ||
            commentReceipt.observed >= commentReceipt.expected);
        if (!completeComments) {
          incompleteCommentThreadCount += 1;
          incompleteRecorded = true;
        }
        const rootPlatformAccountId =
          detail.authorPlatformId ?? post.authorPlatformId ?? null;
        if (rootPlatformAccountId) {
          const rootActorKey = deriveAutonomyActorKey({
            secret: input.secret,
            courseRef: input.manifest.courseId,
            actorRef: rootPlatformAccountId
          });
          recordOperatorIdentity({
            platformAccountId: rootPlatformAccountId,
            displayName: detail.authorName || post.authorName || null,
            memberType: roleByActorKey.get(rootActorKey) ?? null,
            source: "post_author"
          });
        }
        for (const comment of collectedComments.items) {
          if (!comment.authorPlatformId) continue;
          const commentActorKey = deriveAutonomyActorKey({
            secret: input.secret,
            courseRef: input.manifest.courseId,
            actorRef: comment.authorPlatformId
          });
          recordOperatorIdentity({
            platformAccountId: comment.authorPlatformId,
            displayName: comment.authorName,
            memberType: roleByActorKey.get(commentActorKey) ?? null,
            source: "reply_author"
          });
        }
        const normalized = normalizeObservedThread({
          courseAlias: input.manifest.alias,
          secret: input.secret,
          maxComments:
            input.manifest.scan.maxCommentsPerThread,
          thread: {
            courseRef: input.manifest.courseId,
            threadRef,
            authorRef:
              detail.authorPlatformId ??
              post.authorPlatformId ??
              null,
            occurredAt:
              post.createdTime ?? detail.editedAt,
            observedAt,
            versionMaterial: [
              detail.title,
              detail.content,
              detail.editedAt
            ].join("\0"),
            comments: collectedComments.items.map((comment) => ({
              eventRef: comment.id,
              actorRef: comment.authorPlatformId ?? null,
              parentEventRef: comment.parentId ?? threadRef,
              depth: comment.depth ?? 0,
              occurredAt: comment.time,
              versionMaterial:
                comment.contentStatus === "empty_or_deleted"
                  ? ["empty_or_deleted", comment.time].join("\0")
                  : [comment.content, comment.time].join("\0")
            }))
          }
        });
        const rootEvent = normalized.events.find(
          (event) => event.kind === "thread_root"
        );
        if (!rootEvent) {
          throw new Error("COURSE_THREAD_ROOT_EVENT_MISSING");
        }
        addStructureFact(
          createCourseStructureNodeFact({
            courseKey,
            subjectKey: normalized.threadKey,
            subjectKind: "thread",
            revisionHash: normalized.targetVersionHash,
            occurredAt: rootEvent.occurredAt,
            attributes: {
              comment_coverage: completeComments
                ? "complete"
                : "censored",
              source:
                commentTransport ===
                "ui_native_infinite_scroll"
                  ? "cmooc_api_plus_ui_native_infinite_scroll"
                  : "cmooc_api"
            }
          })
        );
        for (
          const columnKey of threadColumnKeys.get(threadRef) ??
          []
        ) {
          addStructureFact(
            createCourseStructureEdgeFact({
              courseKey,
              sourceKey: columnKey,
              sourceKind: "column",
              targetKey: normalized.threadKey,
              targetKind: "thread",
              kind: "contains",
              revisionHash: deriveCourseGraphRevisionHash({
                secret: input.secret,
                courseRef: input.manifest.courseId,
                scope: "column_thread_membership",
                versionMaterial: [
                  columnKey,
                  normalized.threadKey,
                  normalized.targetVersionHash
                ].join("\0")
              }),
              occurredAt: rootEvent.occurredAt,
              attributes: {
                evidence_count: 1,
                source: "course_columns",
                weight: 1
              }
            })
          );
        }
        const semanticTexts = [
          detail.title,
          detail.content,
          ...detail.tags
        ];
        for (
          const signal of extractControlledConceptSignals(
            semanticTexts
          )
        ) {
          const conceptKey = deriveCourseGraphNodeKey({
            secret: input.secret,
            courseRef: input.manifest.courseId,
            kind: "concept",
            sourceRef: signal.conceptId
          });
          const conceptRevisionHash =
            deriveCourseGraphRevisionHash({
              secret: input.secret,
              courseRef: input.manifest.courseId,
              scope: "controlled_concept",
              versionMaterial: [
                signal.conceptId,
                signal.taxonomyVersion
              ].join("\0")
            });
          addStructureFact(
            createCourseStructureNodeFact({
              courseKey,
              subjectKey: conceptKey,
              subjectKind: "concept",
              revisionHash: conceptRevisionHash,
              attributes: {
                label_key: signal.conceptId,
                source: "controlled_taxonomy",
                taxonomy_version:
                  CONTROLLED_COURSE_CONCEPT_TAXONOMY_VERSION
              }
            })
          );
          addStructureFact(
            createCourseStructureEdgeFact({
              courseKey,
              sourceKey: normalized.threadKey,
              sourceKind: "thread",
              targetKey: conceptKey,
              targetKind: "concept",
              kind: "discusses",
              revisionHash: deriveCourseGraphRevisionHash({
                secret: input.secret,
                courseRef: input.manifest.courseId,
                scope: "thread_controlled_concept",
                versionMaterial: [
                  normalized.targetVersionHash,
                  signal.conceptId,
                  String(signal.occurrenceCount)
                ].join("\0")
              }),
              occurredAt: rootEvent.occurredAt,
              attributes: {
                evidence_count: signal.occurrenceCount,
                occurrence_count: signal.occurrenceCount,
                source: "controlled_taxonomy",
                weight: signal.occurrenceCount
              }
            })
          );
        }
        for (
          const signal of extractHashedResourceSignals({
            secret: input.secret,
            courseRef: input.manifest.courseId,
            texts: semanticTexts
          })
        ) {
          addStructureFact(
            createCourseStructureNodeFact({
              courseKey,
              subjectKey: signal.resourceKey,
              subjectKind: "resource",
              revisionHash: signal.resourceKey,
              attributes: {
                resource_kind: signal.resourceKind,
                source: "root_content_link"
              }
            })
          );
          addStructureFact(
            createCourseStructureEdgeFact({
              courseKey,
              sourceKey: normalized.threadKey,
              sourceKind: "thread",
              targetKey: signal.resourceKey,
              targetKind: "resource",
              kind: "references_resource",
              revisionHash: deriveCourseGraphRevisionHash({
                secret: input.secret,
                courseRef: input.manifest.courseId,
                scope: "thread_resource_reference",
                versionMaterial: [
                  normalized.targetVersionHash,
                  signal.resourceKey,
                  String(signal.occurrenceCount)
                ].join("\0")
              }),
              occurredAt: rootEvent.occurredAt,
              attributes: {
                evidence_count: signal.occurrenceCount,
                occurrence_count: signal.occurrenceCount,
                source: "root_content_link",
                weight: signal.occurrenceCount
              }
            })
          );
        }
        const kernel = buildKernelObservation({
          manifest: input.manifest,
          baselineEvidenceHash: uiEvidenceHash,
          courseShellDetected,
          categoryCount: columns.length,
          visibleCardCount,
          thread: normalized,
          observedAt,
          completeComments,
          secret: input.secret,
          roleByActorKey
        });
        const semanticReviewReady =
          kernel.receipt.safeToAdvanceToSemanticReview;
        if (!kernel.receipt.eventSetHash) {
          throw new Error("SEMANTIC_EVIDENCE_EVENT_SET_MISSING");
        }
        const sequenceCompletion =
          kernel.receipt.eventEvidence.some(
            (event) =>
              event.parentEventKey !== null &&
              (event.actorRelation === "external_human" ||
                event.actorRelation === "thread_author" ||
                event.actorRelation === "system_or_agent")
          )
            ? ("socially_complete" as const)
            : kernel.receipt.eventEvidence.some(
                  (event) => event.actorRelation === "unknown"
                )
              ? ("unknown" as const)
              : ("open" as const);
        const semanticEvidence = semanticReviewReady
          ? analyzeTransientSemanticEvidence({
              observationReceiptHash: kernel.receiptHash,
              targetVersionHash: normalized.targetVersionHash,
              eventSetHash: kernel.receipt.eventSetHash,
              observedAt,
              texts: semanticTexts,
              sequenceCompletion
            })
          : undefined;
        threads.push({
          threadKey: normalized.threadKey,
          authorKey: normalized.authorKey,
          targetVersionHash: normalized.targetVersionHash,
          events: normalized.events,
          kernelObservation: kernel.receipt,
          kernelObservationHash: kernel.receiptHash,
          ...(semanticEvidence
            ? {
                semanticEvidence: semanticEvidence.receipt,
                semanticEvidenceHash: semanticEvidence.receiptHash
              }
            : {})
        });
        commentPagination.push(commentReceipt);
        if (commentReceipt.failure) {
          incrementCode(
            failureCodeCounts,
            commentReceipt.failure
          );
        }
        for (const failureCode of stagedSecondaryFailureCodes) {
          if (failureCode !== commentReceipt.failure) {
            incrementCode(failureCodeCounts, failureCode);
          }
        }
      } catch (error) {
        const normalizedFailure = errorCode(
          error,
          "thread_detail_failed"
        );
        const primaryFailure =
          normalizedFailure !== "thread_detail_failed"
            ? normalizedFailure
            : stagedCommentReceipt?.failure ??
              normalizedFailure;
        const failedReceipt: CourseScanPaginationReceipt =
          stagedCommentReceipt
            ? {
                ...stagedCommentReceipt,
                nextCursor:
                  stagedCommentReceipt.nextCursor ??
                  initialCommentCursor,
                truncation: true,
                failure: primaryFailure
              }
            : {
                scopeKey: commentScopeKey,
                expected: post.commentCount ?? null,
                observed: 0,
                nextCursor: initialCommentCursor,
                truncation: true,
                failure: primaryFailure,
                pageRequestCount: 0,
                containsForumText: false
              };
        commentPagination.push(failedReceipt);
        const failureCodes = new Set([
          normalizedFailure,
          failedReceipt.failure,
          ...stagedSecondaryFailureCodes
        ]);
        for (const failureCode of failureCodes) {
          if (failureCode) {
            incrementCode(failureCodeCounts, failureCode);
          }
        }
        if (!incompleteRecorded) {
          incompleteCommentThreadCount += 1;
        }
        scanCursor.scopeCursors[commentScopeKey] =
          failedReceipt.nextCursor ?? initialCommentCursor;
        await emitProgress();
      }
    }
    } finally {
      await (
        commentCompanion as CmoocBrowserCommentCompanion | null
      )?.close().catch(() => undefined);
    }
    try {
      await this.#dependencies.recordOperatorIdentities({
        courseAlias: input.manifest.alias,
        courseRef: input.manifest.courseId,
        observedAt,
        identities: [...operatorIdentities.values()].sort((left, right) =>
          left.actorKey.localeCompare(right.actorKey)
        )
      });
    } catch {
      incrementCode(
        failureCodeCounts,
        "operator_identity_sync_failed"
      );
    }
    const observedEventCount = threads.reduce(
      (sum, thread) => sum + thread.events.length,
      0
    );
    const failedTargetCount =
      uniquePosts.size - threads.length;
    const complete =
      uiStatus === "overview_ready" &&
      completedColumns === columns.length &&
      !truncatedThreadListing &&
      incompleteCommentThreadCount === 0 &&
      failedTargetCount === 0;
    const topicExpected =
      topicPagination.every(
        (receipt) => receipt.expected !== null
      )
        ? topicPagination.reduce(
            (sum, receipt) => sum + (receipt.expected ?? 0),
            0
          )
        : null;
    const commentExpected =
      commentPagination.every(
        (receipt) => receipt.expected !== null
      )
        ? commentPagination.reduce(
            (sum, receipt) => sum + (receipt.expected ?? 0),
            0
          )
        : null;
    const paginationReceipts = [
      ...topicPagination,
      ...commentPagination
    ];
    const firstIncompleteColumn = topicPagination.find(
      (receipt) =>
        receipt.truncation || receipt.failure !== null
    );
    const columnPagination: CourseScanPaginationReceipt = {
      scopeKey: canonicalProtocolHash(
        "cmooc.course-columns-scope.v1",
        input.manifest.manifestHash
      ),
      expected: columns.length,
      observed: completedColumns,
      nextCursor:
        firstIncompleteColumn?.nextCursor ?? null,
      truncation: completedColumns < columns.length,
      failure: firstIncompleteColumn?.failure ?? null,
      pageRequestCount: 1,
      containsForumText: false
    };
    const coverage: CourseScanCoverage = {
      schemaVersion: COURSE_SCAN_COVERAGE_SCHEMA_VERSION,
      observedAt,
      sourceKind: "cmooc_api_plus_read_only_browser",
      apiReadAuthStatus: token ? "authenticated" : "anonymous",
      uiStatus,
      uiEvidenceHash,
      courseShellDetected,
      categoryCount: columns.length,
      categoryCompletedCount: completedColumns,
      pageRequestCount,
      discoveredThreadCount: uniquePosts.size,
      attemptedDetailCount: uniquePosts.size,
      completedDetailCount: threads.length,
      failedTargetCount,
      observedEventCount,
      truncatedThreadListing,
      incompleteCommentThreadCount,
      complete,
      failureCodeCounts,
      recoveryCodeCounts,
      roleRegistryStatus,
      roleRegistryMemberCount: roleByActorKey.size,
      roleRegistrySnapshotHash,
      expectedThreadCount: topicExpected,
      expectedCommentCount: commentExpected,
      nextCursor:
        paginationReceipts.find(
          (receipt) => receipt.nextCursor !== null
        )?.nextCursor ?? null,
      paginationTruncated: paginationReceipts.some(
        (receipt) => receipt.truncation
      ),
      paginationFailureCount: paginationReceipts.filter(
        (receipt) => receipt.failure !== null
      ).length,
      columnPagination,
      topicPagination,
      commentPagination,
      containsForumText: false
    };
    const coverageHash = canonicalProtocolHash(
      coverage.schemaVersion,
      coverage as unknown as CanonicalJsonValue
    );
    const structureFacts = [...structureFactsByKey.values()].sort(
      (left, right) => left.factKey.localeCompare(right.factKey)
    );
    const structureFactSetHash =
      hashCourseStructureFactSet(structureFacts);
    return {
      coverage,
      coverageHash,
      sourceReceiptHash: canonicalProtocolHash(
        "cmooc.course-scan-source-receipts.v2",
        {
          schemaVersion: "cmooc.course-scan-source-receipts.v2",
          uiEvidenceHash,
          coverageHash,
          structureFactSetHash,
          containsForumText: false
        }
      ),
      threads,
      structureFacts,
      structureFactSetHash
    };
  }
}
