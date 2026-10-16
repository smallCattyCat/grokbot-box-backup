import type { PrismaClient } from "@prisma/client";
import {
  appendDecisionTapeEntry
} from "@/lib/autonomy/decision-tape";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";

export const INCIDENT_TRANSITION_SCHEMA_VERSION =
  "cmooc.autonomy-incident-transition.v1" as const;

const INCIDENT_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SAFE_CODE_PATTERN = /^[a-z][a-z0-9_]{1,80}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export type IncidentAction = "acknowledge" | "resolve";

/** Backwards-compatible protocol spelling used by governance callers. */
export type action = IncidentAction;

export type IncidentStatus =
  | "open"
  | "acknowledged"
  | "resolved"
  | "closed";

export type IncidentResolvedAtIntent = "preserve" | "set";

export type IncidentTransition = {
  changed: boolean;
  nextStatus: IncidentStatus;
  resolvedAt: IncidentResolvedAtIntent;
};

/** The safe incident fields used by the governance transition service. */
export type IncidentRecordForGovernance = {
  id: string;
  courseAlias: string;
  invocationId: string | null;
  code: string;
  status: string;
  evidenceHash: string;
  resolvedAt: Date | null;
};

export type IncidentTransitionSummary = {
  schemaVersion: typeof INCIDENT_TRANSITION_SCHEMA_VERSION;
  incidentId: string;
  courseAlias: string;
  invocationId: string | null;
  code: string;
  action: IncidentAction;
  status: IncidentStatus;
  changed: boolean;
  evidenceHash: string;
  transitionedAt: string | null;
  containsForumText: false;
};

/**
 * Resolve one local incident state transition without touching persistence.
 * `resolvedAt` is an update intent because the pure function has no clock.
 */
export function resolveIncidentTransition(
  currentStatus: string,
  action: IncidentAction
): IncidentTransition {
  if (
    action !== "acknowledge" &&
    action !== "resolve"
  ) {
    throw new Error("INCIDENT_TRANSITION_INVALID");
  }

  if (
    currentStatus !== "open" &&
    currentStatus !== "acknowledged" &&
    currentStatus !== "resolved" &&
    currentStatus !== "closed"
  ) {
    throw new Error("INCIDENT_TRANSITION_INVALID");
  }

  if (action === "acknowledge") {
    if (currentStatus === "open") {
      return {
        changed: true,
        nextStatus: "acknowledged",
        resolvedAt: "preserve"
      };
    }
    if (currentStatus === "acknowledged") {
      return {
        changed: false,
        nextStatus: "acknowledged",
        resolvedAt: "preserve"
      };
    }
    throw new Error("INCIDENT_TRANSITION_INVALID");
  }

  if (
    currentStatus === "open" ||
    currentStatus === "acknowledged"
  ) {
    return {
      changed: true,
      nextStatus: "resolved",
      resolvedAt: "set"
    };
  }
  if (currentStatus === "resolved") {
    return {
      changed: false,
      nextStatus: "resolved",
      resolvedAt: "preserve"
    };
  }
  throw new Error("INCIDENT_TRANSITION_INVALID");
}

function validateIncidentId(value: string): string {
  if (
    typeof value !== "string" ||
    !INCIDENT_ID_PATTERN.test(value)
  ) {
    throw new Error("INCIDENT_ID_INVALID");
  }
  return value;
}

function validateEvidenceHash(value: string): string {
  if (
    typeof value !== "string" ||
    !HASH_PATTERN.test(value)
  ) {
    throw new Error("INCIDENT_EVIDENCE_HASH_INVALID");
  }
  return value;
}

function validateNow(value: Date | string): Date {
  if (!(value instanceof Date) && typeof value !== "string") {
    throw new Error("INCIDENT_TRANSITION_TIME_INVALID");
  }
  const date =
    value instanceof Date
      ? new Date(value.getTime())
      : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("INCIDENT_TRANSITION_TIME_INVALID");
  }
  return date;
}

function safeIncidentRecord(
  value: IncidentRecordForGovernance
): IncidentRecordForGovernance {
  if (
    !INCIDENT_ID_PATTERN.test(value.id) ||
    !SAFE_ALIAS_PATTERN.test(value.courseAlias) ||
    !SAFE_CODE_PATTERN.test(value.code) ||
    !HASH_PATTERN.test(value.evidenceHash) ||
    (value.invocationId !== null &&
      !INCIDENT_ID_PATTERN.test(value.invocationId)) ||
    (value.resolvedAt !== null &&
      !Number.isFinite(value.resolvedAt.getTime()))
  ) {
    throw new Error("INCIDENT_RECORD_INVALID");
  }
  return value;
}

