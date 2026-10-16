import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPABILITY_CATALOG,
  CapabilityGateway,
  createCapabilityRequest,
  type PrincipalType
} from "../../lib/capability-gateway";
import { PROTOCOL_SCHEMA_VERSIONS } from "../../lib/facilitation-protocol";

const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");
const PRINCIPALS = [
  "local_ui",
  "local_cli",
  "agent_client"
] as const satisfies readonly PrincipalType[];

function gateway() {
  return new CapabilityGateway({
    clock: () => new Date(FIXED_NOW)
  });
}

test("P4C-1 对全部 principal deny-by-default 禁止真实论坛写能力", () => {
  const subject = gateway();
  for (const principalType of PRINCIPALS) {
    const decision = subject.evaluate(
      createCapabilityRequest({
        principalType,
        principalRef: `test:${principalType}`,
        capability: "forum.execute_authorized",
        correlationId: `test:${principalType}:write`,
        requestedAt: FIXED_NOW.toISOString()
      })
    );
    assert.equal(decision.effect, "deny");
    assert.equal(decision.reasonCode, "external_write_disabled");
    assert.equal(decision.containsForumText, false);
  }
  assert.equal(subject.snapshot().defaultEffect, "deny");
  assert.equal(subject.snapshot().realPublishEnabled, false);
  assert.equal(subject.snapshot().externalWriteGrantedCount, 0);
  assert.equal(
    subject.snapshot().principals.find(
      (entry) => entry.principalType === "agent_client"
    )?.externalWriteCapabilityCount,
    0
  );
});

test("通用智能体只获得计划列出的非外部写能力", () => {
  const subject = gateway();
  for (const definition of CAPABILITY_CATALOG) {
    const decision = subject.evaluate(
      createCapabilityRequest({
        principalType: "agent_client",
        principalRef: "test:agent",
        capability: definition.capability,
        correlationId: `test:agent:${definition.capability}`,
        requestedAt: FIXED_NOW.toISOString()
      })
    );
    assert.equal(
      decision.effect,
      definition.category === "external_write" ? "deny" : "allow"
    );
  }
});

test("未知能力和附加字段均 fail closed 并返回结构化拒绝", () => {
  const subject = gateway();
  for (const request of [
    {
      schemaVersion: PROTOCOL_SCHEMA_VERSIONS.capabilityRequest,
      principalType: "agent_client",
      principalRef: "test:agent",
      capability: "forum.publish_any_text",
      objectRefHash: null,
      correlationId: "test:unknown",
      requestedAt: FIXED_NOW.toISOString(),
      containsForumText: false
    },
    {
      ...createCapabilityRequest({
        principalType: "agent_client",
        principalRef: "test:agent",
        capability: "system.inspect",
        correlationId: "test:extra",
        requestedAt: FIXED_NOW.toISOString()
      }),
      realPublishEnabled: true
    }
  ]) {
    const decision = subject.evaluate(request);
    assert.equal(decision.effect, "deny");
    assert.equal(decision.reasonCode, "invalid_capability_request");
    assert.equal(decision.containsForumText, false);
  }
});
