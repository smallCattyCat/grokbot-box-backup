import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import type { CourseWorldScenarioLabReportV1 } from "../../lib/scenario-lab/contracts";
import { ScenarioLabEvidenceError } from "../../lib/scenario-lab/p3a-evidence-reader";
import { createScenarioLabRouteHandler } from "../../lib/workbench/scenario-lab-route-handler";

function request(body: unknown, raw = false) {
  return new NextRequest("http://localhost:3000/api/scenario-lab/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? String(body) : JSON.stringify(body)
  });
}

const validRequest = {
  datasetRef: "p3a-2025-holdout-v1",
  scenarioSetRef: "scheduler-k-comparison-v1",
  runtimeId: "deterministic_p3a_replay_v1"
} as const;

const readyReport = {
  schemaVersion: "cmooc.courseworld-scenario-lab-report.v1",
  datasetRef: "p3a-2025-holdout-v1",
  scenarioSetRef: "scheduler-k-comparison-v1",
  reportHash: "a".repeat(64)
} as unknown as CourseWorldScenarioLabReportV1;

test("Scenario Lab API 只接受精确的版本化请求", async () => {
  let runCount = 0;
  const handler = createScenarioLabRouteHandler({
    runScenario: async () => {
      runCount += 1;
      return readyReport;
    }
  });
  for (const body of [
    {},
    null,
    [],
    { ...validRequest, extra: true },
    {
      datasetRef: validRequest.datasetRef,
      scenarioSetRef: validRequest.scenarioSetRef
    }
  ]) {
    const response = await handler(request(body));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(
      (await response.json()).error.code,
      "SCENARIO_REQUEST_INVALID"
    );
  }
  const malformed = await handler(request("{bad-json", true));
  assert.equal(malformed.status, 400);
  assert.equal(runCount, 0);
});

test("Scenario Lab API 区分未知数据集、情景集合和未激活运行时", async () => {
  const handler = createScenarioLabRouteHandler({
    runScenario: async () => readyReport
  });
  const fixtures = [
    [
      { ...validRequest, datasetRef: "unknown" },
      404,
      "SCENARIO_DATASET_NOT_FOUND"
    ],
    [
      { ...validRequest, scenarioSetRef: "unknown" },
      404,
      "SCENARIO_SET_NOT_FOUND"
    ],
    [
      { ...validRequest, runtimeId: "oasis_sidecar_v1" },
      409,
      "SCENARIO_RUNTIME_UNAVAILABLE"
    ]
  ] as const;
  for (const [body, status, code] of fixtures) {
    const response = await handler(request(body));
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).error.code, code);
  }
});

test("Scenario Lab API 返回 no-store 报告并传递精确请求", async () => {
  const calls: unknown[] = [];
  const handler = createScenarioLabRouteHandler({
    runScenario: async (input) => {
      calls.push(input);
      return readyReport;
    }
  });
  const response = await handler(request(validRequest));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls, [validRequest]);
  assert.deepEqual(await response.json(), readyReport);
});

test("Scenario Lab API 折叠证据冲突和未知失败，不泄露底层信息", async () => {
  const fixtures = [
    {
      error: new ScenarioLabEvidenceError(
        "EVIDENCE_HASH_MISMATCH",
        "SECRET_LOCAL_PATH"
      ),
      status: 409,
      code: "SCENARIO_EVIDENCE_CONFLICT"
    },
    {
      error: new Error("DATABASE_URL=SECRET_TOKEN"),
      status: 503,
      code: "SCENARIO_SOURCE_UNAVAILABLE"
    }
  ];
  for (const fixture of fixtures) {
    const handler = createScenarioLabRouteHandler({
      runScenario: async () => {
        throw fixture.error;
      }
    });
    const response = await handler(request(validRequest));
    const serialized = JSON.stringify(await response.json());
    assert.equal(response.status, fixture.status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(JSON.parse(serialized).error.code, fixture.code);
    assert.equal(serialized.includes("SECRET"), false);
    assert.equal(serialized.includes("DATABASE_URL"), false);
    assert.equal(serialized.includes("LOCAL_PATH"), false);
  }
});
