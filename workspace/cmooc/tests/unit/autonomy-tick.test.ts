import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  COURSE_MANIFEST_SCHEMA_VERSION,
  COURSE_MANIFEST_TEMPLATE_SCHEMA_VERSION,
  parseCourseManifest,
  type CourseManifestTemplate
} from "../../lib/autonomy/course-manifest";
import {
  defaultInvocationTime
} from "../../lib/autonomy/invocation-store";
import {
  classifyAutonomyTickErrorCode,
  selectCandidatesForAutonomyTick
} from "../../lib/autonomy/tick";
import type { AutonomyCandidate } from "../../lib/autonomy/candidate-set";
import type { ObservedThreadBundle } from "../../lib/autonomy/platform-observer";
import {
  classifyCourseEventObservation,
  normalizeObservedThread
} from "../../lib/world/live-event";
import {
  analyzeTransientSemanticEvidence
} from "../../lib/autonomy/transient-semantic-evidence";
import {
  IncrementalLiveWorldProjector,
  projectLiveWorldIncrementally,
  projectLiveWorld
} from "../../lib/world/live-world-projector";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function markerCandidate(
  candidateKey: string,
  overrides: Partial<AutonomyCandidate> = {}
): AutonomyCandidate {
  return {
    candidateKey,
    threadKey: `thread-${candidateKey}`,
    authorKey: `author-${candidateKey}`,
    rootEventKey: `root-${candidateKey}`,
    targetVersionHash: `version-${candidateKey}`,
    contributionPublishedAt: "2026-08-01T00:00:00.000Z",
    latestEventAt: "2026-08-01T00:00:00.000Z",
    eventCount: 1,
    externalHumanCount: 0,
    authorReturnCount: 0,
    systemResponseCount: 0,
    supportGapHours: 1,
    completeness: "complete",
    sourceObservationReceiptHash: `observation-${candidateKey}`,
    ...overrides
  };
}

function markerObservation(input: {
  threadKey: string;
  commentCompleteness?: "not_observed" | "visible_only" | "complete";
  safeToAdvanceToSemanticReview?: boolean;
  authorRole?: "learner" | "creator" | "helper" | "unknown";
  authorRoleEvidenceHash?: string | null;
  authorRoleEvidenceExpiresAt?: string | null;
  semanticEvidence?: ObservedThreadBundle["semanticEvidence"];
  semanticEvidenceHash?: string;
  eventEvidence?: Array<{
    parentEventKey: string | null;
    actorKey: string | null;
  }>;
}): ObservedThreadBundle {
  return {
    threadKey: input.threadKey,
    authorKey: "marker-author",
    targetVersionHash: "marker-version",
    events: [],
    kernelObservation: {
      commentCompleteness:
        input.commentCompleteness ?? "complete",
      safeToAdvanceToSemanticReview:
        input.safeToAdvanceToSemanticReview ?? true,
      authorRole: input.authorRole ?? "learner",
      authorRoleEvidenceHash:
        input.authorRoleEvidenceHash ?? "marker-role-hash",
      authorRoleEvidenceExpiresAt:
        input.authorRoleEvidenceExpiresAt ??
        "2026-08-02T00:00:00.000Z",
      authorKey: "marker-author",
      eventEvidence: input.eventEvidence ?? []
    } as unknown as ObservedThreadBundle["kernelObservation"],
    kernelObservationHash: "marker-kernel-hash",
    semanticEvidence: input.semanticEvidence,
    semanticEvidenceHash: input.semanticEvidenceHash
  };
}

const markerReadyEvidence = {
  marker: "semantic-ready"
} as unknown as NonNullable<
  ObservedThreadBundle["semanticEvidence"]
>;

test("候选预筛优先选择无回应且证据 ready 的 learner", () => {
  const opaqueYield = markerCandidate("marker-opaque-yield", {
    externalHumanCount: 1
  });
  const readyLearner = markerCandidate("marker-ready-learner", {
    supportGapHours: 3
  });
  const candidates = [opaqueYield, readyLearner];
  const observationByThread = new Map<string, ObservedThreadBundle>([
    [
      readyLearner.threadKey,
      markerObservation({
        threadKey: readyLearner.threadKey,
        semanticEvidence: markerReadyEvidence,
        semanticEvidenceHash: "marker-semantic-hash"
      })
    ],
    [
      opaqueYield.threadKey,
      markerObservation({
        threadKey: opaqueYield.threadKey,
        safeToAdvanceToSemanticReview: false
      })
    ]
  ]);
  const selected = selectCandidatesForAutonomyTick(
    candidates,
    observationByThread,
    1
  );
  assert.deepEqual(selected.map((candidate) => candidate.candidateKey), [
    "marker-ready-learner"
  ]);
});

