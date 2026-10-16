import assert from "node:assert/strict";
import test from "node:test";
import {
  hashCourseScope,
  hashCourseToolValue,
  type EvidenceRef
} from "../../lib/course-tools/contracts";
import {
  hashPreExecutionTargetObservation,
  PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION
} from "../../lib/autonomy/execution-permit";
import type { CourseAgentStageTargetMaterial } from "../../lib/workbench/course-agent-artifact-runtime";
import {
  WORKBENCH_RESOLVED_STAGE_TARGET_RECEIPT_SCHEMA_VERSION,
  WORKBENCH_STAGE_TARGET_RESOLUTION_SCHEMA_VERSION
} from "../../lib/workbench/trusted-workbench-platform-stage-adapter";
import {
  WORKBENCH_STAGE_TARGET_TRANSIENT_READ_SCHEMA_VERSION,
  createWorkbenchStageTargetResolverV2,
  hashWorkbenchStageTargetLocatorV2,
  hmacWorkbenchStageLocatorV2,
  type WorkbenchStageTargetTransientReadV2,
  type WorkbenchStageTargetTransientReaderV2
} from "../../lib/workbench/workbench-stage-target-resolver-v2";

const NOW = "2026-08-13T12:00:00.000Z";
const COURSE_ALIAS = "bnu-test";
const COURSE_ID = "course-private-resolver-fixture";
const MANIFEST_HASH = hashCourseToolValue(
  "fixture.resolver.manifest",
  COURSE_ALIAS
);
const COURSE_SCOPE_HASH = hashCourseScope({
  courseId: COURSE_ID,
  alias: COURSE_ALIAS,
  manifestHash: MANIFEST_HASH
});
const TARGET_VERSION_HASH = hashCourseToolValue(
  "fixture.resolver.target-version",
  "v1"
);
const EVENT_SET_HASH = hashCourseToolValue(
  "fixture.resolver.event-set",
  "v1"
);
const OPPORTUNITY_HASH = hashCourseToolValue(
  "fixture.resolver.opportunity",
  "v1"
);
const REVALIDATION_HASH = hashCourseToolValue(
  "fixture.resolver.revalidation",
  "v1"
);
const AFTER_OBSERVATION_HASH = hashCourseToolValue(
  "fixture.resolver.after-observation",
  "v1"
);
const SERVER_KEY = Buffer.from(
  "resolver-server-key-privacy-sentinel-at-least-32-bytes",
  "utf8"
);
const RAW_TARGET_LOCATOR = "raw-platform-target-privacy-sentinel";
const TARGET_URL =
  "https://forum.example.edu/discussion/url-privacy-sentinel";
const ALLOWED_ORIGIN = "https://forum.example.edu";

function evidence(
  kind: EvidenceRef["kind"],
  id: string,
  hash: string,
  observedAt = NOW
): EvidenceRef {
  return Object.freeze({ kind, id, hash, observedAt });
}

const TARGET: CourseAgentStageTargetMaterial = Object.freeze({
  targetRef: "support-gap:resolver-v2",
  opportunityId: "support-gap:resolver-v2",
  candidateKey: "candidate-resolver-v2",
  decisionId: "decision-resolver-v2",
  threadKey: "thread-resolver-v2",
  targetVersionHash: TARGET_VERSION_HASH,
  eventSetHash: EVENT_SET_HASH,
  opportunityReceiptHash: OPPORTUNITY_HASH,
  revalidationReceiptHash: REVALIDATION_HASH,
  afterObservationReceiptHash: AFTER_OBSERVATION_HASH,
  evidenceRefs: Object.freeze([
    evidence("manifest", COURSE_ALIAS, MANIFEST_HASH),
    evidence("decision", "decision-resolver-v2", OPPORTUNITY_HASH)
  ])
});

