import {
  COURSE_TOOL_GRANT_SCHEMA_VERSION,
  type EffectClass
} from "@/lib/course-tools/contracts";
import type {
  ScopedCourseToolGrant,
  ScopedCourseToolGrantAuthority,
  ScopedGrantClaimResult
} from "@/lib/course-tools/policy-gateway";
import {
  claimCourseToolGrant,
  type CourseToolGrantClaimStoreResult
} from "@/lib/workbench/course-tool-action-store";
import type { WorkbenchDb } from "@/lib/workbench/durable-ledger";

/**
 * Protected server-side adapter for the Course Tool Policy Gateway. It only
 * exposes exact one-shot L3 STAGE or ownership-reconcile grants; L4 and any
 * publish-enabled row fail closed even if a database were externally corrupted.
 */
export class ScopedWorkbenchCourseToolGrantAuthority
  implements ScopedCourseToolGrantAuthority
{
  readonly #db: WorkbenchDb;

  constructor(db: WorkbenchDb) {
    this.#db = db;
  }

  async claim(
    input: Parameters<ScopedCourseToolGrantAuthority["claim"]>[0]
  ): Promise<ScopedGrantClaimResult> {
    if (
      input.binding.capability !== "L3_EXTERNAL_STAGE" ||
      input.binding.effect !== "external_stage"
    ) {
      return { status: "scope_mismatch" };
    }
    const result = await claimCourseToolGrant(this.#db, input);
    return projectClaimResult(result);
  }
}

export function createScopedCourseToolGrantAuthority(
  db: WorkbenchDb
): ScopedCourseToolGrantAuthority {
  return new ScopedWorkbenchCourseToolGrantAuthority(db);
}

function projectClaimResult(
  result: CourseToolGrantClaimStoreResult
): ScopedGrantClaimResult {
  if (result.status !== "claimed" || !result.grant) {
    return { status: result.status };
  }
  const grant = result.grant;
  if (
    grant.schemaVersion !== COURSE_TOOL_GRANT_SCHEMA_VERSION ||
    grant.capability !== "L3_EXTERNAL_STAGE" ||
    grant.effectClass !== "external_stage" ||
    grant.oneShot !== true ||
    grant.realPublishEnabled !== false ||
    grant.status !== "consumed"
  ) {
    return { status: "scope_mismatch" };
  }
  const projected: ScopedCourseToolGrant = Object.freeze({
    schemaVersion: COURSE_TOOL_GRANT_SCHEMA_VERSION,
    grantRef: grant.id,
    issuer: "course_tool_server",
    capability: "L3_EXTERNAL_STAGE",
    effect: grant.effectClass as EffectClass,
    toolName: grant.toolName,
    toolVersion: grant.toolVersion,
    callId: grant.callId,
    taskId: grant.taskId,
    runId: grant.runId,
    planRevisionId: grant.planRevisionId,
    stepId: grant.stepId,
    courseScopeHash: grant.courseScopeHash,
    inputHash: grant.inputHash,
    idempotencyKeyHash: grant.idempotencyKeyHash,
    policyVersion: grant.policyVersion,
    attempt: grant.attempt,
    validFrom: grant.validFrom.toISOString(),
    expiresAt: grant.expiresAt.toISOString(),
    oneShot: true,
    realPublishEnabled: false
  });
  return { status: "claimed", grant: projected };
}
