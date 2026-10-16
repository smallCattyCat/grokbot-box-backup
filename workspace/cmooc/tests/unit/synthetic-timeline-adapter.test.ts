import assert from "node:assert/strict";
import test from "node:test";
import {
  PROTOCOL_SCHEMA_VERSIONS,
  canonicalProtocolHash,
  type ExecutionCommandV1
} from "../../lib/facilitation-protocol";
import {
  SyntheticTimelineForumAdapter,
  syntheticTimelineScopeLocator,
  syntheticTimelineThreadLocator,
  type SyntheticTimeline,
  type SyntheticTimelineExecutionOutcome
} from "../../lib/forum-adapters/synthetic-timeline-adapter";
import {
  defineForumAdapterConformanceSuite,
  type ForumAdapterConformanceFixture
} from "../contract/forum-adapter-conformance";

const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const COURSE_KEY = "course:timeline";
const PLATFORM_COURSE_REF = "space:timeline-course";
const TIMELINE_REF = "timeline-001";
const ROOT_MESSAGE_REF = "message-root-001";
const REPLY_MESSAGE_REF = "message-reply-001";

function timeline(
  replyBody = "SECRET_TIMELINE_REPLY",
  replyRevision = 1
): SyntheticTimeline {
  return {
    stableTimelineRef: TIMELINE_REF,
    courseKey: COURSE_KEY,
    platformCourseRef: PLATFORM_COURSE_REF,
    topicLabel: "SECRET_TIMELINE_TOPIC",
    rootMessageRef: ROOT_MESSAGE_REF,
    messages: [
      {
        stableMessageRef: ROOT_MESSAGE_REF,
        parentMessageRef: null,
        actorRef: "actor-root-001",
        body: "SECRET_TIMELINE_ROOT",
        createdAt: "2025-12-31T22:00:00.000Z",
        updatedAt: "2025-12-31T22:00:00.000Z",
        revision: 1
      },
      {
        stableMessageRef: REPLY_MESSAGE_REF,
        parentMessageRef: ROOT_MESSAGE_REF,
        actorRef: "actor-reply-001",
        body: replyBody,
        createdAt: "2025-12-31T22:30:00.000Z",
        updatedAt:
          replyRevision === 1
            ? "2025-12-31T22:30:00.000Z"
            : "2025-12-31T23:30:00.000Z",
        revision: replyRevision
      }
    ]
  };
}

function command(
  expectedTargetHash: string,
  suffix: string
): ExecutionCommandV1 {
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.executionCommand,
    commandId: `command:${suffix}`,
    correlationId: `correlation:${suffix}`,
    capability: "forum.execute_authorized",
    taskRefHash: HASH_A,
    reviewBundleHash: HASH_B,
    authorizationRefHash: HASH_A,
    idempotencyKey: canonicalProtocolHash(
      "cmooc.synthetic-timeline-test-idempotency.v1",
      { suffix }
    ),
    budgetReservationRefHash: HASH_A,
    expectedTargetHash,
    contentHash: HASH_B,
    gatewayPolicyVersion: "gateway.test.v1",
    issuedAt: "2025-12-31T23:55:00.000Z",
    expiresAt: "2026-01-01T01:00:00.000Z",
    containsForumText: false
  };
}

function fixture(): ForumAdapterConformanceFixture {
  const adapter = new SyntheticTimelineForumAdapter({
    clock: () => new Date(FIXED_NOW),
    timelines: [timeline()]
  });
  return {
    adapter,
    scope: {
      courseKey: COURSE_KEY,
      platformCourseRef: PLATFORM_COURSE_REF,
      locator: syntheticTimelineScopeLocator(PLATFORM_COURSE_REF),
      limit: 10
    },
    targetRef: (thread) => ({
      thread,
      targetType: "comment",
      targetObject: "specific_participant",
      stableTargetRef: REPLY_MESSAGE_REF
    }),
    mutateTarget: () => {
      adapter.upsertTimeline(
        timeline("SECRET_TIMELINE_REPLY_EDITED", 2)
      );
    },
    forbiddenForumText: [
      "SECRET_TIMELINE_TOPIC",
      "SECRET_TIMELINE_ROOT",
      "SECRET_TIMELINE_REPLY",
      "SECRET_TIMELINE_REPLY_EDITED"
    ]
  };
}

