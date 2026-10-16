import {
  COURSE_TOOL_SCHEMA_VERSION,
  CourseToolOperationError,
  assertEvidenceRefs,
  createJsonCourseToolOutputSchema,
  createJsonCourseToolSchema,
  isIsoInstant,
  isSafeIdentifier,
  isSha256,
  type CourseToolBusinessInput,
  type CourseToolDefinition,
  type CourseToolJsonValue,
  type CourseToolRegistration,
  type CourseToolSchema,
  type EvidenceRef,
  type ServerToolExecutionContext,
  type ToolExecutionEnvelope
} from "../contracts";
import { defineCourseTool } from "../registry";
import type {
  CourseToolVerifierRegistration,
  CourseToolVerifierResult
} from "../verifier-registry";

export const PLATFORM_STAGE_TOOL_SCHEMA_VERSION =
  "cmooc.course-tool.platform-stage.v1" as const;
export const PLATFORM_PREFLIGHT_OUTPUT_SCHEMA_VERSION =
  "cmooc.course-tool.platform-preflight-output.v1" as const;
export const PLATFORM_STAGE_OUTPUT_SCHEMA_VERSION =
  "cmooc.course-tool.platform-stage-output.v1" as const;
export const PLATFORM_RECONCILE_OUTPUT_SCHEMA_VERSION =
  "cmooc.course-tool.platform-stage-reconcile-output.v1" as const;
export const PLATFORM_STAGE_VERIFIER_NAME =
  "verification.platform_stage_atomic" as const;
export const PLATFORM_STAGE_VERIFIER_VERSION = "1" as const;

const SAFE_REF_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$";
const HASH_PATTERN = "^[a-f0-9]{64}$";
const ISO_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$";

const strictObject = {
  type: "object",
  additionalProperties: false
} as const;

const evidenceRefSchema = {
  ...strictObject,
  required: ["kind", "id", "hash", "observedAt"],
  properties: {
    kind: {
      type: "string",
      enum: [
        "manifest",
        "invocation",
        "snapshot",
        "world",
        "coverage",
        "content_graph",
        "candidate",
        "decision",
        "outcome",
        "artifact",
        "stage_receipt",
        "verification"
      ]
    },
    id: { type: "string", pattern: SAFE_REF_PATTERN },
    hash: { type: "string", pattern: HASH_PATTERN },
    observedAt: { type: "string", pattern: ISO_PATTERN }
  }
} as const;

const privacyFlagSchema = {
  containsForumText: { const: false },
  containsIdentity: { const: false },
  containsSecrets: { const: false }
} as const;

/**
 * The exact target lineage carried from the evidence workspace through the
 * stage adapter. These are opaque refs/hashes only; retaining them allows the
 * executor to verify the full analysis-to-action chain instead of converting
 * a genuinely successful external STAGE transaction into an unknown result.
 */
const PLATFORM_STAGE_ALLOWED_EVIDENCE_KINDS = [
  "manifest",
  "invocation",
  "snapshot",
  "world",
  "coverage",
  "content_graph",
  "candidate",
  "decision",
  "artifact",
  "stage_receipt",
  "verification"
] as const;

/** JSON-shaped receipt reference used inside transient tool output objects. */
type JsonEvidenceRef = {
  readonly [key: string]: CourseToolJsonValue;
  readonly kind: EvidenceRef["kind"];
  readonly id: string;
  readonly hash: string;
  readonly observedAt: string;
};

export type PlatformTargetPreflightInput = CourseToolBusinessInput & {
  readonly targetRef: string;
};

export type PlatformStageVerifyClearInput = CourseToolBusinessInput & {
  readonly targetRef: string;
  readonly artifactVersionRef: string;
  readonly draftBodyHash: string;
  readonly preflightRef: string;
};

export type PlatformStageReconcileInput = CourseToolBusinessInput & {
  readonly stageTransactionRef: string;
};

export type PlatformPreflightBlockedReason =
  | "browser_unavailable"
  | "page_binding_mismatch"
  | "target_stale"
  | "target_mismatch"
  | "editor_not_empty"
  | "baseline_unavailable"
  | "policy_halted";

export type PlatformTargetPreflightOutput = {
  readonly schemaVersion: typeof PLATFORM_PREFLIGHT_OUTPUT_SCHEMA_VERSION;
  readonly status: "ready" | "waiting_for_browser" | "blocked";
  readonly reasonCode: PlatformPreflightBlockedReason | null;
  readonly preflightRef: string;
  readonly preflightHash: string;
  readonly targetRef: string;
  readonly targetVersionHash: string | null;
  readonly baselineRef: string | null;
  readonly baselineHash: string | null;
  readonly pageBindingRef: string | null;
  readonly pageBindingHash: string | null;
  readonly baselineStatus: "empty" | "non_empty" | "unknown";
  readonly observedAt: string;
  readonly evidenceRefs: readonly JsonEvidenceRef[];
  readonly containsForumText: false;
  readonly containsIdentity: false;
  readonly containsSecrets: false;
};

