import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import {
  type CourseToolBusinessInput,
  type CourseToolJsonValue,
  type ServerToolExecutionContext,
  type ToolExecutionEnvelope,
  assertSafeCourseToolProjection
} from "../../lib/course-tools/contracts";
import type { CourseToolRegistry } from "../../lib/course-tools/registry";
import { CourseToolExecutor } from "../../lib/course-tools/executor";
import { CourseToolPolicyGateway } from "../../lib/course-tools/policy-gateway";
import {
  buildEvidenceWaterfall
} from "../../lib/workbench/course-evidence-workspace";
import {
  resolveCourseContext,
  type CourseSnapshotReadResult,
  type ResolvedCourseContext
} from "../../lib/course-tools/tools/course-context";
import {
  selectSupportGap,
  verifyOpportunityIntegrity,
  type OpportunityListResult,
  type SupportGapOpportunityEvidence
} from "../../lib/course-tools/tools/opportunity-evidence";
import {
  SUPPORT_GAP_SELECTION_POLICY_VERSION,
  OPPORTUNITY_INTEGRITY_VERIFIER_NAME,
  createCourseEvidenceToolRegistrations,
  createCourseEvidenceToolRegistry,
  createCourseEvidenceVerifierRegistry,
  parseOpportunitySelectionToolOutput,
  parseOpportunityVerificationToolOutput
} from "../../lib/course-tools/tools/register-evidence-tools";
import {
  CapturingCourseToolSink,
  serverContext,
  sha
} from "./course-tool-test-fixtures";

const NOW = "2026-08-12T12:00:00.000Z";

function contextFixture(
  overrides: Partial<ResolvedCourseContext["anchor"]> = {}
): ResolvedCourseContext {
  const anchor = {
    courseAlias: "course-fixture",
    invocationId: "invocation-fixture",
    snapshotId: "snapshot-fixture",
    manifestHash: sha("manifest-fixture"),
    worldHash: sha("world-fixture"),
    eventSetHash: sha("events-fixture"),
    coverageHash: sha("coverage-fixture"),
    candidateSetHash: sha("candidate-set-fixture"),
    worldAsOf: NOW,
    ...overrides
  };
  return {
    schemaVersion: "cmooc.course-tool.course-context.v1",
    status: "resolved",
    anchor,
    evidenceRefs: [
      {
        kind: "manifest",
        id: anchor.courseAlias,
        hash: anchor.manifestHash,
        observedAt: NOW
      },
      {
        kind: "invocation",
        id: anchor.invocationId,
        hash: anchor.manifestHash,
        observedAt: NOW
      },
      {
        kind: "snapshot",
        id: anchor.snapshotId,
        hash: anchor.worldHash,
        observedAt: NOW
      },
      {
        kind: "coverage",
        id: "coverage-fixture",
        hash: anchor.coverageHash,
        observedAt: NOW
      },
      {
        kind: "candidate",
        id: "candidate-set-fixture",
        hash: anchor.candidateSetHash,
        observedAt: NOW
      }
    ],
    containsForumText: false,
    containsIdentity: false
  };
}

function snapshotFixture(
  context = contextFixture()
): CourseSnapshotReadResult {
  return {
    schemaVersion: "cmooc.course-tool.course-snapshot.v1",
    status: "ready",
    anchor: context.anchor,
    snapshot: {
      eventCount: 20,
      threadCount: 4,
      actorCount: 7,
      edgeCount: 8,
      openGapCount: 1
    },
    freshness: {
      observedAt: context.anchor.worldAsOf,
      basis: "exact_world_snapshot"
    },
    evidenceRefs: context.evidenceRefs,
    containsForumText: false,
    containsIdentity: false
  };
}