function transientRead(
  overrides: Partial<WorkbenchStageTargetTransientReadV2> = {}
): WorkbenchStageTargetTransientReadV2 {
  return {
    schemaVersion: WORKBENCH_STAGE_TARGET_TRANSIENT_READ_SCHEMA_VERSION,
    courseAlias: COURSE_ALIAS,
    courseScopeHash: COURSE_SCOPE_HASH,
    manifestHash: MANIFEST_HASH,
    targetRef: TARGET.targetRef,
    opportunityId: TARGET.opportunityId,
    candidateKey: TARGET.candidateKey,
    decisionId: TARGET.decisionId,
    threadKey: TARGET.threadKey,
    opportunityReceiptHash: TARGET.opportunityReceiptHash,
    sourceRevalidationReceiptHash: TARGET.revalidationReceiptHash,
    sourceAfterObservationReceiptHash: TARGET.afterObservationReceiptHash,
    targetUrl: TARGET_URL,
    allowedOrigin: ALLOWED_ORIGIN,
    targetLocator: RAW_TARGET_LOCATOR,
    targetVersionHash: TARGET_VERSION_HASH,
    eventSetHash: EVENT_SET_HASH,
    observedAt: NOW,
    evidenceRefs: Object.freeze([
      evidence(
        "snapshot",
        "snapshot-resolver-v2",
        hashCourseToolValue("fixture.resolver.snapshot", "v1")
      )
    ]),
    readOnly: true,
    externalWriteAttempted: false,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false,
    ...overrides
  };
}

function resolveInput() {
  return Object.freeze({
    target: TARGET,
    courseAlias: COURSE_ALIAS,
    courseScopeHash: COURSE_SCOPE_HASH,
    manifestHash: MANIFEST_HASH,
    requestedAt: NOW
  });
}

function readerFixture(
  value: unknown = transientRead()
): {
  reader: WorkbenchStageTargetTransientReaderV2;
  calls: () => number;
  requests: () => readonly unknown[];
} {
  let count = 0;
  const requests: unknown[] = [];
  return {
    reader: {
      read: async (request) => {
        count += 1;
        requests.push(request);
        return value;
      }
    },
    calls: () => count,
    requests: () => requests
  };
}

test("resolver v2 is inert until resolve and returns one closed body-free target", async () => {
  const fixture = readerFixture();
  const resolver = createWorkbenchStageTargetResolverV2({
    reader: fixture.reader,
    serverKey: SERVER_KEY,
    now: () => new Date(NOW)
  });
  assert.equal(fixture.calls(), 0);

  const resolved = await resolver.resolve(resolveInput());
  assert.ok(resolved);
  assert.equal(fixture.calls(), 1);
  assert.equal(resolved.schemaVersion, WORKBENCH_STAGE_TARGET_RESOLUTION_SCHEMA_VERSION);
  assert.equal(resolved.targetUrl, TARGET_URL);
  assert.equal(resolved.allowedOrigin, ALLOWED_ORIGIN);
  assert.equal(resolved.courseLocatorHash, MANIFEST_HASH);
  assert.equal(
    resolved.targetLocatorHash,
    hashWorkbenchStageTargetLocatorV2({
      serverKey: SERVER_KEY,
      courseAlias: COURSE_ALIAS,
      courseScopeHash: COURSE_SCOPE_HASH,
      manifestHash: MANIFEST_HASH,
      targetRef: TARGET.targetRef,
      threadKey: TARGET.threadKey,
      targetUrl: TARGET_URL,
      allowedOrigin: ALLOWED_ORIGIN,
      targetLocator: RAW_TARGET_LOCATOR
    })
  );
  assert.equal(
    resolved.freshObservation.receipt.schemaVersion,
    PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION
  );
  assert.equal(
    hashPreExecutionTargetObservation(resolved.freshObservation.receipt),
    resolved.freshObservation.receiptHash
  );
  assert.equal(
    resolved.resolvedTargetReceipt.schemaVersion,
    WORKBENCH_RESOLVED_STAGE_TARGET_RECEIPT_SCHEMA_VERSION
  );
  assert.equal(Object.isFrozen(resolved), true);
  assert.equal(Object.isFrozen(resolved.evidenceRefs), true);
  assert.equal(Object.isFrozen(resolved.freshObservation.receipt), true);

  const persistableProjection = JSON.stringify({
    receipt: resolved.resolvedTargetReceipt,
    receiptRef: resolved.resolvedTargetReceiptRef,
    receiptHash: resolved.resolvedTargetReceiptHash,
    evidenceRefs: resolved.evidenceRefs
  });
  for (const sentinel of [
    RAW_TARGET_LOCATOR,
    TARGET_URL,
    ALLOWED_ORIGIN,
    SERVER_KEY.toString("utf8")
  ]) {
    assert.equal(persistableProjection.includes(sentinel), false, sentinel);
  }
  assert.equal(JSON.stringify(fixture.requests()).includes(COURSE_ID), false);
});