function timelineWithRef(
  stableTimelineRef: string,
  courseKey = COURSE_KEY,
  platformCourseRef = PLATFORM_COURSE_REF
): SyntheticTimeline {
  return {
    ...timeline(),
    stableTimelineRef,
    courseKey,
    platformCourseRef,
    topicLabel: `SECRET_TOPIC_${stableTimelineRef}`
  };
}

defineForumAdapterConformanceSuite(
  "SyntheticTimelineForumAdapter",
  fixture
);

test("timeline 聚合映射为 thread，root/message 使用不同稳定对象引用", async () => {
  const adapter = fixture().adapter as SyntheticTimelineForumAdapter;
  const page = await adapter.listThreads({
    courseKey: COURSE_KEY,
    platformCourseRef: PLATFORM_COURSE_REF,
    locator: syntheticTimelineScopeLocator(PLATFORM_COURSE_REF)
  });
  assert.equal(page.items.length, 1);
  const thread = page.items[0].threadRef;
  assert.equal(thread.stableThreadRef, TIMELINE_REF);
  assert.equal(
    thread.locator,
    syntheticTimelineThreadLocator(
      PLATFORM_COURSE_REF,
      TIMELINE_REF
    )
  );
  assert.equal(page.items[0].replyCount, 1);

  const root = await adapter.bindTarget({
    thread,
    targetType: "thread",
    targetObject: "thread_author",
    stableTargetRef: TIMELINE_REF
  });
  const reply = await adapter.bindTarget({
    thread,
    targetType: "comment",
    targetObject: "specific_participant",
    stableTargetRef: REPLY_MESSAGE_REF
  });
  assert.equal(root.stableTargetRef, TIMELINE_REF);
  assert.equal(reply.stableTargetRef, REPLY_MESSAGE_REF);
  assert.notEqual(root.targetVersionHash, reply.targetVersionHash);
});

test("locator 必须由课程与 timeline 稳定键共同确定", async () => {
  const adapter = fixture().adapter;
  await assert.rejects(
    () =>
      adapter.listThreads({
        courseKey: COURSE_KEY,
        platformCourseRef: PLATFORM_COURSE_REF,
        locator: "synthetic-timeline://local/wrong"
      }),
    /SCOPE_LOCATOR_MISMATCH/
  );
  const page = await adapter.listThreads({
    courseKey: COURSE_KEY,
    platformCourseRef: PLATFORM_COURSE_REF
  });
  await assert.rejects(
    () =>
      adapter.observeThread({
        ...page.items[0].threadRef,
        locator: "synthetic-timeline://local/wrong"
      }),
    /THREAD_LOCATOR_MISMATCH/
  );
});

test("分页 cursor 按稳定 timeline 键产生确定性首/续页", async () => {
  const adapter = new SyntheticTimelineForumAdapter({
    clock: () => new Date(FIXED_NOW),
    timelines: [
      timelineWithRef("timeline-003"),
      timelineWithRef("timeline-001"),
      timelineWithRef("timeline-004"),
      timelineWithRef("timeline-002")
    ]
  });
  const scope = {
    courseKey: COURSE_KEY,
    platformCourseRef: PLATFORM_COURSE_REF,
    locator: syntheticTimelineScopeLocator(PLATFORM_COURSE_REF),
    limit: 2
  };
  const first = await adapter.listThreads(scope);
  const firstRepeated = await adapter.listThreads(scope);
  assert.deepEqual(
    first.items.map((item) => item.threadRef.stableThreadRef),
    ["timeline-001", "timeline-002"]
  );
  assert.match(first.nextCursor ?? "", /^timeline-cursor:[a-f0-9]{64}$/);
  assert.equal(firstRepeated.nextCursor, first.nextCursor);

  const second = await adapter.listThreads(
    scope,
    first.nextCursor ?? undefined
  );
  assert.deepEqual(
    second.items.map((item) => item.threadRef.stableThreadRef),
    ["timeline-003", "timeline-004"]
  );
  assert.equal(second.nextCursor, null);
});

