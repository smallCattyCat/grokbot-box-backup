import { NextRequest, NextResponse } from "next/server";
import {
  OasisPreviewRequestError,
  type OasisPreviewRequestErrorCode,
  type OasisPreviewRunner,
  parseOasisPreviewRequest
} from "@/lib/scenario-lab/oasis-preview";
import { OasisSidecarTransportError } from "@/lib/scenario-lab/oasis-sidecar-transport";
import { ScenarioLabEvidenceError } from "@/lib/scenario-lab/p3a-evidence-reader";

const NO_STORE = { "Cache-Control": "no-store" } as const;

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

function requestErrorResponse(code: OasisPreviewRequestErrorCode) {
  switch (code) {
    case "OASIS_PREVIEW_REQUEST_INVALID":
      return errorResponse(
        400,
        code,
        "请求必须且只能包含有效的 datasetRef、sceneTemplateRef、seedSetRef 与 runtimeId。"
      );
    case "OASIS_PREVIEW_DATASET_NOT_FOUND":
      return errorResponse(404, code, "未找到请求的冻结课程世界数据集。");
    case "OASIS_PREVIEW_SCENE_TEMPLATE_NOT_FOUND":
      return errorResponse(404, code, "未找到请求的 OASIS 场景模板。");
    case "OASIS_PREVIEW_SEED_SET_NOT_FOUND":
      return errorResponse(404, code, "未找到请求的 OASIS 固定种子集合。");
    case "OASIS_PREVIEW_RUNTIME_UNAVAILABLE":
      return errorResponse(409, code, "请求的 OASIS 运行时当前不可用。");
  }
}

export function createScenarioLabOasisPreviewRouteHandler(input: {
  runPreview: OasisPreviewRunner;
}) {
  return async function POST(request: NextRequest) {
    let rawInput: unknown;
    try {
      rawInput = await request.json();
    } catch {
      return requestErrorResponse("OASIS_PREVIEW_REQUEST_INVALID");
    }

    let parsedInput;
    try {
      parsedInput = parseOasisPreviewRequest(rawInput);
    } catch (error) {
      if (error instanceof OasisPreviewRequestError) {
        return requestErrorResponse(error.code);
      }
      return requestErrorResponse("OASIS_PREVIEW_REQUEST_INVALID");
    }

    try {
      const report = await input.runPreview(parsedInput, {
        signal: request.signal
      });
      return NextResponse.json(report, {
        status: 200,
        headers: NO_STORE
      });
    } catch (error) {
      if (error instanceof OasisPreviewRequestError) {
        return requestErrorResponse(error.code);
      }
      if (error instanceof ScenarioLabEvidenceError) {
        if (error.code === "EVIDENCE_SOURCE_UNAVAILABLE") {
          return errorResponse(
            503,
            "OASIS_PREVIEW_SOURCE_UNAVAILABLE",
            "冻结课程世界实验源暂时不可用，请稍后重试。"
          );
        }
        return errorResponse(
          409,
          "OASIS_PREVIEW_EVIDENCE_CONFLICT",
          "冻结证据或其契约未通过一致性核对。"
        );
      }
      if (error instanceof OasisSidecarTransportError) {
        return errorResponse(
          503,
          "OASIS_PREVIEW_SIDECAR_UNAVAILABLE",
          "OASIS 协议预演侧车暂时不可用，请稍后重试。"
        );
      }
      return errorResponse(
        503,
        "OASIS_PREVIEW_SOURCE_UNAVAILABLE",
        "OASIS 协议预演源暂时不可用，请稍后重试。"
      );
    }
  };
}
