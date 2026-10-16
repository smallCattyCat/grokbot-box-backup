import {
  PROTOCOL_SCHEMA_VERSIONS,
  canonicalProtocolHash,
  type ExecutionCommandV1
} from "../lib/facilitation-protocol";
import {
  CmoocApiAdapter,
  CmoocBrowserDiagnosticAdapter,
  ForumAdapterRegistry,
  MockForumAdapter,
  SyntheticTimelineForumAdapter,
  syntheticTimelineScopeLocator,
  type BrowserDiagnosticProbe
} from "../lib/forum-adapters";

const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function command(
  expectedTargetHash: string,
  suffix: string
): ExecutionCommandV1 {
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.executionCommand,
    commandId: `command:audit:${suffix}`,
    correlationId: `correlation:audit:${suffix}`,
    capability: "forum.execute_authorized",
    taskRefHash: HASH_A,
    reviewBundleHash: HASH_B,
    authorizationRefHash: HASH_A,
    idempotencyKey: canonicalProtocolHash(
      "cmooc.p4b-adapter-audit-idempotency.v1",
      { suffix }
    ),
    budgetReservationRefHash: HASH_A,
    expectedTargetHash,
    contentHash: HASH_B,
    gatewayPolicyVersion: "gateway.audit.v1",
    issuedAt: "2025-12-31T23:55:00.000Z",
    expiresAt: "2026-01-01T01:00:00.000Z",
    containsForumText: false
  };
}

