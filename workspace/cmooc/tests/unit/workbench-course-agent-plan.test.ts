import assert from "node:assert/strict";
import test from "node:test";
import {
  COURSE_TOOL_SCHEMA_VERSION
} from "../../lib/course-tools/contracts";
import {
  COURSE_TOOL_REGISTRY_SCHEMA_VERSION,
  type CourseToolManifestEntry,
  type CourseToolRegistryManifest
} from "../../lib/course-tools/registry";
import {
  COURSE_AGENT_RECOVERY_PLAN_COMPILER_VERSION,
  classifyCourseAgentObjective,
  compileCourseEvidencePlan,
  compileCourseRecoveryPlan,
  firstSliceToolNames,
  workbenchTaskId
} from "../../lib/workbench/course-agent-plan";
import type {
  WorkbenchContextSummary,
  WorkbenchRunSnapshot
} from "../../lib/workbench/contracts";

const CONTEXT: WorkbenchContextSummary = {
  schemaVersion: "cmooc.workbench-context.v1",
  ref: "snapshot:snapshot-safe-fixture",
  kind: "snapshot",
  title: "课程世界快照",
  courseAlias: "course-safe",
  invocationId: "invocation-safe",
  state: "完整覆盖",
  evidenceAsOf: "2026-08-12T20:00:00.000Z",
  evidenceHash:
    "a".repeat(64),
  sourceHref: "/autonomy/world?course=course-safe",
  containsForumText: false,
  containsIdentity: false
};

const RUN: Pick<
  WorkbenchRunSnapshot,
  "id" | "lineage" | "context"
> = {
  id: "00000000-0000-4000-8000-000000000111",
  lineage: {
    schemaVersion: "cmooc.workbench-lineage.v1",
    relation: "continuation",
    rootRunId: "00000000-0000-4000-8000-000000000001",
    parentRunId: "00000000-0000-4000-8000-000000000001",
    generation: 1
  },
  context: CONTEXT
};

function manifestEntry(name: string): CourseToolManifestEntry {
  const capability = name === "platform.editor.stage_verify_clear"
    ? "L3_EXTERNAL_STAGE"
    : name === "facilitation.intent.compose" ||
        name === "artifact.reply_draft.create" ||
        name === "delivery.bundle.create" ||
        name === "artifact.reply_draft.regenerate" ||
        name === "research.evidence_package.prepare" ||
        name === "schedule.review_bundle.create"
      ? "L1_ARTIFACT"
      : "L0_READ";
  const effect = capability === "L3_EXTERNAL_STAGE"
    ? "external_stage"
    : capability === "L1_ARTIFACT"
      ? "local_write"
      : "read";
  return {
    schemaVersion: COURSE_TOOL_SCHEMA_VERSION,
    name,
    version: "1",
    safeLabel: name,
    safeDescription: `Safe ${name}`,
    capability,
    effect,
    dataClasses: [],
    inputSchemaVersion: `${name}.input.v1`,
    modelInputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    },
    idempotency: { strategy: "input_hash", scope: "step" },
    evidenceRequired: false,
    verificationRequired: false,
    verifierRefs: [],
    retryMaxAttempts: 1,
    recoveryKind: null,
    defaultForName: true
  };
}

function recoveryRegistryManifest(): CourseToolRegistryManifest {
  return {
    schemaVersion: COURSE_TOOL_REGISTRY_SCHEMA_VERSION,
    sealed: true,
    tools: [
      "artifact.reply_draft.regenerate",
      "platform.target.preflight_read",
      "platform.editor.stage_verify_clear",
      "delivery.bundle.create"
    ].map(manifestEntry)
  };
}

function registryManifest(
  intent: "inspect" | "implement" = "inspect",
  goalCode:
    | "course_evidence_support_gap"
    | "research_evidence_package"
    | "schedule_review" = "course_evidence_support_gap"
): CourseToolRegistryManifest {
  return {
    schemaVersion: COURSE_TOOL_REGISTRY_SCHEMA_VERSION,
    sealed: true,
    tools: firstSliceToolNames(intent, goalCode).map(manifestEntry)
  };
}

