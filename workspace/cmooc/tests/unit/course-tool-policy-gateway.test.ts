import assert from "node:assert/strict";
import test from "node:test";
import {
  COURSE_TOOL_GRANT_SCHEMA_VERSION,
  hashCourseScope
} from "../../lib/course-tools/contracts";
import {
  CourseToolPolicyError,
  CourseToolPolicyGateway,
  buildGrantBinding,
  type CourseToolAuthorizationRequest,
  type CourseToolPolicyDecision,
  type ScopedCourseToolGrant,
  type ScopedCourseToolGrantAuthority
} from "../../lib/course-tools/policy-gateway";
import { CourseToolRegistry } from "../../lib/course-tools/registry";
import {
  FIXTURE_NOW,
  makeToolRegistration,
  serverContext,
  sha
} from "./course-tool-test-fixtures";

function authorizationRequest(input: {
  effect?: "read" | "local_write" | "external_stage" | "irreversible_external";
  context?: ReturnType<typeof serverContext>;
} = {}): CourseToolAuthorizationRequest {
  const effect = input.effect ?? "read";
  const definition = new CourseToolRegistry()
    .register(
      makeToolRegistration({
        name:
          effect === "external_stage"
            ? "platform.editor_stage"
            : effect === "irreversible_external"
              ? "publication.commit"
              : effect === "local_write"
                ? "artifact.fixture_create"
                : "course.snapshot_read",
        effect
      })
    )
    .resolve(
      effect === "external_stage"
        ? "platform.editor_stage"
        : effect === "irreversible_external"
          ? "publication.commit"
          : effect === "local_write"
            ? "artifact.fixture_create"
            : "course.snapshot_read",
      "1"
    ).definition;
  const context = input.context ?? serverContext();
  return {
    definition,
    context,
    courseScopeHash: hashCourseScope(context.courseScope),
    inputHash: sha("policy-input")
  };
}

function grantFromBinding(
  request: CourseToolAuthorizationRequest,
  overrides: Partial<ScopedCourseToolGrant> = {}
): ScopedCourseToolGrant {
  const binding = buildGrantBinding(request);
  return {
    schemaVersion: COURSE_TOOL_GRANT_SCHEMA_VERSION,
    grantRef: "grant-fixture-001",
    issuer: "course_tool_server",
    ...binding,
    validFrom: "2026-08-12T11:59:00.000Z",
    expiresAt: "2026-08-12T12:01:00.000Z",
    oneShot: true,
    realPublishEnabled: false,
    ...overrides
  };
}

class FixtureGrantAuthority implements ScopedCourseToolGrantAuthority {
  readonly calls: Array<{ grantRef: string; now: string }> = [];
  constructor(
    readonly result: (
      input: Parameters<ScopedCourseToolGrantAuthority["claim"]>[0]
    ) => ReturnType<ScopedCourseToolGrantAuthority["claim"]>
  ) {}

  claim(
    input: Parameters<ScopedCourseToolGrantAuthority["claim"]>[0]
  ): ReturnType<ScopedCourseToolGrantAuthority["claim"]> {
    this.calls.push({ grantRef: input.grantRef, now: input.now });
    return this.result(input);
  }
}

test("L0/L1 use server base capability while inspect cannot escalate to an artifact write", async () => {
  const decisions: CourseToolPolicyDecision[] = [];
  const gateway = new CourseToolPolicyGateway({
    decisionSink: {
      recordPolicyDecision: async (decision) => {
        decisions.push(decision);
      }
    }
  });
  const read = await gateway.authorize(authorizationRequest());
  assert.equal(read.effectDecision, "allow");
  assert.equal(read.reasonCode, "base_capability_granted");
  assert.equal(read.grantedCapability, "L0_READ");

  const inspectWrite = authorizationRequest({
    effect: "local_write",
    context: serverContext({ intent: "inspect", baseCapability: "L1_ARTIFACT" })
  });
  await assert.rejects(
    () => gateway.authorize(inspectWrite),
    (error: unknown) =>
      error instanceof CourseToolPolicyError &&
      error.decision.reasonCode === "intent_capability_mismatch"
  );
  assert.deepEqual(
    decisions.map((decision) => decision.effectDecision),
    ["allow", "deny"]
  );
  assert.equal(JSON.stringify(decisions).includes("fencing-token"), false);
});