export type PlatformStageVerifiedOutput = {
  readonly schemaVersion: typeof PLATFORM_STAGE_OUTPUT_SCHEMA_VERSION;
  readonly status: "verified_cleared";
  readonly stageTransactionRef: string;
  readonly receiptRef: string;
  readonly receiptHash: string;
  readonly targetRef: string;
  readonly targetVersionHash: string;
  readonly artifactVersionRef: string;
  readonly draftBodyHash: string;
  readonly pageBindingRef: string;
  readonly pageBindingHash: string;
  readonly baselineRef: string;
  readonly baselineHash: string;
  readonly editorWriteCount: 1;
  readonly editorReadbackCount: 1;
  readonly editorReadbackVerified: true;
  readonly editorClearCount: 1;
  readonly editorEmptyAfterClear: true;
  readonly submitMutationCount: 0;
  readonly sendMutationCount: 0;
  readonly closeAuditStatus: "passed";
  readonly realPublishEnabled: false;
  readonly bodyPersisted: false;
  readonly published: false;
  readonly observedAt: string;
  readonly evidenceRefs: readonly JsonEvidenceRef[];
  readonly containsForumText: false;
  readonly containsIdentity: false;
  readonly containsSecrets: false;
};

export type PlatformStageReconciledOutput = Omit<
  PlatformStageVerifiedOutput,
  "schemaVersion" | "status"
> & {
  readonly schemaVersion: typeof PLATFORM_RECONCILE_OUTPUT_SCHEMA_VERSION;
  readonly status: "reconciled_cleared";
  readonly resolution: "already_verified" | "owned_draft_cleared";
};

export type TrustedPlatformTargetPreflightMaterial = Omit<
  PlatformTargetPreflightOutput,
  "evidenceRefs"
> & {
  readonly evidenceRefs: readonly EvidenceRef[];
};

export type TrustedPlatformStageVerifiedMaterial = Omit<
  PlatformStageVerifiedOutput,
  "evidenceRefs"
> & {
  readonly evidenceRefs: readonly EvidenceRef[];
};

export type TrustedPlatformStageReconciledMaterial = Omit<
  PlatformStageReconciledOutput,
  "evidenceRefs"
> & {
  readonly evidenceRefs: readonly EvidenceRef[];
};

export type PlatformStageUnknownReason =
  | "network_ambiguous"
  | "driver_disconnected"
  | "driver_timeout"
  | "close_audit_unavailable"
  | "receipt_unavailable"
  | "transaction_state_unknown";

export type PlatformStageBlockedReason =
  | "target_stale"
  | "target_mismatch"
  | "editor_not_empty"
  | "artifact_unavailable"
  | "draft_hash_mismatch"
  | "page_binding_mismatch"
  | "preflight_stale"
  | "grant_binding_invalid";

export type PlatformReconcileBlockedReason =
  | "blocked_unowned_content"
  | "blocked_stage_residue"
  | "transaction_not_found"
  | "transaction_binding_mismatch";

type DriverIssueBase = {
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly observedAt: string;
};

export type TrustedPlatformStageOutcome =
  | TrustedPlatformStageVerifiedMaterial
  | (DriverIssueBase & {
      readonly status: "unknown";
      readonly reasonCode: PlatformStageUnknownReason;
      readonly stageTransactionRef: string;
    })
  | (DriverIssueBase & {
      readonly status: "failed_before_write";
      readonly reasonCode: PlatformStageBlockedReason;
    });

export type TrustedPlatformReconcileOutcome =
  | TrustedPlatformStageReconciledMaterial
  | (DriverIssueBase & {
      readonly status: "unknown";
      readonly reasonCode: PlatformStageUnknownReason;
      readonly stageTransactionRef: string;
    })
  | (DriverIssueBase & {
      readonly status: "blocked";
      readonly reasonCode: PlatformReconcileBlockedReason;
      readonly stageTransactionRef: string;
    });

type TrustedDriverRequestContext<I extends CourseToolBusinessInput> = {
  readonly context: Readonly<ServerToolExecutionContext>;
  readonly envelope: Readonly<ToolExecutionEnvelope<I>>;
};

/**
 * Thin server-side adapter around the existing trusted companion/driver. It
 * resolves protected draft material, signed stage tokens, nonces, browser
 * bindings, and close audits internally. None of those values are model input.
 */
export interface TrustedPlatformStageAdapter {
  preflightRead(
    input: TrustedDriverRequestContext<PlatformTargetPreflightInput> & {
      readonly targetRef: string;
    }
  ): Promise<TrustedPlatformTargetPreflightMaterial>;
  stageVerifyClear(
    input: TrustedDriverRequestContext<PlatformStageVerifyClearInput> & {
      readonly targetRef: string;
      readonly artifactVersionRef: string;
      readonly draftBodyHash: string;
      readonly preflightRef: string;
    }
  ): Promise<TrustedPlatformStageOutcome>;
  reconcileStage(
    input: TrustedDriverRequestContext<PlatformStageReconcileInput> & {
      readonly stageTransactionRef: string;
    }
  ): Promise<TrustedPlatformReconcileOutcome>;
}

