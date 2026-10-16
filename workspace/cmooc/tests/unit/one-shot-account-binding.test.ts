import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { CmoocApiWriteToken } from "../../lib/forum/cmooc-api";
import {
  assertTransientExecutionTargetTokenInput,
  assertTransientExecutionTargetAccountBinding
} from "../../lib/autonomy/execution-target";
import {
  assertOneShotAccountWriteToken,
  compatibleAccountRolesForFacilitationFunction,
  filterExecutionAccountDescriptorsByFacilitationFunction,
  preserveOneShotOutcomeUnknownRootError
} from "../../lib/autonomy/one-shot-runner";
import {
  assertProductionAccountBinding,
  ProductionCommitError
} from "../../lib/autonomy/production-committer";
import { assertOutcomeAccountWriteToken } from "../../lib/autonomy/one-shot-outcome-reconciliation";

function hash(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function writeToken(): CmoocApiWriteToken {
  return {
    token: "opaque-token-marker",
    source: "partner_account",
    accountRefHash: hash("account"),
    credentialRefHash: hash("credential")
  };
}

test("explicit writeToken is accepted, legacy token is mutually exclusive, and refs remain exact", () => {
  const explicit = writeToken();
  assert.deepEqual(
    assertTransientExecutionTargetTokenInput({ writeToken: explicit }),
    explicit
  );
  assert.throws(
    () =>
      assertTransientExecutionTargetTokenInput({
        token: "legacy-token-marker",
        writeToken: explicit
      }),
    /^Error: EXECUTION_TARGET_TOKEN_INPUT_CONFLICT$/
  );
  assert.throws(
    () =>
      assertTransientExecutionTargetAccountBinding({
        writeToken: explicit,
        accountRefHash: hash("different-account"),
        credentialRefHash: explicit.credentialRefHash
      }),
    /^Error: EXECUTION_TARGET_ACCOUNT_BINDING_MISMATCH$/
  );
  assert.throws(
    () =>
      assertTransientExecutionTargetAccountBinding({
        writeToken: {
          ...explicit,
          source: "playwright_storage_state"
        },
        executionAccountLeaseId: hash("lease"),
        accountRefHash: explicit.accountRefHash,
        credentialRefHash: explicit.credentialRefHash
      }),
    /^Error: EXECUTION_TARGET_ACCOUNT_BINDING_MISMATCH$/
  );
});

test("production committer requires target, permit, and attempt account refs to match", () => {
  const refs = {
    executionAccountLeaseId: hash("lease"),
    executionAccountRefHash: hash("account"),
    credentialRefHash: hash("credential")
  };
  assert.doesNotThrow(() =>
    assertProductionAccountBinding({
      target: { ...refs, writeToken: writeToken() },
      permit: refs,
      attempt: { executionAccountRefHash: refs.executionAccountRefHash }
    })
  );
  assert.throws(
    () =>
      assertProductionAccountBinding({
        target: { ...refs, writeToken: writeToken() },
        permit: { ...refs, credentialRefHash: hash("other") },
        attempt: { executionAccountRefHash: refs.executionAccountRefHash }
      }),
    /^Error: PRODUCTION_COMMIT_ACCOUNT_BINDING_MISMATCH$/
  );
  assert.throws(
      () =>
        assertProductionAccountBinding({
        target: { ...refs, writeToken: writeToken() },
        permit: refs,
        attempt: { executionAccountRefHash: hash("other") }
      }),
    /^Error: PRODUCTION_COMMIT_ACCOUNT_BINDING_MISMATCH$/
  );
  assert.throws(
    () =>
      assertProductionAccountBinding({
        target: {
          ...refs,
          writeToken: {
            ...writeToken(),
            source: "env_satoken"
          }
        },
        permit: refs,
        attempt: { executionAccountRefHash: refs.executionAccountRefHash }
      }),
    /^Error: PRODUCTION_COMMIT_ACCOUNT_BINDING_MISMATCH$/
  );
});

test("runner and outcome resolver reject missing or swapped account credentials without fallback", () => {
  const explicit = writeToken();
  assert.doesNotThrow(() =>
    assertOneShotAccountWriteToken({
      writeToken: explicit,
      accountRefHash: explicit.accountRefHash!,
      credentialRefHash: explicit.credentialRefHash!
    })
  );
  assert.throws(
    () =>
      assertOneShotAccountWriteToken({
        writeToken: { ...explicit, accountRefHash: undefined },
        accountRefHash: explicit.accountRefHash!,
        credentialRefHash: explicit.credentialRefHash!
      }),
    /^Error: L3_EXECUTION_ACCOUNT_AUTH_BINDING_MISMATCH$/
  );
  assert.throws(
    () =>
      assertOneShotAccountWriteToken({
        writeToken: { ...explicit, source: "env_satoken" },
        accountRefHash: explicit.accountRefHash!,
        credentialRefHash: explicit.credentialRefHash!
      }),
    /^Error: L3_EXECUTION_ACCOUNT_AUTH_BINDING_MISMATCH$/
  );
  assert.throws(
    () =>
      assertOutcomeAccountWriteToken({
        writeToken: explicit,
        accountRefHash: explicit.accountRefHash!,
        credentialRefHash: hash("swapped")
      }),
    /^Error: L3_OUTCOME_ACCOUNT_AUTH_BINDING_MISMATCH$/
  );
});

test("facilitation function selects only compatible account roles", () => {
  assert.deepEqual(
    compatibleAccountRolesForFacilitationFunction("cognitive_conflict"),
    ["socratic_guide"]
  );
  assert.deepEqual(
    compatibleAccountRolesForFacilitationFunction("resource_connection"),
    ["evidence_connector", "community_host"]
  );
  assert.deepEqual(
    compatibleAccountRolesForFacilitationFunction("emotional_support"),
    ["reflection_coach", "community_host"]
  );
  assert.deepEqual(
    filterExecutionAccountDescriptorsByFacilitationFunction(
      [
        {
          accountRefHash: hash("socratic"),
          credentialRefHash: hash("socratic-credential"),
          roleKey: "socratic_guide",
          courseAliases: ["course"],
          dailyActionLimit: 5,
          cooldownMinutes: 0,
          disclosedAi: true,
          containsForumText: false
        },
        {
          accountRefHash: hash("reflection"),
          credentialRefHash: hash("reflection-credential"),
          roleKey: "reflection_coach",
          courseAliases: ["course"],
          dailyActionLimit: 5,
          cooldownMinutes: 0,
          disclosedAi: true,
          containsForumText: false
        }
      ],
      "cognitive_conflict"
    ).map((item) => item.roleKey),
    ["socratic_guide"]
  );
});

test("outcome_unknown remains the outer stable error across cleanup projection", () => {
  const unknown = new ProductionCommitError(
    "PRODUCTION_COMMIT_OUTCOME_UNKNOWN"
  );
  assert.equal(
    preserveOneShotOutcomeUnknownRootError(unknown),
    unknown
  );
  assert.equal(
    preserveOneShotOutcomeUnknownRootError(
      new Error("L3_EXECUTION_AUDIT_APPEND_FAILED")
    ),
    null
  );
});
