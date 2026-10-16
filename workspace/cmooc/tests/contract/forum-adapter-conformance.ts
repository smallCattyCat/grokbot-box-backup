import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  PROTOCOL_SCHEMA_VERSIONS,
  assertExecutionReceiptSemantics,
  assertObservationEnvelopeSemantics,
  canonicalProtocolHash,
  type ExecutionCommandV1
} from "../../lib/facilitation-protocol";
import {
  assertAdapterManifest,
  assertAuthSummary,
  assertPreflightReceipt,
  assertThreadPage,
  type ForumAdapter,
  type ForumScope,
  type TargetRef,
  type ThreadRef
} from "../../lib/forum-adapters";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

export interface ForumAdapterConformanceFixture {
  adapter: ForumAdapter;
  scope: ForumScope;
  targetRef: (thread: ThreadRef) => TargetRef;
  mutateTarget: () => void;
  forbiddenForumText: string[];
  expectedTemporalEvidenceStatus?:
    | "as_of_verified"
    | "as_of_unverified"
    | "source_censored";
}

function assertRedacted(
  value: unknown,
  forbiddenForumText: string[]
): void {
  const serialized = JSON.stringify(value);
  for (const text of forbiddenForumText) {
    assert.equal(
      serialized.includes(text),
      false,
      `adapter 输出泄漏论坛字段：${text}`
    );
  }
  assert.equal(
    serialized.includes("secret-token-value"),
    false,
    "adapter 输出不得包含 token"
  );
}

function executionCommand(
  expectedTargetHash: string
): ExecutionCommandV1 {
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.executionCommand,
    commandId: "command:conformance",
    correlationId: "correlation:conformance",
    capability: "forum.execute_authorized",
    taskRefHash: HASH_A,
    reviewBundleHash: HASH_B,
    authorizationRefHash: HASH_A,
    idempotencyKey: HASH_B,
    budgetReservationRefHash: HASH_A,
    expectedTargetHash,
    contentHash: HASH_B,
    gatewayPolicyVersion: "gateway.test.v1",
    issuedAt: "2025-12-31T23:55:00.000Z",
    expiresAt: "2026-01-01T01:00:00.000Z",
    containsForumText: false
  };
}