async function main(): Promise<void> {
  const clock = () => new Date(FIXED_NOW);
  let networkDependencyInvocationCount = 0;
  const poison = async (): Promise<never> => {
    networkDependencyInvocationCount += 1;
    throw new Error("P4B_ADAPTER_AUDIT_NETWORK_DEPENDENCY_FORBIDDEN");
  };
  const browserProbe: BrowserDiagnosticProbe = {
    inspectAuth: poison,
    readThreadList: poison,
    readThreadDetail: poison
  };

  const mock = new MockForumAdapter({
    clock,
    threads: [
      {
        stableThreadRef: "audit-thread-001",
        courseKey: "course:audit",
        platformCourseRef: "platform-course-audit",
        locator: "mock://forum/audit-thread-001",
        authorRef: "audit-author-001",
        title: "synthetic audit title",
        content: "synthetic audit body",
        createdAt: "2025-12-31T22:00:00.000Z",
        updatedAt: "2025-12-31T22:10:00.000Z",
        comments: [
          {
            stableCommentRef: "audit-comment-001",
            parentRef: null,
            authorRef: "audit-author-002",
            content: "synthetic audit comment",
            createdAt: "2025-12-31T22:20:00.000Z"
          }
        ]
      }
    ]
  });
  const timeline = new SyntheticTimelineForumAdapter({
    clock,
    timelines: [
      {
        stableTimelineRef: "audit-timeline-001",
        courseKey: "course:audit-timeline",
        platformCourseRef: "space:audit-timeline",
        topicLabel: "synthetic timeline audit topic",
        rootMessageRef: "audit-message-root",
        messages: [
          {
            stableMessageRef: "audit-message-root",
            parentMessageRef: null,
            actorRef: "audit-actor-root",
            body: "synthetic timeline audit root",
            createdAt: "2025-12-31T21:00:00.000Z",
            updatedAt: "2025-12-31T21:00:00.000Z",
            revision: 1
          },
          {
            stableMessageRef: "audit-message-reply",
            parentMessageRef: "audit-message-root",
            actorRef: "audit-actor-reply",
            body: "synthetic timeline audit reply",
            createdAt: "2025-12-31T21:30:00.000Z",
            updatedAt: "2025-12-31T21:30:00.000Z",
            revision: 1
          }
        ]
      }
    ]
  });
  const cmooc = new CmoocApiAdapter({
    dependencies: {
      clock,
      inspectAuth: poison,
      fetchThreads: poison,
      fetchThread: poison
    }
  });
  const browser = new CmoocBrowserDiagnosticAdapter({
    probe: browserProbe,
    clock
  });
  const registry = new ForumAdapterRegistry()
    .register(browser)
    .register(cmooc)
    .register(mock)
    .register(timeline);

  const mockPage = await mock.listThreads({
    courseKey: "course:audit",
    platformCourseRef: "platform-course-audit"
  });
  const mockThreadRef = mockPage.items[0]?.threadRef;
  if (!mockThreadRef) {
    throw new Error("P4B_ADAPTER_AUDIT_MOCK_THREAD_MISSING");
  }
  const mockObservation = await mock.observeThread(mockThreadRef);
  const mockTarget = await mock.bindTarget({
    thread: mockThreadRef,
    targetType: "comment",
    targetObject: "specific_participant",
    stableTargetRef: "audit-comment-001"
  });
  const mockReceipt = await mock.executeAuthorized(
    command(
      canonicalProtocolHash(mockTarget.schemaVersion, mockTarget),
      "mock"
    )
  );

  const timelinePage = await timeline.listThreads({
    courseKey: "course:audit-timeline",
    platformCourseRef: "space:audit-timeline",
    locator: syntheticTimelineScopeLocator("space:audit-timeline")
  });
  const timelineThreadRef = timelinePage.items[0]?.threadRef;
  if (!timelineThreadRef) {
    throw new Error("P4B_ADAPTER_AUDIT_TIMELINE_MISSING");
  }
  const timelineObservation =
    await timeline.observeThread(timelineThreadRef);
  const timelineTarget = await timeline.bindTarget({
    thread: timelineThreadRef,
    targetType: "comment",
    targetObject: "specific_participant",
    stableTargetRef: "audit-message-reply"
  });
  const timelineReceipt = await timeline.executeAuthorized(
    command(
      canonicalProtocolHash(
        timelineTarget.schemaVersion,
        timelineTarget
      ),
      "timeline"
    )
  );

  const readOnlyExecutions = await Promise.all(
    [cmooc, browser].map(async (adapter) => {
      const executionCommand = command(
        HASH_A,
        adapter.manifest().adapterId
      );
      const preflight = await adapter.preflight(executionCommand);
      const receipt =
        await adapter.executeAuthorized(executionCommand);
      return {
        adapterId: adapter.manifest().adapterId,
        preflightStatus: preflight.status,
        outcome: receipt.outcome,
        attemptedAt: receipt.attemptedAt
      };
    })
  );
  const manifests = registry.manifests();
  const registrySnapshot = registry.snapshot();
  const externalWriteAttemptCount = readOnlyExecutions.filter(
    (entry) => entry.attemptedAt !== null
  ).length;
  const syntheticReceipts = [mockReceipt, timelineReceipt];
  const syntheticExecutionCount = syntheticReceipts.filter(
    (receipt) => receipt.attemptedAt !== null
  ).length;
  const expectedReadOnlyAdapterIds = manifests
    .filter((manifest) => manifest.externalWriteMode === "none")
    .map((manifest) => manifest.adapterId)
    .sort();
  const auditedReadOnlyAdapterIds = readOnlyExecutions
    .map((entry) => entry.adapterId)
    .sort();
  const expectedSyntheticExecutionCount = manifests.filter(
    (manifest) => manifest.externalWriteMode === "synthetic_only"
  ).length;

  if (
    registrySnapshot.adapterCount !== 4 ||
    registrySnapshot.realExternalWriteAdapterCount !== 0 ||
    JSON.stringify(auditedReadOnlyAdapterIds) !==
      JSON.stringify(expectedReadOnlyAdapterIds) ||
    externalWriteAttemptCount !== 0 ||
    networkDependencyInvocationCount !== 0 ||
    syntheticExecutionCount !== expectedSyntheticExecutionCount ||
    readOnlyExecutions.some(
      (entry) =>
        entry.preflightStatus !== "denied" ||
        entry.outcome !== "confirmed_not_attempted"
    )
  ) {
    throw new Error("P4B_ADAPTER_AUDIT_BOUNDARY_VIOLATION");
  }

  const summary = {
    ok: true,
    schemaVersion: "cmooc.p4b-adapter-audit.v2",
    registry: registrySnapshot,
    adapters: manifests.map((manifest) => ({
      adapterId: manifest.adapterId,
      platformId: manifest.platformId,
      transport: manifest.transport,
      externalWriteMode: manifest.externalWriteMode,
      supportsVirtualClock: manifest.supportsVirtualClock,
      executeAuthorizedAdvertised:
        manifest.capabilities.executeAuthorized
    })),
    readOnlyExecutionEvidence: readOnlyExecutions,
    syntheticEvidence: {
      mockObservationHash: canonicalProtocolHash(
        mockObservation.schemaVersion,
        mockObservation
      ),
      mockTargetHash: canonicalProtocolHash(
        mockTarget.schemaVersion,
        mockTarget
      ),
      timelineObservationHash: canonicalProtocolHash(
        timelineObservation.schemaVersion,
        timelineObservation
      ),
      timelineTargetHash: canonicalProtocolHash(
        timelineTarget.schemaVersion,
        timelineTarget
      )
    },
    externalWriteAttemptCount,
    networkDependencyInvocationCount,
    syntheticExecutionCount,
    containsForumText: false
  };
  const serialized = JSON.stringify(summary);
  for (const forbidden of [
    "synthetic audit title",
    "synthetic audit body",
    "synthetic audit comment",
    "synthetic timeline audit topic",
    "synthetic timeline audit root",
    "synthetic timeline audit reply",
    "secret-token-value"
  ]) {
    if (serialized.includes(forbidden)) {
      throw new Error("P4B_ADAPTER_AUDIT_FORUM_TEXT_LEAK");
    }
  }
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? `P4B_ADAPTER_AUDIT_FAILED: ${error.message}`
      : "P4B_ADAPTER_AUDIT_FAILED"
  );
  process.exitCode = 1;
});