test("同一 tier 按 support gap、发布时间和 candidateKey 稳定排序", () => {
  const later = markerCandidate("marker-b", {
    supportGapHours: 4,
    contributionPublishedAt: "2026-08-02T00:00:00.000Z"
  });
  const earlier = markerCandidate("marker-a", {
    supportGapHours: 4,
    contributionPublishedAt: "2026-08-01T00:00:00.000Z"
  });
  const lowerGap = markerCandidate("marker-c", {
    supportGapHours: 2,
    contributionPublishedAt: "2026-08-01T00:00:00.000Z"
  });
  const observationByThread = new Map<string, ObservedThreadBundle>([
    ...[later, earlier, lowerGap].map((candidate) => [
      candidate.threadKey,
      markerObservation({
        threadKey: candidate.threadKey,
        semanticEvidence: markerReadyEvidence,
        semanticEvidenceHash: "marker-semantic-hash"
      })
    ] as const)
  ]);
  const selected = selectCandidatesForAutonomyTick(
    [lowerGap, later, earlier],
    observationByThread,
    3
  );
  assert.deepEqual(selected.map((candidate) => candidate.candidateKey), [
    "marker-a",
    "marker-b",
    "marker-c"
  ]);
});

test("没有 actionable 候选时仍返回预算上限数量", () => {
  const candidates = [
    markerCandidate("marker-c", { externalHumanCount: 1 }),
    markerCandidate("marker-a", { externalHumanCount: 1 }),
    markerCandidate("marker-b", { externalHumanCount: 1 })
  ];
  const observationByThread = new Map<string, ObservedThreadBundle>([
    ...candidates.map((candidate) => [
      candidate.threadKey,
      markerObservation({ threadKey: candidate.threadKey })
    ] as const)
  ]);
  const selected = selectCandidatesForAutonomyTick(
    candidates,
    observationByThread,
    2
  );
  assert.equal(selected.length, 2);
  assert.deepEqual(selected.map((candidate) => candidate.candidateKey), [
    "marker-a",
    "marker-b"
  ]);
});

test("候选预筛不改变输入数组顺序或内容", () => {
  const first = markerCandidate("marker-first");
  const second = markerCandidate("marker-second", {
    supportGapHours: 2
  });
  const candidates = [first, second];
  const before = JSON.stringify(candidates);
  const observationByThread = new Map<string, ObservedThreadBundle>([
    [
      first.threadKey,
      markerObservation({
        threadKey: first.threadKey,
        semanticEvidence: markerReadyEvidence,
        semanticEvidenceHash: "marker-semantic-hash"
      })
    ],
    [
      second.threadKey,
      markerObservation({
        threadKey: second.threadKey,
        semanticEvidence: markerReadyEvidence,
        semanticEvidenceHash: "marker-semantic-hash"
      })
    ]
  ]);
  selectCandidatesForAutonomyTick(candidates, observationByThread, 2);
  assert.equal(JSON.stringify(candidates), before);
  assert.deepEqual(candidates.map((candidate) => candidate.candidateKey), [
    "marker-first",
    "marker-second"
  ]);
});

test("顶层读取鉴权失败统一映射为去正文原因码", () => {
  for (const error of [
    new Error("CMOOC_READ_AUTH_UNAVAILABLE"),
    new Error("cMOOC API 请求失败：401"),
    new Error("Forbidden (403)"),
    new Error("cMOOC API 登录态已失效"),
    new Error("token expired")
  ]) {
    assert.equal(
      classifyAutonomyTickErrorCode(error),
      "read_auth_unavailable"
    );
  }
  assert.equal(
    classifyAutonomyTickErrorCode(
      new Error("sensitive body that must not escape")
    ),
    "tick_failed"
  );
});