export function defineForumAdapterConformanceSuite(
  name: string,
  fixtureFactory: () => ForumAdapterConformanceFixture
): void {
  describe(`${name} ForumAdapter conformance`, () => {
    test("manifest 与认证摘要明确写能力且不泄漏凭据", async () => {
      const fixture = fixtureFactory();
      const manifest = assertAdapterManifest(
        fixture.adapter.manifest()
      );
      const auth = assertAuthSummary(
        await fixture.adapter.inspectAuth()
      );
      assert.equal(manifest.containsForumText, false);
      assert.equal(auth.containsForumText, false);
      assert.equal(auth.adapterId, manifest.adapterId);
      assert.equal(auth.adapterVersion, manifest.adapterVersion);
      assert.equal(
        auth.canExecuteAuthorized &&
          !manifest.capabilities.executeAuthorized,
        false
      );
      if (manifest.externalWriteMode === "none") {
        assert.equal(auth.canExecuteAuthorized, false);
        assert.equal(manifest.capabilities.executeAuthorized, false);
      }
      assertRedacted(
        { manifest, auth },
        fixture.forbiddenForumText
      );
    });

    test("列表和观察输出只有稳定引用、时钟、计数与哈希", async () => {
      const fixture = fixtureFactory();
      const page = assertThreadPage(
        await fixture.adapter.listThreads(fixture.scope)
      );
      assert.ok(page.items.length > 0);
      assert.ok(
        page.items.length <= (fixture.scope.limit ?? 100)
      );
      assert.equal(page.adapterId, fixture.adapter.manifest().adapterId);
      assert.equal(
        page.adapterVersion,
        fixture.adapter.manifest().adapterVersion
      );
      assert.equal(page.courseKey, fixture.scope.courseKey);
      assert.equal(page.containsForumText, false);
      assert.equal(page.items[0].containsForumText, false);
      const observation = assertObservationEnvelopeSemantics(
        await fixture.adapter.observeThread(
          page.items[0].threadRef
        )
      );
      assert.equal(observation.containsForumText, false);
      assert.equal(
        observation.temporalEvidenceStatus,
        fixture.expectedTemporalEvidenceStatus ?? "as_of_verified"
      );
      assert.ok(
        Date.parse(observation.evidenceAsOf) <=
          Date.parse(observation.observedAt)
      );
      assert.ok(
        Date.parse(observation.sourceObservedThrough) <=
          Date.parse(observation.observedAt)
      );
      if (observation.temporalEvidenceStatus === "as_of_verified") {
        assert.ok(
          Date.parse(observation.sourceObservedThrough) >=
            Date.parse(observation.evidenceAsOf)
        );
      }
      assert.ok(observation.eventCount >= 1);
      assertRedacted(
        { page, observation },
        fixture.forbiddenForumText
      );
    });

    test("稳定目标绑定随目标版本变化，并拒绝不存在目标", async () => {
      const fixture = fixtureFactory();
      const page = assertThreadPage(
        await fixture.adapter.listThreads(fixture.scope)
      );
      const targetRef = fixture.targetRef(page.items[0].threadRef);
      const first = await fixture.adapter.bindTarget(targetRef);
      const firstHash = canonicalProtocolHash(
        first.schemaVersion,
        first
      );
      fixture.mutateTarget();
      if (
        fixture.adapter.manifest().externalWriteMode ===
        "synthetic_only"
      ) {
        const stale = assertPreflightReceipt(
          await fixture.adapter.preflight(
            executionCommand(firstHash)
          )
        );
        assert.equal(stale.status, "target_changed");
      }
      const second = await fixture.adapter.bindTarget(targetRef);
      assert.notEqual(
        second.targetVersionHash,
        first.targetVersionHash
      );
      assert.equal(first.stableTargetRef, second.stableTargetRef);
      assertRedacted(
        { first, second },
        fixture.forbiddenForumText
      );
      await assert.rejects(() =>
        fixture.adapter.bindTarget({
          ...targetRef,
          stableTargetRef: "missing:target"
        })
      );
    });

    test("只接受 listThreads 签发且未被篡改的完整 ThreadRef", async () => {
      const fixture = fixtureFactory();
      const page = assertThreadPage(
        await fixture.adapter.listThreads(fixture.scope)
      );
      const issued = page.items[0].threadRef;
      for (const tampered of [
        { ...issued, threadKey: "thread:tampered" },
        { ...issued, courseKey: "course:tampered" },
        {
          ...issued,
          platformCourseRef: "platform:tampered"
        },
        {
          ...issued,
          stableThreadRef: "thread:tampered-stable"
        },
        { ...issued, locator: `${issued.locator}?view=tampered` }
      ]) {
        await assert.rejects(() =>
          fixture.adapter.observeThread(tampered)
        );
      }
    });

    test("执行回执遵守 adapter 写模式并对幂等键稳定", async () => {
      const fixture = fixtureFactory();
      const page = assertThreadPage(
        await fixture.adapter.listThreads(fixture.scope)
      );
      const bound = await fixture.adapter.bindTarget(
        fixture.targetRef(page.items[0].threadRef)
      );
      const targetHash = canonicalProtocolHash(
        bound.schemaVersion,
        bound
      );
      const command = executionCommand(targetHash);
      const preflight = assertPreflightReceipt(
        await fixture.adapter.preflight(command)
      );
      assert.equal(preflight.commandId, command.commandId);
      assert.equal(
        preflight.expectedTargetHash,
        command.expectedTargetHash
      );
      assert.equal(
        preflight.adapterId,
        fixture.adapter.manifest().adapterId
      );
      assert.equal(
        preflight.adapterVersion,
        fixture.adapter.manifest().adapterVersion
      );
      const first = assertExecutionReceiptSemantics(
        await fixture.adapter.executeAuthorized(command)
      );
      const second = assertExecutionReceiptSemantics(
        await fixture.adapter.executeAuthorized(command)
      );
      assert.deepEqual(second, first);
      assert.equal(first.containsForumText, false);
      if (
        fixture.adapter.manifest().externalWriteMode ===
        "synthetic_only"
      ) {
        assert.equal(preflight.status, "ready");
        assert.equal(first.outcome, "verified_published");
        assert.notEqual(first.attemptedAt, null);
      } else {
        assert.equal(preflight.status, "denied");
        assert.equal(first.outcome, "confirmed_not_attempted");
        assert.equal(first.attemptedAt, null);
        assert.equal(first.remoteObjectRefHash, null);
      }
      assertRedacted(
        { preflight, first },
        fixture.forbiddenForumText
      );
    });

    test("cursor 绑定分页状态，伪造 cursor 和过期命令均 fail closed", async () => {
      const fixture = fixtureFactory();
      const firstPage = assertThreadPage(
        await fixture.adapter.listThreads(fixture.scope)
      );
      if (firstPage.nextCursor !== null) {
        const secondPage = assertThreadPage(
          await fixture.adapter.listThreads(
            fixture.scope,
            firstPage.nextCursor
          )
        );
        const firstRefs = new Set(
          firstPage.items.map(
            (item) => item.threadRef.stableThreadRef
          )
        );
        assert.equal(
          secondPage.items.some((item) =>
            firstRefs.has(item.threadRef.stableThreadRef)
          ),
          false
        );
      }
      await assert.rejects(() =>
        fixture.adapter.listThreads(
          fixture.scope,
          `${firstPage.nextCursor ?? "opaque:cursor"}:forged`
        )
      );
      const expired = {
        ...executionCommand(HASH_A),
        issuedAt: "2025-12-31T22:00:00.000Z",
        expiresAt: "2025-12-31T23:00:00.000Z"
      };
      const preflight = assertPreflightReceipt(
        await fixture.adapter.preflight(expired)
      );
      assert.equal(preflight.status, "command_expired");
      const receipt = assertExecutionReceiptSemantics(
        await fixture.adapter.executeAuthorized(expired)
      );
      assert.equal(receipt.outcome, "confirmed_not_attempted");
      assert.equal(receipt.attemptedAt, null);
    });
  });
}
