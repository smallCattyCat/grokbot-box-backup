import assert from "node:assert/strict";
import test from "node:test";
import { ControlApplicationService } from "../../lib/control-application-service";
import {
  CmoocApiAdapter,
  ForumAdapterRegistry
} from "../../lib/forum-adapters";

const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");

function fixture(options: { throwAuth?: boolean } = {}) {
  let authInspectionCount = 0;
  let networkDependencyCallCount = 0;
  const adapter = new CmoocApiAdapter({
    dependencies: {
      clock: () => new Date(FIXED_NOW),
      inspectAuth: async () => {
        authInspectionCount += 1;
        if (options.throwAuth) {
          throw new Error("SECRET_TOKEN_FROM_ADAPTER");
        }
        return {
          readyForRealForumWrite: true,
          sources: {
            envSatoken: { configured: true, valid: true },
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
        return [];
      },
      fetchThread: async () => {
        networkDependencyCallCount += 1;
        return null;
      }
    }
  });
  const registry = new ForumAdapterRegistry().register(adapter);
  const service = new ControlApplicationService({
    registry,
    clock: () => new Date(FIXED_NOW),
    correlationIdFactory: () => "test:generated",
    adapterDoctorNetworkPolicy: "local_metadata_only"
  });
  return {
    service,
    getAuthInspectionCount: () => authInspectionCount,
    getNetworkDependencyCallCount: () => networkDependencyCallCount
  };
}

test("manifest 与 status 共用结构化结果和安全状态", async () => {
  const { service } = fixture();
  for (const operation of ["manifest", "status"] as const) {
    const result = await service.invoke({
      principal: { type: "agent_client", ref: "test:agent" },
      operation,
      correlationId: `test:${operation}`
    });
    assert.equal(result.ok, true);
    assert.equal(result.operation, operation);
    assert.equal(result.correlationId, `test:${operation}`);
    assert.equal(result.containsForumText, false);
    assert.equal(
      JSON.stringify(result).includes('"realPublishEnabled":true'),
      false
    );
  }
});

test("adapter doctor 只调用认证摘要，不调用论坛读取依赖", async () => {
  const subject = fixture();
  const result = await subject.service.invoke({
    principal: { type: "local_cli", ref: "test:cli" },
    operation: "adapter.doctor",
    adapterId: "cmooc.api",
    correlationId: "test:doctor"
  });
  assert.equal(result.ok, true);
  assert.equal(subject.getAuthInspectionCount(), 1);
  assert.equal(subject.getNetworkDependencyCallCount(), 0);
  assert.equal(
    (result.data?.auth as { canExecuteAuthorized: boolean })
      .canExecuteAuthorized,
    false
  );
  assert.equal(result.data?.realPublishEnabled, false);
  assert.equal(result.data?.networkPolicy, "local_metadata_only");
});

test("参数无法把只读调用升级为真实发布", async () => {
  const subject = fixture();
  const result = await subject.service.invoke({
    principal: { type: "agent_client", ref: "test:agent" },
    operation: "status",
    realPublishEnabled: true,
    correlationId: "test:elevation"
  });
  assert.equal(result.ok, false);
  assert.equal(result.operation, "invalid");
  assert.equal(result.error?.code, "INVALID_CONTROL_INVOCATION");
  assert.equal(subject.getAuthInspectionCount(), 0);
  assert.equal(subject.getNetworkDependencyCallCount(), 0);
});

test("未知 adapter 和 adapter 异常均返回脱敏结构化错误", async () => {
  const { service } = fixture();
  const unknown = await service.invoke({
    principal: { type: "local_cli", ref: "test:cli" },
    operation: "adapter.doctor",
    adapterId: "missing.adapter",
    correlationId: "test:missing"
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error?.code, "UNKNOWN_FORUM_ADAPTER");
  assert.equal(unknown.containsForumText, false);

  const failed = await fixture({ throwAuth: true }).service.invoke({
    principal: { type: "local_cli", ref: "test:cli" },
    operation: "adapter.doctor",
    adapterId: "cmooc.api",
    correlationId: "test:failed"
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.error?.code, "ADAPTER_DOCTOR_FAILED");
  assert.equal(
    JSON.stringify(failed).includes("SECRET_TOKEN_FROM_ADAPTER"),
    false
  );
});