test("课程读取连接被重置时映射为稳定传输原因码", () => {
  const transportError = new TypeError("fetch failed", {
    cause: Object.assign(new Error("socket closed"), {
      code: "ECONNRESET"
    })
  });

  assert.equal(
    classifyAutonomyTickErrorCode(transportError),
    "read_transport_unavailable"
  );
});

function fixtureManifest(
  courseId = "1234567890",
  expectedCourseId = "1234567890"
) {
  const template: CourseManifestTemplate = {
    schemaVersion:
      COURSE_MANIFEST_TEMPLATE_SCHEMA_VERSION,
    alias: "test-course",
    platformId: "cmooc.bnu",
    courseIdSha256: sha256(expectedCourseId),
    canonicalOrigin: "https://cmooc.example.test",
    canonicalPath: "/cMOOC/course",
    timeZone: "Asia/Shanghai",
    defaultMode: "SHADOW",
    policyVersion: "test.shadow.v1",
    realPublishEnabled: false
  };
  return parseCourseManifest({
    template,
    sourcePath: "C:\\tmp\\test-course-course.json",
    value: {
      schemaVersion: COURSE_MANIFEST_SCHEMA_VERSION,
      alias: "test-course",
      platformId: "cmooc.bnu",
      courseId,
      canonicalUrl:
        `https://cmooc.example.test/cMOOC/course?courseId=${courseId}&isBack=1`,
      allowedOrigins: ["https://cmooc.example.test"],
      adapterId: "test.adapter.v1",
      timeZone: "Asia/Shanghai",
      defaultMode: "SHADOW",
      policyVersion: "test.shadow.v1",
      scan: {
        maxThreadsPerTick: 20,
        maxCommentsPerThread: 500,
        pageSize: 50
      },
      budget: {
        dailySlots: 3,
        workloadCost: 1,
        authorTouchLimit30d: 2
      },
      schedule: {
        intervalMinutes: 30,
        leaseSeconds: 120
      },
      realPublishEnabled: false
    }
  });
}

test("CourseManifest 精确绑定课程标识且 AUTO/STAGE 不由裸配置放行", () => {
  const manifest = fixtureManifest();
  assert.equal(manifest.alias, "test-course");
  assert.equal(manifest.realPublishEnabled, false);
  assert.match(manifest.manifestHash, /^[a-f0-9]{64}$/);

  assert.throws(
    () => fixtureManifest("9876543210"),
    /精确课程标识/
  );
});

test("未显式传入 scheduled-for 时按课程 cadence 折叠重复唤醒", () => {
  assert.equal(
    defaultInvocationTime(
      new Date("2026-07-05T12:29:59.999Z"),
      30
    ).toISOString(),
    "2026-07-05T12:00:00.000Z"
  );
  assert.equal(
    defaultInvocationTime(
      new Date("2026-07-05T12:30:00.000Z"),
      30
    ).toISOString(),
    "2026-07-05T12:30:00.000Z"
  );
});

test("事件归一化只输出 HMAC 引用，不携带正文、名称或原平台引用", () => {
  const rawMarker =
    "SENSITIVE_TRANSIENT_BODY_MUST_NOT_SURVIVE";
  const normalized = normalizeObservedThread({
    courseAlias: "test-course",
    secret: Buffer.alloc(32, 7),
    maxComments: 10,
    thread: {
      courseRef: "1234567890",
      threadRef: "thread-raw-1",
      authorRef: "author-raw-1",
      occurredAt: "2026-07-01 08:00:00",
      observedAt: "2026-07-05T00:00:00.000Z",
      versionMaterial: rawMarker,
      knownExternalHumanActorRefs: ["peer-raw-1"],
      comments: [
        {
          eventRef: "comment-raw-1",
          actorRef: "peer-raw-1",
          parentEventRef: "thread-raw-1",
          depth: 0,
          occurredAt: "2026-07-01 09:00:00",
          versionMaterial: `${rawMarker}-comment`
        }
      ]
    }
  });
  const serialized = JSON.stringify(normalized);
  assert.equal(serialized.includes(rawMarker), false);
  assert.equal(serialized.includes("thread-raw-1"), false);
  assert.equal(serialized.includes("author-raw-1"), false);
  assert.equal(serialized.includes("peer-raw-1"), false);
  assert.equal(normalized.events.length, 2);
  assert.ok(
    normalized.events.every((event) =>
      /^[a-f0-9]{64}$/.test(event.eventKey)
    )
  );
});

