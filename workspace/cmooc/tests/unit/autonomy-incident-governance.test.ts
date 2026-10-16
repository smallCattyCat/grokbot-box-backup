import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  INCIDENT_TRANSITION_SCHEMA_VERSION,
  resolveIncidentTransition,
  transitionAutonomyIncident,
  type IncidentAction,
  type IncidentRecordForGovernance
} from "../../lib/autonomy/incident-governance";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const INCIDENT_EVIDENCE_HASH = hash("incident-evidence");
const NOW = new Date("2026-08-02T12:00:00.000Z");

function incident(
  overrides: Partial<IncidentRecordForGovernance> = {}
): IncidentRecordForGovernance {
  return {
    id: "incident-local",
    courseAlias: "safe-course",
    invocationId: "invocation-local",
    code: "invocation_failed",
    status: "open",
    evidenceHash: INCIDENT_EVIDENCE_HASH,
    resolvedAt: null,
    ...overrides
  };
}

type FakeState = {
  incident: IncidentRecordForGovernance | null;
  updates: Array<Record<string, unknown>>;
  reviewEvents: Array<Record<string, unknown>>;
  tapeEntries: Array<Record<string, unknown>>;
};

function fakePrisma(initial: IncidentRecordForGovernance | null = incident()) {
  const state: FakeState = {
    incident: initial,
    updates: [],
    reviewEvents: [],
    tapeEntries: []
  };
  const client = {
    autonomyIncident: {
      findUnique: async () => state.incident,
      updateMany: async (input: {
        where: { id: string; evidenceHash: string; status: string };
        data: Record<string, unknown>;
      }) => {
        if (
          !state.incident ||
          state.incident.id !== input.where.id ||
          state.incident.evidenceHash !== input.where.evidenceHash ||
          state.incident.status !== input.where.status
        ) {
          return { count: 0 };
        }
        state.updates.push(input.data);
        state.incident = {
          ...state.incident,
          status: String(input.data.status),
          resolvedAt:
            input.data.resolvedAt === undefined
              ? state.incident.resolvedAt
              : (input.data.resolvedAt as Date | null)
        };
        return { count: 1 };
      }
    },
    reviewEvent: {
      create: async (input: { data: Record<string, unknown> }) => {
        state.reviewEvents.push(input.data);
        return input.data;
      }
    },
    scheduledInvocation: {
      findUnique: async (input: { where: { id: string } }) =>
        input.where.id === "invocation-local"
          ? { id: input.where.id }
          : null
    },
    decisionTapeEntry: {
      findFirst: async () => {
        const last = state.tapeEntries.at(-1);
        return last
          ? { sequence: last.sequence, entryHash: last.entryHash }
          : null;
      },
      create: async (input: { data: Record<string, unknown> }) => {
        state.tapeEntries.push(input.data);
        return input.data;
      }
    },
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>) =>
      callback(client)
  };
  return {
    state,
    client: client as never
  };
}

test("异常状态机只允许 open→acknowledged、open/acknowledged→resolved", () => {
  assert.deepEqual(resolveIncidentTransition("open", "acknowledge"), {
    changed: true,
    nextStatus: "acknowledged",
    resolvedAt: "preserve"
  });
  assert.deepEqual(resolveIncidentTransition("open", "resolve"), {
    changed: true,
    nextStatus: "resolved",
    resolvedAt: "set"
  });
  assert.deepEqual(
    resolveIncidentTransition("acknowledged", "resolve"),
    {
      changed: true,
      nextStatus: "resolved",
      resolvedAt: "set"
    }
  );
});

test("相同目标状态幂等，终态不可重新确认", () => {
  assert.deepEqual(
    resolveIncidentTransition("acknowledged", "acknowledge"),
    {
      changed: false,
      nextStatus: "acknowledged",
      resolvedAt: "preserve"
    }
  );
  assert.deepEqual(resolveIncidentTransition("resolved", "resolve"), {
    changed: false,
    nextStatus: "resolved",
    resolvedAt: "preserve"
  });
  assert.throws(
    () => resolveIncidentTransition("resolved", "acknowledge"),
    /INCIDENT_TRANSITION_INVALID/
  );
  assert.throws(
    () => resolveIncidentTransition("closed", "acknowledge"),
    /INCIDENT_TRANSITION_INVALID/
  );
  assert.throws(
    () => resolveIncidentTransition("closed", "resolve"),
    /INCIDENT_TRANSITION_INVALID/
  );
  assert.throws(
    () =>
      resolveIncidentTransition(
        "open",
        "ignore" as unknown as IncidentAction
      ),
    /INCIDENT_TRANSITION_INVALID/
  );
});