export interface PlatformStageToolDependencies {
  readonly trustedDriver: TrustedPlatformStageAdapter;
}

export type PlatformStageToolRegistration =
  | CourseToolRegistration<
      PlatformTargetPreflightInput,
      PlatformTargetPreflightOutput
    >
  | CourseToolRegistration<
      PlatformStageVerifyClearInput,
      PlatformStageVerifiedOutput
    >
  | CourseToolRegistration<
      PlatformStageReconcileInput,
      PlatformStageReconciledOutput
    >;

function inputSchemas() {
  return {
    preflight: createJsonCourseToolSchema<PlatformTargetPreflightInput>({
      schemaVersion: "cmooc.course-tool.platform-preflight-input.v1",
      modelJsonSchema: {
        ...strictObject,
        required: ["targetRef"],
        properties: {
          targetRef: { type: "string", pattern: SAFE_REF_PATTERN }
        }
      }
    }),
    stage: createJsonCourseToolSchema<PlatformStageVerifyClearInput>({
      schemaVersion: "cmooc.course-tool.platform-stage-input.v1",
      modelJsonSchema: {
        ...strictObject,
        required: [
          "targetRef",
          "artifactVersionRef",
          "draftBodyHash",
          "preflightRef"
        ],
        properties: {
          targetRef: { type: "string", pattern: SAFE_REF_PATTERN },
          artifactVersionRef: {
            type: "string",
            pattern: SAFE_REF_PATTERN
          },
          draftBodyHash: { type: "string", pattern: HASH_PATTERN },
          preflightRef: { type: "string", pattern: SAFE_REF_PATTERN }
        }
      }
    }),
    reconcile: createJsonCourseToolSchema<PlatformStageReconcileInput>({
      schemaVersion: "cmooc.course-tool.platform-stage-reconcile-input.v1",
      modelJsonSchema: {
        ...strictObject,
        required: ["stageTransactionRef"],
        properties: {
          stageTransactionRef: {
            type: "string",
            pattern: SAFE_REF_PATTERN
          }
        }
      }
    })
  };
}

function verifiedOutputProperties(schemaVersion: string, status: string) {
  return {
    schemaVersion: { const: schemaVersion },
    status: { const: status },
    stageTransactionRef: { type: "string", pattern: SAFE_REF_PATTERN },
    receiptRef: { type: "string", pattern: SAFE_REF_PATTERN },
    receiptHash: { type: "string", pattern: HASH_PATTERN },
    targetRef: { type: "string", pattern: SAFE_REF_PATTERN },
    targetVersionHash: { type: "string", pattern: HASH_PATTERN },
    artifactVersionRef: { type: "string", pattern: SAFE_REF_PATTERN },
    draftBodyHash: { type: "string", pattern: HASH_PATTERN },
    pageBindingRef: { type: "string", pattern: SAFE_REF_PATTERN },
    pageBindingHash: { type: "string", pattern: HASH_PATTERN },
    baselineRef: { type: "string", pattern: SAFE_REF_PATTERN },
    baselineHash: { type: "string", pattern: HASH_PATTERN },
    editorWriteCount: { const: 1 },
    editorReadbackCount: { const: 1 },
    editorReadbackVerified: { const: true },
    editorClearCount: { const: 1 },
    editorEmptyAfterClear: { const: true },
    submitMutationCount: { const: 0 },
    sendMutationCount: { const: 0 },
    closeAuditStatus: { const: "passed" },
    realPublishEnabled: { const: false },
    bodyPersisted: { const: false },
    published: { const: false },
    observedAt: { type: "string", pattern: ISO_PATTERN },
    evidenceRefs: {
      type: "array",
      minItems: 2,
      maxItems: 64,
      items: evidenceRefSchema
    },
    ...privacyFlagSchema
  } as const;
}

const VERIFIED_OUTPUT_REQUIRED = [
  "schemaVersion",
  "status",
  "stageTransactionRef",
  "receiptRef",
  "receiptHash",
  "targetRef",
  "targetVersionHash",
  "artifactVersionRef",
  "draftBodyHash",
  "pageBindingRef",
  "pageBindingHash",
  "baselineRef",
  "baselineHash",
  "editorWriteCount",
  "editorReadbackCount",
  "editorReadbackVerified",
  "editorClearCount",
  "editorEmptyAfterClear",
  "submitMutationCount",
  "sendMutationCount",
  "closeAuditStatus",
  "realPublishEnabled",
  "bodyPersisted",
  "published",
  "observedAt",
  "evidenceRefs",
  "containsForumText",
  "containsIdentity",
  "containsSecrets"
] as const;

