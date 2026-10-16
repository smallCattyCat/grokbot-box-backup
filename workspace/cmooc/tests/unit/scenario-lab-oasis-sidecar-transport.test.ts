import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OASIS_SIDECAR_SCHEMA_VERSIONS,
  type OasisSidecarCapabilitiesV1
} from "../../lib/scenario-lab/oasis-sidecar-contracts";
import {
  OASIS_SIDECAR_MAX_OUTPUT_BYTES,
  OASIS_SIDECAR_TRANSPORT_VERSION,
  OASIS_SIDECAR_WALL_CLOCK_LIMIT_MS,
  OasisSidecarTransportError,
  readOasisSidecarCapabilities,
  runOasisConformanceSidecar
} from "../../lib/scenario-lab/oasis-sidecar-transport";
import {
  SCENARIO_LAB_SCHEMA_VERSIONS,
  type CourseWorldFrozenEvidenceV1,
  protocolHash
} from "../../lib/scenario-lab/contracts";
import { compileOasisScenePack } from "../../lib/scenario-lab/oasis-scene-pack";

const REQUEST_ID = "0123456789abcdef0123456789abcdef";
const HASH_A = "a".repeat(64);
const temporaryRoots: string[] = [];

after(async () => {
  await Promise.all(
    temporaryRoots.map((root) => rm(root, { recursive: true, force: true }))
  );
});

function capability(
  overrides: Partial<Omit<OasisSidecarCapabilitiesV1, "capabilityHash">> = {}
): OasisSidecarCapabilitiesV1 {
  const body = {
    schemaVersion: OASIS_SIDECAR_SCHEMA_VERSIONS.capabilities,
    runtimeId: "oasis_sidecar_v1" as const,
    protocolVersion: "v1" as const,
    conformanceReferenceAvailable: true as const,
    nativeOasisAvailable: false,
    supportedScenePackSchemaVersions: [
      "cmooc.oasis-scene-pack.v1" as const
    ] as ["cmooc.oasis-scene-pack.v1"],
    supportedOperations: [
      "capabilities" as const,
      "run_conformance" as const
    ] as ["capabilities", "run_conformance"],
    executionBoundary: {
      externalNetworkUsed: false as const,
      workspaceWriteCount: 0 as const,
      scratchWriteCount: 0 as const,
      evidenceMode: "sidecar_self_report" as const,
      enforcementMode: "process_contract_only" as const
    },
    ...overrides
  };
  return {
    ...body,
    capabilityHash: protocolHash(body.schemaVersion, body)
  };
}

async function fixtureScript(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cmooc-oasis-transport-"));
  temporaryRoots.push(root);
  const path = join(root, "fixture.cjs");
  await writeFile(path, source, "utf8");
  return path;
}

function nodeOptions(scriptPath: string) {
  return {
    executable: process.execPath,
    scriptPath,
    cwd: process.cwd(),
    requestId: REQUEST_ID
  } as const;
}

function responderSource(
  payload: unknown,
  transform = "const response = {transportVersion: request.transportVersion, requestId: request.requestId, requestHash: request.requestHash, ok: true, payload};"
): string {
  return `
const payload = ${JSON.stringify(payload)};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const frames = input.split("\\n");
  if (frames.length !== 2 || frames[1] !== "") process.exit(91);
  const request = JSON.parse(frames[0]);
  if (
    Object.keys(request).sort().join(",") !== "maxOutputBytes,payload,requestHash,requestId,transportVersion,wallClockLimitMs" ||
    request.transportVersion !== ${JSON.stringify(OASIS_SIDECAR_TRANSPORT_VERSION)} ||
    request.requestId !== ${JSON.stringify(REQUEST_ID)} ||
    request.wallClockLimitMs !== ${OASIS_SIDECAR_WALL_CLOCK_LIMIT_MS} ||
    request.maxOutputBytes !== ${OASIS_SIDECAR_MAX_OUTPUT_BYTES} ||
    process.env.OASIS_TEST_SECRET !== undefined
  ) process.exit(92);
  process.stderr.write("local-secret-must-not-escape\\n");
  ${transform}
  process.stdout.write(JSON.stringify(response) + "\\n");
});
`;
}

