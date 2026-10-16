import assert from "node:assert/strict";
import {
  OPERATOR_ACTION_IDS,
  OPERATOR_REGISTRY,
  getOperatorAction,
  getOperatorManifest,
  isOperatorActionId
} from "../lib/operator-registry";
import {
  OPERATOR_ACTIONS,
  OPERATOR_CONTRACT_VERSION,
  OPERATOR_HTTP_ENDPOINTS
} from "../lib/operator-contract";
import {
  OPERATOR_API_GROUPS,
  OPERATOR_API_WORKFLOWS,
  OPERATOR_BLOCKED_ACTION_IDS,
  OPERATOR_SAFE_ACTION_IDS,
  getOperatorApiCatalog
} from "../lib/operator-api-catalog";

const expectedActionIds = [
  "inspect_status",
  "read_research_digest",
  "read_cmooc_auth_status",
  "run_preview",
  "refresh_world_model",
  "start_preview_scheduler",
  "run_preview_scheduler_once",
  "stop_preview_scheduler"
] as const;

assert.equal(OPERATOR_REGISTRY.appId, "cmooc-companion-system");
assert.equal(OPERATOR_REGISTRY.preferredRoute, "/");
assert.equal(OPERATOR_CONTRACT_VERSION, OPERATOR_REGISTRY.version);
assert.strictEqual(OPERATOR_ACTIONS, OPERATOR_REGISTRY.actions);
assert.strictEqual(OPERATOR_HTTP_ENDPOINTS, OPERATOR_REGISTRY.endpoints);
assert.strictEqual(OPERATOR_API_GROUPS, OPERATOR_REGISTRY.apiGroups);
assert.strictEqual(OPERATOR_API_WORKFLOWS, OPERATOR_REGISTRY.workflows);

assert.deepEqual(OPERATOR_ACTION_IDS, expectedActionIds);
assert.deepEqual(OPERATOR_SAFE_ACTION_IDS, expectedActionIds);
assert.deepEqual(OPERATOR_BLOCKED_ACTION_IDS, []);
assert.equal(new Set(OPERATOR_ACTION_IDS).size, OPERATOR_ACTION_IDS.length);

for (const action of OPERATOR_REGISTRY.actions) {
  assert.equal(isOperatorActionId(action.id), true, `${action.id} must be registered`);
  assert.strictEqual(getOperatorAction(action.id), action);
  assert.equal(action.safe, true, `${action.id} must be safe`);
  assert.equal(action.forumWrite, false, `${action.id} must never write to the real forum`);
  assert.equal(action.requiresConfirmation, false, `${action.id} must not expose a fake approval step`);
}

const endpointEntries = Object.entries(OPERATOR_REGISTRY.endpoints);
for (const [id, endpoint] of endpointEntries) {
  if (endpoint.method === "POST" && endpoint.operatorAction) {
    assert.equal(endpoint.path, "/api/operator/actions", `${id} operator mutation must use the runner`);
  }
  if (endpoint.pollingPolicy === "preferred" || endpoint.pollingPolicy === "allowed") {
    assert.equal(endpoint.method, "GET", `${id} polling endpoint must be read-only`);
  }
}

const reviewEndpoint = OPERATOR_REGISTRY.endpoints.review;
const authorizeEndpoint = OPERATOR_REGISTRY.endpoints.authorizePublish;
const publishEndpoint = OPERATOR_REGISTRY.endpoints.publishAuthorized;
assert.equal(reviewEndpoint.path, "/review");
assert.equal(authorizeEndpoint.path, "/api/interventions/{id}/authorize-publish");
assert.equal(authorizeEndpoint.requiresContentBinding, true);
assert.equal(authorizeEndpoint.operatorAction, false);
assert.equal(publishEndpoint.path, "/api/interventions/{id}/publish");
assert.equal(publishEndpoint.requiresContentBinding, true);
assert.equal(publishEndpoint.operatorAction, false);

const catalog = getOperatorApiCatalog();
const manifest = getOperatorManifest();
assert.equal(manifest.appId, "cmooc-companion-system");
assert.equal(manifest.preferredRoute, "/");
assert.strictEqual(manifest.actions, OPERATOR_REGISTRY.actions);
assert.strictEqual(manifest.endpoints, OPERATOR_REGISTRY.endpoints);
assert.equal(catalog.appId, "cmooc-companion-system");
assert.equal(catalog.preferredRoute, "/");
assert.strictEqual(catalog.actions, OPERATOR_REGISTRY.actions);
assert.strictEqual(catalog.httpEndpoints, OPERATOR_REGISTRY.endpoints);
assert.strictEqual(catalog.apiGroups, OPERATOR_REGISTRY.apiGroups);
assert.strictEqual(catalog.workflows, OPERATOR_REGISTRY.workflows);

const serializedRegistry = JSON.stringify(OPERATOR_REGISTRY);
const serializedManifest = JSON.stringify(manifest);
for (const forbiddenSurface of [
  "allowRealPublish",
  "run_real_publish",
  "start_scheduler_real_publish",
  "publish_intervention_real",
  "/agent-console"
]) {
  assert.equal(
    serializedRegistry.includes(forbiddenSurface),
    false,
    `operator registry must not expose legacy surface: ${forbiddenSurface}`
  );
  assert.equal(
    serializedManifest.includes(forbiddenSurface),
    false,
    `operator manifest must not expose legacy surface: ${forbiddenSurface}`
  );
}

assert.equal(
  OPERATOR_REGISTRY.actions.some((action) => action.id.includes("publish")),
  false,
  "real publishing must not be an operator action"
);
assert.equal(
  OPERATOR_REGISTRY.workflows.some((workflow) => workflow.id === "review_and_publish"),
  true,
  "registry must document the separate human review publishing path"
);

console.log("single operator registry invariants verified");
