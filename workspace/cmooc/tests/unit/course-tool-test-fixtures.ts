import { createHash } from "node:crypto";
import {
  COURSE_TOOL_SCHEMA_VERSION,
  type CapabilityLevel,
  type CourseToolBusinessInput,
  type CourseToolDefinition,
  type CourseToolExecutionSink,
  type CourseToolHandler,
  type CourseToolRegistration,
  type CourseToolVerificationReport,
  type DurableToolCallProjection,
  type DurableToolCallStartProjection,
  type EffectClass,
  type EvidenceRef,
  type ServerToolExecutionContext,
  type ToolReceiptCommitFence,
  type ToolVerificationCommitContext,
  createJsonCourseToolOutputSchema,
  createJsonCourseToolSchema
} from "../../lib/course-tools/contracts";
import type {
  CourseToolVerifierRegistration,
  CourseToolVerifierResult
} from "../../lib/course-tools/verifier-registry";

export const FIXTURE_NOW = "2026-08-12T12:00:00.000Z";

export type FixtureInput = CourseToolBusinessInput & {
  readonly query: string;
};

export type FixtureOutput = {
  readonly value: string;
  readonly internalDigest?: string;
};

export function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function evidenceRef(
  overrides: Partial<EvidenceRef> = {}
): EvidenceRef {
  return {
    kind: "snapshot",
    id: "snapshot-fixture",
    hash: sha("snapshot-fixture"),
    observedAt: FIXTURE_NOW,
    ...overrides
  };
}

export function serverContext(
  overrides: Partial<ServerToolExecutionContext> = {}
): ServerToolExecutionContext {
  return {
    callId: "call-fixture-001",
    taskId: "task-fixture-001",
    runId: "run-fixture-001",
    planRevisionId: "plan-fixture-001",
    stepId: "step-fixture-001",
    courseScope: {
      courseId: "course-platform-fixture",
      alias: "course-fixture",
      manifestHash: sha("manifest-fixture")
    },
    intent: "implement",
    baseCapability: "L1_ARTIFACT",
    capabilityGrantRefs: [],
    policyVersion: "policy-fixture-v1",
    now: FIXTURE_NOW,
    deadlineAt: "2026-08-12T12:05:00.000Z",
    idempotencyKey: "idempotency-fixture-001",
    attempt: 1,
    executionLeaseId: "lease-fixture-001",
    leaseGeneration: 3,
    fencingToken: "fencing-token-fixture-0123456789abcdef",
    causationId: "cause-fixture-001",
    ...overrides
  };
}

export function fixtureInputSchema() {
  return createJsonCourseToolSchema<FixtureInput>({
    schemaVersion: "fixture.input.v1",
    modelJsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 120 }
      }
    }
  });
}

export function fixtureOutputSchema() {
  return createJsonCourseToolOutputSchema<FixtureOutput>({
    schemaVersion: "fixture.output.v1",
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: {
        value: { type: "string", minLength: 1, maxLength: 240 },
        internalDigest: { type: "string", minLength: 1, maxLength: 240 }
      }
    }
  });
}