test("locator HMAC is stable, full length, and isolated by domain and binding", () => {
  const first = hmacWorkbenchStageLocatorV2({
    serverKey: SERVER_KEY,
    domain: "target-locator",
    locator: RAW_TARGET_LOCATOR
  });
  const second = hmacWorkbenchStageLocatorV2({
    serverKey: Buffer.from(SERVER_KEY),
    domain: "target-locator",
    locator: RAW_TARGET_LOCATOR
  });
  const otherDomain = hmacWorkbenchStageLocatorV2({
    serverKey: SERVER_KEY,
    domain: "course-origin",
    locator: RAW_TARGET_LOCATOR
  });
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, second);
  assert.notEqual(first, otherDomain);

  const base = {
    serverKey: SERVER_KEY,
    courseAlias: COURSE_ALIAS,
    courseScopeHash: COURSE_SCOPE_HASH,
    manifestHash: MANIFEST_HASH,
    targetRef: TARGET.targetRef,
    threadKey: TARGET.threadKey,
    targetUrl: TARGET_URL,
    allowedOrigin: ALLOWED_ORIGIN,
    targetLocator: RAW_TARGET_LOCATOR
  } as const;
  assert.notEqual(
    hashWorkbenchStageTargetLocatorV2(base),
    hashWorkbenchStageTargetLocatorV2({
      ...base,
      threadKey: "thread-resolver-v2-other"
    })
  );
});

test("configuration requires an explicit reader and at least 32 key bytes without side effects", () => {
  const fixture = readerFixture();
  for (const configuration of [
    { reader: undefined, serverKey: SERVER_KEY },
    { reader: fixture.reader, serverKey: Buffer.alloc(31, 1) },
    { reader: fixture.reader, serverKey: "a".repeat(31) },
    { reader: { read: null }, serverKey: SERVER_KEY }
  ]) {
    assert.throws(
      () => createWorkbenchStageTargetResolverV2(configuration as never),
      /WORKBENCH_STAGE_TARGET_RESOLVER_CONFIGURATION_INVALID/
    );
  }
  assert.equal(fixture.calls(), 0);
});

test("invalid request scope fails closed before the transient reader", async () => {
  const invalidTargets = [
    { ...TARGET, threadKey: "" },
    { ...TARGET, targetVersionHash: "0".repeat(63) },
    { ...TARGET, unexpected: "forbidden" }
  ];
  for (const target of invalidTargets) {
    const fixture = readerFixture();
    const resolver = createWorkbenchStageTargetResolverV2({
      reader: fixture.reader,
      serverKey: SERVER_KEY,
      now: () => new Date(NOW)
    });
    assert.equal(
      await resolver.resolve({ ...resolveInput(), target } as never),
      null
    );
    assert.equal(fixture.calls(), 0);
  }

  const fixture = readerFixture();
  const resolver = createWorkbenchStageTargetResolverV2({
    reader: fixture.reader,
    serverKey: SERVER_KEY,
    now: () => new Date(NOW)
  });
  assert.equal(
    await resolver.resolve({ ...resolveInput(), unexpected: true } as never),
    null
  );
  assert.equal(fixture.calls(), 0);
});