test("同一时点事件置换不改变 World/Graph，未来后缀不倒改旧快照", () => {
  const normalized = normalizeObservedThread({
    courseAlias: "test-course",
    secret: Buffer.alloc(32, 9),
    maxComments: 10,
    thread: {
      courseRef: "1234567890",
      threadRef: "thread-1",
      authorRef: "author-1",
      occurredAt: "2026-07-01T00:00:00.000Z",
      observedAt: "2026-07-05T00:00:00.000Z",
      versionMaterial: "root-v1",
      knownExternalHumanActorRefs: ["peer-a", "peer-b"],
      comments: [
        {
          eventRef: "comment-a",
          actorRef: "peer-a",
          parentEventRef: "thread-1",
          depth: 0,
          occurredAt: "2026-07-02T00:00:00.000Z",
          versionMaterial: "comment-a-v1"
        },
        {
          eventRef: "comment-b",
          actorRef: "peer-b",
          parentEventRef: "thread-1",
          depth: 0,
          occurredAt: "2026-07-02T00:00:00.000Z",
          versionMaterial: "comment-b-v1"
        }
      ]
    }
  });
  const forward = projectLiveWorld(normalized.events);
  const reversed = projectLiveWorld(
    [...normalized.events].reverse()
  );
  assert.equal(reversed.worldHash, forward.worldHash);
  assert.equal(reversed.graphHash, forward.graphHash);
  assert.equal(reversed.eventSetHash, forward.eventSetHash);

  const prefix = projectLiveWorld(normalized.events.slice(0, 2));
  projectLiveWorld(normalized.events);
  const replayedPrefix = projectLiveWorld(
    [...normalized.events.slice(0, 2)].reverse()
  );
  assert.equal(
    replayedPrefix.worldHash,
    prefix.worldHash,
    "未来事件后缀不能改变旧 as-of 前缀"
  );

  const incremental = projectLiveWorldIncrementally(
    [
      normalized.events.slice(0, 1),
      normalized.events.slice(1, 2),
      normalized.events.slice(2)
    ]
  );
  assert.equal(incremental.worldHash, forward.worldHash);
  assert.equal(incremental.graphHash, forward.graphHash);
  assert.equal(
    incremental.eventSetHash,
    forward.eventSetHash
  );
});

test("World 将非整小时支持缺口规范为可哈希的整小时下界", () => {
  const normalized = normalizeObservedThread({
    courseAlias: "test-course",
    secret: Buffer.alloc(32, 10),
    maxComments: 10,
    thread: {
      courseRef: "1234567890",
      threadRef: "fractional-gap-thread",
      authorRef: "fractional-gap-author",
      occurredAt: "2026-07-01T00:15:00.000Z",
      observedAt: "2026-07-01T02:00:00.000Z",
      versionMaterial: "root-v1",
      comments: [
        {
          eventRef: "fractional-gap-comment",
          actorRef: "fractional-gap-author",
          parentEventRef: "fractional-gap-thread",
          depth: 0,
          occurredAt: "2026-07-01T01:45:00.000Z",
          versionMaterial: "comment-v1"
        }
      ]
    }
  });

  const projection = projectLiveWorld(normalized.events);
  assert.equal(projection.threads[0].supportGapHours, 1);
  assert.match(projection.worldHash, /^[a-f0-9]{64}$/);
});

