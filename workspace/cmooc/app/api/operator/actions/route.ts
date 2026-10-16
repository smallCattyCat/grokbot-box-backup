import { NextRequest, NextResponse } from "next/server";
import { syncSocialNetworkMetrics } from "@/lib/analytics/social-network-sync";
import { syncUserProfiles } from "@/lib/analytics/user-profile-sync";
import { runAutoIntervention } from "@/lib/auto-intervention/run-auto-intervention";
import {
  runAutoInterventionSchedulerOnce,
  startAutoInterventionScheduler,
  stopAutoInterventionScheduler
} from "@/lib/auto-intervention/scheduler";
import {
  getOperatorResearchDigestPayload,
  getOperatorStatusPayload
} from "@/lib/agent-console-operator-status";
import { getCmoocAuthStatus } from "@/lib/forum/cmooc-auth-status";
import { runForumIngestion } from "@/lib/forum/forum-ingestion";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";
import {
  OPERATOR_ACTION_IDS,
  OPERATOR_PATHS,
  OPERATOR_REGISTRY,
  getOperatorAction,
  isOperatorActionId,
  type OperatorActionId
} from "@/lib/operator-registry";

export const dynamic = "force-dynamic";

type OperatorActionBody = {
  actionId?: string;
  fresh?: boolean;
  input?: Record<string, unknown>;
};

function asNumber(value: unknown, fallback: number, min: number, max: number) {
  const numeric = Number(value ?? fallback);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function asInteger(value: unknown, fallback: number, min: number, max: number) {
  return Math.trunc(asNumber(value, fallback, min, max));
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredForumListUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("PREVIEW_FORUM_LIST_URL_REQUIRED");
  }
  return value.trim();
}

function previewConfigFromInput(input: Record<string, unknown> = {}) {
  return {
    forumListUrl: requiredForumListUrl(input.forumListUrl),
    maxScanPosts: asInteger(input.maxScanPosts, 10, 1, 30),
    maxPublishCount: asInteger(input.maxCandidateCount, 5, 0, 30),
    minScoreToPublish: asNumber(input.minScore, 75, 0, 100),
    courseId: optionalString(input.courseId),
    platformCourseId: optionalString(input.platformCourseId),
    mode: "dry_run" as const,
    allowRealPublish: false
  };
}

function previewSchedulerConfigFromInput(input: Record<string, unknown> = {}) {
  return {
    ...previewConfigFromInput(input),
    intervalMinutes: asInteger(input.intervalMinutes, 30, 1, 24 * 60)
  };
}

async function refreshWorldModel(input: Record<string, unknown>) {
  const sourceUrl = optionalString(input.sourceUrl);
  const requestedCourseId = optionalString(input.courseId);
  const requestedPlatformCourseId = optionalString(input.platformCourseId);
  const ingestion = sourceUrl
    ? await runForumIngestion({
      sourceUrl,
      maxPosts: asInteger(
        input.maxPosts,
        sourceUrl.includes("/detail?") ? 1 : 10,
        1,
        50
      ),
      courseId: requestedCourseId,
      platformCourseId: requestedPlatformCourseId
    })
    : null;
  const scope = {
    runId: ingestion?.runId ?? optionalString(input.runId),
    courseId: ingestion?.course.id ?? requestedCourseId,
    platformCourseId:
      ingestion?.course.platformCourseId ?? requestedPlatformCourseId
  };
  const socialNetwork = await syncSocialNetworkMetrics(scope);
  const learnerProfiles = await syncUserProfiles({
    ...scope,
    mode: "materialize"
  });
  return {
    ingestion,
    socialNetwork,
    learnerProfiles
  };
}

function actionResponse(actionId: OperatorActionId, result: unknown) {
  const action = getOperatorAction(actionId);
  return NextResponse.json({
    ok: true,
    actionId,
    category: action.category,
    safe: action.safe,
    forumWrite: action.forumWrite,
    generatedAt: new Date().toISOString(),
    result
  }, {
    headers: {
      "Cache-Control": "no-store"
    }
  });
}

export async function GET() {
  return NextResponse.json({
    appId: OPERATOR_REGISTRY.appId,
    endpoint: OPERATOR_PATHS.actions,
    method: "POST",
    actionIds: OPERATOR_ACTION_IDS,
    actions: OPERATOR_REGISTRY.actions,
    workflows: OPERATOR_REGISTRY.workflows,
    publishBoundary: OPERATOR_REGISTRY.publishBoundary
  }, {
    headers: {
      "Cache-Control": "no-store"
    }
  });
}

export async function POST(request: NextRequest) {
  try {
    const rejected = requireTrustedJsonMutation(request, "统一操作入口");
    if (rejected) return rejected;
    const body = (await request.json().catch(() => ({}))) as OperatorActionBody;
    const actionId = body.actionId;
    const input = body.input ?? {};
    const fresh = body.fresh === true || input.fresh === true;

    if (!actionId || !isOperatorActionId(actionId)) {
      return NextResponse.json({
        ok: false,
        actionId: actionId ?? null,
        error: "未知或未开放的 operator action。",
        actionIds: OPERATOR_ACTION_IDS,
        publishBoundary: OPERATOR_REGISTRY.publishBoundary
      }, { status: 400 });
    }

    if (actionId === "inspect_status") {
      return actionResponse(actionId, await getOperatorStatusPayload());
    }
    if (actionId === "read_research_digest") {
      return actionResponse(
        actionId,
        await getOperatorResearchDigestPayload({ fresh })
      );
    }
    if (actionId === "read_cmooc_auth_status") {
      return actionResponse(actionId, await getCmoocAuthStatus());
    }
    if (actionId === "run_preview") {
      return actionResponse(
        actionId,
        await runAutoIntervention(previewConfigFromInput(input))
      );
    }
    if (actionId === "refresh_world_model") {
      return actionResponse(actionId, await refreshWorldModel(input));
    }
    if (actionId === "start_preview_scheduler") {
      return actionResponse(
        actionId,
        await startAutoInterventionScheduler(
          previewSchedulerConfigFromInput(input),
          input.runImmediately === true
        )
      );
    }
    if (actionId === "run_preview_scheduler_once") {
      return actionResponse(
        actionId,
        await runAutoInterventionSchedulerOnce({
          mode: "dry_run",
          allowRealPublish: false
        })
      );
    }
    if (actionId === "stop_preview_scheduler") {
      return actionResponse(actionId, stopAutoInterventionScheduler());
    }

    return NextResponse.json({
      ok: false,
      actionId,
      error: "operator action 尚未实现。"
    }, { status: 501 });
  } catch (error) {
    const errorMessage = error instanceof Error
      ? error.message
      : "未知 operator action 错误。";
    return NextResponse.json({
      ok: false,
      error: errorMessage,
      safeDefault: {
        operation: "preview",
        forumWrite: false
      }
    }, {
      status:
        errorMessage === "PREVIEW_FORUM_LIST_URL_REQUIRED"
          ? 400
          : 500
    });
  }
}
