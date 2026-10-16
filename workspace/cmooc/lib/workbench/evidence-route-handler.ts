import { NextRequest, NextResponse } from "next/server";
import type { CourseEvidenceWorkspace } from "@/lib/workbench/course-evidence-workspace";

export type CourseEvidenceAnchor = {
  courseAlias: string;
  invocationId: string;
  snapshotId: string;
};

export class CourseEvidenceWorkspaceReadError extends Error {
  constructor(
    readonly code:
      | "EVIDENCE_ANCHOR_NOT_FOUND"
      | "EVIDENCE_ANCHOR_CONFLICT",
    message: string
  ) {
    super(message);
    this.name = "CourseEvidenceWorkspaceReadError";
  }
}

export type CourseEvidenceWorkspaceReader = (input: {
  anchor: CourseEvidenceAnchor;
}) => Promise<CourseEvidenceWorkspace>;

export const EVIDENCE_NO_STORE_HEADERS = {
  "Cache-Control": "no-store"
} as const;

const ANCHOR_KEYS = ["courseAlias", "invocationId", "snapshotId"] as const;
const COURSE_ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const OPAQUE_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;

export function parseExactEvidenceAnchor(
  request: NextRequest
): CourseEvidenceAnchor | null {
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

function errorResponse(
  status: 400 | 404 | 409 | 503,
  code: string,
  message: string
) {
  return NextResponse.json(
    { error: { code, message } },
    { status, headers: EVIDENCE_NO_STORE_HEADERS }
  );
}

export function createEvidenceRouteHandler(input: {
  readWorkspace: CourseEvidenceWorkspaceReader;
}) {
  return async function GET(request: NextRequest) {
    const anchor = parseExactEvidenceAnchor(request);
    if (!anchor) {
      return errorResponse(
        400,
        "EVIDENCE_ANCHOR_QUERY_INVALID",
        "必须且只能提供有效的 courseAlias、invocationId 与 snapshotId。"
      );
    }

    try {
      const workspace = await input.readWorkspace({ anchor });
      return NextResponse.json(workspace, {
        status: 200,
        headers: EVIDENCE_NO_STORE_HEADERS
      });
    } catch (error) {
      if (error instanceof CourseEvidenceWorkspaceReadError) {
        if (error.code === "EVIDENCE_ANCHOR_NOT_FOUND") {
          return errorResponse(
            404,
            error.code,
            "未找到请求的课程证据锚点。"
          );
        }
        return errorResponse(
          409,
          error.code,
          "课程、运行与世界快照的证据绑定不一致。"
        );
      }
      return errorResponse(
        503,
        "EVIDENCE_SOURCE_UNAVAILABLE",
        "课程证据工作区暂时不可用，请稍后重试。"
      );
    }
  };
}
