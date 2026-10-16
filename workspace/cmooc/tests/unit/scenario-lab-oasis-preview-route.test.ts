import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import type { OasisPreviewReportV1 } from "../../lib/scenario-lab/oasis-sidecar-contracts";
import { OasisSidecarTransportError } from "../../lib/scenario-lab/oasis-sidecar-transport";
import { ScenarioLabEvidenceError } from "../../lib/scenario-lab/p3a-evidence-reader";
import { createScenarioLabOasisPreviewRouteHandler } from "../../lib/workbench/scenario-lab-oasis-preview-route-handler";

const VALID_REQUEST = {
  datasetRef: "p3a-2025-holdout-v1",
  sceneTemplateRef: "course-support-network-64-v1",
  seedSetRef: "courseworld-seeds-16-v1",
  runtimeId: "oasis_contract_reference_v1"
} as const;

const READY_REPORT = {
  schemaVersion: "cmooc.oasis-preview-report.v1",
  datasetRef: VALID_REQUEST.datasetRef,
  sceneTemplateRef: VALID_REQUEST.sceneTemplateRef,
  seedSetRef: VALID_REQUEST.seedSetRef,
  reportHash: "a".repeat(64)
} as unknown as OasisPreviewReportV1;

function request(
  body: unknown,
  options: { raw?: boolean; signal?: AbortSignal } = {}
): NextRequest {
  return new NextRequest(
    "http://localhost:3000/api/scenario-lab/oasis-preview",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: options.raw ? String(body) : JSON.stringify(body),
      signal: options.signal
    }
  );
}

async function responseBody(response: Response) {
  return (await response.json()) as { error?: { code?: string } };
}

test("OASIS preview API accepts only the exact four-field request", async () => {
  let runCount = 0;
  const handler = createScenarioLabOasisPreviewRouteHandler({
    runPreview: async () => {
      runCount += 1;
      return READY_REPORT;
    }
  });

  for (const body of [
    {},
    null,
    [],
    { ...VALID_REQUEST, extra: true },
    {
      datasetRef: VALID_REQUEST.datasetRef,
      sceneTemplateRef: VALID_REQUEST.sceneTemplateRef,
      seedSetRef: VALID_REQUEST.seedSetRef
    },
    { ...VALID_REQUEST, datasetRef: 17 }
  ]) {
    const response = await handler(request(body));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(
      (await responseBody(response)).error?.code,
      "OASIS_PREVIEW_REQUEST_INVALID"
    );
  }
  const malformed = await handler(request("{bad-json", { raw: true }));
  assert.equal(malformed.status, 400);
  assert.equal(malformed.headers.get("cache-control"), "no-store");
  assert.equal(runCount, 0);
});

test("OASIS preview API distinguishes unknown versioned references and runtime", async () => {
  const handler = createScenarioLabOasisPreviewRouteHandler({
    runPreview: async () => READY_REPORT
  });
  const fixtures = [
    [
      { ...VALID_REQUEST, datasetRef: "unknown" },
      404,
      "OASIS_PREVIEW_DATASET_NOT_FOUND"
    ],
    [
      { ...VALID_REQUEST, sceneTemplateRef: "unknown" },
      404,
      "OASIS_PREVIEW_SCENE_TEMPLATE_NOT_FOUND"
    ],
    [
      { ...VALID_REQUEST, seedSetRef: "unknown" },
      404,
      "OASIS_PREVIEW_SEED_SET_NOT_FOUND"
    ],
    [
      { ...VALID_REQUEST, runtimeId: "oasis_sidecar_v1" },
      409,
      "OASIS_PREVIEW_RUNTIME_UNAVAILABLE"
    ]
  ] as const;

  for (const [body, status, code] of fixtures) {
    const response = await handler(request(body));
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await responseBody(response)).error?.code, code);
  }
});

test("OASIS preview API injects the exact runner request and request cancellation signal", async () => {
  const controller = new AbortController();
  let receivedRequest: unknown;
  let receivedSignal: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const handler = createScenarioLabOasisPreviewRouteHandler({
    runPreview: async (input, options) => {
      receivedRequest = input;
      receivedSignal = options.signal;
      markStarted();
      return new Promise<OasisPreviewReportV1>((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(new OasisSidecarTransportError("OASIS_SIDECAR_ABORTED")),
          { once: true }
        );
      });
    }
  });

  const incomingRequest = request(VALID_REQUEST, {
    signal: controller.signal
  });
  const pending = handler(incomingRequest);
  await started;
  controller.abort();
  const response = await pending;

  assert.deepEqual(receivedRequest, VALID_REQUEST);
  assert.equal(receivedSignal, incomingRequest.signal);
  assert.equal(receivedSignal?.aborted, true);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(
    (await responseBody(response)).error?.code,
    "OASIS_PREVIEW_SIDECAR_UNAVAILABLE"
  );
});

test("OASIS preview API returns no-store reports and folds evidence/sidecar errors without leaks", async () => {
  const successHandler = createScenarioLabOasisPreviewRouteHandler({
    runPreview: async () => READY_REPORT
  });
  const success = await successHandler(request(VALID_REQUEST));
  assert.equal(success.status, 200);
  assert.equal(success.headers.get("cache-control"), "no-store");
  assert.deepEqual(await success.json(), READY_REPORT);

  const fixtures = [
    {
      error: new ScenarioLabEvidenceError(
        "EVIDENCE_HASH_MISMATCH",
        "C:\\private\\SECRET_EVIDENCE.csv"
      ),
      status: 409,
      code: "OASIS_PREVIEW_EVIDENCE_CONFLICT"
    },
    {
      error: new OasisSidecarTransportError(
        "OASIS_SIDECAR_REMOTE_ERROR",
        "SECRET_REMOTE_CODE"
      ),
      status: 503,
      code: "OASIS_PREVIEW_SIDECAR_UNAVAILABLE"
    },
    {
      error: new Error("DATABASE_URL=SECRET_TOKEN at C:\\private\\runner.py"),
      status: 503,
      code: "OASIS_PREVIEW_SOURCE_UNAVAILABLE"
    }
  ] as const;

  for (const fixture of fixtures) {
    const handler = createScenarioLabOasisPreviewRouteHandler({
      runPreview: async () => {
        throw fixture.error;
      }
    });
    const response = await handler(request(VALID_REQUEST));
    const serialized = JSON.stringify(await response.json());
    assert.equal(response.status, fixture.status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(JSON.parse(serialized).error.code, fixture.code);
    assert.equal(serialized.includes("SECRET"), false);
    assert.equal(serialized.includes("DATABASE_URL"), false);
    assert.equal(serialized.includes("private"), false);
    assert.equal(serialized.includes("remoteCode"), false);
  }
});
