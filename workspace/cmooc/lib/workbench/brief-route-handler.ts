import { NextRequest, NextResponse } from "next/server";
import {
  CourseOpportunityBriefReadError,
  type getAnchoredCourseOpportunityBrief
} from "@/lib/workbench/operator-read-model";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const ANCHOR_KEYS = ["courseAlias", "invocationId", "snapshotId"] as const;
const COURSE_ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const OPAQUE_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;

type BriefReader = typeof getAnchoredCourseOpportunityBrief;

function errorResponse(
  status: 400 | 404 | 409 | 503,
  code: string,
  message: string
) {
  return NextResponse.json(
    { error: { code, message } },
    { status, headers: NO_STORE }
  );
}

function parseExactAnchor(request: NextRequest) {
  const query = request.nextUrl.searchParams;
  if ([...query.keys()].some((key) => !ANCHOR_KEYS.includes(key as never))) {
    return null;
  }
  const values = Object.fromEntries(
    ANCHOR_KEYS.map((key) => [key, query.getAll(key)])
  ) as Record<(typeof ANCHOR_KEYS)[number], string[]>;
  if (ANCHOR_KEYS.some((key) => values[key].length !== 1)) return null;

  const courseAlias = values.courseAlias[0]?.trim() ?? "";
  const invocationId = values.invocationId[0]?.trim() ?? "";
  const snapshotId = values.snapshotId[0]?.trim() ?? "";
  if (
    !COURSE_ALIAS_PATTERN.test(courseAlias) ||
    !OPAQUE_ID_PATTERN.test(invocationId) ||
    !OPAQUE_ID_PATTERN.test(snapshotId)
  ) {
    return null;
  }
  return { courseAlias, invocationId, snapshotId };
}

export function createBriefRouteHandler(input: { readBrief: BriefReader }) {
  return async function GET(request: NextRequest) {
    const anchor = parseExactAnchor(request);
    if (!anchor) {
      return errorResponse(
        400,
        "BRIEF_ANCHOR_QUERY_INVALID",
        "必须且只能提供有效的 courseAlias、invocationId 与 snapshotId。"
      );
    }

    try {
      const brief = await input.readBrief({ anchor });
      return NextResponse.json(brief, { status: 200, headers: NO_STORE });
    } catch (error) {
      if (error instanceof CourseOpportunityBriefReadError) {
        if (error.code === "BRIEF_ANCHOR_NOT_FOUND") {
          return errorResponse(
            404,
            "BRIEF_ANCHOR_NOT_FOUND",
            "未找到请求的课程简报锚点。"
          );
        }
        if (error.code === "BRIEF_ANCHOR_CONFLICT") {
          return errorResponse(
            409,
            "BRIEF_ANCHOR_CONFLICT",
            "课程、运行与世界快照的证据绑定不一致。"
          );
        }
      }
      return errorResponse(
        503,
        "BRIEF_SOURCE_UNAVAILABLE",
        "课程简报暂时不可用，请稍后重试。"
      );
    }
  };
}
