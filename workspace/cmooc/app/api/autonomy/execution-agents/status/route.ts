import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  getSafeExecutionAccountPoolSummary,
  type SafeExecutionAgentPoolSummary
} from "@/lib/autonomy/execution-account-pool-read-model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unavailableSummary(): SafeExecutionAgentPoolSummary {
  return {
    schemaVersion: "cmooc.execution-agent-pool-read-model.v1",
    scope: "enabled_courses",
    configurationState: "unavailable",
    configuredAgentCount: 0,
    configuredRoleCount: 0,
    availableAgentCount: 0,
    activeAgentCount: 0,
    cooldownAgentCount: 0,
    dailyLimitReachedAgentCount: 0,
    consumedLeaseCountToday: 0,
    roles: [
      "socratic_guide",
      "evidence_connector",
      "reflection_coach",
      "community_host"
    ].map((roleKey) => ({
      roleKey: roleKey as SafeExecutionAgentPoolSummary["roles"][number]["roleKey"],
      configuredAgentCount: 0,
      availableAgentCount: 0,
      activeAgentCount: 0,
      cooldownAgentCount: 0,
      dailyLimitReachedAgentCount: 0,
      consumedLeaseCountToday: 0
    })),
    containsAccountIdentity: false,
    containsCredentialMaterial: false,
    containsForumText: false
  };
}

export async function GET() {
  let summary: SafeExecutionAgentPoolSummary;
  try {
    summary = await getSafeExecutionAccountPoolSummary({ prisma });
  } catch {
    summary = unavailableSummary();
  }
  return NextResponse.json(summary, {
    status: 200,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}