test("分页 cursor 拒绝伪造及跨 scope、locator 和 limit 重放", async () => {
  const otherCourseKey = "course:timeline-other";
  const adapter = new SyntheticTimelineForumAdapter({
    clock: () => new Date(FIXED_NOW),
    timelines: [
      timelineWithRef("timeline-001"),
      timelineWithRef("timeline-002"),
      timelineWithRef(
        "timeline-other-001",
        otherCourseKey,
        PLATFORM_COURSE_REF
      )
    ]
  });
  const scope = {
    courseKey: COURSE_KEY,
    platformCourseRef: PLATFORM_COURSE_REF,
    limit: 1
  };
  const first = await adapter.listThreads(scope);
  assert.notEqual(first.nextCursor, null);
  const cursor = first.nextCursor ?? "";
  const forged = `${cursor.slice(0, -1)}${
    cursor.endsWith("0") ? "1" : "0"
  }`;
  await assert.rejects(
    () => adapter.listThreads(scope, forged),
    /INVALID_SYNTHETIC_TIMELINE_CURSOR/
  );
  await assert.rejects(
    () =>
      adapter.listThreads(
        { ...scope, courseKey: otherCourseKey },
        cursor
      ),
    /CURSOR_SCOPE_MISMATCH/
  );
  await assert.rejects(
    () => adapter.listThreads({ ...scope, limit: 2 }, cursor),
    /CURSOR_SCOPE_MISMATCH/
  );

  const explicitLocatorScope = {
    ...scope,
    locator: syntheticTimelineScopeLocator(PLATFORM_COURSE_REF)
  };
  const explicitFirst =
    await adapter.listThreads(explicitLocatorScope);
  assert.equal(explicitFirst.nextCursor, first.nextCursor);
});

test("分页集合变化使已签发 cursor 越界或漂移时 fail closed", async () => {
  let now = new Date("2026-01-01T01:00:00.000Z");
  const futureSecond = timelineWithRef("timeline-002");
  futureSecond.messages = futureSecond.messages.map(
    (message, index) => ({
      ...message,
      createdAt:
        index === 0
          ? "2026-01-01T00:30:00.000Z"
          : "2026-01-01T00:45:00.000Z",
      updatedAt:
        index === 0
          ? "2026-01-01T00:30:00.000Z"
          : "2026-01-01T00:45:00.000Z"
    })
  );
  const adapter = new SyntheticTimelineForumAdapter({
    clock: () => new Date(now),
    timelines: [
      timelineWithRef("timeline-001"),
      futureSecond
    ]
  });
  const scope = {
    courseKey: COURSE_KEY,
    platformCourseRef: PLATFORM_COURSE_REF,
    limit: 1
  };
  const first = await adapter.listThreads(scope);
  const cursor = first.nextCursor ?? "";
  now = new Date(FIXED_NOW);
  await assert.rejects(
    () => adapter.listThreads(scope, cursor),
    /CURSOR_OFFSET_OUT_OF_BOUNDS/
  );

  const driftAdapter = new SyntheticTimelineForumAdapter({
    clock: () => new Date(FIXED_NOW),
    timelines: [
      timelineWithRef("timeline-001"),
      timelineWithRef("timeline-002")
    ]
  });
  const driftFirst = await driftAdapter.listThreads(scope);
  driftAdapter.upsertTimeline(timelineWithRef("timeline-003"));
  await assert.rejects(
    () =>
      driftAdapter.listThreads(
        scope,
        driftFirst.nextCursor ?? undefined
      ),
    /CURSOR_COLLECTION_CHANGED/
  );
});

