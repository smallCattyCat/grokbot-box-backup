import {
  PROTOCOL_SCHEMA_VERSIONS,
  assertExecutionCommandSemantics,
  assertExecutionReceiptSemantics,
  assertObservationEnvelopeSemantics,
  canonicalProtocolHash,
  parseProtocolObject,
  type BoundTargetV1,
  type CanonicalJsonValue,
  type ExecutionCommandV1,
  type ExecutionReceiptV1,
  type ObservationEnvelopeV1
} from "../facilitation-protocol";
import {
  AUTH_SUMMARY_SCHEMA_VERSION,
  PREFLIGHT_RECEIPT_SCHEMA_VERSION,
  assertAuthSummary,
  assertPreflightReceipt,
  type AuthSummary,
  type PreflightReceipt,
  type PreflightStatus
} from "./contract";

export type AdapterClock = () => Date;

export function adapterNow(clock: AdapterClock): string {
  const value = clock();
  if (
    !(value instanceof Date) ||
    !Number.isFinite(value.getTime())
  ) {
    throw new Error("INVALID_ADAPTER_CLOCK");
  }
  return value.toISOString();
}

export function adapterEvidenceHash(
  domain: string,
  value: CanonicalJsonValue
): string {
  return canonicalProtocolHash(`cmooc.adapter.${domain}.v1`, value);
}

export function buildAuthSummary(input: {
  adapterId: string;
  adapterVersion: string;
  status: AuthSummary["status"];
  canRead: boolean;
  canExecuteAuthorized: boolean;
  checkedAt: string;
  messageCode: string;
  evidence: CanonicalJsonValue;
}): AuthSummary {
  return assertAuthSummary({
    schemaVersion: AUTH_SUMMARY_SCHEMA_VERSION,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    status: input.status,
    canRead: input.canRead,
    canExecuteAuthorized: input.canExecuteAuthorized,
    checkedAt: input.checkedAt,
    evidenceHash: adapterEvidenceHash("auth-summary", input.evidence),
    messageCode: input.messageCode,
    containsForumText: false
  });
}

export function buildObservationEnvelope(input: {
  adapterId: string;
  adapterVersion: string;
  observationKey: string;
  threadKey: string;
  courseKey: string;
  observedAt: string;
  evidenceAsOf?: string;
  sourceObservedThrough?: string;
  temporalEvidenceStatus?: ObservationEnvelopeV1["temporalEvidenceStatus"];
  timeBasis:
    | "naive_platform_local_time_no_dst_adjustment"
    | "utc"
    | "platform_declared_timezone"
    | "synthetic_virtual_clock";
  contentRevisionStatus:
    | "not_included"
    | "decision_time_version_verified"
    | "final_export_revision_unknown";
  eventCount: number;
  state: CanonicalJsonValue;
}): ObservationEnvelopeV1 {
  return assertObservationEnvelopeSemantics({
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.observationEnvelope,
    observationKey: input.observationKey,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    threadKey: input.threadKey,
    courseKey: input.courseKey,
    observedAt: input.observedAt,
    evidenceAsOf: input.evidenceAsOf ?? input.observedAt,
    sourceObservedThrough:
      input.sourceObservedThrough ?? input.observedAt,
    timeBasis: input.timeBasis,
    temporalEvidenceStatus:
      input.temporalEvidenceStatus ?? "as_of_verified",
    contentRevisionStatus: input.contentRevisionStatus,
    stateHash: adapterEvidenceHash("observation-state", input.state),
    eventCount: input.eventCount,
    containsForumText: false
  });
}

export function buildBoundTarget(input: {
  adapterId: string;
  adapterVersion: string;
  threadKey: string;
  targetType: "thread" | "comment";
  targetObject: BoundTargetV1["targetObject"];
  stableTargetRef: string;
  contentRevisionStatus: BoundTargetV1["contentRevisionStatus"];
  boundAt: string;
  targetState: CanonicalJsonValue;
}): BoundTargetV1 {
  return parseProtocolObject("boundTarget", {
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.boundTarget,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    threadKey: input.threadKey,
    targetType: input.targetType,
    targetObject: input.targetObject,
    stableTargetRef: input.stableTargetRef,
    targetVersionHash: adapterEvidenceHash(
      "target-version",
      input.targetState
    ),
    contentRevisionStatus: input.contentRevisionStatus,
    boundAt: input.boundAt,
    containsForumText: false
  });
}

export function buildPreflightReceipt(input: {
  adapterId: string;
  adapterVersion: string;
  command: ExecutionCommandV1;
  status: PreflightStatus;
  checkedAt: string;
  messageCode: string;
  evidence?: CanonicalJsonValue;
}): PreflightReceipt {
  const command = assertExecutionCommandSemantics(input.command);
  return assertPreflightReceipt({
    schemaVersion: PREFLIGHT_RECEIPT_SCHEMA_VERSION,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    commandId: command.commandId,
    status: input.status,
    expectedTargetHash: command.expectedTargetHash,
    checkedAt: input.checkedAt,
    evidenceHash: adapterEvidenceHash(
      "preflight",
      input.evidence ?? {
        commandId: command.commandId,
        expectedTargetHash: command.expectedTargetHash,
        status: input.status,
        messageCode: input.messageCode
      }
    ),
    messageCode: input.messageCode,
    containsForumText: false
  });
}

export function commandExpired(
  command: ExecutionCommandV1,
  checkedAt: string
): boolean {
  return Date.parse(command.expiresAt) <= Date.parse(checkedAt);
}

export function buildExecutionReceipt(input: {
  adapterId: string;
  adapterVersion: string;
  command: ExecutionCommandV1;
  outcome: ExecutionReceiptV1["outcome"];
  attemptedAt: string | null;
  recordedAt: string;
  remoteObjectRefHash: string | null;
  evidenceHash: string;
  messageCode: string;
}): ExecutionReceiptV1 {
  const command = assertExecutionCommandSemantics(input.command);
  return assertExecutionReceiptSemantics({
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.executionReceipt,
    commandId: command.commandId,
    correlationId: command.correlationId,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    outcome: input.outcome,
    attemptedAt: input.attemptedAt,
    recordedAt: input.recordedAt,
    remoteObjectRefHash: input.remoteObjectRefHash,
    evidenceHash: input.evidenceHash,
    messageCode: input.messageCode,
    containsForumText: false
  });
}
