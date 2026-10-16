import assert from "node:assert/strict";
import test from "node:test";
import type { TrustedPlatformStageAdapter } from "../../lib/course-tools/tools/platform-stage";
import { createCourseAgentArtifactRuntime } from "../../lib/workbench/course-agent-artifact-runtime";
import { createUnavailablePlatformStageAdapter } from "../../lib/workbench/course-agent-toolkit";
import {
  createWorkbenchCourseAgentToolkit,
  resolveWorkbenchCourseAgentToolkitBootstrap,
  type WorkbenchTrustedStageProviders
} from "../../lib/workbench/course-agent-toolkit-bootstrap";
import {
  createWorkbenchRouteCourseAgentComposition,
  createWorkbenchRouteCourseAgentToolkit,
  setWorkbenchTrustedStageProviderSourceForTests
} from "../../lib/workbench/workbench-course-agent-toolkit-factory";

function unavailableAdapter(): TrustedPlatformStageAdapter {
  return Object.freeze({
    preflightRead: async () => {
      throw new Error("fixture preflight should not run");
    },
    stageVerifyClear: async () => {
      throw new Error("fixture stage should not run");
    },
    reconcileStage: async () => {
      throw new Error("fixture reconcile should not run");
    }
  });
}

test("trusted STAGE bootstrap is disabled unless the exact server flag is one", () => {
  let providerCalls = 0;
  const providers: WorkbenchTrustedStageProviders = {
    resolvePlatformStageAdapter: () => {
      providerCalls += 1;
      return unavailableAdapter();
    }
  };

  for (const value of [undefined, "", "0", "true", "01"]) {
    const bootstrap = resolveWorkbenchCourseAgentToolkitBootstrap({
      env: { CMOOC_WORKBENCH_TRUSTED_STAGE_ENABLED: value },
      providers
    });
    assert.equal(bootstrap.stageMode, "disabled");
    assert.equal(bootstrap.reasonCode, "feature_disabled");
    assert.equal(bootstrap.platformStageAdapterFactory, undefined);
  }
  assert.equal(providerCalls, 0);
});

test("enabled bootstrap remains blocked without complete server providers", () => {
  const bootstrap = resolveWorkbenchCourseAgentToolkitBootstrap({
    env: { CMOOC_WORKBENCH_TRUSTED_STAGE_ENABLED: "1" }
  });
  assert.equal(bootstrap.stageMode, "blocked");
  assert.equal(bootstrap.reasonCode, "provider_unavailable");
  assert.equal(bootstrap.platformStageAdapterFactory, undefined);
});

test("toolkit construction is lazy and never resolves a trusted provider", () => {
  let providerCalls = 0;
  const toolkit = createWorkbenchCourseAgentToolkit({
    taskId: "task-bootstrap-fixture-1",
    runId: "run-bootstrap-fixture-1",
    courseAlias: "course-fixture",
    env: { CMOOC_WORKBENCH_TRUSTED_STAGE_ENABLED: "1" },
    providers: {
      resolvePlatformStageAdapter: () => {
        providerCalls += 1;
        return unavailableAdapter();
      }
    }
  });

  assert.equal(providerCalls, 0);
  assert.equal(toolkit.registry.has("platform.target.preflight_read", "1"), true);
  assert.equal(toolkit.registry.has("platform.editor.stage_verify_clear", "1"), true);
  assert.equal(
    toolkit.registry.manifest().tools.some((tool) =>
      tool.capability === "L4_IRREVERSIBLE" ||
      tool.effect === "irreversible_external" ||
      /(?:publish|submit|send|commit)/u.test(tool.name)
    ),
    false
  );
});

test("the enabled provider resolves once, only on the first trusted operation", async () => {
  let providerCalls = 0;
  let preflightCalls = 0;
  const expected = new Error("fixture trusted operation reached");
  const bootstrap = resolveWorkbenchCourseAgentToolkitBootstrap({
    env: { CMOOC_WORKBENCH_TRUSTED_STAGE_ENABLED: "1" },
    providers: {
      resolvePlatformStageAdapter: () => {
        providerCalls += 1;
        return Object.freeze({
          preflightRead: async () => {
            preflightCalls += 1;
            throw expected;
          },
          stageVerifyClear: async () => {
            throw new Error("fixture stage should not run");
          },
          reconcileStage: async () => {
            throw new Error("fixture reconcile should not run");
          }
        });
      }
    }
  });
  const runtime = createCourseAgentArtifactRuntime({
    taskId: "task-bootstrap-fixture-2",
    runId: "run-bootstrap-fixture-2",
    courseAlias: "course-fixture"
  });
  const adapter = bootstrap.platformStageAdapterFactory?.({
    materialLedger: runtime.materialLedger,
    protectedMaterialVault: runtime.protectedMaterialVault,
    protectedStore: runtime.dependencies.protectedStore
  });
  assert.ok(adapter);
  assert.equal(providerCalls, 0);

  const request = {} as Parameters<TrustedPlatformStageAdapter["preflightRead"]>[0];
  await assert.rejects(adapter.preflightRead(request), expected);
  await assert.rejects(adapter.preflightRead(request), expected);
  assert.equal(providerCalls, 1);
  assert.equal(preflightCalls, 2);
});

