import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  transitionAutonomyIncident,
  type IncidentAction
} from "@/lib/autonomy/incident-governance";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ACTIONS = new Set<IncidentAction>([
  "acknowledge",
  "resolve"
]);

type IncidentTransitionRequest = {
  action: IncidentAction;
  expectedEvidenceHash: string;
};

function invalidRequest(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      code: "incident_transition_invalid_request",
      message: "异常状态操作请求无效。",
      containsForumText: false
    },
    { status: 400 }
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function parseRequestBody(
  value: unknown
): IncidentTransitionRequest | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "action" ||
    keys[1] !== "expectedEvidenceHash"
  ) {
    return null;
  }
  if (
    typeof value.action !== "string" ||
    !ACTIONS.has(value.action as IncidentAction) ||
    typeof value.expectedEvidenceHash !== "string" ||
    !HASH_PATTERN.test(value.expectedEvidenceHash)
  ) {
    return null;
  }
  return {
    action: value.action as IncidentAction,
    expectedEvidenceHash: value.expectedEvidenceHash
  };
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function failureResponse(error: unknown): NextResponse {
  const code = errorCode(error);
  if (code === "INCIDENT_NOT_FOUND") {
    return NextResponse.json(
      {
        ok: false,
        code: "incident_not_found",
        message: "异常记录不存在。",
        containsForumText: false
      },
      { status: 404 }
    );
  }
  if (
    code === "INCIDENT_ID_INVALID" ||
    code === "INCIDENT_EVIDENCE_HASH_INVALID"
  ) {
    return invalidRequest();
  }
  if (
    code === "INCIDENT_TRANSITION_INVALID" ||
    code === "INCIDENT_RECORD_INVALID" ||
    code === "INCIDENT_EVIDENCE_HASH_MISMATCH" ||
    code === "INCIDENT_TRANSITION_CONFLICT"
  ) {
    return NextResponse.json(
      {
        ok: false,
        code: "incident_transition_conflict",
        message: "异常状态已变化，请刷新后重试。",
        containsForumText: false
      },
      { status: 409 }
    );
  }
  return NextResponse.json(
    {
      ok: false,
      code: "incident_transition_failed",
      message: "异常状态更新失败，请稍后重试。",
      containsForumText: false
    },
    { status: 500 }
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const denied = requireTrustedJsonMutation(
    request,
    "更新自治异常状态"
  );
  if (denied) return denied;

  let body: IncidentTransitionRequest | null;
  try {
    body = parseRequestBody(await request.json());
  } catch {
    body = null;
  }
  if (!body) return invalidRequest();

  try {
    const result = await transitionAutonomyIncident({
      prisma,
      incidentId: params.id,
      expectedEvidenceHash: body.expectedEvidenceHash,
      action: body.action,
      now: new Date()
    });
    return NextResponse.json({
      ok: true,
      status: result.status,
      changed: result.changed,
      transitionedAt: result.transitionedAt,
      containsForumText: false
    });
  } catch (error) {
    return failureResponse(error);
  }
}
