import assert from "node:assert/strict";
import test from "node:test";
import { ProductionCommitError } from "../../lib/autonomy/production-committer";
import { projectL3CliErrorCode } from "../../lib/autonomy/l3-cli-error";

test("projects mechanical budget and execution gate failures safely", () => {
  assert.equal(
    projectL3CliErrorCode(new Error("BUDGET_AUTHOR_TOUCH_LIMIT_EXCEEDED")),
    "BUDGET_AUTHOR_TOUCH_LIMIT_EXCEEDED"
  );
  assert.equal(
    projectL3CliErrorCode({ code: "BUDGET_PERMIT_NOT_FOUND" }),
    "BUDGET_PERMIT_NOT_FOUND"
  );
  assert.equal(
    projectL3CliErrorCode(new Error("EXECUTION_PERMIT_NOT_FOUND")),
    "EXECUTION_PERMIT_NOT_FOUND"
  );
  assert.equal(
    projectL3CliErrorCode(
      new Error(
        "EXECUTION_POLICY_INVALID:token=secret https://unsafe.invalid/private"
      )
    ),
    "EXECUTION_POLICY_INVALID"
  );
});

test("preserves the existing allowlist and ProductionCommitError semantics", () => {
  for (const code of [
    "L3_STAGE_PUBLISH_FAILED",
    "CMOOC_QUILL_STAGE_BROWSER_NAVIGATION_FAILED",
    "STAGE_COMPANION_PAGE_GUARD_MISMATCH",
    "EXECUTION_STAGE_RECEIPT_INVALID"
  ]) {
    assert.equal(projectL3CliErrorCode(new Error(code)), code);
  }
  for (const code of [
    "PRODUCTION_COMMIT_REPLAY_BLOCKED",
    "PRODUCTION_COMMIT_ABORTED_BEFORE_SEND",
    "PRODUCTION_COMMIT_OUTCOME_UNKNOWN"
  ] as const) {
    assert.equal(projectL3CliErrorCode(new ProductionCommitError(code)), code);
  }
});

test("rejects raw sensitive pseudo-codes and malformed execution details", () => {
  const fallback = "L3_COMMAND_FAILED";
  for (const error of [
    new Error("BUDGET_AUTHOR_TOUCH_LIMIT_EXCEEDED:https://unsafe.invalid"),
    new Error("BUDGET_AUTHOR_TOUCH_LIMIT_EXCEEDED:/private/token"),
    new Error("BUDGET_token_secret"),
    new Error("BUDGET_FORUM正文"),
    new Error("BUDGET_AUTHOR_TOUCH_LIMIT_EXCEEDED\n"),
    new Error(" BUDGET_AUTHOR_TOUCH_LIMIT_EXCEEDED"),
    new Error("BUDGET_AUTHOR_TOUCH_LIMIT_EXCEEDED "),
    new Error(`BUDGET_${"A".repeat(101)}`),
    new Error("EXECUTION_POLICY_INVALID https://unsafe.invalid"),
    new Error(`EXECUTION_POLICY_INVALID${"A".repeat(101)}`),
    { code: "EXECUTION_POLICY_INVALID:private detail" },
    { code: "BUDGET_AUTHOR_TOUCH_LIMIT_EXCEEDED https://unsafe.invalid" },
    { code: "BUDGET_" },
    { code: "execution_permit_not_found" },
    { code: "BUDGET_TOKEN=secret" }
  ]) {
    assert.equal(projectL3CliErrorCode(error), fallback);
  }
});

test("hostile code, message, and prototype access collapse safely", () => {
  const fallback = "L3_COMMAND_FAILED";
  const throwingGetter = {} as { code?: unknown; message?: unknown };
  Object.defineProperty(throwingGetter, "code", {
    get() {
      throw new Error("token=secret");
    }
  });
  Object.defineProperty(throwingGetter, "message", {
    get() {
      throw new Error("https://unsafe.invalid");
    }
  });
  assert.equal(projectL3CliErrorCode(throwingGetter), fallback);

  const hostileProxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error("/private/path");
      },
      get() {
        throw new Error("token=secret");
      }
    }
  );
  assert.equal(projectL3CliErrorCode(hostileProxy), fallback);
});