function outputSchemas() {
  return {
    preflight: createJsonCourseToolOutputSchema<PlatformTargetPreflightOutput>({
      schemaVersion: PLATFORM_PREFLIGHT_OUTPUT_SCHEMA_VERSION,
      jsonSchema: {
        ...strictObject,
        required: [
          "schemaVersion",
          "status",
          "reasonCode",
          "preflightRef",
          "preflightHash",
          "targetRef",
          "targetVersionHash",
          "baselineRef",
          "baselineHash",
          "pageBindingRef",
          "pageBindingHash",
          "baselineStatus",
          "observedAt",
          "evidenceRefs",
          "containsForumText",
          "containsIdentity",
          "containsSecrets"
        ],
        properties: {
          schemaVersion: {
            const: PLATFORM_PREFLIGHT_OUTPUT_SCHEMA_VERSION
          },
          status: {
            type: "string",
            enum: ["ready", "waiting_for_browser", "blocked"]
          },
          reasonCode: {
            type: ["string", "null"],
            enum: [
              null,
              "browser_unavailable",
              "page_binding_mismatch",
              "target_stale",
              "target_mismatch",
              "editor_not_empty",
              "baseline_unavailable",
              "policy_halted"
            ]
          },
          preflightRef: { type: "string", pattern: SAFE_REF_PATTERN },
          preflightHash: { type: "string", pattern: HASH_PATTERN },
          targetRef: { type: "string", pattern: SAFE_REF_PATTERN },
          targetVersionHash: {
            anyOf: [
              { type: "string", pattern: HASH_PATTERN },
              { type: "null" }
            ]
          },
          baselineRef: {
            anyOf: [
              { type: "string", pattern: SAFE_REF_PATTERN },
              { type: "null" }
            ]
          },
          baselineHash: {
            anyOf: [
              { type: "string", pattern: HASH_PATTERN },
              { type: "null" }
            ]
          },
          pageBindingRef: {
            anyOf: [
              { type: "string", pattern: SAFE_REF_PATTERN },
              { type: "null" }
            ]
          },
          pageBindingHash: {
            anyOf: [
              { type: "string", pattern: HASH_PATTERN },
              { type: "null" }
            ]
          },
          baselineStatus: {
            type: "string",
            enum: ["empty", "non_empty", "unknown"]
          },
          observedAt: { type: "string", pattern: ISO_PATTERN },
          evidenceRefs: {
            type: "array",
            minItems: 1,
            maxItems: 64,
            items: evidenceRefSchema
          },
          ...privacyFlagSchema
        }
      }
    }),
    stage: createJsonCourseToolOutputSchema<PlatformStageVerifiedOutput>({
      schemaVersion: PLATFORM_STAGE_OUTPUT_SCHEMA_VERSION,
      jsonSchema: {
        ...strictObject,
        required: VERIFIED_OUTPUT_REQUIRED,
        properties: verifiedOutputProperties(
          PLATFORM_STAGE_OUTPUT_SCHEMA_VERSION,
          "verified_cleared"
        )
      }
    }),
    reconcile:
      createJsonCourseToolOutputSchema<PlatformStageReconciledOutput>({
        schemaVersion: PLATFORM_RECONCILE_OUTPUT_SCHEMA_VERSION,
        jsonSchema: {
          ...strictObject,
          required: [...VERIFIED_OUTPUT_REQUIRED, "resolution"],
          properties: {
            ...verifiedOutputProperties(
              PLATFORM_RECONCILE_OUTPUT_SCHEMA_VERSION,
              "reconciled_cleared"
            ),
            resolution: {
              type: "string",
              enum: ["already_verified", "owned_draft_cleared"]
            }
          }
        }
      })
  };
}

function assertPreflightInvariants(
  output: TrustedPlatformTargetPreflightMaterial,
  expectedTargetRef: string
): void {
  assertEvidenceRefs(output.evidenceRefs);
  if (
    output.targetRef !== expectedTargetRef ||
    output.containsForumText !== false ||
    output.containsIdentity !== false ||
    output.containsSecrets !== false ||
    !isSafeIdentifier(output.preflightRef) ||
    !isSha256(output.preflightHash) ||
    !isIsoInstant(output.observedAt)
  ) {
    throw new CourseToolOperationError({
      outcome: "failed",
      safeCode: "platform_preflight_invalid",
      safeSummary: "Trusted target preflight returned an invalid safe receipt."
    });
  }
  if (
    output.status === "ready" &&
    (output.reasonCode !== null ||
      output.baselineStatus !== "empty" ||
      !isSha256(output.targetVersionHash) ||
      !isSafeIdentifier(output.baselineRef) ||
      !isSha256(output.baselineHash) ||
      !isSafeIdentifier(output.pageBindingRef) ||
      !isSha256(output.pageBindingHash))
  ) {
    throw new CourseToolOperationError({
      outcome: "failed",
      safeCode: "platform_preflight_not_ready",
      safeSummary: "Trusted target preflight could not establish an empty bound editor baseline.",
      evidenceRefs: output.evidenceRefs
    });
  }
}

function assertExactL3Envelope<I extends CourseToolBusinessInput>(
  envelope: Readonly<ToolExecutionEnvelope<I>>
): void {
  if (
    envelope.grantedCapability !== "L3_EXTERNAL_STAGE" ||
    !envelope.grantRef ||
    !isSafeIdentifier(envelope.grantRef)
  ) {
    throw new CourseToolOperationError({
      outcome: "failed",
      safeCode: "platform_stage_grant_missing",
      safeSummary: "An exact one-shot platform STAGE grant is required."
    });
  }
}

