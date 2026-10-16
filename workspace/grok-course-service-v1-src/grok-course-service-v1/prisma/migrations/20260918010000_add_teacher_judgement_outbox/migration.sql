-- Append-only, body-free cross-store teacher judgement promotion events.
CREATE TABLE "CommunityTeacherJudgementOutbox" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "schemaVersion" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "judgementHash" TEXT NOT NULL,
    "judgementJson" TEXT NOT NULL,
    "courseAlias" TEXT NOT NULL,
    "browserCourseId" TEXT NOT NULL,
    "browserRunRef" TEXT NOT NULL,
    "invocationId" TEXT NOT NULL,
    "decisionKey" TEXT NOT NULL,
    "candidateKey" TEXT NOT NULL,
    "worldSnapshotId" TEXT NOT NULL,
    "graphSnapshotId" TEXT NOT NULL,
    "candidateSetId" TEXT NOT NULL,
    "asOfAt" DATETIME NOT NULL,
    "worldHash" TEXT NOT NULL,
    "graphHash" TEXT NOT NULL,
    "candidateSetHash" TEXT NOT NULL,
    "bindingHash" TEXT NOT NULL,
    "browserTapeRef" TEXT NOT NULL,
    "browserTapeHeadHash" TEXT NOT NULL,
    "browserRunRevision" INTEGER NOT NULL,
    "browserObservationHash" TEXT NOT NULL,
    "previousEventHash" TEXT,
    "eventHash" TEXT NOT NULL,
    "errorCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommunityTeacherJudgementOutbox_courseAlias_fkey"
        FOREIGN KEY ("courseAlias") REFERENCES "AutonomyCourseManifest" ("alias")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CommunityTeacherJudgementOutbox_invocationId_fkey"
        FOREIGN KEY ("invocationId") REFERENCES "ScheduledInvocation" ("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CommunityTeacherJudgementOutbox_schemaVersion_check"
        CHECK ("schemaVersion" = 'cmooc.community-teacher-judgement-outbox.v1'),
    CONSTRAINT "CommunityTeacherJudgementOutbox_sequence_check"
        CHECK ("sequence" >= 1),
    CONSTRAINT "CommunityTeacherJudgementOutbox_state_check"
        CHECK ("state" IN ('prepared', 'autonomy_appended', 'browser_mirrored', 'needs_review')),
    CONSTRAINT "CommunityTeacherJudgementOutbox_judgementJson_check"
        CHECK (length("judgementJson") > 0 AND length("judgementJson") <= 64000),
    CONSTRAINT "CommunityTeacherJudgementOutbox_browserRunRevision_check"
        CHECK ("browserRunRevision" >= 0)
);

CREATE UNIQUE INDEX "CommunityTeacherJudgementOutbox_operationKey_sequence_key"
ON "CommunityTeacherJudgementOutbox" ("operationKey", "sequence");

CREATE UNIQUE INDEX "CommunityTeacherJudgementOutbox_eventHash_key"
ON "CommunityTeacherJudgementOutbox" ("eventHash");

CREATE INDEX "CommunityTeacherJudgementOutbox_state_createdAt_idx"
ON "CommunityTeacherJudgementOutbox" ("state", "createdAt");

CREATE INDEX "CommunityTeacherJudgementOutbox_browserRunRef_operationKey_idx"
ON "CommunityTeacherJudgementOutbox" ("browserRunRef", "operationKey");

CREATE INDEX "CommunityTeacherJudgementOutbox_judgementHash_idx"
ON "CommunityTeacherJudgementOutbox" ("judgementHash");

CREATE INDEX "CommunityTeacherJudgementOutbox_invocationId_decisionKey_idx"
ON "CommunityTeacherJudgementOutbox" ("invocationId", "decisionKey");

CREATE TRIGGER "CommunityTeacherJudgementOutbox_immutable_update"
BEFORE UPDATE ON "CommunityTeacherJudgementOutbox"
BEGIN
    SELECT RAISE(ABORT, 'CommunityTeacherJudgementOutbox is append-only: UPDATE is forbidden');
END;

CREATE TRIGGER "CommunityTeacherJudgementOutbox_immutable_delete"
BEFORE DELETE ON "CommunityTeacherJudgementOutbox"
BEGIN
    SELECT RAISE(ABORT, 'CommunityTeacherJudgementOutbox is append-only: DELETE is forbidden');
END;