test("t 后新增 message 不改变 t 时观察、列表或既有目标版本", async () => {
  const adapter = new SyntheticTimelineForumAdapter({
    clock: () => new Date(FIXED_NOW),
    timelines: [timeline()]
  });
  const scope = {
    courseKey: COURSE_KEY,
    platformCourseRef: PLATFORM_COURSE_REF
  };
  const beforePage = await adapter.listThreads(scope);
  const thread = beforePage.items[0].threadRef;
  const beforeObservation = await adapter.observeThread(thread);
  const beforeTarget = await adapter.bindTarget({
    thread,
    targetType: "comment",
    targetObject: "specific_participant",
    stableTargetRef: REPLY_MESSAGE_REF
  });

  const withFutureSuffix = timeline();
  withFutureSuffix.messages.push({
    stableMessageRef: "message-future-nested-001",
    parentMessageRef: REPLY_MESSAGE_REF,
    actorRef: "actor-future-001",
    body: "SECRET_FUTURE_SUFFIX",
    createdAt: "2026-01-01T00:30:00.000Z",
    updatedAt: "2026-01-01T00:30:00.000Z",
    revision: 1
  });
  adapter.upsertTimeline(withFutureSuffix);

  const afterPage = await adapter.listThreads(scope);
  const afterObservation = await adapter.observeThread(thread);
  const afterTarget = await adapter.bindTarget({
    thread,
    targetType: "comment",
    targetObject: "specific_participant",
    stableTargetRef: REPLY_MESSAGE_REF
  });
  assert.deepEqual(afterPage, beforePage);
  assert.deepEqual(afterObservation, beforeObservation);
  assert.deepEqual(afterTarget, beforeTarget);
  assert.equal(
    JSON.stringify({
      afterPage,
      afterObservation,
      afterTarget
    }).includes("SECRET_FUTURE_SUFFIX"),
    false
  );
});

test("已创建 message 的未来 revision 无法重建时明确拒绝", async () => {
  const adapter = new SyntheticTimelineForumAdapter({
    clock: () => new Date(FIXED_NOW),
    timelines: [timeline()]
  });
  const page = await adapter.listThreads({
    courseKey: COURSE_KEY,
    platformCourseRef: PLATFORM_COURSE_REF
  });
  const thread = page.items[0].threadRef;
  const bound = await adapter.bindTarget({
    thread,
    targetType: "comment",
    targetObject: "specific_participant",
    stableTargetRef: REPLY_MESSAGE_REF
  });
  const staleCommand = command(
    canonicalProtocolHash(bound.schemaVersion, bound),
    "future-revision"
  );
  const revised = timeline("SECRET_FUTURE_REVISION", 2);
  revised.messages = revised.messages.map((message) =>
    message.stableMessageRef === REPLY_MESSAGE_REF
      ? {
          ...message,
          updatedAt: "2026-01-01T00:30:00.000Z"
        }
      : message
  );
  adapter.upsertTimeline(revised);

  await assert.rejects(
    () =>
      adapter.listThreads({
        courseKey: COURSE_KEY,
        platformCourseRef: PLATFORM_COURSE_REF
      }),
    /REVISION_AFTER_AS_OF/
  );
  await assert.rejects(
    () => adapter.observeThread(thread),
    /REVISION_AFTER_AS_OF/
  );
  await assert.rejects(
    () =>
      adapter.bindTarget({
        thread,
        targetType: "comment",
        targetObject: "specific_participant",
        stableTargetRef: REPLY_MESSAGE_REF
      }),
    /REVISION_AFTER_AS_OF/
  );
  assert.equal(
    (await adapter.preflight(staleCommand)).status,
    "target_changed"
  );
});

test("topic 与既有 message 的编辑必须显式单调版本化，未来版本在 t 时拒绝", async () => {
  let now = new Date(FIXED_NOW);
  const adapter = new SyntheticTimelineForumAdapter({
    clock: () => new Date(now),
    timelines: [timeline()]
  });
  const page = await adapter.listThreads({
    courseKey: COURSE_KEY,
    platformCourseRef: PLATFORM_COURSE_REF
  });
  const thread = page.items[0].threadRef;

  assert.throws(
    () =>
      adapter.upsertTimeline({
        ...timeline(),
        topicLabel: "SECRET_UNVERSIONED_TOPIC_EDIT"
      }),
    /TOPIC_REVISION_REQUIRED/
  );
  assert.throws(
    () =>
      adapter.upsertTimeline({
        ...timeline(),
        messages: timeline().messages.map((message) =>
          message.stableMessageRef === REPLY_MESSAGE_REF
            ? {
                ...message,
                body: "SECRET_UNVERSIONED_BODY_EDIT"
              }
            : message
        )
      }),
    /REVISION_NOT_MONOTONIC/
  );
  assert.throws(
    () =>
      adapter.upsertTimeline({
        ...timeline(),
        messages: timeline().messages.filter(
          (message) =>
            message.stableMessageRef !== REPLY_MESSAGE_REF
        )
      }),
    /MESSAGE_DELETION_UNVERSIONED/
  );

  const versionedTopic = {
    ...timeline(),
    topicLabel: "SECRET_VERSIONED_FUTURE_TOPIC",
    messages: timeline().messages.map((message) =>
      message.stableMessageRef === ROOT_MESSAGE_REF
        ? {
            ...message,
            updatedAt: "2026-01-01T00:10:00.000Z",
            revision: 2
          }
        : message
    )
  };
  adapter.upsertTimeline(versionedTopic);
  await assert.rejects(
    () =>
      adapter.listThreads({
        courseKey: COURSE_KEY,
        platformCourseRef: PLATFORM_COURSE_REF
      }),
    /REVISION_AFTER_AS_OF/
  );
  await assert.rejects(
    () => adapter.observeThread(thread),
    /REVISION_AFTER_AS_OF/
  );

  now = new Date("2026-01-01T00:20:00.000Z");
  const futurePage = await adapter.listThreads({
    courseKey: COURSE_KEY,
    platformCourseRef: PLATFORM_COURSE_REF
  });
  assert.notEqual(
    futurePage.items[0].titleHash,
    page.items[0].titleHash
  );
});