test("L3 is denied by default even if a caller claims a high base capability", async () => {
  const request = authorizationRequest({
    effect: "external_stage",
    context: serverContext({
      baseCapability: "L4_IRREVERSIBLE",
      capabilityGrantRefs: []
    })
  });
  const decision = await new CourseToolPolicyGateway().evaluate(request);
  assert.equal(decision.effectDecision, "deny");
  assert.equal(decision.reasonCode, "scoped_grant_required");
  assert.equal(decision.realPublishEnabled, false);
});

test("L3 requires an atomically claimed grant bound to tool, call scope, course, input, and idempotency", async () => {
  const context = serverContext({
    baseCapability: "L1_ARTIFACT",
    capabilityGrantRefs: ["grant-fixture-001"]
  });
  const request = authorizationRequest({ effect: "external_stage", context });
  const grant = grantFromBinding(request);
  const authority = new FixtureGrantAuthority(async () => ({
    status: "claimed",
    grant
  }));
  const gateway = new CourseToolPolicyGateway({ grantAuthority: authority });

  const decision = await gateway.authorize(request);
  assert.equal(decision.effectDecision, "allow");
  assert.equal(decision.reasonCode, "scoped_grant_claimed");
  assert.equal(decision.grantRef, "grant-fixture-001");
  assert.equal(authority.calls.length, 1);
  assert.equal(authority.calls[0]?.now, FIXTURE_NOW);

  const mismatchedAuthority = new FixtureGrantAuthority(async () => ({
    status: "claimed",
    grant: { ...grant, inputHash: sha("other-input") }
  }));
  const mismatch = await new CourseToolPolicyGateway({
    grantAuthority: mismatchedAuthority
  }).evaluate(request);
  assert.equal(mismatch.effectDecision, "deny");
  assert.equal(mismatch.reasonCode, "scoped_grant_scope_mismatch");
});

test("an L3 grant carrying a publish flag is rejected instead of upgrading STAGE to L4", async () => {
  const context = serverContext({
    capabilityGrantRefs: ["grant-fixture-001"]
  });
  const request = authorizationRequest({ effect: "external_stage", context });
  const authority = new FixtureGrantAuthority(async () => ({
    status: "claimed",
    grant: grantFromBinding(request, { realPublishEnabled: true })
  }));
  const decision = await new CourseToolPolicyGateway({
    grantAuthority: authority
  }).evaluate(request);
  assert.equal(decision.effectDecision, "deny");
  assert.equal(decision.reasonCode, "stage_grant_publish_flag_invalid");
});

test("L4 remains hard locked by default and needs both an enabled environment and exact publish grant", async () => {
  const context = serverContext({
    capabilityGrantRefs: ["grant-fixture-001"]
  });
  const request = authorizationRequest({
    effect: "irreversible_external",
    context
  });
  const grant = grantFromBinding(request, { realPublishEnabled: true });
  const authority = new FixtureGrantAuthority(async () => ({
    status: "claimed",
    grant
  }));

  const locked = await new CourseToolPolicyGateway({
    grantAuthority: authority
  }).evaluate(request);
  assert.equal(locked.effectDecision, "deny");
  assert.equal(locked.reasonCode, "irreversible_external_locked");
  assert.equal(authority.calls.length, 0, "hard lock must not consume the grant");

  const enabled = await new CourseToolPolicyGateway({
    grantAuthority: authority,
    irreversibleExternalEnabled: true
  }).authorize(request);
  assert.equal(enabled.effectDecision, "allow");
  assert.equal(enabled.grantedCapability, "L4_IRREVERSIBLE");
  assert.equal(enabled.realPublishEnabled, true);
});

test("expired or consumed grants fail closed and are never replaced by base capability", async () => {
  const context = serverContext({
    baseCapability: "L4_IRREVERSIBLE",
    capabilityGrantRefs: ["grant-fixture-001"]
  });
  const request = authorizationRequest({ effect: "external_stage", context });
  for (const status of ["expired", "consumed", "revoked"] as const) {
    const decision = await new CourseToolPolicyGateway({
      grantAuthority: new FixtureGrantAuthority(async () => ({ status }))
    }).evaluate(request);
    assert.equal(decision.effectDecision, "deny");
    assert.equal(decision.reasonCode, "scoped_grant_expired_or_consumed");
  }
});
