import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  createBriefRouteHandler
} from "../../lib/workbench/brief-route-handler";
import {
  CourseOpportunityBriefReadError,
  type getAnchoredCourseOpportunityBrief
} from "../../lib/workbench/operator-read-model";
import { buildCourseOpportunityBrief } from "../../lib/workbench/course-opportunity-brief";

type BriefReader = typeof getAnchoredCourseOpportunityBrief;

function request(query: string) {
  return new NextRequest(`http://localhost:3000/api/workbench/brief${query}`);
}

function readyBrief() {
  return buildCourseOpportunityBrief({
    anchor: {
      courseAlias: "safe-course",
      courseName: "安全课程",
      invocationId: "invocation-current",
      snapshotId: "snapshot-current",
      manifestHash: "manifest-current",
      worldHash: "world-current",
      coverageHash: "coverage-current",
      candidateSetHash: "candidates-current",
      worldAsOf: new Date("2026-08-12T11:00:00.000Z")
    },
    coverage: {
      status: "complete",
      incompleteThreadCount: 0,
      failedTargetCount: 0
    },
    supportGaps: { matureCount: 0, longestOpenHours: null },
    sourceChecks: {
      coverage: "checked",
      supportGaps: "checked",
      decisions: "checked",
      incidents: "checked",
      dueOutcomes: "checked"
    },
    decisions: [],
    incidents: [],
    dueOutcomes: []
  });
}

test("brief route requires exactly one complete immutable anchor and rejects extra query fields", async () => {
  let readCount = 0;
  const handler = createBriefRouteHandler({
    readBrief: (async () => {
      readCount += 1;
      return readyBrief();
    }) as BriefReader
  });
  const invalidQueries = [
    "",
    "?courseAlias=safe-course&invocationId=invocation-current",
    "?courseAlias=&invocationId=invocation-current&snapshotId=snapshot-current",
    "?courseAlias=safe-course&courseAlias=decoy-course&invocationId=invocation-current&snapshotId=snapshot-current",
    "?courseAlias=safe-course&invocationId=invocation-current&snapshotId=snapshot-current&latest=true",
    "?courseAlias=safe%20course&invocationId=invocation-current&snapshotId=snapshot-current"
  ];

  for (const query of invalidQueries) {
    const response = await handler(request(query));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      error: {
        code: "BRIEF_ANCHOR_QUERY_INVALID",
        message: "必须且只能提供有效的 courseAlias、invocationId 与 snapshotId。"
      }
    });
  }
  assert.equal(readCount, 0);
});

test("brief route passes the exact normalized anchor and returns a no-store safe brief", async () => {
  const calls: unknown[] = [];
  const brief = readyBrief();
  const handler = createBriefRouteHandler({
    readBrief: (async (input) => {
      calls.push(input);
      return brief;
    }) as BriefReader
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
  assert.deepEqual(await response.json(), brief);
});

test("brief route maps stable not-found and conflict errors without leaking reader messages", async () => {
  for (const fixture of [
    {
      error: new CourseOpportunityBriefReadError(
        "BRIEF_ANCHOR_NOT_FOUND",
        "SECRET_DATABASE_DETAIL"
      ),
      status: 404,
      code: "BRIEF_ANCHOR_NOT_FOUND",
      message: "未找到请求的课程简报锚点。"
    },
    {
      error: new CourseOpportunityBriefReadError(
        "BRIEF_ANCHOR_CONFLICT",
        "SECRET_HASH_DETAIL"
      ),
      status: 409,
      code: "BRIEF_ANCHOR_CONFLICT",
      message: "课程、运行与世界快照的证据绑定不一致。"
    }
  ]) {
    const handler = createBriefRouteHandler({
      readBrief: (async () => {
        throw fixture.error;
      }) as BriefReader
    });
    const response = await handler(
      request(
        "?courseAlias=safe-course&invocationId=invocation-current&snapshotId=snapshot-current"
      )
    );
    const serialized = JSON.stringify(await response.json());
    assert.equal(response.status, fixture.status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(JSON.parse(serialized), {
      error: { code: fixture.code, message: fixture.message }
    });
    assert.equal(serialized.includes("SECRET_"), false);
  }
});

test("brief route collapses unexpected failures to a stable non-leaking 503", async () => {
  const handler = createBriefRouteHandler({
    readBrief: (async () => {
      throw new Error("DATABASE_URL=SECRET_TOKEN_SENTINEL");
    }) as BriefReader
  });
  const response = await handler(
    request(
      "?courseAlias=safe-course&invocationId=invocation-current&snapshotId=snapshot-current"
    )
  );
  const serialized = JSON.stringify(await response.json());

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(JSON.parse(serialized), {
    error: {
      code: "BRIEF_SOURCE_UNAVAILABLE",
      message: "课程简报暂时不可用，请稍后重试。"
    }
  });
  assert.equal(serialized.includes("SECRET_TOKEN_SENTINEL"), false);
  assert.equal(serialized.includes("DATABASE_URL"), false);
});
