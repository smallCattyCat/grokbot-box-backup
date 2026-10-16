import {
  hashCourseToolValue,
  type EvidenceRef,
  type ServerToolExecutionContext
} from "@/lib/course-tools/contracts";
import { CourseToolRegistry } from "@/lib/course-tools/registry";
import { CourseToolVerifierRegistry } from "@/lib/course-tools/verifier-registry";
import {
  createFacilitationArtifactToolRegistrations,
  createFacilitationArtifactVerifierRegistrations,
  createTrustedReplyDraftCorrection,
  verifyReplyDraftCreateOutputV2,
  type VerifiedReplyDraftRecoveryMaterialV2,
  type ReplyDraftCreateOutput
} from "@/lib/course-tools/tools/facilitation-artifacts";
import {
  createPlatformStageToolRegistrations,
  createPlatformStageVerifierRegistrations,
  type TrustedPlatformStageAdapter
} from "@/lib/course-tools/tools/platform-stage";
import {
  createCourseEvidenceToolRegistrations,
  createCourseEvidenceVerifierRegistrations
} from "@/lib/course-tools/tools/register-evidence-tools";
import {
  createCourseOperationsToolRegistrations,
  createCourseOperationsVerifierRegistrations
} from "@/lib/course-tools/tools/course-operations";
import {
  createCourseAgentArtifactRuntime,
  type CourseAgentArtifactRuntimeOptions
} from "@/lib/workbench/course-agent-artifact-runtime";
import type { CourseAgentToolOutcomeListener } from "@/lib/workbench/course-agent-runtime";
import { bindProtectedArtifactPreview } from "@/lib/workbench/protected-artifact-preview-controller";
import type { CourseToolVerifierResult } from "@/lib/course-tools/verifier-registry";

export const COURSE_AGENT_TOOLKIT_SCHEMA_VERSION =
  "cmooc.course-agent-toolkit.v1" as const;

export type CourseAgentToolkitOptions = CourseAgentArtifactRuntimeOptions & {
  readonly platformStageAdapter?: TrustedPlatformStageAdapter;
  readonly platformStageAdapterFactory?: (input: {
    readonly materialLedger: ReturnType<
      typeof createCourseAgentArtifactRuntime
    >["materialLedger"];
    readonly protectedMaterialVault: ReturnType<
      typeof createCourseAgentArtifactRuntime
    >["protectedMaterialVault"];
    readonly protectedStore: ReturnType<
      typeof createCourseAgentArtifactRuntime
    >["dependencies"]["protectedStore"];
  }) => TrustedPlatformStageAdapter;
};

export type CourseAgentToolkit = Readonly<{
  schemaVersion: typeof COURSE_AGENT_TOOLKIT_SCHEMA_VERSION;
  registry: CourseToolRegistry;
  verifierRegistry: CourseToolVerifierRegistry;
  onToolOutcome: CourseAgentToolOutcomeListener;
  protectedStore: ReturnType<
    typeof createCourseAgentArtifactRuntime
  >["dependencies"]["protectedStore"];
  correctProtectedDraft?: (input: {
    readonly prior: VerifiedReplyDraftRecoveryMaterialV2;
    readonly priorVersionRef: string;
    readonly feedbackRef: string;
    readonly evidenceRefs: readonly EvidenceRef[];
    readonly correctedBody: string;
    readonly idempotencyKey: string;
    readonly now: string;
  }) => Promise<Readonly<{
    output: ReplyDraftCreateOutput;
    verification: CourseToolVerifierResult;
  }>>;
}>;

function manifestEvidence(
  context: Readonly<ServerToolExecutionContext>
): readonly EvidenceRef[] {
  const manifestHash = context.courseScope.manifestHash;
  if (!manifestHash) {
    throw new Error("COURSE_AGENT_EXACT_MANIFEST_REQUIRED");
  }
  return Object.freeze([
    Object.freeze({
      kind: "manifest" as const,
      id: context.courseScope.alias,
      hash: manifestHash,
      observedAt: context.now
    })
  ]);
}

/**
 * Honest process-local fallback used until a bound Chrome companion is
 * attached. It performs no browser or platform operation: preflight reports
 * waiting, while any impossible direct STAGE/reconcile call fails closed.
 */