test("reader scope, origin, shape, time, evidence, and hashes are exact and fail closed", async () => {
  const stale = "2026-08-13T11:59:29.999Z";
  const future = "2026-08-13T12:00:05.001Z";
  const invalidReads: readonly unknown[] = [
    { ...transientRead(), courseAlias: "other-course" },
    { ...transientRead(), courseScopeHash: hashCourseToolValue("other", "scope") },
    { ...transientRead(), manifestHash: hashCourseToolValue("other", "manifest") },
    { ...transientRead(), targetRef: "support-gap:other" },
    { ...transientRead(), threadKey: "thread-other" },
    { ...transientRead(), decisionId: "decision-other" },
    { ...transientRead(), targetUrl: "https://evil.example/discussion/1" },
    { ...transientRead(), allowedOrigin: "https://evil.example" },
    { ...transientRead(), targetUrl: "http://forum.example.edu/discussion/1" },
    { ...transientRead(), targetUrl: `${TARGET_URL}#editor` },
    { ...transientRead(), targetVersionHash: "A".repeat(64) },
    { ...transientRead(), eventSetHash: "0".repeat(63) },
    { ...transientRead(), observedAt: stale },
    { ...transientRead(), observedAt: future },
    { ...transientRead(), observedAt: "2026-08-13T12:00:00Z" },
    { ...transientRead(), unexpected: "forbidden" },
    {
      ...transientRead(),
      evidenceRefs: [
        { ...transientRead().evidenceRefs[0], unexpected: "forbidden" }
      ]
    },
    {
      ...transientRead(),
      evidenceRefs: [
        evidence("snapshot", RAW_TARGET_LOCATOR, hashCourseToolValue("x", "y"))
      ]
    },
    null
  ];

  for (const [index, read] of invalidReads.entries()) {
    const fixture = readerFixture(read);
    const resolver = createWorkbenchStageTargetResolverV2({
      reader: fixture.reader,
      serverKey: SERVER_KEY,
      now: () => new Date(NOW)
    });
    assert.equal(await resolver.resolve(resolveInput()), null, `case ${index}`);
    assert.equal(fixture.calls(), 1, `case ${index}`);
  }
});

test("fresh later target and event hashes are returned for adapter-level reconcile semantics", async () => {
  const laterTargetVersionHash = hashCourseToolValue(
    "fixture.resolver.target-version",
    "v2"
  );
  const laterEventSetHash = hashCourseToolValue(
    "fixture.resolver.event-set",
    "v2"
  );
  const fixture = readerFixture(
    transientRead({
      targetVersionHash: laterTargetVersionHash,
      eventSetHash: laterEventSetHash
    })
  );
  const resolver = createWorkbenchStageTargetResolverV2({
    reader: fixture.reader,
    serverKey: SERVER_KEY,
    now: () => new Date(NOW)
  });
  const resolved = await resolver.resolve(resolveInput());
  assert.ok(resolved);
  assert.equal(resolved.targetVersionHash, laterTargetVersionHash);
  assert.equal(resolved.eventSetHash, laterEventSetHash);
  assert.equal(resolved.resolvedTargetReceipt.targetVersionHash, laterTargetVersionHash);
  assert.equal(resolved.resolvedTargetReceipt.eventSetHash, laterEventSetHash);
});

test("reader errors converge to null without leaking private error material", async () => {
  const privateError = "private-reader-error-credential-sentinel";
  let calls = 0;
  const resolver = createWorkbenchStageTargetResolverV2({
    reader: {
      read: async () => {
        calls += 1;
        throw new Error(privateError);
      }
    },
    serverKey: SERVER_KEY,
    now: () => new Date(NOW)
  });
  const result = await resolver.resolve(resolveInput());
  assert.equal(result, null);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(result).includes(privateError), false);
});

test("resolver factory is server-only and rejects a browser runtime before reader access", () => {
  const fixture = readerFixture();
  const prior = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    Object.defineProperty(globalThis, "window", {
      value: {},
      configurable: true,
      writable: true
    });
    assert.throws(
      () =>
        createWorkbenchStageTargetResolverV2({
          reader: fixture.reader,
          serverKey: SERVER_KEY,
          now: () => new Date(NOW)
        }),
      /WORKBENCH_STAGE_TARGET_RESOLVER_SERVER_ONLY/
    );
    assert.equal(fixture.calls(), 0);
  } finally {
    if (prior) {
      Object.defineProperty(globalThis, "window", prior);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
});
