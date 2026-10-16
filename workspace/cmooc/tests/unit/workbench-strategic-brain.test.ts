import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStrategicBrainInstructions,
  resolveWorkbenchBrainConfig,
  WORKBENCH_EXECUTOR_MODEL,
  WORKBENCH_EXECUTOR_PROVIDER,
  WORKBENCH_EXECUTOR_REASONING_EFFORT
} from "../../lib/workbench/strategic-brain";

test("defaults to Grok strategy while keeping the Sol Codex executor", () => {
  const config = resolveWorkbenchBrainConfig({});

  assert.equal(config.strategicBrain, "grok");
  assert.equal(config.executorProvider, WORKBENCH_EXECUTOR_PROVIDER);
  assert.equal(config.executorModel, WORKBENCH_EXECUTOR_MODEL);
  assert.equal(config.executorReasoningEffort, WORKBENCH_EXECUTOR_REASONING_EFFORT);

  const instructions = buildStrategicBrainInstructions(config);
  assert.match(instructions, /策略主脑配置：Grok/u);
  assert.match(instructions, /gpt-5\.6-sol/u);
  assert.match(instructions, /realPublishEnabled=false/u);
});

test("strategy selection can change without swapping the executor", () => {
  const config = resolveWorkbenchBrainConfig({ WORKBENCH_STRATEGIC_BRAIN: "sol" });

  assert.equal(config.strategicBrain, "sol");
  assert.equal(config.executorModel, WORKBENCH_EXECUTOR_MODEL);
  assert.equal(resolveWorkbenchBrainConfig({ WORKBENCH_STRATEGIC_BRAIN: "unknown" }).strategicBrain, "grok");
});
