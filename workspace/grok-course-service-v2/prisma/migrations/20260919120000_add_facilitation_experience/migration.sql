-- Persist the cMOOC experience loop as four append-only streams.  These
-- records are body-free canonical contracts and never replace the Course
-- Event World, CandidateSet, Decision Tape, or external execution ledger.

CREATE TABLE "FacilitationExperienceObservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "schemaVersion" TEXT NOT NULL,
    "observationKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "courseAlias" TEXT NOT NULL,
    "invocationId" TEXT NOT NULL,
    "worldSnapshotId" TEXT NOT NULL,
    "graphSnapshotId" TEXT NOT NULL,
    "candidateSetId" TEXT NOT NULL,
    "asOfAt" DATETIME NOT NULL,
    "worldHash" TEXT NOT NULL,
    "graphHash" TEXT NOT NULL,
    "candidateSetHash" TEXT NOT NULL,
    "sourceAnchorHash" TEXT NOT NULL,
    "sourceAnchorJson" TEXT NOT NULL,
    "sourceObservationHashesJson" TEXT NOT NULL,
    "observationJson" TEXT NOT NULL,
    "observationHash" TEXT NOT NULL,
    "observedAt" DATETIME NOT NULL,
    "recordedAt" DATETIME NOT NULL,
    "operationKeyHash" TEXT NOT NULL,
    "containsForumText" BOOLEAN NOT NULL DEFAULT false,
    "containsDirectIdentity" BOOLEAN NOT NULL DEFAULT false,
    "assertsCausality" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FacilitationExperienceObservation_courseAlias_fkey"
        FOREIGN KEY ("courseAlias") REFERENCES "AutonomyCourseManifest" ("alias")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "FacilitationExperienceObservation_invocationId_fkey"
        FOREIGN KEY ("invocationId") REFERENCES "ScheduledInvocation" ("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "FacilitationExperienceObservation_worldSnapshotId_fkey"
        FOREIGN KEY ("worldSnapshotId") REFERENCES "CourseWorldSnapshot" ("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "FacilitationExperienceObservation_graphSnapshotId_fkey"
        FOREIGN KEY ("graphSnapshotId") REFERENCES "CourseContentGraphSnapshot" ("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "FacilitationExperienceObservation_candidateSetId_fkey"
        FOREIGN KEY ("candidateSetId") REFERENCES "CandidateSet" ("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "FacilitationExperienceObservation_version_check"
        CHECK ("version" >= 1),
    CONSTRAINT "FacilitationExperienceObservation_json_check"
        CHECK (length("sourceAnchorJson") > 0 AND length("sourceObservationHashesJson") > 0 AND length("observationJson") > 0),
    CONSTRAINT "FacilitationExperienceObservation_containsForumText_check"
        CHECK ("containsForumText" = false),
    CONSTRAINT "FacilitationExperienceObservation_containsDirectIdentity_check"
        CHECK ("containsDirectIdentity" = false),
    CONSTRAINT "FacilitationExperienceObservation_assertsCausality_check"
        CHECK ("assertsCausality" = false)
);

CREATE UNIQUE INDEX "FacilitationExperienceObservation_observationHash_key"
ON "FacilitationExperienceObservation" ("observationHash");

CREATE UNIQUE INDEX "FacilitationExperienceObservation_operationKeyHash_key"
ON "FacilitationExperienceObservation" ("operationKeyHash");

CREATE UNIQUE INDEX "FacilitationExperienceObservation_observationKey_version_key"
ON "FacilitationExperienceObservation" ("observationKey", "version");

CREATE INDEX "FacilitationExperienceObservation_courseAlias_observedAt_idx"
ON "FacilitationExperienceObservation" ("courseAlias", "observedAt");

CREATE INDEX "FacilitationExperienceObservation_courseAlias_sourceAnchorHash_idx"
ON "FacilitationExperienceObservation" ("courseAlias", "sourceAnchorHash");

CREATE INDEX "FacilitationExperienceObservation_invocationId_asOfAt_idx"
ON "FacilitationExperienceObservation" ("invocationId", "asOfAt");

CREATE TRIGGER "FacilitationExperienceObservation_immutable_update"
BEFORE UPDATE ON "FacilitationExperienceObservation"
BEGIN
    SELECT RAISE(ABORT, 'FacilitationExperienceObservation is append-only: UPDATE is forbidden');
END;

CREATE TRIGGER "FacilitationExperienceObservation_immutable_delete"
BEFORE DELETE ON "FacilitationExperienceObservation"
BEGIN
    SELECT RAISE(ABORT, 'FacilitationExperienceObservation is append-only: DELETE is forbidden');
END;

CREATE TABLE "FacilitationLessonRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "schemaVersion" TEXT NOT NULL,
    "lessonKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "courseAlias" TEXT NOT NULL,
    "lessonJson" TEXT NOT NULL,
    "lessonHash" TEXT NOT NULL,
    "sourceObservationHashesJson" TEXT NOT NULL,
    "recordedAt" DATETIME NOT NULL,
    "validFrom" DATETIME,
    "validThrough" DATETIME,
    "supersedesLessonKey" TEXT,
    "supersedesVersion" INTEGER,
    "supersedesLessonHash" TEXT,
    "operationKeyHash" TEXT NOT NULL,
    "containsForumText" BOOLEAN NOT NULL DEFAULT false,
    "containsDirectIdentity" BOOLEAN NOT NULL DEFAULT false,
    "assertsCausality" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FacilitationLessonRevision_courseAlias_fkey"
        FOREIGN KEY ("courseAlias") REFERENCES "AutonomyCourseManifest" ("alias")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "FacilitationLessonRevision_version_check"
        CHECK ("version" >= 1),
    CONSTRAINT "FacilitationLessonRevision_status_check"
        CHECK ("status" IN ('candidate', 'approved', 'rejected', 'retracted', 'superseded', 'active', 'branch')),
    CONSTRAINT "FacilitationLessonRevision_json_check"
        CHECK (length("lessonJson") > 0 AND length("sourceObservationHashesJson") > 0),
    CONSTRAINT "FacilitationLessonRevision_containsForumText_check"
        CHECK ("containsForumText" = false),
    CONSTRAINT "FacilitationLessonRevision_containsDirectIdentity_check"
        CHECK ("containsDirectIdentity" = false),
    CONSTRAINT "FacilitationLessonRevision_assertsCausality_check"
        CHECK ("assertsCausality" = false),
    CONSTRAINT "FacilitationLessonRevision_supersedes_pair_check"
        CHECK (("supersedesLessonKey" IS NULL AND "supersedesVersion" IS NULL AND "supersedesLessonHash" IS NULL)
            OR ("supersedesLessonKey" IS NOT NULL AND "supersedesVersion" IS NOT NULL AND "supersedesLessonHash" IS NOT NULL))
);

CREATE UNIQUE INDEX "FacilitationLessonRevision_lessonHash_key"
ON "FacilitationLessonRevision" ("lessonHash");

CREATE UNIQUE INDEX "FacilitationLessonRevision_operationKeyHash_key"
ON "FacilitationLessonRevision" ("operationKeyHash");

CREATE UNIQUE INDEX "FacilitationLessonRevision_lessonKey_version_key"
ON "FacilitationLessonRevision" ("lessonKey", "version");

CREATE INDEX "FacilitationLessonRevision_courseAlias_lessonKey_version_idx"
ON "FacilitationLessonRevision" ("courseAlias", "lessonKey", "version");

CREATE INDEX "FacilitationLessonRevision_courseAlias_status_recordedAt_idx"
ON "FacilitationLessonRevision" ("courseAlias", "status", "recordedAt");

CREATE INDEX "FacilitationLessonRevision_lessonHash_version_idx"
ON "FacilitationLessonRevision" ("lessonHash", "version");

CREATE TRIGGER "FacilitationLessonRevision_immutable_update"
BEFORE UPDATE ON "FacilitationLessonRevision"
BEGIN
    SELECT RAISE(ABORT, 'FacilitationLessonRevision is append-only: UPDATE is forbidden');
END;

CREATE TRIGGER "FacilitationLessonRevision_immutable_delete"
BEFORE DELETE ON "FacilitationLessonRevision"
BEGIN
    SELECT RAISE(ABORT, 'FacilitationLessonRevision is append-only: DELETE is forbidden');
END;

CREATE TABLE "FacilitationLessonReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lessonRevisionId" TEXT NOT NULL,
    "courseAlias" TEXT NOT NULL,
    "lessonKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "lessonHash" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "reviewerRole" TEXT NOT NULL,
    "reviewerRefHash" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "previousReviewHash" TEXT,
    "reviewHash" TEXT NOT NULL,
    "operationKeyHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "containsForumText" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "FacilitationLessonReview_lessonRevisionId_fkey"
        FOREIGN KEY ("lessonRevisionId") REFERENCES "FacilitationLessonRevision" ("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "FacilitationLessonReview_version_check"
        CHECK ("version" >= 1),
    CONSTRAINT "FacilitationLessonReview_sequence_check"
        CHECK ("sequence" >= 1),
    CONSTRAINT "FacilitationLessonReview_action_check"
        CHECK ("action" IN ('approved', 'rejected', 'retracted')),
    CONSTRAINT "FacilitationLessonReview_reviewerRole_check"
        CHECK ("reviewerRole" IN ('course_owner', 'teacher')),
    CONSTRAINT "FacilitationLessonReview_containsForumText_check"
        CHECK ("containsForumText" = false)
);

CREATE UNIQUE INDEX "FacilitationLessonReview_reviewHash_key"
ON "FacilitationLessonReview" ("reviewHash");

CREATE UNIQUE INDEX "FacilitationLessonReview_operationKeyHash_key"
ON "FacilitationLessonReview" ("operationKeyHash");

CREATE UNIQUE INDEX "FacilitationLessonReview_lessonRevisionId_sequence_key"
ON "FacilitationLessonReview" ("lessonRevisionId", "sequence");

CREATE INDEX "FacilitationLessonReview_courseAlias_lessonKey_version_sequence_idx"
ON "FacilitationLessonReview" ("courseAlias", "lessonKey", "version", "sequence");

CREATE INDEX "FacilitationLessonReview_lessonHash_action_createdAt_idx"
ON "FacilitationLessonReview" ("lessonHash", "action", "createdAt");

CREATE TRIGGER "FacilitationLessonReview_immutable_update"
BEFORE UPDATE ON "FacilitationLessonReview"
BEGIN
    SELECT RAISE(ABORT, 'FacilitationLessonReview is append-only: UPDATE is forbidden');
END;

CREATE TRIGGER "FacilitationLessonReview_immutable_delete"
BEFORE DELETE ON "FacilitationLessonReview"
BEGIN
    SELECT RAISE(ABORT, 'FacilitationLessonReview is append-only: DELETE is forbidden');
END;

CREATE TABLE "FacilitationLessonApplication" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "schemaVersion" TEXT NOT NULL,
    "applicationKey" TEXT NOT NULL,
    "courseAlias" TEXT NOT NULL,
    "lessonHash" TEXT NOT NULL,
    "targetInvocationId" TEXT,
    "targetWorldSnapshotId" TEXT,
    "targetGraphSnapshotId" TEXT,
    "targetCandidateSetId" TEXT,
    "targetAsOfAt" DATETIME NOT NULL,
    "targetAnchorHash" TEXT NOT NULL,
    "targetAnchorJson" TEXT NOT NULL,
    "sourceObservationHashesJson" TEXT NOT NULL,
    "applicationJson" TEXT NOT NULL,
    "applicationHash" TEXT NOT NULL,
    "disposition" TEXT NOT NULL,
    "changedFieldsJson" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "decisionJson" TEXT NOT NULL,
    "recordedAt" DATETIME NOT NULL,
    "operationKeyHash" TEXT NOT NULL,
    "containsForumText" BOOLEAN NOT NULL DEFAULT false,
    "containsDirectIdentity" BOOLEAN NOT NULL DEFAULT false,
    "assertsCausality" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FacilitationLessonApplication_courseAlias_fkey"
        FOREIGN KEY ("courseAlias") REFERENCES "AutonomyCourseManifest" ("alias")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "FacilitationLessonApplication_lessonHash_fkey"
        FOREIGN KEY ("lessonHash") REFERENCES "FacilitationLessonRevision" ("lessonHash")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "FacilitationLessonApplication_targetInvocationId_fkey"
        FOREIGN KEY ("targetInvocationId") REFERENCES "ScheduledInvocation" ("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "FacilitationLessonApplication_targetWorldSnapshotId_fkey"
        FOREIGN KEY ("targetWorldSnapshotId") REFERENCES "CourseWorldSnapshot" ("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "FacilitationLessonApplication_targetGraphSnapshotId_fkey"
        FOREIGN KEY ("targetGraphSnapshotId") REFERENCES "CourseContentGraphSnapshot" ("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "FacilitationLessonApplication_targetCandidateSetId_fkey"
        FOREIGN KEY ("targetCandidateSetId") REFERENCES "CandidateSet" ("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "FacilitationLessonApplication_json_check"
        CHECK (length("targetAnchorJson") > 0 AND length("sourceObservationHashesJson") > 0 AND length("applicationJson") > 0 AND length("decisionJson") > 0),
    CONSTRAINT "FacilitationLessonApplication_containsForumText_check"
        CHECK ("containsForumText" = false),
    CONSTRAINT "FacilitationLessonApplication_containsDirectIdentity_check"
        CHECK ("containsDirectIdentity" = false),
    CONSTRAINT "FacilitationLessonApplication_assertsCausality_check"
        CHECK ("assertsCausality" = false)
);

CREATE UNIQUE INDEX "FacilitationLessonApplication_applicationHash_key"
ON "FacilitationLessonApplication" ("applicationHash");

CREATE UNIQUE INDEX "FacilitationLessonApplication_operationKeyHash_key"
ON "FacilitationLessonApplication" ("operationKeyHash");

CREATE INDEX "FacilitationLessonApplication_courseAlias_targetAsOfAt_idx"
ON "FacilitationLessonApplication" ("courseAlias", "targetAsOfAt");

CREATE INDEX "FacilitationLessonApplication_courseAlias_lessonHash_idx"
ON "FacilitationLessonApplication" ("courseAlias", "lessonHash");

CREATE INDEX "FacilitationLessonApplication_applicationKey_targetAsOfAt_idx"
ON "FacilitationLessonApplication" ("applicationKey", "targetAsOfAt");

CREATE TRIGGER "FacilitationLessonApplication_immutable_update"
BEFORE UPDATE ON "FacilitationLessonApplication"
BEGIN
    SELECT RAISE(ABORT, 'FacilitationLessonApplication is append-only: UPDATE is forbidden');
END;

CREATE TRIGGER "FacilitationLessonApplication_immutable_delete"
BEFORE DELETE ON "FacilitationLessonApplication"
BEGIN
    SELECT RAISE(ABORT, 'FacilitationLessonApplication is append-only: DELETE is forbidden');
END;
