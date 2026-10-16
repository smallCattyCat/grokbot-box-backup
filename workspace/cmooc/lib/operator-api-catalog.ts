import {
  OPERATOR_ACTION_IDS,
  OPERATOR_API_GROUP_DEFINITIONS,
  OPERATOR_PATHS,
  OPERATOR_WORKFLOW_DEFINITIONS,
  getOperatorCatalog,
  type OperatorActionId
} from "@/lib/operator-registry";

export const OPERATOR_API_VERSION = 2;
export const OPERATOR_ACTION_RUNNER_PATH = OPERATOR_PATHS.actions;
export const OPERATOR_API_DOCS_PATH = OPERATOR_PATHS.apiDocs;
export const OPERATOR_MANIFEST_PATH = OPERATOR_PATHS.manifest;

export const OPERATOR_SAFE_ACTION_IDS = OPERATOR_ACTION_IDS;

// Compatibility export for older callers. Unsupported publish shortcuts are no
// longer advertised or specially handled; they are simply unknown actions.
export const OPERATOR_BLOCKED_ACTION_IDS = [] as const;

export type OperatorSafeActionId = OperatorActionId;
export type OperatorBlockedActionId = never;
export type OperatorActionRunnerId = OperatorActionId;

export const OPERATOR_API_GROUPS = OPERATOR_API_GROUP_DEFINITIONS;
export const OPERATOR_API_WORKFLOWS = OPERATOR_WORKFLOW_DEFINITIONS;

export function getOperatorApiCatalog() {
  return getOperatorCatalog();
}
