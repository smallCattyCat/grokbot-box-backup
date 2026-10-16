import {
  OASIS_CONFORMANCE_RUNTIME_ID,
  type OasisPreviewReportV1,
  type OasisSidecarCapabilitiesV1,
  type OasisSidecarRunOutputV1,
  buildOasisPreviewReport
} from "./oasis-sidecar-contracts";
import {
  OasisSidecarTransportError,
  readOasisSidecarCapabilities,
  runOasisConformanceSidecar
} from "./oasis-sidecar-transport";
import {
  OASIS_SCENE_TEMPLATE_REF,
  OASIS_SEED_SET_REF,
  type OasisScenePackV1,
  compileOasisScenePack
} from "./oasis-scene-pack";
import {
  SCENARIO_LAB_DATASET_REF,
  type CourseWorldFrozenEvidenceV1
} from "./contracts";
import {
  type P3aScenarioEvidenceBundle,
  readP3aScenarioEvidence
} from "./p3a-evidence-reader";

const OASIS_PREVIEW_REQUEST_KEYS = [
  "datasetRef",
  "sceneTemplateRef",
  "seedSetRef",
  "runtimeId"
] as const;

export interface OasisPreviewRequestV1 {
  datasetRef: typeof SCENARIO_LAB_DATASET_REF;
  sceneTemplateRef: typeof OASIS_SCENE_TEMPLATE_REF;
  seedSetRef: typeof OASIS_SEED_SET_REF;
  runtimeId: typeof OASIS_CONFORMANCE_RUNTIME_ID;
}

export type OasisPreviewRequestErrorCode =
  | "OASIS_PREVIEW_REQUEST_INVALID"
  | "OASIS_PREVIEW_DATASET_NOT_FOUND"
  | "OASIS_PREVIEW_SCENE_TEMPLATE_NOT_FOUND"
  | "OASIS_PREVIEW_SEED_SET_NOT_FOUND"
  | "OASIS_PREVIEW_RUNTIME_UNAVAILABLE";

export class OasisPreviewRequestError extends Error {
  readonly code: OasisPreviewRequestErrorCode;

  constructor(code: OasisPreviewRequestErrorCode) {
    super(code);
    this.name = "OasisPreviewRequestError";
    this.code = code;
  }
}

export interface OasisPreviewRunContext {
  signal: AbortSignal;
}

export type OasisPreviewRunner = (
  request: OasisPreviewRequestV1,
  context: OasisPreviewRunContext
) => Promise<OasisPreviewReportV1>;

interface OasisPreviewRunnerDependencies {
  readEvidence: () => Promise<P3aScenarioEvidenceBundle>;
  readCapabilities: (
    context: OasisPreviewRunContext
  ) => Promise<OasisSidecarCapabilitiesV1>;
  runConformance: (
    scenePack: OasisScenePackV1,
    context: OasisPreviewRunContext
  ) => Promise<OasisSidecarRunOutputV1>;
  compileScenePack: (
    evidence: CourseWorldFrozenEvidenceV1
  ) => OasisScenePackV1;
  buildReport: (input: {
    scenePack: OasisScenePackV1;
    capabilities: OasisSidecarCapabilitiesV1;
    output: OasisSidecarRunOutputV1;
  }) => OasisPreviewReportV1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

export function parseOasisPreviewRequest(
  value: unknown
): OasisPreviewRequestV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, OASIS_PREVIEW_REQUEST_KEYS) ||
    OASIS_PREVIEW_REQUEST_KEYS.some(
      (key) => typeof value[key] !== "string"
    )
  ) {
    throw new OasisPreviewRequestError("OASIS_PREVIEW_REQUEST_INVALID");
  }
  if (value.datasetRef !== SCENARIO_LAB_DATASET_REF) {
    throw new OasisPreviewRequestError("OASIS_PREVIEW_DATASET_NOT_FOUND");
  }
  if (value.sceneTemplateRef !== OASIS_SCENE_TEMPLATE_REF) {
    throw new OasisPreviewRequestError(
      "OASIS_PREVIEW_SCENE_TEMPLATE_NOT_FOUND"
    );
  }
  if (value.seedSetRef !== OASIS_SEED_SET_REF) {
    throw new OasisPreviewRequestError("OASIS_PREVIEW_SEED_SET_NOT_FOUND");
  }
  if (value.runtimeId !== OASIS_CONFORMANCE_RUNTIME_ID) {
    throw new OasisPreviewRequestError("OASIS_PREVIEW_RUNTIME_UNAVAILABLE");
  }
  return {
    datasetRef: value.datasetRef,
    sceneTemplateRef: value.sceneTemplateRef,
    seedSetRef: value.seedSetRef,
    runtimeId: value.runtimeId
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new OasisSidecarTransportError("OASIS_SIDECAR_ABORTED");
  }
}

const DEFAULT_DEPENDENCIES: OasisPreviewRunnerDependencies = {
  readEvidence: readP3aScenarioEvidence,
  readCapabilities: readOasisSidecarCapabilities,
  runConformance: runOasisConformanceSidecar,
  compileScenePack: compileOasisScenePack,
  buildReport: buildOasisPreviewReport
};

export function createOasisPreviewRunner(
  overrides: Partial<OasisPreviewRunnerDependencies> = {}
): OasisPreviewRunner {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };

  return async (request, context) => {
    const exactRequest = parseOasisPreviewRequest(request);
    throwIfAborted(context.signal);

    const { evidence } = await dependencies.readEvidence();
    throwIfAborted(context.signal);
    const scenePack = dependencies.compileScenePack(evidence);
    if (
      scenePack.datasetRef !== exactRequest.datasetRef ||
      scenePack.sceneTemplateRef !== exactRequest.sceneTemplateRef ||
      scenePack.seedSetRef !== exactRequest.seedSetRef
    ) {
      throw new Error("OASIS_PREVIEW_COMPILED_REFERENCE_MISMATCH");
    }

    const capabilities = await dependencies.readCapabilities(context);
    throwIfAborted(context.signal);
    const output = await dependencies.runConformance(scenePack, context);
    throwIfAborted(context.signal);

    return dependencies.buildReport({ scenePack, capabilities, output });
  };
}

export const runOasisPreview = createOasisPreviewRunner();
