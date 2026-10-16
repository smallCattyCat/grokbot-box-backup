import { NextResponse } from "next/server";
import {
  courseOperationGovernanceListOrderBy,
  currentCourseOperationGovernanceHashes,
  safeCourseOperationGovernanceState
} from "@/lib/autonomy/course-operation-governance";
import { safeCourseOperationGovernanceTransitionState } from "@/lib/autonomy/course-operation-governance-lifecycle";
import { loadCourseManifest } from "@/lib/autonomy/course-manifest";
import { filterOperatorCourses } from "@/lib/autonomy/operator-presentation";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const GOVERNANCE_VIEW_LIMIT = 200;

export async function GET() {
  try {
    const now = new Date();
    const manifests = filterOperatorCourses(
      await prisma.autonomyCourseManifest.findMany({
        where: { enabled: true },
        select: {
          alias: true,
          manifestHash: true,
          realPublishEnabled: true,
          enabled: true
        }
      })
    );
    const visibleCourseAliases = manifests.map((manifest) => manifest.alias);
    const [policyWindow, transitionWindow] = await Promise.all([
      prisma.courseOperationGovernancePolicy.findMany({
        where: { courseAlias: { in: visibleCourseAliases } },
        take: GOVERNANCE_VIEW_LIMIT + 1,
        orderBy: courseOperationGovernanceListOrderBy()
      }),
      prisma.courseOperationGovernanceTransition.findMany({
        where: { courseAlias: { in: visibleCourseAliases } },
        take: GOVERNANCE_VIEW_LIMIT + 1,
        orderBy: [
          { courseAlias: "asc" },
          { createdAt: "desc" },
          { id: "desc" }
        ]
      })
    ]);
    const policiesTruncated = policyWindow.length > GOVERNANCE_VIEW_LIMIT;
    const transitionsTruncated = transitionWindow.length > GOVERNANCE_VIEW_LIMIT;
    const rows = policyWindow.slice(0, GOVERNANCE_VIEW_LIMIT);
    const transitionRows = transitionWindow.slice(0, GOVERNANCE_VIEW_LIMIT);
    const manifestHashes = new Map<string, string>();
    await Promise.all(
      manifests.map(async (manifestRow) => {
        try {
          const manifest = await loadCourseManifest(manifestRow.alias);
          if (
            manifest.alias === manifestRow.alias &&
            manifest.manifestHash === manifestRow.manifestHash &&
            manifestRow.realPublishEnabled === false &&
            manifest.realPublishEnabled === false
          ) {
            manifestHashes.set(manifestRow.alias, manifest.manifestHash);
          }
        } catch {
          // Missing or malformed disk manifests must never appear active.
        }
      })
    );
    const currentHashes = currentCourseOperationGovernanceHashes(rows, now);
    const policies = rows.map((row) => ({
      ...safeCourseOperationGovernanceState({
        record: row,
        currentManifestHash: manifestHashes.get(row.courseAlias) ?? null,
        now
      }),
      isCurrent: currentHashes.has(row.governanceHash)
    }));
    const currentPolicies = policies.filter((row) => row.isCurrent);
    const transitions = transitionRows.map((row) =>
      safeCourseOperationGovernanceTransitionState(row)
    );
    return NextResponse.json(
      {
        ok: true,
        asOf: now.toISOString(),
        policies,
        transitions,
        pagination: {
          limit: GOVERNANCE_VIEW_LIMIT,
          policiesTruncated,
          transitionsTruncated,
          countsScope:
            policiesTruncated || transitionsTruncated
              ? "visible_window"
              : "complete"
        },
        counts: {
          total: policies.length,
          current: currentPolicies.length,
          history: policies.length - currentPolicies.length,
          transitions: transitions.length,
          active: currentPolicies.filter((row) => row.status === "active").length,
          paused: currentPolicies.filter((row) => row.status === "paused").length,
          revoked: currentPolicies.filter((row) => row.status === "revoked").length,
          expired: currentPolicies.filter((row) => row.status === "expired").length,
          emergencyHalt: currentPolicies.filter((row) => row.status === "emergency_halt").length,
          integrityInvalid: currentPolicies.filter((row) => row.status === "integrity_invalid").length,
          manifestStale: currentPolicies.filter((row) => row.status === "manifest_stale").length
        },
        externalMutationAttempted: false,
        containsForumText: false
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json(
      {
        ok: false,
        code: "autonomy_governance_unavailable",
        externalMutationAttempted: false,
        containsForumText: false
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
