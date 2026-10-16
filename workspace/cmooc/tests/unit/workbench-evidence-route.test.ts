import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  CourseEvidenceWorkspaceReadError,
  createEvidenceRouteHandler,
  type CourseEvidenceWorkspaceReader
} from "../../lib/workbench/evidence-route-handler";
import {
  buildCourseEvidenceWorkspace,
  type BuildCourseEvidenceWorkspaceInput
} from "../../lib/workbench/course-evidence-workspace";

function request(query: string) {
  return new NextRequest(`http://localhost:3000/api/workbench/evidence${query}`);
}

function readyWorkspace() {
  const fixture: BuildCourseEvidenceWorkspaceInput = {
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
  return buildCourseEvidenceWorkspace(fixture);
}

const VALID_QUERY =
  "?courseAlias=safe-course&invocationId=invocation-current&snapshotId=snapshot-current";

test("the public evidence API wires the strict handler to the anchored reader", () => {
  const routeSource = readFileSync(
    new URL("../../app/api/workbench/evidence/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(routeSource, /export const dynamic = "force-dynamic"/);
  assert.match(
    routeSource,
    /export const GET = createEvidenceRouteHandler\(\{[\s\S]*?readWorkspace: getAnchoredCourseEvidenceWorkspace[\s\S]*?\}\)/
  );
});

test("evidence API requires exactly one valid course, invocation, and snapshot parameter", async () => {
  let readCount = 0;
  const handler = createEvidenceRouteHandler({
    readWorkspace: (async () => {
      readCount += 1;
      return readyWorkspace();
    }) as CourseEvidenceWorkspaceReader
  });

  for (const query of [
    "",
    "?courseAlias=safe-course&invocationId=invocation-current",
    "?courseAlias=&invocationId=invocation-current&snapshotId=snapshot-current",
    "?courseAlias=safe-course&courseAlias=decoy-course&invocationId=invocation-current&snapshotId=snapshot-current",
    `${VALID_QUERY}&latest=true`,
    "?courseAlias=safe%20course&invocationId=invocation-current&snapshotId=snapshot-current"
  ]) {
    const response = await handler(request(query));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      error: {
        code: "EVIDENCE_ANCHOR_QUERY_INVALID",
        message: "必须且只能提供有效的 courseAlias、invocationId 与 snapshotId。"
      }
    });
  }
  assert.equal(readCount, 0);
});

test("evidence API passes only the exact normalized anchor and never caches the workspace", async () => {
  const calls: unknown[] = [];
  const workspace = readyWorkspace();
  const handler = createEvidenceRouteHandler({
    readWorkspace: (async (input) => {
      calls.push(input);
      return workspace;
    }) as CourseEvidenceWorkspaceReader
  });
  const response = await handler(
    request(
      "?courseAlias=%20safe-course%20&invocationId=invocation-current&snapshotId=snapshot-current"
    )
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls, [
    {
      anchor: {
        courseAlias: "safe-course",
        invocationId: "invocation-current",
        snapshotId: "snapshot-current"
      }
    }
  ]);
  assert.deepEqual(await response.json(), workspace);
});

test("evidence API maps stable 404 and 409 errors without leaking reader details", async () => {
  for (const fixture of [
    {
      error: new CourseEvidenceWorkspaceReadError(
        "EVIDENCE_ANCHOR_NOT_FOUND",
        "SECRET_DATABASE_ROW"
      ),
      status: 404,
      code: "EVIDENCE_ANCHOR_NOT_FOUND",
      message: "未找到请求的课程证据锚点。"
    },
    {
      error: new CourseEvidenceWorkspaceReadError(
        "EVIDENCE_ANCHOR_CONFLICT",
        "SECRET_MANIFEST_HASH"
      ),
      status: 409,
      code: "EVIDENCE_ANCHOR_CONFLICT",
      message: "课程、运行与世界快照的证据绑定不一致。"
    }
  ]) {
    const handler = createEvidenceRouteHandler({
      readWorkspace: (async () => {
        throw fixture.error;
      }) as CourseEvidenceWorkspaceReader
    });
    const response = await handler(request(VALID_QUERY));
    const serialized = JSON.stringify(await response.json());

    assert.equal(response.status, fixture.status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(JSON.parse(serialized), {
      error: { code: fixture.code, message: fixture.message }
    });
    assert.equal(serialized.includes("SECRET_"), false);
  }
});

test("evidence API collapses unexpected failures to a stable non-leaking 503", async () => {
  const handler = createEvidenceRouteHandler({
    readWorkspace: (async () => {
      throw new Error("DATABASE_URL=SECRET_TOKEN_SENTINEL");
    }) as CourseEvidenceWorkspaceReader
  });
  const response = await handler(request(VALID_QUERY));
  const serialized = JSON.stringify(await response.json());

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(JSON.parse(serialized), {
    error: {
      code: "EVIDENCE_SOURCE_UNAVAILABLE",
      message: "课程证据工作区暂时不可用，请稍后重试。"
    }
  });
  assert.equal(serialized.includes("SECRET_TOKEN_SENTINEL"), false);
  assert.equal(serialized.includes("DATABASE_URL"), false);
});