export function createUnavailablePlatformStageAdapter(): TrustedPlatformStageAdapter {
  const adapter: TrustedPlatformStageAdapter = {
    preflightRead: async ({ targetRef, context }) => {
      const preflightHash = hashCourseToolValue(
        "cmooc.platform-preflight-unavailable.v1",
        {
          targetRef,
          courseAlias: context.courseScope.alias,
          manifestHash: context.courseScope.manifestHash ?? null,
          observedAt: context.now,
          reasonCode: "browser_unavailable"
        }
      );
      return Object.freeze({
        schemaVersion: "cmooc.course-tool.platform-preflight-output.v1" as const,
        status: "waiting_for_browser" as const,
        reasonCode: "browser_unavailable" as const,
        preflightRef: `preflight-unavailable-${preflightHash.slice(0, 32)}`,
        preflightHash,
        targetRef,
        targetVersionHash: null,
        baselineRef: null,
        baselineHash: null,
        pageBindingRef: null,
        pageBindingHash: null,
        baselineStatus: "unknown" as const,
        observedAt: context.now,
        evidenceRefs: manifestEvidence(context),
        containsForumText: false as const,
        containsIdentity: false as const,
        containsSecrets: false as const
      });
    },
    stageVerifyClear: async ({ context }) =>
      Object.freeze({
        status: "failed_before_write" as const,
        reasonCode: "grant_binding_invalid" as const,
        evidenceRefs: manifestEvidence(context),
        observedAt: context.now
      }),
    reconcileStage: async ({ stageTransactionRef, context }) =>
      Object.freeze({
        status: "blocked" as const,
        reasonCode: "transaction_not_found" as const,
        stageTransactionRef,
        evidenceRefs: manifestEvidence(context),
        observedAt: context.now
      })
  };
  return Object.freeze(adapter);
}

