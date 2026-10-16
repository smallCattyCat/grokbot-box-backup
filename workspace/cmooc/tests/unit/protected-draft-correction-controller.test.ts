import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { hashTransientDraftBody } from "../../lib/live-runtime/draft-content";
import {
  consumeProtectedDraftCorrectionSession,
  openProtectedDraftCorrectionSession,
  ProtectedDraftCorrectionError,
  resetProtectedDraftCorrectionSessionsForTests
} from "../../lib/workbench/protected-draft-correction-controller";

const NOW = new Date("2026-08-13T12:00:00.000Z");
const BODY = "受保护草稿正文";
const binding = {
  taskId: "task-correction",
  runId: "run-correction",
  versionRef: "artifact-version:correction-v1",
  contentHash: createHash("sha256").update("content").digest("hex"),
  draftBodyHash: hashTransientDraftBody(BODY)
};

test("protected correction edit session is exact, process-local and one-shot", () => {
  resetProtectedDraftCorrectionSessionsForTests();
  const opened = openProtectedDraftCorrectionSession({
    ...binding,
    priorBody: BODY,
    now: NOW
  });
  assert.equal(Date.parse(opened.expiresAt) - NOW.getTime(), 5 * 60_000);
  assert.equal(JSON.stringify(opened).includes(BODY), false);
  assert.equal(
    consumeProtectedDraftCorrectionSession({ ...binding, now: NOW }).priorBody,
    BODY
  );
  assert.throws(
    () => consumeProtectedDraftCorrectionSession({ ...binding, now: NOW }),
    (error: unknown) =>
      error instanceof ProtectedDraftCorrectionError &&
      error.reason === "preview_or_edit_session_missing"
  );
});

test("protected correction edit session rejects tamper and expiry", () => {
  resetProtectedDraftCorrectionSessionsForTests();
  openProtectedDraftCorrectionSession({ ...binding, priorBody: BODY, now: NOW });
  assert.throws(
    () =>
      consumeProtectedDraftCorrectionSession({
        ...binding,
        contentHash: "f".repeat(64),
        now: NOW
      }),
    (error: unknown) =>
      error instanceof ProtectedDraftCorrectionError &&
      error.reason === "version_hash_changed"
  );
  openProtectedDraftCorrectionSession({ ...binding, priorBody: BODY, now: NOW });
  assert.throws(
    () =>
      consumeProtectedDraftCorrectionSession({
        ...binding,
        now: new Date(NOW.getTime() + 5 * 60_000 + 1)
      }),
    (error: unknown) =>
      error instanceof ProtectedDraftCorrectionError &&
      error.reason === "edit_session_expired"
  );
});