function opportunityFixture(input: {
  context?: ResolvedCourseContext;
  policyDecision?: SupportGapOpportunityEvidence["policy"]["decision"];
  qualificationStatus?: SupportGapOpportunityEvidence["qualification"]["status"];
  qualificationIntegrity?: SupportGapOpportunityEvidence["integrity"]["qualification"];
} = {}): SupportGapOpportunityEvidence {
  const context = input.context ?? contextFixture();
  const candidateKey = sha("candidate-fixture");
  const stateHash = sha("thread-state-fixture");
  const predicates: SupportGapOpportunityEvidence["target"]["predicates"] = [
    { code: "candidate_target_bound", status: "passed", safeValue: true },
    { code: "target_state_hash_valid", status: "passed", safeValue: true },
    { code: "target_complete", status: "passed", safeValue: "complete" },
    { code: "support_gap_mature", status: "passed", safeValue: 96 },
    {
      code: "no_external_human_response",
      status: "passed",
      safeValue: 0
    },
    {
      code: "no_distinct_actor_response",
      status: "passed",
      safeValue: 0
    },
    { code: "no_author_return", status: "passed", safeValue: 0 },
    { code: "no_system_response", status: "passed", safeValue: 0 }
  ];
  const qualificationStatus = input.qualificationStatus ?? "qualified";
  const qualificationIntegrity = input.qualificationIntegrity ?? "verified";
  return {
    schemaVersion: "cmooc.course-tool.opportunity-evidence.v1",
    opportunityId: `support-gap:${candidateKey}`,
    kind: "support_gap",
    candidateKey,
    exactAnchor: context.anchor,
    claim: {
      kind: "mature_support_gap",
      contentGraphRequired: false
    },
    target: {
      targetVersionHash: sha("target-version-fixture"),
      stateHash,
      supportGapHours: 96,
      predicates
    },
    qualification: {
      status: qualificationStatus,
      decisionRef:
        qualificationStatus === "unknown" ? null : "decision:decision-fixture",
      opportunityReceiptHash:
        qualificationStatus === "unknown"
          ? null
          : sha("opportunity-receipt-fixture"),
      waterfall:
        qualificationStatus === "unknown"
          ? buildEvidenceWaterfall(null)
          : buildEvidenceWaterfall({
              answerability: "qualified",
              formatValid: true,
              evidenceLegal: true,
              relationCorrect: true,
              temporalLegal: true,
              supportResolution: "resolved"
            })
    },
    graphIntegrity: {
      status: "unavailable",
      reasonCode: "content_graph_missing",
      contentGraphHash: null,
      nodeSetHash: null,
      edgeSetHash: null,
      nodeCount: null,
      edgeCount: null,
      learnerNodeCount: null,
      requiredForClaim: false
    },
    policy: {
      decision: input.policyDecision ?? "draft",
      reasonCodes:
        input.policyDecision && input.policyDecision !== "draft"
          ? ["anchored_decision_no_action"]
          : []
    },
    integrity: {
      candidateSet: "verified",
      targetProjection: "verified",
      qualification: qualificationIntegrity
    },
    status:
      input.policyDecision && input.policyDecision !== "draft"
        ? "policy_no_safe_action"
        : qualificationStatus === "unknown"
          ? "evidence_unavailable"
          : "eligible",
    limitations: [],
    evidenceRefs: [
      ...context.evidenceRefs,
      {
        kind: "target_projection",
        id: candidateKey,
        hash: stateHash,
        observedAt: NOW
      },
      ...(qualificationStatus === "unknown"
        ? []
        : [
            {
              kind: "qualification" as const,
              id: "decision:decision-fixture",
              hash: sha("opportunity-receipt-fixture"),
              observedAt: NOW
            }
          ])
    ],
    containsForumText: false,
    containsIdentity: false
  };
}

function listFixture(input: {
  context?: ResolvedCourseContext;
  outcome?: OpportunityListResult["outcome"];
  items?: SupportGapOpportunityEvidence[];
} = {}): OpportunityListResult {
  const context = input.context ?? contextFixture();
  const items = input.items ?? [opportunityFixture({ context })];
  return {
    schemaVersion: "cmooc.course-tool.opportunity-list.v1",
    status: "ready",
    outcome: input.outcome ?? "opportunities_available",
    exactAnchor: context.anchor,
    sourceCompleteness: {
      coverageReceiptVerified: true,
      courseCoverageComplete: true,
      candidateSetVerified: true,
      allCandidateTargetsAccountedFor: true
    },
    totalCandidateCount: items.length,
    items,
    limitations: [],
    containsForumText: false,
    containsIdentity: false
  };
}

async function invoke(
  registry: CourseToolRegistry,
  name: string,
  input: Record<string, CourseToolJsonValue>,
  context: ServerToolExecutionContext = serverContext()
) {
  const registration = registry.resolve(name, "1");
  const parsed = registration.definition.inputSchema.parse(input);
  const result = await registration.handler({
    input: parsed,
    context,
    envelope: {} as ToolExecutionEnvelope<CourseToolBusinessInput>
  });
  const output = registration.definition.outputSchema.parse(result.output);
  const projection = registration.projectOutput(output, context);
  assertSafeCourseToolProjection(projection);
  return { registration, result, output, projection };
}

