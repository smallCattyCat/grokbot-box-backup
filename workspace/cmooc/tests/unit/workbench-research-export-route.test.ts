import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  buildCourseEvidenceWorkspace,
  buildCourseResearchExport,
  type BuildCourseEvidenceWorkspaceInput
} from "../../lib/workbench/course-evidence-workspace";
import {
  CourseEvidenceWorkspaceReadError,
  type CourseEvidenceWorkspaceReader
} from "../../lib/workbench/evidence-route-handler";
import { createResearchExportRouteHandler } from "../../lib/workbench/research-export-route-handler";

function readyWorkspace() {
  const input: BuildCourseEvidenceWorkspaceInput = {
    anchor: {
      courseAlias: "safe-course",
      invocationId: "invocation-current",
      snapshotId: "snapshot-current"
    },
    current: {
      id: "snapshot-current",
      courseAlias: "safe-course",
      invocationId: "invocation-current",
      asOfAt: new Date("2026-08-12T11:00:00.000Z"),
      eventCount: 10,
      threadCount: 5,
      actorCount: 4,
      edgeCount: 3,
      openGapCount: 2
    },
    baseline: null,
    coverage: {
      status: "complete",
      discoveredThreadCount: 5,
      completedDetailCount: 5,
      observedEventCount: 10,
      incompleteThreadCount: 0,
      failedTargetCount: 0
    },
    qualification: null,
    matureSupportGapCount: 2,
    graph: { status: "complete" }
  };
  return buildCourseEvidenceWorkspace(input);
}

function request(query: string) {
  return new NextRequest(
    `http://localhost:3000/api/workbench/research-export${query}`
  );
}

const VALID_QUERY =
  "?courseAlias=safe-course&invocationId=invocation-current&snapshotId=snapshot-current";

test("the public research API wires the attachment handler to the anchored reader", () => {
  const routeSource = readFileSync(
    new URL("../../app/api/workbench/research-export/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(routeSource, /export const dynamic = "force-dynamic"/);
  assert.match(
    routeSource,
    /export const GET = createResearchExportRouteHandler\(\{[\s\S]*?readWorkspace: getAnchoredCourseEvidenceWorkspace[\s\S]*?\}\)/
  );
});

test("research export route enforces the same exact three-parameter anchor", async () => {
  let reads = 0;
  const handler = createResearchExportRouteHandler({
    readWorkspace: (async () => {
      reads += 1;
      return readyWorkspace();
    }) as CourseEvidenceWorkspaceReader
  });
  for (const query of [
    "",
    "?courseAlias=safe-course&invocationId=invocation-current",
    `${VALID_QUERY}&format=csv`,
    "?courseAlias=safe-course&invocationId=invocation-current&snapshotId=snapshot-current&snapshotId=decoy"
  ]) {
    const response = await handler(request(query));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).error.code, "RESEARCH_EXPORT_ANCHOR_QUERY_INVALID");
  }
  assert.equal(reads, 0);
});

test("research export is a no-store JSON attachment named only from its digest", async () => {
  const workspace = readyWorkspace();
  const expected = buildCourseResearchExport(workspace);
  const calls: unknown[] = [];
  const handler = createResearchExportRouteHandler({
    readWorkspace: (async (input) => {
      calls.push(input);
      return workspace;
    }) as CourseEvidenceWorkspaceReader
  });
  const response = await handler(request(VALID_QUERY));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(
    response.headers.get("content-disposition"),
    `attachment; filename="cmooc-course-evidence-${expected.sha256.slice(0, 12)}.json"`
  );
  assert.equal(response.headers.get("x-cmooc-evidence-sha256"), expected.sha256);
  assert.equal((response.headers.get("content-disposition") ?? "").includes("safe-course"), false);
  assert.equal((response.headers.get("content-disposition") ?? "").includes("snapshot-current"), false);
  assert.equal(await response.text(), expected.json);
  assert.deepEqual(calls, [
    {
      anchor: {
        courseAlias: "safe-course",
        invocationId: "invocation-current",
        snapshotId: "snapshot-current"
      }
    }
  ]);
});

test("research export maps 404, 409, and unexpected 503 without leaking errors", async () => {
  const fixtures = [
    {
      error: new CourseEvidenceWorkspaceReadError(
        "EVIDENCE_ANCHOR_NOT_FOUND",
        "SECRET_ROW"
      ),
      status: 404,
      code: "RESEARCH_EXPORT_ANCHOR_NOT_FOUND"
    },
    {
      error: new CourseEvidenceWorkspaceReadError(
        "EVIDENCE_ANCHOR_CONFLICT",
        "SECRET_HASH"
      ),
      status: 409,
      code: "RESEARCH_EXPORT_ANCHOR_CONFLICT"
    },
    {
      error: new Error("DATABASE_URL=SECRET_TOKEN"),
      status: 503,
      code: "RESEARCH_EXPORT_UNAVAILABLE"
    }
  ];
  for (const fixture of fixtures) {
    const handler = createResearchExportRouteHandler({
      readWorkspace: (async () => {
        throw fixture.error;
      }) as CourseEvidenceWorkspaceReader
    });
    const response = await handler(request(VALID_QUERY));
    const serialized = JSON.stringify(await response.json());

    assert.equal(response.status, fixture.status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(JSON.parse(serialized).error.code, fixture.code);
    assert.equal(serialized.includes("SECRET_"), false);
    assert.equal(serialized.includes("DATABASE_URL"), false);
  }
});