export function createCourseAgentToolkit(
  options: CourseAgentToolkitOptions
): CourseAgentToolkit {
  if (options.platformStageAdapter && options.platformStageAdapterFactory) {
    throw new Error("COURSE_AGENT_PLATFORM_STAGE_ADAPTER_CONFLICT");
  }
  const artifactRuntime = createCourseAgentArtifactRuntime(options);
  const platformStageAdapter =
    options.platformStageAdapter ??
    options.platformStageAdapterFactory?.({
      materialLedger: artifactRuntime.materialLedger,
      protectedMaterialVault: artifactRuntime.protectedMaterialVault,
      protectedStore: artifactRuntime.dependencies.protectedStore
    }) ??
    createUnavailablePlatformStageAdapter();
  const evidenceTools = createCourseEvidenceToolRegistrations({
    prisma: options.prisma
  });
  const artifactTools = createFacilitationArtifactToolRegistrations(
    artifactRuntime.dependencies
  );
  const platformTools = createPlatformStageToolRegistrations({
    trustedDriver: platformStageAdapter
  });
  const courseOperationsTools = createCourseOperationsToolRegistrations({
    prisma: options.prisma
  });
  const registry = new CourseToolRegistry()
    .register(evidenceTools[0])
    .register(evidenceTools[1])
    .register(evidenceTools[2])
    .register(evidenceTools[3])
    .register(evidenceTools[4])
    .register(evidenceTools[5])
    .register(artifactTools[0])
    .register(artifactTools[1])
    .register(artifactTools[2])
    .register(artifactTools[3])
    .register(platformTools[0])
    .register(platformTools[1])
    .register(platformTools[2])
    .register(courseOperationsTools[0])
    .register(courseOperationsTools[1])
    .register(courseOperationsTools[2])
    .seal();

  const evidenceVerifiers = createCourseEvidenceVerifierRegistrations({
    prisma: options.prisma
  });
  const artifactVerifiers = createFacilitationArtifactVerifierRegistrations({
    protectedStore: artifactRuntime.dependencies.protectedStore
  });
  const platformVerifiers = createPlatformStageVerifierRegistrations();
  const courseOperationsVerifiers = createCourseOperationsVerifierRegistrations({
    prisma: options.prisma
  });
  const verifierRegistry = new CourseToolVerifierRegistry()
    .register(evidenceVerifiers[0])
    .register(artifactVerifiers[0])
    .register(artifactVerifiers[1])
    .register(artifactVerifiers[2])
    .register(platformVerifiers[0])
    .register(courseOperationsVerifiers[0])
    .register(courseOperationsVerifiers[1])
    .register(courseOperationsVerifiers[2])
    .seal();

  const onToolOutcome: CourseAgentToolOutcomeListener = async (input) => {
    artifactRuntime.materialLedger.recordToolOutcome({
      toolName: input.toolName,
      context: input.context,
      outcome: input.outcome
    });
    if (
      (input.toolName === "artifact.reply_draft.create" ||
        input.toolName === "artifact.reply_draft.regenerate") &&
      input.outcome.result.status === "succeeded" &&
      input.outcome.verification?.status === "passed"
    ) {
      const output = input.outcome.result.transientOutput as
        | ReplyDraftCreateOutput
        | undefined;
      if (output?.status === "created") {
        bindProtectedArtifactPreview({
          taskId: input.context.taskId,
          runId: input.context.runId,
          versionRef: output.artifact.versionRef,
          contentHash: output.artifact.contentHash,
          draftBodyHash: output.artifact.draftBodyHash,
          protectedRef: output.artifact.protectedRef,
          protectedStore: artifactRuntime.dependencies.protectedStore,
          protectedExpiresAt: output.artifact.expiresAt,
          now: new Date(input.context.now)
        });
      }
    }
  };

  return Object.freeze({
    schemaVersion: COURSE_AGENT_TOOLKIT_SCHEMA_VERSION,
    registry,
    verifierRegistry,
    onToolOutcome,
    protectedStore: artifactRuntime.dependencies.protectedStore,
    correctProtectedDraft: async (input) => {
      const priorDraft = artifactRuntime.materialLedger.draft(
        input.priorVersionRef
      );
      const composition = artifactRuntime.materialLedger.composition(
        input.prior.compositionRef
      );
      if (
        !priorDraft ||
        !composition ||
        priorDraft.contentHash !== input.prior.contentHash ||
        priorDraft.draftBodyHash !== input.prior.draftBodyHash ||
        priorDraft.compositionRef !== input.prior.compositionRef
      ) {
        throw new Error("WORKBENCH_PROTECTED_CORRECTION_PRIOR_MISMATCH");
      }
      const context: ServerToolExecutionContext = Object.freeze({
        callId: `protected-correction-${input.idempotencyKey.slice(-48)}`,
        taskId: options.taskId,
        runId: options.runId,
        planRevisionId: "protected-artifact-correction",
        stepId: "protected-artifact-correction",
        courseScope: Object.freeze({
          courseId: options.courseAlias,
          alias: options.courseAlias
        }),
        intent: "implement",
        baseCapability: "L1_ARTIFACT",
        capabilityGrantRefs: Object.freeze([]),
        policyVersion: input.prior.toolPolicyVersion,
        now: input.now,
        deadlineAt: new Date(Date.parse(input.now) + 60_000).toISOString(),
        idempotencyKey: input.idempotencyKey,
        attempt: 1,
        executionLeaseId: "protected-artifact-correction",
        leaseGeneration: 1,
        fencingToken: "protected-artifact-correction"
      });
      const output = await createTrustedReplyDraftCorrection({
        deps: artifactRuntime.dependencies,
        prior: input.prior,
        priorVersionRef: input.priorVersionRef,
        feedbackRef: input.feedbackRef,
        logicalDraftKey: `support-gap-draft:${composition.decisionId}`,
        evidenceRefs: input.evidenceRefs,
        correctedBody: input.correctedBody,
        context
      });
      const verification = await verifyReplyDraftCreateOutputV2({
        protectedStore: artifactRuntime.dependencies.protectedStore,
        taskId: options.taskId,
        runId: options.runId,
        now: input.now,
        output,
        evidenceRefs: input.evidenceRefs
      });
      if (verification.status !== "passed") {
        throw new Error("WORKBENCH_PROTECTED_CORRECTION_VERIFICATION_FAILED");
      }
      bindProtectedArtifactPreview({
        taskId: options.taskId,
        runId: options.runId,
        versionRef: output.artifact.versionRef,
        contentHash: output.artifact.contentHash,
        draftBodyHash: output.artifact.draftBodyHash,
        protectedRef: output.artifact.protectedRef,
        protectedStore: artifactRuntime.dependencies.protectedStore,
        protectedExpiresAt: output.artifact.expiresAt,
        now: new Date(input.now)
      });
      return Object.freeze({ output, verification });
    }
  });
}