test("World 使用可信 cutoff 推进静默支持缺口，且增量重复事件幂等、冲突失败关闭", () => {
  const normalized = normalizeObservedThread({
    courseAlias: "test-course",
    secret: Buffer.alloc(32, 11),
    maxComments: 10,
    thread: {
      courseRef: "1234567890",
      threadRef: "aging-thread",
      authorRef: "aging-author",
      occurredAt: "2026-07-01T00:00:00.000Z",
      observedAt: "2026-07-05T00:00:00.000Z",
      versionMaterial: "root-v1",
      comments: []
    }
  });
  const first = projectLiveWorld(normalized.events, {
    asOfAt: "2026-07-04T00:00:00.000Z"
  });
  const later = projectLiveWorld(normalized.events, {
    asOfAt: "2026-07-05T00:00:00.000Z"
  });
  assert.equal(first.threads[0].supportGapHours, 72);
  assert.equal(later.threads[0].supportGapHours, 96);
  assert.notEqual(first.worldHash, later.worldHash);
  assert.equal(first.eventSetHash, later.eventSetHash);

  const incremental = new IncrementalLiveWorldProjector();
  assert.deepEqual(incremental.append(normalized.events), {
    appended: 1,
    duplicate: 0
  });
  assert.deepEqual(incremental.append(normalized.events), {
    appended: 0,
    duplicate: 1
  });
  assert.throws(
    () =>
      incremental.append([
        {
          ...normalized.events[0],
          depth: 1
        }
      ]),
    /INCREMENTAL_WORLD_EVENT_CONFLICT/
  );
});

test("World 用稳定异账号回复关闭结构性缺口，但不冒充真人回复", () => {
  const normalized = normalizeObservedThread({
    courseAlias: "test-course",
    secret: Buffer.alloc(32, 12),
    maxComments: 10,
    thread: {
      courseRef: "1234567890",
      threadRef: "distinct-actor-thread",
      authorRef: "root-author",
      occurredAt: "2026-07-01T00:00:00.000Z",
      observedAt: "2026-07-05T00:00:00.000Z",
      versionMaterial: "root-v1",
      comments: [
        {
          eventRef: "unknown-role-comment",
          actorRef: "stable-other-account",
          parentEventRef: "distinct-actor-thread",
          depth: 0,
          occurredAt: "2026-07-02T00:00:00.000Z",
          versionMaterial: "comment-v1"
        }
      ]
    }
  });

  const projection = projectLiveWorld(normalized.events);
  assert.equal(normalized.events[1].actorRelation, "unknown");
  assert.equal(projection.threads[0].externalHumanCount, 0);
  assert.equal(projection.threads[0].distinctActorResponseCount, 1);
  assert.equal(projection.openGapCount, 0);
});

test("World 的不同账号回复数按 actor 去重而不是按评论事件计数", () => {
  const normalized = normalizeObservedThread({
    courseAlias: "test-course",
    secret: Buffer.alloc(32, 14),
    maxComments: 10,
    thread: {
      courseRef: "1234567890",
      threadRef: "distinct-actor-dedup-thread",
      authorRef: "root-author",
      occurredAt: "2026-07-01T00:00:00.000Z",
      observedAt: "2026-07-05T00:00:00.000Z",
      versionMaterial: "root-v1",
      comments: [
        {
          eventRef: "same-actor-comment-1",
          actorRef: "same-stable-account",
          parentEventRef: "distinct-actor-dedup-thread",
          depth: 0,
          occurredAt: "2026-07-02T00:00:00.000Z",
          versionMaterial: "comment-1-v1"
        },
        {
          eventRef: "same-actor-comment-2",
          actorRef: "same-stable-account",
          parentEventRef: "same-actor-comment-1",
          depth: 1,
          occurredAt: "2026-07-02T01:00:00.000Z",
          versionMaterial: "comment-2-v1"
        }
      ]
    }
  });

  const projection = projectLiveWorld(normalized.events);
  assert.equal(projection.threads[0].eventCount, 3);
  assert.equal(
    projection.threads[0].distinctActorResponseCount,
    1
  );
});