function transitionKind(action: IncidentAction):
  | "incident_acknowledged"
  | "incident_resolved" {
  return action === "acknowledge"
    ? "incident_acknowledged"
    : "incident_resolved";
}

function idempotentSummary(input: {
  incident: IncidentRecordForGovernance;
  action: IncidentAction;
  transition: IncidentTransition;
}): IncidentTransitionSummary {
  return {
    schemaVersion: INCIDENT_TRANSITION_SCHEMA_VERSION,
    incidentId: input.incident.id,
    courseAlias: input.incident.courseAlias,
    invocationId: input.incident.invocationId,
    code: input.incident.code,
    action: input.action,
    status: input.transition.nextStatus,
    changed: false,
    evidenceHash: input.incident.evidenceHash,
    transitionedAt:
      input.incident.resolvedAt?.toISOString() ?? null,
    containsForumText: false
  };
}

/**
 * Apply one trusted long-running incident transition. The incident evidence
 * hash is an optimistic-concurrency token; no caller-provided text or actor
 * identity is accepted or persisted.
 */
export async function transitionAutonomyIncident(input: {
  prisma: PrismaClient;
  incidentId: string;
  expectedEvidenceHash: string;
  action: IncidentAction;
  now: Date | string;
}): Promise<IncidentTransitionSummary> {
  const incidentId = validateIncidentId(input.incidentId);
  const expectedEvidenceHash = validateEvidenceHash(
    input.expectedEvidenceHash
  );
  const now = validateNow(input.now);
  if (
    input.action !== "acknowledge" &&
    input.action !== "resolve"
  ) {
    throw new Error("INCIDENT_TRANSITION_INVALID");
  }

  return input.prisma.$transaction(async (tx) => {
    const record = await tx.autonomyIncident.findUnique({
      where: { id: incidentId },
      select: {
        id: true,
        courseAlias: true,
        invocationId: true,
        code: true,
        status: true,
        evidenceHash: true,
        resolvedAt: true
      }
    });
    if (!record) {
      throw new Error("INCIDENT_NOT_FOUND");
    }

    const incident = safeIncidentRecord(record);
    if (incident.evidenceHash !== expectedEvidenceHash) {
      throw new Error("INCIDENT_EVIDENCE_HASH_MISMATCH");
    }
    const transition = resolveIncidentTransition(
      incident.status,
      input.action
    );
    if (!transition.changed) {
      return idempotentSummary({
        incident,
        action: input.action,
        transition
      });
    }

    const transitionedAt = now.toISOString();
    const payload = {
      schemaVersion: INCIDENT_TRANSITION_SCHEMA_VERSION,
      action: input.action,
      status: transition.nextStatus,
      incidentEvidenceHash: incident.evidenceHash,
      transitionedAt,
      containsForumText: false
    } as const;
    const evidenceHash = canonicalProtocolHash(
      INCIDENT_TRANSITION_SCHEMA_VERSION,
      payload as unknown as CanonicalJsonValue
    );
    const updated = await tx.autonomyIncident.updateMany({
      where: {
        id: incident.id,
        evidenceHash: expectedEvidenceHash,
        status: incident.status
      },
      data: {
        status: transition.nextStatus,
        ...(transition.resolvedAt === "set"
          ? { resolvedAt: now }
          : {})
      }
    });
    if (updated.count !== 1) {
      const racedRecord = await tx.autonomyIncident.findUnique({
        where: { id: incident.id },
        select: {
          id: true,
          courseAlias: true,
          invocationId: true,
          code: true,
          status: true,
          evidenceHash: true,
          resolvedAt: true
        }
      });
      if (
        racedRecord &&
        racedRecord.evidenceHash === expectedEvidenceHash &&
        racedRecord.status === transition.nextStatus
      ) {
        return idempotentSummary({
          incident: safeIncidentRecord(racedRecord),
          action: input.action,
          transition
        });
      }
      throw new Error("INCIDENT_TRANSITION_CONFLICT");
    }

    const kind = transitionKind(input.action);
    if (incident.invocationId) {
      await appendDecisionTapeEntry({
        prisma: tx,
        invocationId: incident.invocationId,
        kind,
        payload: payload as unknown as CanonicalJsonValue
      });
    }
    await tx.reviewEvent.create({
      data: {
        invocationId: incident.invocationId,
        kind,
        outcome: transition.nextStatus,
        reasonCode: incident.code,
        evidenceHash,
        containsForumText: false,
        createdAt: now
      }
    });

    return {
      schemaVersion: INCIDENT_TRANSITION_SCHEMA_VERSION,
      incidentId: incident.id,
      courseAlias: incident.courseAlias,
      invocationId: incident.invocationId,
      code: incident.code,
      action: input.action,
      status: transition.nextStatus,
      changed: true,
      evidenceHash,
      transitionedAt,
      containsForumText: false
    };
  });
}
