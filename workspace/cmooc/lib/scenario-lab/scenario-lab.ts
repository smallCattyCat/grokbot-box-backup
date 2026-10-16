import type {
  CourseWorldScenarioLabReportV1,
  ScenarioLabRunRequestV1
} from "./contracts";
import {
  DETERMINISTIC_P3A_RUNTIME_ID,
  SCENARIO_LAB_DATASET_REF,
  SCENARIO_LAB_SCENARIO_SET_REF
} from "./contracts";
import { deterministicP3aReplayAdapter } from "./deterministic-runtime";
import { readP3aScenarioEvidence } from "./p3a-evidence-reader";

export async function runScenarioLab(
  request: ScenarioLabRunRequestV1
): Promise<CourseWorldScenarioLabReportV1> {
  if (
    request.datasetRef !== SCENARIO_LAB_DATASET_REF ||
    request.scenarioSetRef !== SCENARIO_LAB_SCENARIO_SET_REF ||
    request.runtimeId !== DETERMINISTIC_P3A_RUNTIME_ID
  ) {
    throw new Error("SCENARIO_LAB_REQUEST_UNSUPPORTED");
  }
  const { evidence, replayResults } = await readP3aScenarioEvidence();
  return deterministicP3aReplayAdapter.run(evidence, replayResults);
}

