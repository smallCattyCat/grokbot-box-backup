import assert from "node:assert/strict";
import {
  CapabilityGateway,
  createCapabilityRequest,
  type PrincipalType
} from "../lib/capability-gateway";
import { ControlApplicationService } from "../lib/control-application-service";
import {
  CmoocApiAdapter,
  ForumAdapterRegistry
} from "../lib/forum-adapters";

const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");
const PRINCIPALS = [
  "local_ui",
  "local_cli",
  "agent_client"
] as const satisfies readonly PrincipalType[];

async function main() {
  let networkDependencyCallCount = 0;
  let authInspectionCount = 0;
  const adapter = new CmoocApiAdapter({
    dependencies: {
      clock: () => new Date(FIXED_NOW),
      inspectAuth: async () => {
        authInspectionCount += 1;
        return {
          readyForRealForumWrite: false,
          sources: {
            envSatoken: { configured: false, valid: null },
            partnerAccount: { configured: false, valid: null },
            playwrightStorageState: {
              exists: false,
              hasSatoken: false,
              valid: null
            }
          }
        };
      },
      fetchThreads: async () => {
        networkDependencyCallCount += 1;
        throw new Error("NETWORK_DEPENDENCY_FORBIDDEN");
      },
      fetchThread: async () => {
        networkDependencyCallCount += 1;
        throw new Error("NETWORK_DEPENDENCY_FORBIDDEN");
      }
    }
  });
  const registry = new ForumAdapterRegistry().register(adapter);
  const gateway = new CapabilityGateway({
    clock: () => new Date(FIXED_NOW)
  });
  const service = new ControlApplicationService({
    registry,
    gateway,
    clock: () => new Date(FIXED_NOW),
    correlationIdFactory: () => "audit:p4c1",
    adapterDoctorNetworkPolicy: "local_metadata_only"
  });

  const externalWriteDecisions = PRINCIPALS.map((principalType) =>
    gateway.evaluate(
      createCapabilityRequest({
        principalType,
        principalRef: `audit:${principalType}`,
        capability: "forum.execute_authorized",
        correlationId: `audit:${principalType}:external-write`,
        requestedAt: FIXED_NOW.toISOString()
      })
    )
  );
  assert.ok(
    externalWriteDecisions.every(
      (decision) =>
        decision.effect === "deny" &&
        decision.reasonCode === "external_write_disabled"
    )
  );

  const manifest = await service.invoke({
    principal: { type: "agent_client", ref: "audit:agent" },
    operation: "manifest",
    correlationId: "audit:manifest"
  });
  const status = await service.invoke({
    principal: { type: "local_cli", ref: "audit:cli" },
    operation: "status",
    correlationId: "audit:status"
  });
  const doctor = await service.invoke({
    principal: { type: "local_cli", ref: "audit:cli" },
    operation: "adapter.doctor",
    adapterId: "cmooc.api",
    correlationId: "audit:doctor"
  });
  const elevationAttempt = await service.invoke({
    principal: { type: "agent_client", ref: "audit:agent" },
    operation: "status",
    realPublishEnabled: true,
    correlationId: "audit:elevation"
  });

  assert.equal(manifest.ok, true);
  assert.equal(status.ok, true);
  assert.equal(doctor.ok, true);
  assert.equal(elevationAttempt.ok, false);
  assert.equal(
    elevationAttempt.error?.code,
    "INVALID_CONTROL_INVOCATION"
  );
  assert.equal(gateway.snapshot().externalWriteGrantedCount, 0);
  assert.equal(registry.snapshot().realExternalWriteAdapterCount, 0);
  assert.equal(networkDependencyCallCount, 0);
  assert.equal(authInspectionCount, 1);

  const output = {
    schemaVersion: "cmooc.p4c1-audit.v1",
    checkpoint: "P4C-1",
    principalCount: PRINCIPALS.length,
    externalWriteDecisionCount: externalWriteDecisions.length,
    externalWriteAllowedCount: externalWriteDecisions.filter(
      (decision) => decision.effect === "allow"
    ).length,
    externalWriteGrantedCount:
      gateway.snapshot().externalWriteGrantedCount,
    realExternalWriteAdapterCount:
      registry.snapshot().realExternalWriteAdapterCount,
    networkDependencyCallCount,
    authInspectionCount,
    parameterElevationRejected: !elevationAttempt.ok,
    structuredResultCount: [manifest, status, doctor].filter(
      (result) =>
        result.correlationId.startsWith("audit:") &&
        result.containsForumText === false
    ).length,
    realPublishEnabled: false,
    containsForumText: false
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

void main();
