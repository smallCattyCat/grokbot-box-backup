import assert from "node:assert/strict";
import test from "node:test";
import {
  OPERATOR_WORKER_WAKE_SCOPE,
  readLatestOperatorRunReceipt,
  readLatestOperatorWorkerWakeReceipt
} from "../../lib/workbench/operator-read-model";

type FixtureReceipt = {
  id: string;
  source: string;
  runtimeVersion: string;
  status: string;
  startedAt: Date;
  editorWriteCount: number;
  publishAttemptCount: number;
  realPublishEnabled: boolean;
  containsForumText: boolean;
};

function fixtureReceipt(
  input: Pick<
    FixtureReceipt,
    "id" | "source" | "runtimeVersion" | "startedAt"
  >
): FixtureReceipt {
  return {
    ...input,
    status: "completed",
    editorWriteCount: 0,
    publishAttemptCount: 0,
    realPublishEnabled: false,
    containsForumText: false
  };
}

function fixtureReader(rows: FixtureReceipt[]) {
  const queries: unknown[] = [];
  return {
    queries,
    findFirst: async (query: {
      where: typeof OPERATOR_WORKER_WAKE_SCOPE;
      orderBy: Array<{ startedAt: "desc" } | { id: "desc" }>;
      select: {
        status: true;
        startedAt: true;
        editorWriteCount: true;
        publishAttemptCount: true;
        realPublishEnabled: true;
        containsForumText: true;
      };
    }) => {
      queries.push(query);
      const selected = rows
        .filter(
          (row) =>
            row.source === query.where.source &&
            row.runtimeVersion === query.where.runtimeVersion
        )
        .sort(
          (left, right) =>
            right.startedAt.getTime() - left.startedAt.getTime() ||
            right.id.localeCompare(left.id)
        )[0];
      if (!selected) return null;
      return {
        status: selected.status,
        startedAt: selected.startedAt,
        editorWriteCount: selected.editorWriteCount,
        publishAttemptCount: selected.publishAttemptCount,
        realPublishEnabled: selected.realPublishEnabled,
        containsForumText: selected.containsForumText
      };
    }
  };
}

test("operator latest wake is restricted to the active production source and runtime", async () => {
  const productionStartedAt = new Date("2026-08-04T15:30:00.000Z");
  const reader = fixtureReader([
    fixtureReceipt({
      id: "wake-local-newer",
      source: "local",
      runtimeVersion: "v1-rc13",
      startedAt: new Date("2026-08-10T12:00:00.000Z")
    }),
    fixtureReceipt({
      id: "wake-old-runtime-newer",
      source: "codex_automation",
      runtimeVersion: "v1-rc12",
      startedAt: new Date("2026-08-09T12:00:00.000Z")
    }),
    fixtureReceipt({
      id: "wake-production",
      source: "codex_automation",
      runtimeVersion: "v1-rc13",
      startedAt: productionStartedAt
    })
  ]);

  const result = await readLatestOperatorWorkerWakeReceipt({
    findFirst: reader.findFirst
  });

  assert.deepEqual(OPERATOR_WORKER_WAKE_SCOPE, {
    source: "codex_automation",
    runtimeVersion: "v1-rc13"
  });
  assert.deepEqual(reader.queries, [
    {
      where: {
        source: "codex_automation",
        runtimeVersion: "v1-rc13"
      },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      select: {
        status: true,
        startedAt: true,
        editorWriteCount: true,
        publishAttemptCount: true,
        realPublishEnabled: true,
        containsForumText: true
      }
    }
  ]);
  assert.equal(result?.startedAt.getTime(), productionStartedAt.getTime());
});

test("operator latest wake remains null when only foreign-scope receipts exist", async () => {
  const reader = fixtureReader([
    fixtureReceipt({
      id: "wake-local",
      source: "local",
      runtimeVersion: "v1-rc13",
      startedAt: new Date("2026-08-10T12:00:00.000Z")
    }),
    fixtureReceipt({
      id: "wake-other-runtime",
      source: "codex_automation",
      runtimeVersion: "v1-rc12",
      startedAt: new Date("2026-08-09T12:00:00.000Z")
    })
  ]);

  const result = await readLatestOperatorWorkerWakeReceipt({
    findFirst: reader.findFirst
  });

  assert.equal(result, null);
});

test("operator latest run receipt can surface a newer local failure without treating it as host activation", async () => {
  const rows = [
    {
      ...fixtureReceipt({
        id: "wake-host-older",
        source: "codex_automation",
        runtimeVersion: "v1-rc13",
        startedAt: new Date("2026-08-10T11:00:00.000Z")
      }),
      status: "completed"
    },
    {
      ...fixtureReceipt({
        id: "wake-local-newer",
        source: "local_cli",
        runtimeVersion: "v1-rc13",
        startedAt: new Date("2026-08-10T12:00:00.000Z")
      }),
      status: "failed"
    }
  ];
  const queries: unknown[] = [];

  const result = await readLatestOperatorRunReceipt({
    findFirst: async (query) => {
      queries.push(query);
      const selected = [...rows].sort(
        (left, right) =>
          right.startedAt.getTime() - left.startedAt.getTime() ||
          right.id.localeCompare(left.id)
      )[0]!;
      return {
        status: selected.status,
        startedAt: selected.startedAt,
        editorWriteCount: selected.editorWriteCount,
        publishAttemptCount: selected.publishAttemptCount,
        realPublishEnabled: selected.realPublishEnabled,
        containsForumText: selected.containsForumText
      };
    }
  });

  assert.equal(result?.status, "failed");
  assert.equal(result?.startedAt.toISOString(), "2026-08-10T12:00:00.000Z");
  assert.deepEqual(queries, [{
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    select: {
      status: true,
      startedAt: true,
      editorWriteCount: true,
      publishAttemptCount: true,
      realPublishEnabled: true,
      containsForumText: true
    }
  }]);
});