async function runPreflight(
  toolkit: ReturnType<typeof createWorkbenchRouteCourseAgentToolkit>,
  suffix: string
): Promise<Readonly<{ status: string; reasonCode: string }>> {
  const registration = toolkit.registry.resolve(
    "platform.target.preflight_read",
    "1"
  );
  const result = await registration.handler({
    input: { targetRef: `target-${suffix}` },
    context: {
      now: "2026-08-13T12:00:00.000Z",
      courseScope: {
        alias: "course-fixture",
        manifestHash: "a".repeat(64)
      }
    } as never,
    envelope: {} as never
  });
  return result.output as unknown as Readonly<{
    status: string;
    reasonCode: string;
  }>;
}

test("the shared route factory keeps create and launch toolkits identical without resolving providers", () => {
  let sourceCalls = 0;
  let providerCalls = 0;
  setWorkbenchTrustedStageProviderSourceForTests(() => {
    sourceCalls += 1;
    const providers: WorkbenchTrustedStageProviders = {
      resolvePlatformStageAdapter: () => {
        providerCalls += 1;
        return createUnavailablePlatformStageAdapter();
      }
    };
    return providers;
  });
  try {
    const createComposition = createWorkbenchRouteCourseAgentComposition({
      taskId: "task-route-create-fixture",
      runId: "run-route-create-fixture",
      courseAlias: "course-fixture",
      env: {
        CMOOC_WORKBENCH_TRUSTED_STAGE_ENABLED: "1",
        CMOOC_WORKBENCH_AUTO_REVERSIBLE_STAGE_ENABLED: "1"
      }
    });
    const launchComposition = createWorkbenchRouteCourseAgentComposition({
      taskId: "task-route-launch-fixture",
      runId: "run-route-launch-fixture",
      courseAlias: "course-fixture",
      env: {
        CMOOC_WORKBENCH_TRUSTED_STAGE_ENABLED: "1",
        CMOOC_WORKBENCH_AUTO_REVERSIBLE_STAGE_ENABLED: "1"
      }
    });
    const createToolkit = createComposition.toolkit;
    const launchToolkit = launchComposition.toolkit;

    assert.equal(createComposition.actionPolicyMode, "auto_reversible");
    assert.equal(launchComposition.actionPolicyMode, "auto_reversible");
    assert.equal(typeof createComposition.autoActionExecutor, "function");
    assert.equal(typeof launchComposition.autoActionExecutor, "function");
    assert.deepEqual(
      createToolkit.registry.manifest(),
      launchToolkit.registry.manifest()
    );
    assert.deepEqual(
      createToolkit.verifierRegistry.manifest(),
      launchToolkit.verifierRegistry.manifest()
    );
    assert.equal(sourceCalls, 0);
    assert.equal(providerCalls, 0);
  } finally {
    setWorkbenchTrustedStageProviderSourceForTests(undefined);
  }
});

test("the route action policy defaults to confirmation and requires the exact flag plus a source", () => {
  let sourceCalls = 0;
  setWorkbenchTrustedStageProviderSourceForTests(() => {
    sourceCalls += 1;
    return {
      resolvePlatformStageAdapter: () => createUnavailablePlatformStageAdapter()
    };
  });
  try {
    for (const value of [undefined, "", "0", "true", "01"]) {
      const composition = createWorkbenchRouteCourseAgentComposition({
        taskId: `task-policy-${value ?? "unset"}`,
        runId: `run-policy-${value ?? "unset"}`,
        courseAlias: "course-fixture",
        env: {
          CMOOC_WORKBENCH_TRUSTED_STAGE_ENABLED: "1",
          CMOOC_WORKBENCH_AUTO_REVERSIBLE_STAGE_ENABLED: value
        }
      });
      assert.equal(composition.actionPolicyMode, "confirm_stage");
      assert.equal(composition.autoActionExecutor, undefined);
    }
    assert.equal(sourceCalls, 0);

    const trustedProviderWithAutoUnset =
      createWorkbenchRouteCourseAgentComposition({
        taskId: "task-policy-trusted-confirm",
        runId: "run-policy-trusted-confirm",
        courseAlias: "course-fixture",
        env: { CMOOC_WORKBENCH_TRUSTED_STAGE_ENABLED: "1" }
      });
    assert.equal(
      trustedProviderWithAutoUnset.actionPolicyMode,
      "confirm_stage"
    );
    assert.equal(
      trustedProviderWithAutoUnset.autoActionExecutor,
      undefined
    );
    assert.equal(sourceCalls, 0);

    const autoFlagWithoutTrustedAdapter =
      createWorkbenchRouteCourseAgentComposition({
        taskId: "task-policy-auto-without-trusted",
        runId: "run-policy-auto-without-trusted",
        courseAlias: "course-fixture",
        env: { CMOOC_WORKBENCH_AUTO_REVERSIBLE_STAGE_ENABLED: "1" }
      });
    assert.equal(
      autoFlagWithoutTrustedAdapter.actionPolicyMode,
      "confirm_stage"
    );
    assert.equal(
      autoFlagWithoutTrustedAdapter.autoActionExecutor,
      undefined
    );
    assert.equal(sourceCalls, 0);
  } finally {
    setWorkbenchTrustedStageProviderSourceForTests(undefined);
  }

  const noSource = createWorkbenchRouteCourseAgentComposition({
    taskId: "task-policy-no-source",
    runId: "run-policy-no-source",
    courseAlias: "course-fixture",
    env: {
      CMOOC_WORKBENCH_TRUSTED_STAGE_ENABLED: "1",
      CMOOC_WORKBENCH_AUTO_REVERSIBLE_STAGE_ENABLED: "1"
    }
  });
  assert.equal(noSource.actionPolicyMode, "confirm_stage");
  assert.equal(noSource.autoActionExecutor, undefined);
});