test("未来 root 在列表不可见，直接观察与绑定均拒绝", async () => {
  const future = timelineWithRef("timeline-future-root");
  future.messages = future.messages.map((message) => ({
    ...message,
    createdAt:
      message.stableMessageRef === future.rootMessageRef
        ? "2026-01-01T00:30:00.000Z"
        : "2026-01-01T00:45:00.000Z",
    updatedAt:
      message.stableMessageRef === future.rootMessageRef
        ? "2026-01-01T00:30:00.000Z"
        : "2026-01-01T00:45:00.000Z"
  }));
  let now = new Date("2026-01-01T01:00:00.000Z");
  const adapter = new SyntheticTimelineForumAdapter({
    clock: () => new Date(now),
    timelines: [timeline(), future]
  });
  const issuedPage = await adapter.listThreads({
    courseKey: COURSE_KEY,
    platformCourseRef: PLATFORM_COURSE_REF
  });
  const futureThread = issuedPage.items.find(
    (item) =>
      item.threadRef.stableThreadRef === future.stableTimelineRef
  )?.threadRef;
  assert.ok(futureThread);

  now = new Date(FIXED_NOW);
  const page = await adapter.listThreads({
    courseKey: COURSE_KEY,
    platformCourseRef: PLATFORM_COURSE_REF
  });
  assert.deepEqual(
    page.items.map((item) => item.threadRef.stableThreadRef),
    [TIMELINE_REF]
  );
  await assert.rejects(
    () => adapter.observeThread(futureThread),
    /ROOT_NOT_VISIBLE_AS_OF/
  );
  await assert.rejects(
    () =>
      adapter.bindTarget({
        thread: futureThread,
        targetType: "thread",
        targetObject: "thread_author",
        stableTargetRef: future.stableTimelineRef
      }),
    /ROOT_NOT_VISIBLE_AS_OF/
  );
});

test("preflight 对未变目标保持 ready，时点内编辑后拒绝旧绑定", async () => {
  const adapter = new SyntheticTimelineForumAdapter({
    clock: () => new Date(FIXED_NOW),
    timelines: [timeline()]
  });
  const page = await adapter.listThreads({
    courseKey: COURSE_KEY,
    platformCourseRef: PLATFORM_COURSE_REF
  });
  const targetRef = {
    thread: page.items[0].threadRef,
    targetType: "comment" as const,
    targetObject: "specific_participant" as const,
    stableTargetRef: REPLY_MESSAGE_REF
  };
  const bound = await adapter.bindTarget(targetRef);
  const executionCommand = command(
    canonicalProtocolHash(bound.schemaVersion, bound),
    "as-of-recheck"
  );
  assert.equal(
    (await adapter.preflight(executionCommand)).status,
    "ready"
  );
  adapter.upsertTimeline(timeline());
  assert.equal(
    (await adapter.preflight(executionCommand)).status,
    "ready"
  );
  adapter.upsertTimeline(
    timeline("SECRET_EDIT_WITHIN_AS_OF", 2)
  );
  assert.equal(
    (await adapter.preflight(executionCommand)).status,
    "target_changed"
  );
});

