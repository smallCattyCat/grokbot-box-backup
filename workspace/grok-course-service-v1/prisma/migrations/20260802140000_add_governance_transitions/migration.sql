CREATE TABLE "CourseOperationGovernanceTransition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "schemaVersion" TEXT NOT NULL,
    "courseAlias" TEXT NOT NULL,
    "transitionKey" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromGovernanceHash" TEXT NOT NULL,
    "toGovernanceHash" TEXT NOT NULL,
    "expectedManifestHash" TEXT NOT NULL,
    "effectiveAt" DATETIME NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "eventHash" TEXT NOT NULL,
    "containsForumText" BOOLEAN NOT NULL DEFAULT false
        CHECK ("containsForumText" = false),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CourseOperationGovernanceTransition_fromGovernanceHash_fkey"
        FOREIGN KEY ("fromGovernanceHash")
        REFERENCES "CourseOperationGovernancePolicy" ("governanceHash")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CourseOperationGovernanceTransition_toGovernanceHash_fkey"
        FOREIGN KEY ("toGovernanceHash")
        REFERENCES "CourseOperationGovernancePolicy" ("governanceHash")
        ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "CourseOperationGovernanceTransition_fromGovernanceHash_key"
ON "CourseOperationGovernanceTransition"("fromGovernanceHash");

CREATE UNIQUE INDEX "CourseOperationGovernanceTransition_toGovernanceHash_key"
ON "CourseOperationGovernanceTransition"("toGovernanceHash");

CREATE UNIQUE INDEX "CourseOperationGovernanceTransition_eventHash_key"
ON "CourseOperationGovernanceTransition"("eventHash");

CREATE UNIQUE INDEX "CourseOperationGovernanceTransition_courseAlias_transitionKey_key"
ON "CourseOperationGovernanceTransition"("courseAlias", "transitionKey");

CREATE INDEX "CourseOperationGovernanceTransition_courseAlias_createdAt_idx"
ON "CourseOperationGovernanceTransition"("courseAlias", "createdAt");

CREATE INDEX "CourseOperationGovernanceTransition_courseAlias_effectiveAt_idx"
ON "CourseOperationGovernanceTransition"("courseAlias", "effectiveAt");

CREATE TRIGGER "CourseOperationGovernanceTransition_immutable_update"
BEFORE UPDATE ON "CourseOperationGovernanceTransition"
BEGIN
    SELECT RAISE(ABORT, 'CourseOperationGovernanceTransition is append-only: UPDATE is forbidden');
END;

CREATE TRIGGER "CourseOperationGovernanceTransition_immutable_delete"
BEFORE DELETE ON "CourseOperationGovernanceTransition"
BEGIN
    SELECT RAISE(ABORT, 'CourseOperationGovernanceTransition is append-only: DELETE is forbidden');
END;