test("the shared route factory resolves its injected provider only at first preflight", async () => {
  let sourceCalls = 0;
  let providerCalls = 0;
  let preflightCalls = 0;
  const secretSentinel = "RAW_STAGE_SECRET_MUST_NOT_SERIALIZE";
  const pathSentinel = "C:/private/browser/profile/must-not-serialize";
  setWorkbenchTrustedStageProviderSourceForTests(({ courseAlias }) => {
    sourceCalls += 1;
    assert.equal(courseAlias, "course-fixture");
    void secretSentinel;
    void pathSentinel;
    return {
      resolvePlatformStageAdapter: () => {
        providerCalls += 1;
        const fallback = createUnavailablePlatformStageAdapter();
        return Object.freeze({
          ...fallback,
          preflightRead: async (
            input: Parameters<TrustedPlatformStageAdapter["preflightRead"]>[0]
          ) => {
            preflightCalls += 1;
            return fallback.preflightRead(input);
          }
        });
      }
    };
  });
  try {
    const toolkit = createWorkbenchRouteCourseAgentToolkit({
      taskId: "task-route-lazy-fixture",
      runId: "run-route-lazy-fixture",
      courseAlias: "course-fixture",
      env: { CMOOC_WORKBENCH_TRUSTED_STAGE_ENABLED: "1" }
    });
    const safeSnapshot = JSON.stringify({
      toolkit: toolkit.registry.manifest(),
      verifiers: toolkit.verifierRegistry.manifest()
    });
    assert.equal(sourceCalls, 0);
    assert.equal(providerCalls, 0);
    assert.equal(safeSnapshot.includes(secretSentinel), false);
    assert.equal(safeSnapshot.includes(pathSentinel), false);

    const first = await runPreflight(toolkit, "first");
    const second = await runPreflight(toolkit, "second");
    assert.equal(first.status, "waiting_for_browser");
    assert.equal(second.status, "waiting_for_browser");
    assert.equal(sourceCalls, 1);
    assert.equal(providerCalls, 1);
    assert.equal(preflightCalls, 2);
  } finally {
    setWorkbenchTrustedStageProviderSourceForTests(undefined);
  }
});

test("an unavailable route provider leaves L0 and L1 tools registered and waits only at preflight", async () => {
  setWorkbenchTrustedStageProviderSourceForTests(undefined);
  const toolkit = createWorkbenchRouteCourseAgentToolkit({
    taskId: "task-route-inert-fixture",
    runId: "run-route-inert-fixture",
    courseAlias: "course-fixture",
    env: { CMOOC_WORKBENCH_TRUSTED_STAGE_ENABLED: "1" }
  });
  const tools = toolkit.registry.manifest().tools;

  assert.equal(
    tools.some((tool) => tool.capability === "L0_READ"),
    true
  );
  assert.equal(
    tools.some((tool) => tool.capability === "L1_ARTIFACT"),
    true
  );
  const preflight = await runPreflight(toolkit, "unavailable");
  assert.equal(preflight.status, "waiting_for_browser");
  assert.equal(preflight.reasonCode, "browser_unavailable");
});

test("an injected but incomplete provider source also converges to waiting_for_browser", async () => {
  let sourceCalls = 0;
  setWorkbenchTrustedStageProviderSourceForTests(() => {
    sourceCalls += 1;
    return undefined;
  });
  try {
    const toolkit = createWorkbenchRouteCourseAgentToolkit({
      taskId: "task-route-incomplete-provider-fixture",
      runId: "run-route-incomplete-provider-fixture",
      courseAlias: "course-fixture",
      env: { CMOOC_WORKBENCH_TRUSTED_STAGE_ENABLED: "1" }
    });
    assert.equal(sourceCalls, 0);

    const preflight = await runPreflight(toolkit, "incomplete-provider");
    assert.equal(sourceCalls, 1);
    assert.equal(preflight.status, "waiting_for_browser");
    assert.equal(preflight.reasonCode, "browser_unavailable");
  } finally {
    setWorkbenchTrustedStageProviderSourceForTests(undefined);
  }
});