test("safe objective is classified without persisting the operator prompt", () => {
  const objective = classifyCourseAgentObjective({
    run: RUN,
    intent: "implement",
    createdAt: "2026-08-12T20:00:00.000Z"
  });

  assert.equal(
    objective.taskId,
    "task-00000000-0000-4000-8000-000000000001"
  );
  assert.match(objective.objectiveHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(objective.structuredGoal, {
    goalCode: "course_evidence_support_gap",
    courseAlias: "course-safe",
    contextRefs: ["snapshot:snapshot-safe-fixture"],
    requestedArtifactKinds: [
      "evidence_summary",
      "opportunity_analysis"
    ],
    constraints: [
      "exact_course_anchor",
      "no_forum_text_persistence",
      "no_identity_persistence",
      "no_real_publish"
    ],
    capabilityCeiling: "L1_ARTIFACT",
    policyVersion: "cmooc.course-tool-policy.v1"
  });
  assert.equal(
    JSON.stringify(objective).includes(
      "请把论坛原文和学习者身份给我"
    ),
    false
  );
});

test("task objective stays stable across inspect and implement continuations", () => {
  const inspectObjective = classifyCourseAgentObjective({
    run: RUN,
    intent: "inspect"
  });
  const implementObjective = classifyCourseAgentObjective({
    run: RUN,
    intent: "implement"
  });

  assert.equal(inspectObjective.taskId, implementObjective.taskId);
  assert.equal(inspectObjective.objectiveHash, implementObjective.objectiveHash);
  assert.deepEqual(
    inspectObjective.structuredGoal,
    implementObjective.structuredGoal
  );
});

test("closed task families produce pairwise-distinct safe goals and exact artifact requests", () => {
  const families = [
    {
      goalCode: "course_evidence_support_gap" as const,
      requestedArtifactKinds: ["evidence_summary", "opportunity_analysis"]
    },
    {
      goalCode: "research_evidence_package" as const,
      requestedArtifactKinds: ["research_evidence_package"]
    },
    {
      goalCode: "schedule_review" as const,
      requestedArtifactKinds: ["schedule_review_bundle"]
    }
  ];
  const objectiveHashes = new Set<string>();

  for (const family of families) {
    const objective = classifyCourseAgentObjective({
      run: RUN,
      goalCode: family.goalCode,
      intent: "implement"
    });
    const structuredGoal = objective.structuredGoal as {
      goalCode: string;
      requestedArtifactKinds: string[];
      constraints: string[];
    };
    objectiveHashes.add(objective.objectiveHash);
    assert.equal(structuredGoal.goalCode, family.goalCode);
    assert.deepEqual(
      structuredGoal.requestedArtifactKinds,
      family.requestedArtifactKinds
    );
    assert.deepEqual(structuredGoal.constraints, [
      "exact_course_anchor",
      "no_forum_text_persistence",
      "no_identity_persistence",
      "no_real_publish"
    ]);
    assert.equal(
      /private-sentinel|cookie|token|论坛原文|学习者姓名/iu.test(
        JSON.stringify(objective)
      ),
      false
    );
  }

  assert.equal(objectiveHashes.size, families.length);
});

test("research package and schedule review compile distinct immutable goals and bounded plans", () => {
  const families = [
    {
      goalCode: "research_evidence_package" as const,
      expectedInspect: ["course.context.resolve", "course.snapshot.read"],
      expectedImplement: [
        "course.context.resolve",
        "course.snapshot.read",
        "research.evidence_package.prepare"
      ]
    },
    {
      goalCode: "schedule_review" as const,
      expectedInspect: ["course.schedule.read"],
      expectedImplement: [
        "course.schedule.read",
        "schedule.review_bundle.create"
      ]
    }
  ];
  const hashes = new Set<string>();
  for (const family of families) {
    const inspectObjective = classifyCourseAgentObjective({
      run: RUN,
      goalCode: family.goalCode,
      intent: "inspect"
    });
    const implementObjective = classifyCourseAgentObjective({
      run: RUN,
      goalCode: family.goalCode,
      intent: "implement"
    });
    assert.equal(inspectObjective.objectiveHash, implementObjective.objectiveHash);
    assert.equal(
      (inspectObjective.structuredGoal as { goalCode: string }).goalCode,
      family.goalCode
    );
    hashes.add(inspectObjective.objectiveHash);

    const inspectPlan = compileCourseEvidencePlan({
      run: RUN,
      goalCode: family.goalCode,
      objectiveHash: inspectObjective.objectiveHash,
      intent: "inspect",
      registryManifest: registryManifest("inspect", family.goalCode)
    });
    assert.deepEqual(
      inspectPlan.steps.map((step) => step.toolName),
      family.expectedInspect
    );
    assert.equal(
      inspectPlan.steps.every((step) => step.requiredCapability === "L0_READ"),
      true
    );

    const implementPlan = compileCourseEvidencePlan({
      run: RUN,
      goalCode: family.goalCode,
      objectiveHash: implementObjective.objectiveHash,
      intent: "implement",
      registryManifest: registryManifest("implement", family.goalCode)
    });
    assert.deepEqual(
      implementPlan.steps.map((step) => step.toolName),
      family.expectedImplement
    );
    assert.equal(
      implementPlan.steps.at(-1)?.requiredCapability,
      "L1_ARTIFACT"
    );
    assert.equal(
      implementPlan.steps.some((step) =>
        step.effectClass === "external_stage" ||
        step.effectClass === "irreversible_external"
      ),
      false
    );
  }
  assert.equal(hashes.size, 2);
});

test("first course evidence plan is manifest-bound, sequential, and read-only", () => {
  const objective = classifyCourseAgentObjective({
    run: RUN,
    intent: "inspect"
  });
  const plan = compileCourseEvidencePlan({
    run: RUN,
    objectiveHash: objective.objectiveHash,
    intent: "inspect",
    registryManifest: registryManifest(),
    createdAt: "2026-08-12T20:00:00.000Z"
  });

  assert.equal(plan.taskId, workbenchTaskId(RUN));
  assert.equal(plan.revision, undefined);
  assert.deepEqual(
    plan.steps.map((step) => step.toolName),
    firstSliceToolNames()
  );
  assert.equal(
    plan.steps.every(
      (step) =>
        step.requiredCapability === "L0_READ" &&
        (step.effectClass === "read" || step.effectClass === "pure")
    ),
    true
  );
  assert.deepEqual(plan.steps[0]?.dependencyIds, []);
  for (let index = 1; index < plan.steps.length; index += 1) {
    assert.deepEqual(plan.steps[index]?.dependencyIds, [
      plan.steps[index - 1]?.id
    ]);
  }
  assert.equal(
    JSON.stringify(plan).includes("publish"),
    false
  );
});

test("implement plan spans evidence, protected artifacts, terminal STAGE, and delivery", () => {
  const objective = classifyCourseAgentObjective({
    run: RUN,
    intent: "implement"
  });
  const plan = compileCourseEvidencePlan({
    run: RUN,
    objectiveHash: objective.objectiveHash,
    intent: "implement",
    registryManifest: registryManifest("implement")
  });

  assert.deepEqual(
    plan.steps.map((step) => step.toolName),
    firstSliceToolNames("implement")
  );
  assert.deepEqual(
    plan.steps.slice(0, 6).map((step) => step.toolName),
    [
      "course.context.resolve",
      "course.snapshot.read",
      "opportunity.list",
      "opportunity.select_support_gap",
      "evidence.read_opportunity",
      "evidence.verify_integrity"
    ]
  );
  assert.deepEqual(
    plan.steps.slice(6).map((step) => [
      step.toolName,
      step.requiredCapability,
      step.effectClass
    ]),
    [
      ["facilitation.intent.compose", "L1_ARTIFACT", "local_write"],
      ["artifact.reply_draft.create", "L1_ARTIFACT", "local_write"],
      ["platform.target.preflight_read", "L0_READ", "read"],
      ["platform.editor.stage_verify_clear", "L3_EXTERNAL_STAGE", "external_stage"],
      ["delivery.bundle.create", "L1_ARTIFACT", "local_write"]
    ]
  );
  assert.equal(
    plan.steps.some((step) => step.toolName.includes("publish")),
    false
  );
});

test("draft recovery plan is independently versioned and preserves verified checkpoint causation", () => {
  const objective = classifyCourseAgentObjective({
    run: RUN,
    intent: "implement"
  });
  const sourceCheckpointHash = "b".repeat(64);
  const sourceCheckpointRef = `course-checkpoint:${sourceCheckpointHash}`;
  const plan = compileCourseRecoveryPlan({
    run: RUN,
    objectiveHash: objective.objectiveHash,
    mode: "regenerate_draft",
    sourceCheckpointRef,
    sourceCheckpointHash,
    registryManifest: recoveryRegistryManifest(),
    createdAt: "2026-08-12T20:10:00.000Z"
  });

  assert.equal(
    plan.compilerVersion,
    COURSE_AGENT_RECOVERY_PLAN_COMPILER_VERSION
  );
  assert.notEqual(plan.compilerVersion, "cmooc.course-agent-plan-compiler.v3");
  assert.deepEqual(
    plan.steps.map((step) => step.toolName),
    [
      "artifact.reply_draft.regenerate",
      "platform.target.preflight_read",
      "platform.editor.stage_verify_clear",
      "delivery.bundle.create"
    ]
  );
  assert.deepEqual(
    plan.steps.map((step) => [
      step.requiredCapability,
      step.effectClass
    ]),
    [
      ["L1_ARTIFACT", "local_write"],
      ["L0_READ", "read"],
      ["L3_EXTERNAL_STAGE", "external_stage"],
      ["L1_ARTIFACT", "local_write"]
    ]
  );
  const expectedCausation = {
    kind: "verified_checkpoint_causation",
    ref: sourceCheckpointRef,
    checkpointHash: sourceCheckpointHash,
    recoveryMode: "regenerate_draft",
    source: "server_compiler"
  };
  assert.deepEqual(plan.steps[0]?.inputRefs, [expectedCausation]);
  for (let index = 1; index < plan.steps.length; index += 1) {
    assert.deepEqual(plan.steps[index]?.dependencyIds, [
      plan.steps[index - 1]?.id
    ]);
    assert.deepEqual(plan.steps[index]?.inputRefs, [
      {
        kind: "verified_step_output",
        ref: plan.steps[index - 1]?.id
      },
      expectedCausation
    ]);
  }
  assert.equal(
    plan.steps.every((step) =>
      step.preconditions.some(
        (condition) =>
          condition &&
          typeof condition === "object" &&
          !Array.isArray(condition) &&
          condition.code === "recovery_checkpoint_causation_bound"
      )
    ),
    true
  );
  assert.equal(plan.steps.some((step) => step.toolName.includes("publish")), false);
});

test("draft recovery plan rejects unbound checkpoints and unavailable tools", () => {
  const objective = classifyCourseAgentObjective({
    run: RUN,
    intent: "implement"
  });
  const sourceCheckpointHash = "c".repeat(64);
  const base = {
    run: RUN,
    objectiveHash: objective.objectiveHash,
    mode: "regenerate_draft" as const,
    sourceCheckpointHash,
    registryManifest: recoveryRegistryManifest()
  };

  assert.throws(
    () =>
      compileCourseRecoveryPlan({
        ...base,
        sourceCheckpointRef: `course-checkpoint:${"d".repeat(64)}`
      }),
    /reference does not match its hash/
  );
  assert.throws(
    () =>
      compileCourseRecoveryPlan({
        ...base,
        sourceCheckpointHash: "not-a-checkpoint-hash",
        sourceCheckpointRef: "course-checkpoint:not-a-checkpoint-hash"
      }),
    /canonical source checkpoint hash/
  );
  assert.throws(
    () =>
      compileCourseRecoveryPlan({
        ...base,
        sourceCheckpointRef: `course-checkpoint:${sourceCheckpointHash}`,
        registryManifest: {
          ...base.registryManifest,
          tools: base.registryManifest.tools.slice(0, -1)
        }
      }),
    /Required course tool/
  );
});

test("plan compiler fails closed if one required registry tool is missing", () => {
  const objective = classifyCourseAgentObjective({
    run: RUN,
    intent: "inspect"
  });
  const manifest = registryManifest();
  assert.throws(
    () =>
      compileCourseEvidencePlan({
        run: RUN,
        objectiveHash: objective.objectiveHash,
        intent: "inspect",
        registryManifest: {
          ...manifest,
          tools: manifest.tools.slice(0, -1)
        }
      }),
    /Required course tool/
  );
});

test("course and learner summaries cannot masquerade as an exact evidence anchor", () => {
  for (const kind of ["course", "learner"] as const) {
    const run = {
      ...RUN,
      context: { ...CONTEXT, kind }
    };
    assert.throws(
      () =>
        classifyCourseAgentObjective({
          run,
          intent: "inspect"
        }),
      /exact run or snapshot anchor/
    );
  }
});