function stageIssue(
  output: Exclude<
    TrustedPlatformStageOutcome,
    TrustedPlatformStageVerifiedMaterial
  >
): never {
  assertEvidenceRefs(output.evidenceRefs);
  if (output.status === "unknown") {
    if (!isSafeIdentifier(output.stageTransactionRef)) {
      throw safeGenericUnknown();
    }
    throw new CourseToolOperationError({
      outcome: "unknown",
      safeCode: "platform_stage_reconcile_required",
      safeSummary:
        "Trusted STAGE outcome is unknown; only ownership-safe reconciliation may continue.",
      evidenceRefs: output.evidenceRefs,
      compensationRef: output.stageTransactionRef
    });
  }
  throw new CourseToolOperationError({
    outcome: "failed",
    safeCode: `platform_stage_${output.reasonCode}`,
    safeSummary: "Trusted STAGE stopped before an editor write was established.",
    evidenceRefs: output.evidenceRefs
  });
}

function reconcileIssue(
  output: Exclude<
    TrustedPlatformReconcileOutcome,
    TrustedPlatformStageReconciledMaterial
  >,
  expectedStageTransactionRef: string
): never {
  assertEvidenceRefs(output.evidenceRefs);
  if (output.status === "unknown") {
    if (output.stageTransactionRef !== expectedStageTransactionRef) {
      throw safeGenericUnknown(expectedStageTransactionRef);
    }
    throw new CourseToolOperationError({
      outcome: "unknown",
      safeCode: "platform_stage_reconcile_required",
      safeSummary:
        "Trusted reconciliation remains inconclusive; the transaction stays blocked.",
      evidenceRefs: output.evidenceRefs,
      compensationRef: expectedStageTransactionRef
    });
  }
  throw new CourseToolOperationError({
    outcome: "failed",
    safeCode: `platform_stage_${output.reasonCode}`,
    safeSummary:
      output.reasonCode === "blocked_unowned_content"
        ? "Observed editor content is not owned by this STAGE transaction and was not cleared."
        : "Trusted reconciliation could not establish a safe cleared state.",
    evidenceRefs: output.evidenceRefs
  });
}

function safeGenericUnknown(
  stageTransactionRef?: string
): CourseToolOperationError {
  return new CourseToolOperationError({
    outcome: "unknown",
    safeCode: "platform_stage_reconcile_required",
    safeSummary:
      "Trusted STAGE outcome is unknown; only ownership-safe reconciliation may continue.",
    ...(isSafeIdentifier(stageTransactionRef)
      ? { compensationRef: stageTransactionRef }
      : {})
  });
}

function hasStageReceiptAndArtifact(refs: readonly EvidenceRef[]): boolean {
  return (
    refs.some((ref) => ref.kind === "stage_receipt") &&
    refs.some((ref) => ref.kind === "artifact")
  );
}

function asJsonEvidenceRefs(
  refs: readonly EvidenceRef[]
): readonly JsonEvidenceRef[] {
  return Object.freeze(
    refs.map((ref) =>
      Object.freeze({
        kind: ref.kind,
        id: ref.id,
        hash: ref.hash,
        observedAt: ref.observedAt
      })
    )
  );
}

function commonDefinition<
  I extends CourseToolBusinessInput,
  O extends CourseToolJsonValue
>(input: {
  name: string;
  safeLabel: string;
  safeDescription: string;
  inputSchema: CourseToolSchema<I>;
  outputSchema: CourseToolSchema<O>;
}): Pick<
  CourseToolDefinition<I, O>,
  | "schemaVersion"
  | "name"
  | "version"
  | "safeLabel"
  | "safeDescription"
  | "inputSchema"
  | "outputSchema"
> {
  return {
    schemaVersion: COURSE_TOOL_SCHEMA_VERSION,
    name: input.name,
    version: "1",
    safeLabel: input.safeLabel,
    safeDescription: input.safeDescription,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema
  };
}