function asObject(value: CourseToolJsonValue): Record<string, CourseToolJsonValue> {
  assert.equal(value !== null && !Array.isArray(value) && typeof value === "object", true);
  return value as Record<string, CourseToolJsonValue>;
}

test("evidence tool registry exposes six sealed L0 reads with closed business-only schemas", () => {
  const registrations = createCourseEvidenceToolRegistrations();
  const registry = createCourseEvidenceToolRegistry();
  assert.equal(registry.sealed, true);
  assert.deepEqual(
    registrations.map((registration) => registration.definition.name),
    [
      "course.context.resolve",
      "course.snapshot.read",
      "opportunity.list",
      "evidence.read_opportunity",
      "evidence.verify_integrity",
      "opportunity.select_support_gap"
    ]
  );
  for (const registration of registrations) {
    assert.equal(registration.definition.capability, "L0_READ");
    assert.equal(registration.definition.effect, "read");
    if (registration.definition.name === "evidence.verify_integrity") {
      assert.equal(registration.definition.verification.required, true);
      assert.deepEqual(registration.definition.verification.verifiers, [
        {
          name: OPPORTUNITY_INTEGRITY_VERIFIER_NAME,
          version: "1",
          required: true
        }
      ]);
    } else {
      assert.equal(registration.definition.verification.required, false);
      assert.deepEqual(registration.definition.verification.verifiers, []);
    }
    const schema = registration.definition.inputSchema.modelJsonSchema;
    assert.equal(schema?.additionalProperties, false);
    assert.equal(JSON.stringify(schema).includes("courseAlias"), false);
    assert.equal(registration.definition.outputSchema.modelJsonSchema, undefined);
  }

  const contextSchema = registry.resolve("course.context.resolve", "1").definition.inputSchema;
  assert.deepEqual(contextSchema.parse({ contextRef: "invocation:invocation-fixture" }), {
    contextRef: "invocation:invocation-fixture"
  });
  assert.throws(() =>
    contextSchema.parse({
      contextRef: "snapshot:snapshot-fixture",
      courseAlias: "model-injected-course"
    })
  );
  assert.throws(() =>
    registry.resolve("evidence.read_opportunity", "1").definition.inputSchema.parse({
      contextRef: "snapshot:snapshot-fixture",
      opportunityId: `support-gap:${sha("candidate")}`,
      claim: "unsupported_claim"
    })
  );
  assert.throws(() =>
    parseOpportunitySelectionToolOutput({
      schemaVersion: "cmooc.course-tool.opportunity-selection-output.v1",
      extra: "rejected"
    })
  );
  assert.throws(() =>
    parseOpportunityVerificationToolOutput({
      schemaVersion: "cmooc.course-tool.opportunity-verification-output.v1",
      forumText: "rejected"
    })
  );
});