test("确认异常在事务内 CAS，并写入去正文 ReviewEvent 与 Decision Tape", async () => {
  const fixture = fakePrisma();
  const result = await transitionAutonomyIncident({
    prisma: fixture.client,
    incidentId: "incident-local",
    expectedEvidenceHash: INCIDENT_EVIDENCE_HASH,
    action: "acknowledge",
    now: NOW
  });

  assert.deepEqual(result, {
    schemaVersion: INCIDENT_TRANSITION_SCHEMA_VERSION,
    incidentId: "incident-local",
    courseAlias: "safe-course",
    invocationId: "invocation-local",
    code: "invocation_failed",
    action: "acknowledge",
    status: "acknowledged",
    changed: true,
    evidenceHash: result.evidenceHash,
    transitionedAt: NOW.toISOString(),
    containsForumText: false
  });
  assert.match(result.evidenceHash, /^[a-f0-9]{64}$/);
  assert.equal(fixture.state.updates.length, 1);
  assert.deepEqual(fixture.state.updates[0], {
    status: "acknowledged"
  });
  assert.equal(fixture.state.reviewEvents.length, 1);
  assert.equal(fixture.state.reviewEvents[0].kind, "incident_acknowledged");
  assert.equal(fixture.state.reviewEvents[0].outcome, "acknowledged");
  assert.equal(fixture.state.reviewEvents[0].reasonCode, "invocation_failed");
  assert.equal(fixture.state.reviewEvents[0].containsForumText, false);
  assert.equal(fixture.state.tapeEntries.length, 1);
  assert.equal(fixture.state.tapeEntries[0].kind, "incident_acknowledged");
  const tapePayload = JSON.parse(
    String(fixture.state.tapeEntries[0].payloadJson)
  ) as Record<string, unknown>;
  assert.deepEqual(Object.keys(tapePayload).sort(), [
    "action",
    "containsForumText",
    "incidentEvidenceHash",
    "schemaVersion",
    "status",
    "transitionedAt"
  ]);
  assert.equal(tapePayload.schemaVersion, INCIDENT_TRANSITION_SCHEMA_VERSION);
  assert.equal(tapePayload.action, "acknowledge");
  assert.equal(tapePayload.status, "acknowledged");
  assert.equal(tapePayload.incidentEvidenceHash, INCIDENT_EVIDENCE_HASH);
  assert.equal(tapePayload.transitionedAt, NOW.toISOString());
  assert.equal(tapePayload.containsForumText, false);
  assert.equal(
    JSON.stringify(fixture.state).includes("free text"),
    false
  );
});

test("resolve 可从 acknowledged 到 resolved，重复调用不重复写事件", async () => {
  const fixture = fakePrisma(
    incident({ status: "acknowledged" })
  );
  const first = await transitionAutonomyIncident({
    prisma: fixture.client,
    incidentId: "incident-local",
    expectedEvidenceHash: INCIDENT_EVIDENCE_HASH,
    action: "resolve",
    now: NOW
  });
  const second = await transitionAutonomyIncident({
    prisma: fixture.client,
    incidentId: "incident-local",
    expectedEvidenceHash: INCIDENT_EVIDENCE_HASH,
    action: "resolve",
    now: new Date(NOW.getTime() + 1_000)
  });
  assert.equal(first.status, "resolved");
  assert.equal(first.changed, true);
  assert.equal(second.status, "resolved");
  assert.equal(second.changed, false);
  assert.equal(fixture.state.updates.length, 1);
  assert.equal(fixture.state.reviewEvents.length, 1);
  assert.equal(fixture.state.tapeEntries.length, 1);
  assert.equal(
    fixture.state.updates[0].resolvedAt instanceof Date,
    true
  );
});

test("服务严格校验输入、证据漂移、缺失异常与 CAS 失败", async () => {
  const fixture = fakePrisma();
  await assert.rejects(
    () =>
      transitionAutonomyIncident({
        prisma: fixture.client,
        incidentId: "",
        expectedEvidenceHash: INCIDENT_EVIDENCE_HASH,
        action: "acknowledge",
        now: NOW
      }),
    /INCIDENT_ID_INVALID/
  );
  await assert.rejects(
    () =>
      transitionAutonomyIncident({
        prisma: fixture.client,
        incidentId: "incident-local",
        expectedEvidenceHash: "not-a-hash",
        action: "acknowledge",
        now: NOW
      }),
    /INCIDENT_EVIDENCE_HASH_INVALID/
  );
  await assert.rejects(
    () =>
      transitionAutonomyIncident({
        prisma: fixture.client,
        incidentId: "incident-local",
        expectedEvidenceHash: INCIDENT_EVIDENCE_HASH,
        action: "acknowledge",
        now: "not-a-time"
      }),
    /INCIDENT_TRANSITION_TIME_INVALID/
  );
  await assert.rejects(
    () =>
      transitionAutonomyIncident({
        prisma: fixture.client,
        incidentId: "incident-local",
        expectedEvidenceHash: INCIDENT_EVIDENCE_HASH,
        action: "acknowledge",
        now: 123 as unknown as Date
      }),
    /INCIDENT_TRANSITION_TIME_INVALID/
  );
  await assert.rejects(
    () =>
      transitionAutonomyIncident({
        prisma: fixture.client,
        incidentId: "incident-local",
        expectedEvidenceHash: hash("different-evidence"),
        action: "acknowledge",
        now: NOW
      }),
    /INCIDENT_EVIDENCE_HASH_MISMATCH/
  );
  const missing = fakePrisma(null);
  await assert.rejects(
    () =>
      transitionAutonomyIncident({
        prisma: missing.client,
        incidentId: "incident-local",
        expectedEvidenceHash: INCIDENT_EVIDENCE_HASH,
        action: "acknowledge",
        now: NOW
      }),
    /INCIDENT_NOT_FOUND/
  );
  const conflict = fakePrisma();
  (conflict.client as {
    autonomyIncident: {
      updateMany: () => Promise<{ count: number }>;
    };
  }).autonomyIncident.updateMany = async () => ({ count: 0 });
  await assert.rejects(
    () =>
      transitionAutonomyIncident({
        prisma: conflict.client,
        incidentId: "incident-local",
        expectedEvidenceHash: INCIDENT_EVIDENCE_HASH,
        action: "acknowledge",
        now: NOW
      }),
    /INCIDENT_TRANSITION_CONFLICT/
  );
});
