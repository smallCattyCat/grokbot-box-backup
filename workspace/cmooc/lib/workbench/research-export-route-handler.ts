import { NextRequest, NextResponse } from "next/server";
import { buildCourseResearchExport } from "@/lib/workbench/course-evidence-workspace";
import {
  CourseEvidenceWorkspaceReadError,
  EVIDENCE_NO_STORE_HEADERS,
  parseExactEvidenceAnchor,
  type CourseEvidenceWorkspaceReader
} from "@/lib/workbench/evidence-route-handler";

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

export function createResearchExportRouteHandler(input: {
  readWorkspace: CourseEvidenceWorkspaceReader;
}) {
  return async function GET(request: NextRequest) {
    const anchor = parseExactEvidenceAnchor(request);
    if (!anchor) {
      return errorResponse(
        400,
        "RESEARCH_EXPORT_ANCHOR_QUERY_INVALID",
        "必须且只能提供有效的 courseAlias、invocationId 与 snapshotId。"
      );
    }

    try {
      const workspace = await input.readWorkspace({ anchor });
      const exported = buildCourseResearchExport(workspace);
      const filename = `cmooc-course-evidence-${exported.sha256.slice(0, 12)}.json`;
      return new NextResponse(exported.json, {
        status: 200,
        headers: {
          ...EVIDENCE_NO_STORE_HEADERS,
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "X-CMOOC-Evidence-SHA256": exported.sha256
        }
      });
    } catch (error) {
      if (error instanceof CourseEvidenceWorkspaceReadError) {
        if (error.code === "EVIDENCE_ANCHOR_NOT_FOUND") {
          return errorResponse(
            404,
            "RESEARCH_EXPORT_ANCHOR_NOT_FOUND",
            "未找到请求的课程证据锚点。"
          );
        }
        return errorResponse(
          409,
          "RESEARCH_EXPORT_ANCHOR_CONFLICT",
          "课程、运行与世界快照的证据绑定不一致。"
        );
      }
      return errorResponse(
        503,
        "RESEARCH_EXPORT_UNAVAILABLE",
        "聚合研究证据包暂时不可用，请稍后重试。"
      );
    }
  };
}