test("all six handlers inject the server course scope and return bounded safe projections", async () => {
  const resolved = contextFixture();
  const opportunity = opportunityFixture({ context: resolved });
  const opportunities = listFixture({ context: resolved, items: [opportunity] });
  const resolveCalls: Array<{ courseAlias: string; contextRef: string }> = [];
  const readClaims: Array<string | undefined> = [];
  const registry = createCourseEvidenceToolRegistry({
    prisma: {} as PrismaClient,
    resolveCourseContext: async (input) => {
      resolveCalls.push({
        courseAlias: input.courseAlias,
        contextRef: input.contextRef
      });
      return resolved;
    },
    readCourseSnapshot: async () => snapshotFixture(resolved),
    listOpportunities: async () => opportunities,
    readOpportunityEvidence: async (input) => {
      readClaims.push(input.claim);
      return opportunity;
    }
  });
  const contextRef = "invocation:invocation-fixture";
  const opportunityInput = {
    contextRef,
    opportunityId: opportunity.opportunityId
  };
  const calls = [
    await invoke(registry, "course.context.resolve", { contextRef }),
    await invoke(registry, "course.snapshot.read", { contextRef }),
    await invoke(registry, "opportunity.list", { contextRef }),
    await invoke(registry, "evidence.read_opportunity", opportunityInput),
    await invoke(registry, "evidence.verify_integrity", opportunityInput),
    await invoke(registry, "opportunity.select_support_gap", { contextRef })
  ];

  assert.equal(resolveCalls.length, 6);
  assert.deepEqual(
    [...new Set(resolveCalls.map((call) => call.courseAlias))],
    ["course-fixture"]
  );
  assert.deepEqual(readClaims, [undefined, undefined]);
  assert.deepEqual(
    calls.map((call) => asObject(call.output).status),
    ["resolved", "ready", "ready", "eligible", "eligible", "selected"]
  );
  assert.equal(
    asObject(calls[5]!.output).selectionPolicyVersion,
    SUPPORT_GAP_SELECTION_POLICY_VERSION
  );
  assert.match(
    String(asObject(calls[4]!.output).integrityVerificationRef),
    /^integrity-verification:[a-f0-9]{64}$/
  );
  assert.match(
    String(asObject(calls[5]!.output).selectionRef),
    /^support-gap-selection:[a-f0-9]{64}$/
  );
  assert.match(
    String(asObject(calls[5]!.output).evidenceBindingHash),
    /^[a-f0-9]{64}$/
  );

  const repeatedSelection = await invoke(
    registry,
    "opportunity.select_support_gap",
    { contextRef }
  );
  assert.equal(
    asObject(repeatedSelection.output).selectionRef,
    asObject(calls[5]!.output).selectionRef
  );
  assert.equal(
    asObject(repeatedSelection.output).evidenceBindingHash,
    asObject(calls[5]!.output).evidenceBindingHash
  );
  const changedPolicySelection = await invoke(
    registry,
    "opportunity.select_support_gap",
    { contextRef },
    serverContext({ policyVersion: "policy-fixture-v2" })
  );
  assert.notEqual(
    asObject(changedPolicySelection.output).evidenceBindingHash,
    asObject(calls[5]!.output).evidenceBindingHash
  );
  for (const call of calls) {
    assert.equal(call.result.containsForumText, false);
    assert.equal(call.result.containsIdentity, false);
    assert.equal(call.result.containsSecrets, false);
    const serialized = JSON.stringify(call.projection.model);
    for (const forbidden of [
      "courseAlias",
      "courseId",
      "threadKey",
      "authorKey",
      "actorKey",
      "forumText",
      "decisionJson",
      "candidatesJson"
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  }
});

test("handler rejects a resolved context that conflicts with trusted server course scope", async () => {
  const registry = createCourseEvidenceToolRegistry({
    prisma: {} as PrismaClient,
    resolveCourseContext: async () =>
      contextFixture({ courseAlias: "course-decoy" })
  });
  await assert.rejects(
    invoke(registry, "course.context.resolve", {
      contextRef: "snapshot:snapshot-fixture"
    }),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "COURSE_CONTEXT_CONFLICT"
      );
      return true;
    }
  );
});

test("integrity tool creates an independent verifier record before its tool receipt", async () => {
  const resolved = contextFixture();
  const opportunity = opportunityFixture({ context: resolved });
  const deps = {
    prisma: {} as PrismaClient,
    resolveCourseContext: async () => resolved,
    readOpportunityEvidence: async () => opportunity
  };
  const registry = createCourseEvidenceToolRegistry(deps);
  let verificationId = 0;
  const verifierRegistry = createCourseEvidenceVerifierRegistry(deps, {
    idFactory: () => `verification-record-${++verificationId}`
  });
  assert.deepEqual(verifierRegistry.manifest().verifiers, [
    {
      name: OPPORTUNITY_INTEGRITY_VERIFIER_NAME,
      version: "1",
      safeLabel: "Replay opportunity integrity"
    }
  ]);
  const sink = new CapturingCourseToolSink();
  const executor = new CourseToolExecutor({
    registry,
    policyGateway: new CourseToolPolicyGateway(),
    verifierRegistry,
    sink,
    receiptIdFactory: () => "evidence-tool-receipt-1"
  });
  const outcome = await executor.execute(
    {
      toolName: "evidence.verify_integrity",
      input: {
        contextRef: "snapshot:snapshot-fixture",
        opportunityId: opportunity.opportunityId
      }
    },
    serverContext({ baseCapability: "L0_READ" })
  );

  assert.equal(outcome.result.status, "succeeded");
  assert.equal(outcome.verification?.status, "passed");
  assert.deepEqual(sink.order, ["call", "verification", "receipt"]);
  assert.equal(sink.verifications.length, 1);
  assert.equal(
    sink.verifications[0]?.report.receipts[0]?.verifier,
    OPPORTUNITY_INTEGRITY_VERIFIER_NAME
  );
  assert.equal(
    sink.receipts[0]?.projection.verificationId,
    sink.verifications[0]?.report.id
  );
  const transient = parseOpportunityVerificationToolOutput(
    outcome.result.transientOutput
  );
  assert.equal(
    sink.verifications[0]?.report.subjectId,
    transient.integrityVerificationRef
  );
  assert.equal(
    JSON.stringify(sink.verifications[0]?.report).includes("threadKey"),
    false
  );
  assert.equal(
    JSON.stringify(sink.verifications[0]?.report).includes("forumText"),
    false
  );
});