export function createPlatformStageToolRegistrations(
  deps: PlatformStageToolDependencies
): readonly [
  CourseToolRegistration<
    PlatformTargetPreflightInput,
    PlatformTargetPreflightOutput
  >,
  CourseToolRegistration<
    PlatformStageVerifyClearInput,
    PlatformStageVerifiedOutput
  >,
  CourseToolRegistration<
    PlatformStageReconcileInput,
    PlatformStageReconciledOutput
  >
] {
  if (
    !deps?.trustedDriver ||
    typeof deps.trustedDriver.preflightRead !== "function" ||
    typeof deps.trustedDriver.stageVerifyClear !== "function" ||
    typeof deps.trustedDriver.reconcileStage !== "function"
  ) {
    throw new Error("PLATFORM_STAGE_TRUSTED_DRIVER_REQUIRED");
  }
  const inputs = inputSchemas();
  const outputs = outputSchemas();

  const preflight = defineCourseTool({
    definition: {
      ...commonDefinition({
        name: "platform.target.preflight_read",
        safeLabel: "Trusted target preflight",
        safeDescription:
          "Reads the exact target, page binding, and editor baseline without changing platform state.",
        inputSchema: inputs.preflight,
        outputSchema: outputs.preflight
      }),
      capability: "L0_READ",
      effect: "read",
      dataClasses: ["safe_aggregate", "external_receipt"],
      preconditions: [
        {
          code: "exact_course_scope",
          safeDescription: "The server provides one exact course scope."
        },
        {
          code: "trusted_page_binding",
          safeDescription: "A trusted page binding must be inspected."
        }
      ],
      idempotency: { strategy: "input_hash", scope: "step" },
      evidence: { required: true, minimumRefs: 1 },
      verification: {
        required: false,
        subjectType: "target",
        verifiers: [],
        mode: "all",
        onFailure: "failed"
      },
      retry: {
        maxAttempts: 3,
        retryableStatuses: ["failed"],
        backoff: "exponential"
      }
    },
    handler: async ({ input, context, envelope }) => {
      let output: TrustedPlatformTargetPreflightMaterial;
      try {
        output = await deps.trustedDriver.preflightRead({
          targetRef: input.targetRef,
          context,
          envelope
        });
      } catch (error) {
        if (error instanceof CourseToolOperationError) throw error;
        throw new CourseToolOperationError({
          outcome: "failed",
          safeCode: "platform_preflight_unavailable",
          safeSummary: "Trusted target preflight is temporarily unavailable."
        });
      }
      assertPreflightInvariants(output, input.targetRef);
      const toolOutput: PlatformTargetPreflightOutput = {
        ...output,
        evidenceRefs: asJsonEvidenceRefs(output.evidenceRefs)
      };
      return {
        output: toolOutput,
        evidenceRefs: output.evidenceRefs,
        verificationSubject: {
          type: "target" as const,
          id: output.preflightRef
        },
        containsForumText: false as const,
        containsIdentity: false as const,
        containsSecrets: false as const
      };
    },
    summarizeInput: () => "Read the exact bound platform target.",
    projectOutput: (output) => ({
      model: {
        status: output.status,
        reasonCode: output.reasonCode,
        preflightRef: output.preflightRef,
        preflightHash: output.preflightHash,
        targetRef: output.targetRef,
        targetVersionHash: output.targetVersionHash,
        baselineRef: output.baselineRef,
        baselineHash: output.baselineHash,
        pageBindingRef: output.pageBindingRef,
        pageBindingHash: output.pageBindingHash,
        baselineStatus: output.baselineStatus
      },
      safeSummary:
        output.status === "ready"
          ? "Trusted target preflight is ready with an empty editor baseline."
          : output.status === "waiting_for_browser"
            ? "Trusted target preflight is waiting for a bound browser."
            : "Trusted target preflight is blocked.",
      containsForumText: false,
      containsIdentity: false,
      containsSecrets: false
    }),
    defaultForName: true
  });

  const stage = defineCourseTool({
    definition: {
      ...commonDefinition({
        name: "platform.editor.stage_verify_clear",
        safeLabel: "Atomic editor STAGE verification",
        safeDescription:
          "Uses the trusted driver to bind, stage, read back, ownership-check, clear, and close-audit one draft without submission.",
        inputSchema: inputs.stage,
        outputSchema: outputs.stage
      }),
      capability: "L3_EXTERNAL_STAGE",
      effect: "external_stage",
      dataClasses: ["restricted_transient", "external_receipt"],
      preconditions: [
        {
          code: "validated_artifact_version",
          safeDescription: "A frozen validated artifact version is required."
        },
        {
          code: "empty_editor_baseline",
          safeDescription: "The trusted fresh baseline must be empty."
        },
        {
          code: "exact_one_shot_stage_grant",
          safeDescription: "The server must claim one exact scoped STAGE grant."
        }
      ],
      idempotency: { strategy: "stage_nonce", scope: "step" },
      evidence: {
        required: true,
        minimumRefs: 2,
        allowedKinds: PLATFORM_STAGE_ALLOWED_EVIDENCE_KINDS
      },
      verification: {
        required: true,
        subjectType: "stage_transaction",
        verifiers: [
          {
            name: PLATFORM_STAGE_VERIFIER_NAME,
            version: PLATFORM_STAGE_VERIFIER_VERSION,
            required: true
          }
        ],
        mode: "all",
        onFailure: "unknown"
      },
      retry: {
        maxAttempts: 1,
        retryableStatuses: [],
        backoff: "none"
      },
      recovery: {
        kind: "trusted_reconcile",
        toolName: "platform.editor.reconcile_stage",
        toolVersion: "1"
      }
    },
    handler: async ({ input, context, envelope }) => {
      assertExactL3Envelope(envelope);
      let output: TrustedPlatformStageOutcome;
      try {
        output = await deps.trustedDriver.stageVerifyClear({
          targetRef: input.targetRef,
          artifactVersionRef: input.artifactVersionRef,
          draftBodyHash: input.draftBodyHash,
          preflightRef: input.preflightRef,
          context,
          envelope
        });
      } catch (error) {
        if (error instanceof CourseToolOperationError) throw error;
        throw safeGenericUnknown();
      }
      if (output.status !== "verified_cleared") stageIssue(output);
      assertEvidenceRefs(output.evidenceRefs);
      if (
        output.targetRef !== input.targetRef ||
        output.artifactVersionRef !== input.artifactVersionRef ||
        output.draftBodyHash !== input.draftBodyHash ||
        !hasStageReceiptAndArtifact(output.evidenceRefs)
      ) {
        throw safeGenericUnknown(output.stageTransactionRef);
      }
      const toolOutput: PlatformStageVerifiedOutput = {
        ...output,
        evidenceRefs: asJsonEvidenceRefs(output.evidenceRefs)
      };
      return {
        output: toolOutput,
        evidenceRefs: output.evidenceRefs,
        beforeRef: {
          kind: "editor_baseline",
          id: output.baselineRef,
          hash: output.baselineHash,
          observedAt: output.observedAt
        },
        afterRef: {
          kind: "editor_cleared",
          id: output.stageTransactionRef,
          hash: output.receiptHash,
          observedAt: output.observedAt
        },
        verificationSubject: {
          type: "stage_transaction" as const,
          id: output.stageTransactionRef
        },
        containsForumText: false as const,
        containsIdentity: false as const,
        containsSecrets: false as const
      };
    },
    summarizeInput: () =>
      "Run one atomic trusted editor STAGE verification transaction.",
    projectOutput: (output) => ({
      model: {
        status: output.status,
        stageTransactionRef: output.stageTransactionRef,
        receiptRef: output.receiptRef,
        receiptHash: output.receiptHash,
        targetRef: output.targetRef,
        targetVersionHash: output.targetVersionHash,
        artifactVersionRef: output.artifactVersionRef,
        draftBodyHash: output.draftBodyHash,
        pageBindingRef: output.pageBindingRef,
        pageBindingHash: output.pageBindingHash,
        baselineRef: output.baselineRef,
        baselineHash: output.baselineHash,
        editorStatus: "cleared",
        publicationStatus: "not_published",
        closeAuditStatus: output.closeAuditStatus,
        counts: {
          editorWrite: output.editorWriteCount,
          editorReadback: output.editorReadbackCount,
          editorClear: output.editorClearCount,
          submitMutation: output.submitMutationCount,
          sendMutation: output.sendMutationCount
        }
      },
      safeSummary:
        "Trusted editor STAGE was verified, cleared, and not published.",
      containsForumText: false,
      containsIdentity: false,
      containsSecrets: false
    }),
    defaultForName: true
  });

  const reconcile = defineCourseTool({
    definition: {
      ...commonDefinition({
        name: "platform.editor.reconcile_stage",
        safeLabel: "Ownership-safe STAGE reconciliation",
        safeDescription:
          "Audits one prior STAGE transaction and clears only content still proven to be owned by that transaction.",
        inputSchema: inputs.reconcile,
        outputSchema: outputs.reconcile
      }),
      capability: "L3_EXTERNAL_STAGE",
      effect: "external_stage",
      dataClasses: ["restricted_transient", "external_receipt"],
      preconditions: [
        {
          code: "prior_stage_transaction",
          safeDescription: "One prior ambiguous STAGE transaction is required."
        },
        {
          code: "exact_one_shot_reconcile_grant",
          safeDescription: "The server must claim one exact scoped reconciliation grant."
        },
        {
          code: "ownership_before_clear",
          safeDescription: "Only exact transaction-owned editor state may be cleared."
        }
      ],
      idempotency: { strategy: "server_key", scope: "step" },
      evidence: {
        required: true,
        minimumRefs: 2,
        allowedKinds: PLATFORM_STAGE_ALLOWED_EVIDENCE_KINDS
      },
      verification: {
        required: true,
        subjectType: "stage_transaction",
        verifiers: [
          {
            name: PLATFORM_STAGE_VERIFIER_NAME,
            version: PLATFORM_STAGE_VERIFIER_VERSION,
            required: true
          }
        ],
        mode: "all",
        onFailure: "unknown"
      },
      retry: {
        maxAttempts: 1,
        retryableStatuses: [],
        backoff: "none"
      },
      recovery: { kind: "terminal_reconcile" }
    },
    handler: async ({ input, context, envelope }) => {
      assertExactL3Envelope(envelope);
      let output: TrustedPlatformReconcileOutcome;
      try {
        output = await deps.trustedDriver.reconcileStage({
          stageTransactionRef: input.stageTransactionRef,
          context,
          envelope
        });
      } catch (error) {
        if (error instanceof CourseToolOperationError) throw error;
        throw safeGenericUnknown(input.stageTransactionRef);
      }
      if (output.status !== "reconciled_cleared") {
        reconcileIssue(output, input.stageTransactionRef);
      }
      assertEvidenceRefs(output.evidenceRefs);
      if (
        output.stageTransactionRef !== input.stageTransactionRef ||
        !hasStageReceiptAndArtifact(output.evidenceRefs)
      ) {
        throw safeGenericUnknown(input.stageTransactionRef);
      }
      const toolOutput: PlatformStageReconciledOutput = {
        ...output,
        evidenceRefs: asJsonEvidenceRefs(output.evidenceRefs)
      };
      return {
        output: toolOutput,
        evidenceRefs: output.evidenceRefs,
        beforeRef: {
          kind: "stage_transaction",
          id: output.stageTransactionRef,
          hash: output.draftBodyHash,
          observedAt: output.observedAt
        },
        afterRef: {
          kind: "editor_cleared",
          id: output.receiptRef,
          hash: output.receiptHash,
          observedAt: output.observedAt
        },
        verificationSubject: {
          type: "stage_transaction" as const,
          id: output.stageTransactionRef
        },
        containsForumText: false as const,
        containsIdentity: false as const,
        containsSecrets: false as const
      };
    },
    summarizeInput: () =>
      "Reconcile one prior trusted editor STAGE transaction.",
    projectOutput: (output) => ({
      model: {
        status: output.status,
        resolutionStatus: output.resolution,
        stageTransactionRef: output.stageTransactionRef,
        receiptRef: output.receiptRef,
        receiptHash: output.receiptHash,
        targetRef: output.targetRef,
        targetVersionHash: output.targetVersionHash,
        artifactVersionRef: output.artifactVersionRef,
        draftBodyHash: output.draftBodyHash,
        pageBindingRef: output.pageBindingRef,
        pageBindingHash: output.pageBindingHash,
        baselineRef: output.baselineRef,
        baselineHash: output.baselineHash,
        editorStatus: "cleared",
        publicationStatus: "not_published",
        closeAuditStatus: output.closeAuditStatus,
        counts: {
          editorWrite: output.editorWriteCount,
          editorReadback: output.editorReadbackCount,
          editorClear: output.editorClearCount,
          submitMutation: output.submitMutationCount,
          sendMutation: output.sendMutationCount
        }
      },
      safeSummary:
        "Trusted STAGE reconciliation established a cleared, not-published state.",
      containsForumText: false,
      containsIdentity: false,
      containsSecrets: false
    }),
    defaultForName: true
  });

  return Object.freeze([preflight, stage, reconcile]);
}