test("World 按线程隔离覆盖失败，不让一个坏目标污染完整目标", () => {
  const secret = Buffer.alloc(32, 13);
  const complete = normalizeObservedThread({
    courseAlias: "test-course",
    secret,
    maxComments: 0,
    thread: {
      courseRef: "1234567890",
      threadRef: "complete-thread",
      authorRef: "complete-author",
      occurredAt: "2026-07-01T00:00:00.000Z",
      observedAt: "2026-07-05T00:00:00.000Z",
      versionMaterial: "complete-v1",
      comments: []
    }
  });
  const censored = normalizeObservedThread({
    courseAlias: "test-course",
    secret,
    maxComments: 0,
    thread: {
      courseRef: "1234567890",
      threadRef: "censored-thread",
      authorRef: "censored-author",
      occurredAt: "2026-07-01T00:00:00.000Z",
      observedAt: "2026-07-05T00:00:00.000Z",
      versionMaterial: "censored-v1",
      comments: []
    }
  });

  const projection = projectLiveWorld(
    [...complete.events, ...censored.events],
    {
      coverageComplete: false,
      completeThreadKeys: [complete.threadKey]
    }
  );
  const byThread = new Map(
    projection.threads.map((thread) => [thread.threadKey, thread])
  );
  assert.equal(byThread.get(complete.threadKey)?.completeness, "complete");
  assert.equal(
    byThread.get(censored.threadKey)?.completeness,
    "censored"
  );
});

test("事件账本区分重复观察、合法新修订和不可解释冲突", () => {
  const normalized = normalizeObservedThread({
    courseAlias: "test-course",
    secret: Buffer.alloc(32, 15),
    maxComments: 0,
    thread: {
      courseRef: "1234567890",
      threadRef: "revision-thread",
      authorRef: "revision-author",
      occurredAt: "2026-07-01T00:00:00.000Z",
      observedAt: "2026-07-05T00:00:00.000Z",
      versionMaterial: "root-v1",
      comments: []
    }
  });
  const stable = normalized.events[0];

  assert.equal(
    classifyCourseEventObservation({
      stableEvent: stable,
      latestObservation: {
        observedAt: stable.observedAt,
        sourceVersionHash: stable.sourceVersionHash,
        targetVersionHash: stable.targetVersionHash
      },
      incomingEvent: {
        ...stable,
        observedAt: "2026-07-05T01:00:00.000Z"
      }
    }),
    "duplicate"
  );

  assert.equal(
    classifyCourseEventObservation({
      stableEvent: stable,
      latestObservation: {
        observedAt: stable.observedAt,
        sourceVersionHash: stable.sourceVersionHash,
        targetVersionHash: stable.targetVersionHash
      },
      incomingEvent: {
        ...stable,
        observedAt: "2026-07-05T01:00:00.000Z",
        sourceVersionHash: "a".repeat(64),
        targetVersionHash: "b".repeat(64)
      }
    }),
    "revision"
  );

  assert.equal(
    classifyCourseEventObservation({
      stableEvent: stable,
      latestObservation: {
        observedAt: stable.observedAt,
        sourceVersionHash: stable.sourceVersionHash,
        targetVersionHash: stable.targetVersionHash
      },
      incomingEvent: {
        ...stable,
        observedAt: stable.observedAt,
        sourceVersionHash: "c".repeat(64),
        targetVersionHash: "d".repeat(64)
      }
    }),
    "conflict"
  );

  assert.equal(
    classifyCourseEventObservation({
      stableEvent: stable,
      latestObservation: {
        observedAt: stable.observedAt,
        sourceVersionHash: stable.sourceVersionHash,
        targetVersionHash: stable.targetVersionHash
      },
      incomingEvent: {
        ...stable,
        actorKey: "e".repeat(64),
        observedAt: "2026-07-05T01:00:00.000Z"
      }
    }),
    "conflict"
  );
});

test("瞬时正文只生成受约束语义证据，不进入结构化回执", () => {
  const marker = "TRANSIENT_SEMANTIC_BODY_MUST_NOT_SURVIVE";
  const result = analyzeTransientSemanticEvidence({
    observationReceiptHash: "1".repeat(64),
    targetVersionHash: "2".repeat(64),
    eventSetHash: "3".repeat(64),
    observedAt: "2026-07-05T00:00:00.000Z",
    texts: [
      marker,
      "我认为这个案例说明了协作条件的重要性，但是如果参与者观点完全相反，原来的判断还成立吗？"
    ]
  });

  assert.equal(result.receipt.epistemicSeedStatus, "supported");
  assert.equal(
    result.receipt.needSignals.conceptualTension,
    "supported"
  );
  assert.equal(result.receipt.dominantNeed, "conceptual_tension");
  assert.ok(
    result.receipt.contributionFunctions.includes("meaning_making")
  );
  assert.equal(result.receipt.containsForumText, false);
  assert.match(result.receiptHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes(marker), false);
});