function expectCode(code: OasisSidecarTransportError["code"]) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof OasisSidecarTransportError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(error.message.includes("local-secret"), false);
    return true;
  };
}

function frozenEvidence(): CourseWorldFrozenEvidenceV1 {
  const body = {
    schemaVersion: SCENARIO_LAB_SCHEMA_VERSIONS.evidence,
    datasetRef: "p3a-2025-holdout-v1" as const,
    evidenceClass: "observed_frozen_aggregate" as const,
    cohortYear: 2025 as const,
    split: "time_holdout" as const,
    clock: {
      kind: "p3a_historical" as const,
      decisionLagHours: 22 as const,
      outcomeEndHours: 86 as const,
      outcomeWindowHours: 64 as const,
      schedulerTickMinutes: 30 as const,
      candidateTtlMinutes: 30 as const
    },
    counts: {
      snapshotCount: 2_702,
      ineligibleOrAnsweredAtDecisionCount: 2_085,
      eligibleUnansweredCount: 617,
      organicExternalResponseInWindowCount: 217,
      supportGapAtHorizonCount: 400
    },
    decisionCalendarYearCounts: [
      { year: 2025, count: 2_604 },
      { year: 2026, count: 98 }
    ],
    upstream: {
      snapshotSchemaVersion: "cmooc-decision-snapshot-v1" as const,
      benchmarkSchemaVersion: "cmooc-scheduler-benchmark-v2" as const,
      temporalContractHash: HASH_A,
      evidenceRefSetHash: HASH_A,
      benchmarkInputHash: HASH_A,
      metricsResultHash: HASH_A,
      actionLogHash: HASH_A,
      artifactFileHashes: {
        decisionSnapshotsCsvSha256: HASH_A,
        metricsJsonSha256: HASH_A,
        actionsCsvSha256: HASH_A
      }
    },
    privacy: {
      containsForumText: false as const,
      containsIdentity: false as const,
      containsRawPlatformIds: false as const,
      containsRowLevelKeys: false as const
    },
    networkUsed: false as const,
    writesPerformed: false as const,
    interventionEligible: false as const
  };
  return {
    ...body,
    evidenceHash: protocolHash(body.schemaVersion, body)
  };
}

test("sidecar transport sends one bounded JSONL envelope and strips ambient secrets", async () => {
  const previous = process.env.OASIS_TEST_SECRET;
  process.env.OASIS_TEST_SECRET = "do-not-inherit";
  try {
    const scriptPath = await fixtureScript(responderSource(capability()));
    const result = await readOasisSidecarCapabilities(nodeOptions(scriptPath));
    assert.deepEqual(result, capability());
  } finally {
    if (previous === undefined) delete process.env.OASIS_TEST_SECRET;
    else process.env.OASIS_TEST_SECRET = previous;
  }
});

test("sidecar transport rejects extra stdout frames and a mismatched echo", async () => {
  const duplicatePath = await fixtureScript(
    responderSource(
      capability(),
      "const response = {transportVersion: request.transportVersion, requestId: request.requestId, requestHash: request.requestHash, ok: true, payload}; process.stdout.write(JSON.stringify(response) + '\\n');"
    )
  );
  await assert.rejects(
    readOasisSidecarCapabilities(nodeOptions(duplicatePath)),
    expectCode("OASIS_SIDECAR_OUTPUT_FRAME_INVALID")
  );

  const echoPath = await fixtureScript(
    responderSource(
      capability(),
      "const response = {transportVersion: request.transportVersion, requestId: 'f'.repeat(32), requestHash: request.requestHash, ok: true, payload};"
    )
  );
  await assert.rejects(
    readOasisSidecarCapabilities(nodeOptions(echoPath)),
    expectCode("OASIS_SIDECAR_ECHO_MISMATCH")
  );
});

test("sidecar transport validates unknown payload shape and recomputes its hash", async () => {
  const extraField = { ...capability(), unexpected: true };
  const extraPath = await fixtureScript(responderSource(extraField));
  await assert.rejects(
    readOasisSidecarCapabilities(nodeOptions(extraPath)),
    expectCode("OASIS_SIDECAR_PAYLOAD_INVALID")
  );

  const tampered = { ...capability(), nativeOasisAvailable: true };
  const tamperedPath = await fixtureScript(responderSource(tampered));
  await assert.rejects(
    readOasisSidecarCapabilities(nodeOptions(tamperedPath)),
    expectCode("OASIS_SIDECAR_PAYLOAD_INVALID")
  );
});

