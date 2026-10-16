import { NextRequest, NextResponse } from "next/server";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";
import {
  getAutoInterventionSchedulerStatus,
  runAutoInterventionSchedulerOnce,
  startAutoInterventionScheduler,
  stopAutoInterventionScheduler,
  type AutoInterventionSchedulerConfig
} from "@/lib/auto-intervention/scheduler";

type SchedulerRequestBody = Partial<AutoInterventionSchedulerConfig> & {
  action?: "start" | "stop" | "run_once";
  runImmediately?: boolean;
};

function requiredForumListUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("PREVIEW_FORUM_LIST_URL_REQUIRED");
  }
  return value.trim();
}

function schedulerConfigFromBody(body: SchedulerRequestBody): AutoInterventionSchedulerConfig {
  const maxScanPosts = Number(body.maxScanPosts ?? 10);
  const maxPublishCount = Number(body.maxPublishCount ?? 1);
  const minScoreToPublish = Number(body.minScoreToPublish ?? 75);
  const intervalMinutes = Number(body.intervalMinutes ?? 30);
  if (![maxScanPosts, maxPublishCount, minScoreToPublish, intervalMinutes].every(Number.isFinite)) {
    throw new Error("调度器参数必须是有效数字。");
  }
  return {
    forumListUrl: requiredForumListUrl(body.forumListUrl),
    maxScanPosts,
    maxPublishCount,
    minScoreToPublish,
    mode: "dry_run",
    allowRealPublish: false,
    intervalMinutes
  };
}

export async function GET() {
  return NextResponse.json(getAutoInterventionSchedulerStatus());
}

export async function POST(request: NextRequest) {
  try {
    const denied = requireTrustedJsonMutation(request, "周期预演");
    if (denied) return denied;
    const body = (await request.json().catch(() => ({}))) as SchedulerRequestBody;
    if (body.action === "stop") {
      return NextResponse.json(stopAutoInterventionScheduler());
    }
    if (body.action === "run_once") {
      return NextResponse.json(await runAutoInterventionSchedulerOnce());
    }
    return NextResponse.json(await startAutoInterventionScheduler(schedulerConfigFromBody(body), Boolean(body.runImmediately)));
  } catch (error) {
    return NextResponse.json({ isError: true, error: error instanceof Error ? error.message : "未知周期巡检错误", safeDefault: { action: "start", mode: "dry_run", allowRealPublish: false } }, { status: 400 });
  }
}