test("合成执行区分三态回执，并保持每个幂等键的首次结果", async () => {
  for (const outcome of [
    "verified_published",
    "confirmed_not_published",
    "outcome_unknown"
  ] satisfies SyntheticTimelineExecutionOutcome[]) {
    const adapter = new SyntheticTimelineForumAdapter({
      clock: () => new Date(FIXED_NOW),
      timelines: [timeline()],
      executionOutcome: outcome
    });
    const page = await adapter.listThreads({
      courseKey: COURSE_KEY,
      platformCourseRef: PLATFORM_COURSE_REF
    });
    const bound = await adapter.bindTarget({
      thread: page.items[0].threadRef,
      targetType: "comment",
      targetObject: "specific_participant",
      stableTargetRef: REPLY_MESSAGE_REF
    });
    const executionCommand = command(
      canonicalProtocolHash(bound.schemaVersion, bound),
      outcome
    );
    const first = await adapter.executeAuthorized(executionCommand);
    adapter.setExecutionOutcome(
      outcome === "outcome_unknown"
        ? "verified_published"
        : "outcome_unknown"
    );
    const repeated =
      await adapter.executeAuthorized(executionCommand);
    assert.equal(first.outcome, outcome);
    assert.deepEqual(repeated, first);
    assert.equal(first.attemptedAt, FIXED_NOW.toISOString());
    assert.equal(
      first.remoteObjectRefHash !== null,
      outcome === "verified_published"
    );
  }
});

test("同一幂等键绑定不同命令时 fail closed", async () => {
  const adapter = fixture().adapter;
  const page = await adapter.listThreads({
    courseKey: COURSE_KEY,
    platformCourseRef: PLATFORM_COURSE_REF
  });
  const bound = await adapter.bindTarget({
    thread: page.items[0].threadRef,
    targetType: "comment",
    targetObject: "specific_participant",
    stableTargetRef: REPLY_MESSAGE_REF
  });
  const executionCommand = command(
    canonicalProtocolHash(bound.schemaVersion, bound),
    "conflict"
  );
  await adapter.executeAuthorized(executionCommand);
  await assert.rejects(
    () =>
      adapter.executeAuthorized({
        ...executionCommand,
        contentHash: HASH_A
      }),
    /IDEMPOTENCY_KEY_CONFLICT/
  );
});

test("timeline 数据拒绝缺失 parent、循环 parent 与逆序修订时间", () => {
  const base = timeline();
  assert.throws(
    () =>
      new SyntheticTimelineForumAdapter({
        clock: () => new Date(FIXED_NOW),
        timelines: [
          {
            ...base,
            messages: base.messages.map((message) =>
              message.stableMessageRef === REPLY_MESSAGE_REF
                ? {
                    ...message,
                    parentMessageRef: "message-missing"
                  }
                : message
            )
          }
        ]
      }),
    /PARENT_NOT_FOUND/
  );
  assert.throws(
    () =>
      new SyntheticTimelineForumAdapter({
        clock: () => new Date(FIXED_NOW),
        timelines: [
          {
            ...base,
            messages: base.messages.map((message) =>
              message.stableMessageRef === REPLY_MESSAGE_REF
                ? {
                    ...message,
                    parentMessageRef: REPLY_MESSAGE_REF
                  }
                : message
            )
          }
        ]
      }),
    /PARENT_CYCLE/
  );
  assert.throws(
    () =>
      new SyntheticTimelineForumAdapter({
        clock: () => new Date(FIXED_NOW),
        timelines: [
          {
            ...base,
            messages: base.messages.map((message) =>
              message.stableMessageRef === REPLY_MESSAGE_REF
                ? {
                    ...message,
                    updatedAt: "2025-12-31T21:00:00.000Z"
                  }
                : message
            )
          }
        ]
    }),
    /REVISION_PRECEDES_CREATION/
  );
  assert.throws(
    () =>
      new SyntheticTimelineForumAdapter({
        clock: () => new Date(FIXED_NOW),
        timelines: [
          {
            ...base,
            messages: base.messages.map((message) =>
              message.stableMessageRef === REPLY_MESSAGE_REF
                ? {
                    ...message,
                    createdAt: "2025-12-31T21:30:00.000Z",
                    updatedAt: "2025-12-31T21:30:00.000Z"
                  }
                : message
            )
          }
        ]
      }),
    /PARENT_CREATED_AFTER_CHILD/
  );
});
