-- Persist only the canonical, body-free CommunityInquiryMemoryV1 contract.
-- This table is a read-model registry: it never replaces CourseEvent,
-- CourseWorldSnapshot, CourseContentGraphSnapshot, CandidateSet or DecisionTape.
CREATE TABLE "CommunityInquiryMemoryRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "schemaVersion" TEXT NOT NULL,
    "memoryKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "courseAlias" TEXT NOT NULL,
    "invocationId" TEXT NOT NULL,
    "worldSnapshotId" TEXT NOT NULL,
    "graphSnapshotId" TEXT NOT NULL,
    "candidateSetId" TEXT NOT NULL,
    "asOfAt" DATETIME NOT NULL,
    "worldHash" TEXT NOT NULL,
    "graphHash" TEXT NOT NULL,
    "candidateSetHash" TEXT NOT NULL,
    "memoryJson" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "recordedAt" DATETIME NOT NULL,
    "validFrom" DATETIME,
    "validThrough" DATETIME,
    "supersedesMemoryKey" TEXT,
    "supersedesVersion" INTEGER,
    "supersedesContentHash" TEXT,
    "containsForumText" BOOLEAN NOT NULL DEFAULT false,
    "containsDirectIdentity" BOOLEAN NOT NULL DEFAULT false,
    "assertsCausality" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommunityInquiryMemoryRevision_courseAlias_fkey"
        FOREIGN KEY ("courseAlias") REFERENCES "AutonomyCourseManifest" ("alias")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CommunityInquiryMemoryRevision_invocationId_fkey"
        FOREIGN KEY ("invocationId") REFERENCES "ScheduledInvocation" ("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CommunityInquiryMemoryRevision_worldSnapshotId_fkey"
        FOREIGN KEY ("worldSnapshotId") REFERENCES "CourseWorldSnapshot" ("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CommunityInquiryMemoryRevision_graphSnapshotId_fkey"
        FOREIGN KEY ("graphSnapshotId") REFERENCES "CourseContentGraphSnapshot" ("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CommunityInquiryMemoryRevision_candidateSetId_fkey"
        FOREIGN KEY ("candidateSetId") REFERENCES "CandidateSet" ("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CommunityInquiryMemoryRevision_schemaVersion_check"
        CHECK ("schemaVersion" = 'cmooc.community-inquiry-memory.v1'),
    CONSTRAINT "CommunityInquiryMemoryRevision_version_check"
        CHECK ("version" >= 1),
    CONSTRAINT "CommunityInquiryMemoryRevision_status_check"
        CHECK ("status" IN ('candidate', 'active', 'disputed', 'retracted', 'superseded')),
    CONSTRAINT "CommunityInquiryMemoryRevision_memoryJson_check"
        CHECK (length("memoryJson") > 0),
    CONSTRAINT "CommunityInquiryMemoryRevision_containsForumText_check"
        CHECK ("containsForumText" = false),
    CONSTRAINT "CommunityInquiryMemoryRevision_containsDirectIdentity_check"
        CHECK ("containsDirectIdentity" = false),
    CONSTRAINT "CommunityInquiryMemoryRevision_assertsCausality_check"
        CHECK ("assertsCausality" = false)
);

CREATE UNIQUE INDEX "CommunityInquiryMemoryRevision_contentHash_key"
ON "CommunityInquiryMemoryRevision" ("contentHash");

CREATE UNIQUE INDEX "CommunityInquiryMemoryRevision_memoryKey_version_key"
ON "CommunityInquiryMemoryRevision" ("memoryKey", "version");

CREATE INDEX "CommunityInquiryMemoryRevision_courseAlias_memoryKey_version_idx"
ON "CommunityInquiryMemoryRevision" ("courseAlias", "memoryKey", "version");

CREATE INDEX "CommunityInquiryMemoryRevision_candidateSetId_asOfAt_idx"
ON "CommunityInquiryMemoryRevision" ("candidateSetId", "asOfAt");

CREATE INDEX "CommunityInquiryMemoryRevision_invocationId_idx"
ON "CommunityInquiryMemoryRevision" ("invocationId");

CREATE INDEX "CommunityInquiryMemoryRevision_status_createdAt_idx"
ON "CommunityInquiryMemoryRevision" ("status", "createdAt");

CREATE TRIGGER "CommunityInquiryMemoryRevision_immutable_update"
BEFORE UPDATE ON "CommunityInquiryMemoryRevision"
BEGIN
    SELECT RAISE(ABORT, 'CommunityInquiryMemoryRevision is append-only: UPDATE is forbidden');
END;

CREATE TRIGGER "CommunityInquiryMemoryRevision_immutable_delete"
BEFORE DELETE ON "CommunityInquiryMemoryRevision"
BEGIN
    SELECT RAISE(ABORT, 'CommunityInquiryMemoryRevision is append-only: DELETE is forbidden');
END;

CREATE TABLE "CommunityInquiryMemoryReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "memoryRevisionId" TEXT NOT NULL,
    "courseAlias" TEXT NOT NULL,
    "memoryKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "reviewerRole" TEXT NOT NULL,
    "reviewerRefHash" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "previousReviewHash" TEXT,
    "reviewHash" TEXT NOT NULL,
    "idempotencyKeyHash" TEXT NOT NULL,
    "containsForumText" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommunityInquiryMemoryReview_memoryRevisionId_fkey"
        FOREIGN KEY ("memoryRevisionId") REFERENCES "CommunityInquiryMemoryRevision" ("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CommunityInquiryMemoryReview_version_check"
        CHECK ("version" >= 1),
    CONSTRAINT "CommunityInquiryMemoryReview_sequence_check"
        CHECK ("sequence" >= 1),
    CONSTRAINT "CommunityInquiryMemoryReview_action_check"
        CHECK ("action" IN ('approved', 'rejected', 'disputed', 'retracted')),
    CONSTRAINT "CommunityInquiryMemoryReview_reviewerRole_check"
        CHECK ("reviewerRole" IN ('course_owner', 'teacher')),
    CONSTRAINT "CommunityInquiryMemoryReview_containsForumText_check"
        CHECK ("containsForumText" = false)
);

CREATE UNIQUE INDEX "CommunityInquiryMemoryReview_reviewHash_key"
ON "CommunityInquiryMemoryReview" ("reviewHash");

CREATE UNIQUE INDEX "CommunityInquiryMemoryReview_idempotencyKeyHash_key"
ON "CommunityInquiryMemoryReview" ("idempotencyKeyHash");

CREATE UNIQUE INDEX "CommunityInquiryMemoryReview_memoryRevisionId_sequence_key"
ON "CommunityInquiryMemoryReview" ("memoryRevisionId", "sequence");

CREATE INDEX "CommunityInquiryMemoryReview_memoryKey_version_sequence_idx"
ON "CommunityInquiryMemoryReview" ("memoryKey", "version", "sequence");

CREATE INDEX "CommunityInquiryMemoryReview_contentHash_action_idx"
ON "CommunityInquiryMemoryReview" ("contentHash", "action");

CREATE TRIGGER "CommunityInquiryMemoryReview_immutable_update"
BEFORE UPDATE ON "CommunityInquiryMemoryReview"
BEGIN
    SELECT RAISE(ABORT, 'CommunityInquiryMemoryReview is append-only: UPDATE is forbidden');
END;

CREATE TRIGGER "CommunityInquiryMemoryReview_immutable_delete"
BEFORE DELETE ON "CommunityInquiryMemoryReview"
BEGIN
    SELECT RAISE(ABORT, 'CommunityInquiryMemoryReview is append-only: DELETE is forbidden');
END;