function check(
  code: string,
  passed: boolean,
  passedSummary: string,
  failedSummary: string
) {
  return {
    code,
    status: passed ? ("passed" as const) : ("failed" as const),
    safeSummary: passed ? passedSummary : failedSummary
  };
}

function verifyPlatformStageOutput(
  output: CourseToolJsonValue,
  evidenceRefs: readonly EvidenceRef[]
): CourseToolVerifierResult {
  const value: Readonly<Record<string, CourseToolJsonValue>> =
    output && typeof output === "object" && !Array.isArray(output)
      ? (output as Readonly<Record<string, CourseToolJsonValue>>)
      : {};
  const checks = [
    check(
      "atomic_editor_round_trip",
      value.editorWriteCount === 1 &&
        value.editorReadbackCount === 1 &&
        value.editorReadbackVerified === true &&
        value.editorClearCount === 1 &&
        value.editorEmptyAfterClear === true,
      "One write, matching readback, one clear, and empty final editor were verified.",
      "The atomic editor round trip was not established."
    ),
    check(
      "zero_external_mutations",
      value.submitMutationCount === 0 && value.sendMutationCount === 0,
      "Submit and send mutation counts are zero.",
      "A submit or send mutation cannot be ruled out."
    ),
    check(
      "trusted_close_audit",
      value.closeAuditStatus === "passed",
      "The trusted close audit passed.",
      "The trusted close audit did not pass."
    ),
    check(
      "publication_hard_lock",
      value.realPublishEnabled === false && value.published === false,
      "Real publication remained disabled and no publication occurred.",
      "The publication hard lock was not established."
    ),
    check(
      "restricted_body_not_persisted",
      value.bodyPersisted === false,
      "The transient draft body was not persisted.",
      "Draft body non-persistence was not established."
    ),
    check(
      "trusted_receipt_binding",
      isSafeIdentifier(value.stageTransactionRef) &&
        isSafeIdentifier(value.receiptRef) &&
        isSha256(value.receiptHash) &&
        isSha256(value.draftBodyHash) &&
        hasStageReceiptAndArtifact(evidenceRefs),
      "The transaction, receipt, artifact, and draft hashes are bound.",
      "The trusted receipt binding is incomplete."
    )
  ];
  return {
    status: checks.every((item) => item.status === "passed")
      ? "passed"
      : "failed",
    checks,
    evidenceRefs,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  };
}

export function createPlatformStageVerifierRegistrations(): readonly CourseToolVerifierRegistration[] {
  const verifier: CourseToolVerifierRegistration = {
    definition: {
      name: PLATFORM_STAGE_VERIFIER_NAME,
      version: PLATFORM_STAGE_VERIFIER_VERSION,
      safeLabel: "Trusted atomic STAGE verification"
    },
    verify: async ({ handlerResult }) =>
      verifyPlatformStageOutput(
        handlerResult.output,
        handlerResult.evidenceRefs
      )
  };
  return Object.freeze([Object.freeze(verifier)]);
}