test("exact invocation context resolves only its course-bound world snapshot", async () => {
  const manifestHash = sha("manifest-fixture");
  const worldHash = sha("world-fixture");
  const coverageHash = sha("coverage-fixture");
  const candidateSetHash = sha("candidate-set-fixture");
  const invocation = {
    id: "invocation-fixture",
    courseAlias: "course-fixture",
    manifestHash,
    scheduledFor: new Date(NOW),
    worldSnapshot: {
      id: "snapshot-fixture",
      invocationId: "invocation-fixture",
      courseAlias: "course-fixture"
    }
  };
  const db = {
    autonomyCourseManifest: {
      findUnique: async () => ({ alias: "course-fixture", manifestHash })
    },
    scheduledInvocation: { findUnique: async () => invocation },
    courseWorldSnapshot: {
      findUnique: async () => ({
        id: "snapshot-fixture",
        invocationId: "invocation-fixture",
        courseAlias: "course-fixture",
        asOfAt: new Date(NOW),
        eventSetHash: sha("events-fixture"),
        worldHash,
        coverageHash
      })
    },
    courseScanRun: {
      findUnique: async () => ({
        id: "scan-fixture",
        invocationId: "invocation-fixture",
        courseAlias: "course-fixture",
        status: "completed",
        coverageHash,
        finishedAt: new Date(NOW)
      })
    },
    candidateSet: {
      findUnique: async () => ({
        invocationId: "invocation-fixture",
        snapshotId: "snapshot-fixture",
        asOfAt: new Date(NOW),
        candidateSetHash
      })
    }
  } as unknown as PrismaClient;

  const resolved = await resolveCourseContext({
    courseAlias: "course-fixture",
    contextRef: "invocation:invocation-fixture",
    prisma: db
  });
  assert.equal(resolved.anchor.invocationId, "invocation-fixture");
  assert.equal(resolved.anchor.snapshotId, "snapshot-fixture");
  assert.equal(resolved.anchor.courseAlias, "course-fixture");

  const mismatchedDb = {
    scheduledInvocation: {
      findUnique: async () => ({
        ...invocation,
        worldSnapshot: {
          ...invocation.worldSnapshot,
          invocationId: "invocation-decoy"
        }
      })
    }
  } as unknown as PrismaClient;
  await assert.rejects(
    resolveCourseContext({
      courseAlias: "course-fixture",
      contextRef: "invocation:invocation-fixture",
      prisma: mismatchedDb
    }),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "COURSE_CONTEXT_NOT_FOUND"
      );
      return true;
    }
  );
});

test("opportunity verdicts keep no-action, unavailable, and policy boundaries distinct", () => {
  const eligible = opportunityFixture();
  const withoutVerdict = (
    evidence: SupportGapOpportunityEvidence
  ): Omit<SupportGapOpportunityEvidence, "status" | "limitations"> => {
    const { status: _status, limitations: _limitations, ...base } = evidence;
    return base;
  };

  const notGap = structuredClone(eligible);
  const mature = notGap.target.predicates.find(
    (predicate) => predicate.code === "support_gap_mature"
  )!;
  mature.status = "failed";
  mature.safeValue = 12;
  notGap.qualification.status = "unknown";
  notGap.integrity.qualification = "unavailable";
  assert.equal(
    verifyOpportunityIntegrity({ evidence: withoutVerdict(notGap) }).status,
    "not_a_support_gap"
  );

  const unavailable = opportunityFixture({
    qualificationStatus: "unknown",
    qualificationIntegrity: "unavailable"
  });
  assert.equal(
    verifyOpportunityIntegrity({ evidence: withoutVerdict(unavailable) }).status,
    "evidence_unavailable"
  );

  const policyBlocked = opportunityFixture({ policyDecision: "wait" });
  assert.equal(
    verifyOpportunityIntegrity({ evidence: withoutVerdict(policyBlocked) }).status,
    "policy_no_safe_action"
  );

  const noActionList = listFixture({ outcome: "no_action", items: [] });
  assert.equal(selectSupportGap(noActionList).status, "no_action");
});
