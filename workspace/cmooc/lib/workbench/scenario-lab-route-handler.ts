import { NextRequest, NextResponse } from "next/server";
import {
  DETERMINISTIC_P3A_RUNTIME_ID,
  SCENARIO_LAB_DATASET_REF,
  SCENARIO_LAB_SCENARIO_SET_REF,
  type CourseWorldScenarioLabReportV1,
  type ScenarioLabRunRequestV1
} from "@/lib/scenario-lab/contracts";
import { ScenarioLabEvidenceError } from "@/lib/scenario-lab/p3a-evidence-reader";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const REQUEST_KEYS = [
  "datasetRef",
  "scenarioSetRef",
  "runtimeId"
] as const;

type ScenarioRunner = (
  request: ScenarioLabRunRequestV1
) => Promise<CourseWorldScenarioLabReportV1>;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function parseRequest(
  request: NextRequest
): Promise<
  | { kind: "valid"; value: ScenarioLabRunRequestV1 }
  | { kind: "invalid" }
  | { kind: "dataset_missing" }
  | { kind: "scenario_set_missing" }
  | { kind: "runtime_unavailable" }
> {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return { kind: "invalid" };
  }
  if (!isRecord(input)) return { kind: "invalid" };
  const keys = Object.keys(input).sort();
  if (
    keys.length !== REQUEST_KEYS.length ||
    [...REQUEST_KEYS].sort().some((key, index) => keys[index] !== key)
  ) {
    return { kind: "invalid" };
  }
  if (input.datasetRef !== SCENARIO_LAB_DATASET_REF) {
    return { kind: "dataset_missing" };
  }
  if (input.scenarioSetRef !== SCENARIO_LAB_SCENARIO_SET_REF) {
    return { kind: "scenario_set_missing" };
  }
  if (input.runtimeId !== DETERMINISTIC_P3A_RUNTIME_ID) {
    return { kind: "runtime_unavailable" };
  }
  return {
    kind: "valid",
    value: {
      datasetRef: input.datasetRef,
      scenarioSetRef: input.scenarioSetRef,
      runtimeId: input.runtimeId
    }
  };
}

export function createScenarioLabRouteHandler(input: {
  runScenario: ScenarioRunner;
}) {
  return async function POST(request: NextRequest) {
    const parsed = await parseRequest(request);
    if (parsed.kind === "invalid") {
      return errorResponse(
        400,
        "SCENARIO_REQUEST_INVALID",
        "请求必须且只能包含有效的 datasetRef、scenarioSetRef 与 runtimeId。"
      );
    }
    if (parsed.kind === "dataset_missing") {
      return errorResponse(
        404,
        "SCENARIO_DATASET_NOT_FOUND",
        "未找到请求的冻结课程世界数据集。"
      );
    }
    if (parsed.kind === "scenario_set_missing") {
      return errorResponse(
        404,
        "SCENARIO_SET_NOT_FOUND",
        "未找到请求的情景集合。"
      );
    }
    if (parsed.kind === "runtime_unavailable") {
      return errorResponse(
        409,
        "SCENARIO_RUNTIME_UNAVAILABLE",
        "请求的情景运行时尚未在当前切片激活。"
      );
    }

    try {
      const report = await input.runScenario(parsed.value);
      return NextResponse.json(report, {
        status: 200,
        headers: NO_STORE
      });
    } catch (error) {
      if (
        error instanceof ScenarioLabEvidenceError &&
        [
          "EVIDENCE_HASH_MISMATCH",
          "EVIDENCE_CROSS_MANIFEST_MISMATCH",
          "EVIDENCE_DATASET_DRIFT",
          "EVIDENCE_OUTCOME_PARTITION_MISMATCH",
          "EVIDENCE_SCENARIO_SET_INCOMPLETE"
        ].includes(error.code)
      ) {
        return errorResponse(
          409,
          "SCENARIO_EVIDENCE_CONFLICT",
          "冻结证据或回放工件未通过一致性核对。"
        );
      }
      return errorResponse(
        503,
        "SCENARIO_SOURCE_UNAVAILABLE",
        "课程世界实验源暂时不可用，请稍后重试。"
      );
    }
  };
}