export function makeToolRegistration(input: {
  name?: string;
  version?: string;
  capability?: CapabilityLevel;
  effect?: EffectClass;
  defaultForName?: boolean;
  handler?: CourseToolHandler<FixtureInput, FixtureOutput>;
  projectOutput?: CourseToolRegistration<
    FixtureInput,
    FixtureOutput
  >["projectOutput"];
  summarizeInput?: CourseToolRegistration<
    FixtureInput,
    FixtureOutput
  >["summarizeInput"];
  definition?: Partial<
    Omit<
      CourseToolDefinition<FixtureInput, FixtureOutput>,
      | "schemaVersion"
      | "name"
      | "version"
      | "capability"
      | "effect"
      | "inputSchema"
      | "outputSchema"
    >
  >;
} = {}): CourseToolRegistration<FixtureInput, FixtureOutput> {
  const effect = input.effect ?? "read";
  const capability = input.capability ?? capabilityForEffect(effect);
  const external =
    effect === "external_stage" || effect === "irreversible_external";
  const definition: CourseToolDefinition<FixtureInput, FixtureOutput> = {
    schemaVersion: COURSE_TOOL_SCHEMA_VERSION,
    name: input.name ?? "course.fixture_read",
    version: input.version ?? "1",
    safeLabel: input.definition?.safeLabel ?? "Fixture course read",
    safeDescription:
      input.definition?.safeDescription ?? "Reads a bounded fixture value.",
    capability,
    effect,
    inputSchema: fixtureInputSchema(),
    outputSchema: fixtureOutputSchema(),
    dataClasses: input.definition?.dataClasses ?? ["safe_aggregate"],
    preconditions: input.definition?.preconditions ?? [],
    idempotency:
      input.definition?.idempotency ??
      (effect === "external_stage"
        ? { strategy: "stage_nonce", scope: "step" }
        : effect === "irreversible_external"
          ? { strategy: "server_key", scope: "course" }
          : { strategy: "input_hash", scope: "step" }),
    evidence: input.definition?.evidence ?? {
      required: false,
      minimumRefs: 0
    },
    verification: input.definition?.verification ?? {
      required: external,
      subjectType:
        effect === "external_stage" ? "stage_transaction" : "tool_result",
      verifiers: external
        ? [
            {
              name: "verification.fixture",
              version: "1",
              required: true
            }
          ]
        : [],
      mode: "all",
      onFailure: external ? "unknown" : "failed"
    },
    retry: input.definition?.retry ?? {
      maxAttempts: 1,
      retryableStatuses: [],
      backoff: "none"
    },
    ...(input.definition?.recovery
      ? { recovery: input.definition.recovery }
      : effect === "external_stage"
        ? {
            recovery: {
              kind: "trusted_reconcile" as const,
              toolName: "platform.fixture_reconcile",
              toolVersion: "1"
            }
          }
        : effect === "reversible_write"
          ? {
              recovery: {
                kind: "safe_state" as const,
                toolName: "course.fixture_restore",
                toolVersion: "1"
              }
            }
          : {})
  };
  return {
    definition,
    handler:
      input.handler ??
      (async () => ({
        output: { value: "fixture-output" },
        evidenceRefs: [],
        containsForumText: false,
        containsIdentity: false,
        containsSecrets: false
      })),
    summarizeInput: input.summarizeInput,
    projectOutput:
      input.projectOutput ??
      ((output) => ({
        model: { value: output.value },
        safeSummary: "Fixture course tool completed.",
        containsForumText: false,
        containsIdentity: false,
        containsSecrets: false
      })),
    defaultForName: input.defaultForName
  };
}

function capabilityForEffect(effect: EffectClass): CapabilityLevel {
  switch (effect) {
    case "pure":
    case "read":
      return "L0_READ";
    case "local_write":
      return "L1_ARTIFACT";
    case "reversible_write":
      return "L2_REVERSIBLE";
    case "external_stage":
      return "L3_EXTERNAL_STAGE";
    case "irreversible_external":
      return "L4_IRREVERSIBLE";
  }
}

export class CapturingCourseToolSink implements CourseToolExecutionSink {
  appendResult: "accepted" | "duplicate" = "accepted";
  readonly starts: Array<{
    projection: DurableToolCallStartProjection;
    fence: ToolReceiptCommitFence;
  }> = [];
  readonly receipts: Array<{
    projection: DurableToolCallProjection;
    fence: ToolReceiptCommitFence;
  }> = [];
  readonly verifications: Array<{
    report: CourseToolVerificationReport;
    context: ToolVerificationCommitContext;
  }> = [];
  readonly order: string[] = [];

  async appendToolCall(
    projection: DurableToolCallStartProjection,
    fence: ToolReceiptCommitFence
  ): Promise<"accepted" | "duplicate"> {
    this.starts.push({ projection, fence });
    this.order.push("call");
    return this.appendResult;
  }

  async recordVerification(
    report: CourseToolVerificationReport,
    context: ToolVerificationCommitContext
  ): Promise<void> {
    this.verifications.push({ report, context });
    this.order.push("verification");
  }

  async commitToolReceipt(
    projection: DurableToolCallProjection,
    fence: ToolReceiptCommitFence
  ): Promise<void> {
    this.receipts.push({ projection, fence });
    this.order.push("receipt");
  }
}

export function passingVerifier(
  overrides: Partial<CourseToolVerifierResult> = {}
): CourseToolVerifierRegistration {
  return {
    definition: {
      name: "verification.fixture",
      version: "1",
      safeLabel: "Fixture verification"
    },
    verify: async () => ({
      status: "passed",
      checks: [
        {
          code: "fixture_check",
          status: "passed",
          safeSummary: "Fixture postcondition passed."
        }
      ],
      evidenceRefs: [],
      containsForumText: false,
      containsIdentity: false,
      containsSecrets: false,
      ...overrides
    })
  };
}

export function jsonContains(value: unknown, fragment: string): boolean {
  return JSON.stringify(value).includes(fragment);
}