test("sidecar transport preserves only a stable remote error code", async () => {
  const scriptPath = await fixtureScript(
    responderSource(
      capability(),
      "const response = {transportVersion: request.transportVersion, requestId: request.requestId, requestHash: request.requestHash, ok: false, error: {code: 'SIDECAR_OPERATION_UNSUPPORTED'}};"
    )
  );
  await assert.rejects(
    readOasisSidecarCapabilities(nodeOptions(scriptPath)),
    (error: unknown) => {
      assert.ok(error instanceof OasisSidecarTransportError);
      assert.equal(error.code, "OASIS_SIDECAR_REMOTE_ERROR");
      assert.equal(error.remoteCode, "SIDECAR_OPERATION_UNSUPPORTED");
      assert.equal(error.message, "OASIS_SIDECAR_REMOTE_ERROR");
      return true;
    }
  );
});

test("Abort kills the sidecar process tree and waits for confirmed closure", async () => {
  const root = await mkdtemp(join(tmpdir(), "cmooc-oasis-tree-"));
  temporaryRoots.push(root);
  const marker = join(root, "descendant-survived.txt");
  const source = `
const {spawn} = require("node:child_process");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  ${
    process.platform === "win32"
      ? `spawn(process.execPath, ["-e", ${JSON.stringify(
          `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 900); setTimeout(() => {}, 5000);`
        )}], {stdio: "ignore", windowsHide: true});`
      : ""
  }
  setInterval(() => {}, 1000);
});
`;
  const scriptPath = await fixtureScript(source);
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  await assert.rejects(
    readOasisSidecarCapabilities({
      ...nodeOptions(scriptPath),
      signal: controller.signal
    }),
    expectCode("OASIS_SIDECAR_ABORTED")
  );
  clearTimeout(abortTimer);
  assert.ok(Date.now() - started < 4_000);
  if (process.platform === "win32") {
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_100));
    assert.equal(existsSync(marker), false);
  }
});

test("wall-clock expiry kills the sidecar and reports the stable timeout code", async () => {
  const scriptPath = await fixtureScript(`
process.stdin.resume();
process.stdin.on("end", () => setInterval(() => {}, 1000));
`);
  const started = Date.now();
  await assert.rejects(
    readOasisSidecarCapabilities({
      ...nodeOptions(scriptPath),
      wallClockLimitMs: 75
    }),
    expectCode("OASIS_SIDECAR_TIMEOUT")
  );
  assert.ok(Date.now() - started < 3_000);
});

test("the repository Python sidecar verifies request hash and returns deterministic validated output", async () => {
  const firstCapability = await readOasisSidecarCapabilities({
    requestId: REQUEST_ID
  });
  const secondCapability = await readOasisSidecarCapabilities({
    requestId: REQUEST_ID
  });
  assert.deepEqual(secondCapability, firstCapability);

  const scenePack = compileOasisScenePack(frozenEvidence());
  const first = await runOasisConformanceSidecar(scenePack, {
    requestId: REQUEST_ID
  });
  const second = await runOasisConformanceSidecar(scenePack, {
    requestId: REQUEST_ID
  });
  assert.deepEqual(second, first);
  assert.equal(first.seedRunCount, 64);
  assert.equal(first.scenePackHash, scenePack.scenePackHash);
  assert.equal(first.executionBoundary.workspaceWriteCount, 0);
  assert.equal(first.interventionEligible, false);
});

test("a response larger than the advertised two MiB limit is terminated", async () => {
  const scriptPath = await fixtureScript(`
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write("x".repeat(${OASIS_SIDECAR_MAX_OUTPUT_BYTES + 1}));
  setInterval(() => {}, 1000);
});
`);
  await assert.rejects(
    readOasisSidecarCapabilities(nodeOptions(scriptPath)),
    expectCode("OASIS_SIDECAR_OUTPUT_TOO_LARGE")
  );
});
