CREATE TABLE "WorkbenchArtifactSelectionRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "versionRef" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "draftBodyHash" TEXT,
    "verificationId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "selectionHash" TEXT NOT NULL,
    "selectedAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkbenchArtifactSelectionRecord_taskId_fkey"
      FOREIGN KEY ("taskId") REFERENCES "WorkbenchTask" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkbenchArtifactSelection_shape_check" CHECK (
      "generation" >= 1 AND "version" >= 1 AND
      length("contentHash") = 64 AND "contentHash" NOT GLOB '*[^a-f0-9]*' AND
      ("draftBodyHash" IS NULL OR
        (length("draftBodyHash") = 64 AND "draftBodyHash" NOT GLOB '*[^a-f0-9]*')) AND
      length("selectionHash") = 64 AND "selectionHash" NOT GLOB '*[^a-f0-9]*' AND
      "versionRef" = 'artifact-version:' || "versionId"
    )
);

CREATE UNIQUE INDEX "WorkbenchArtifactSelectionRecord_taskId_artifactId_key"
  ON "WorkbenchArtifactSelectionRecord"("taskId", "artifactId");
CREATE INDEX "WorkbenchArtifactSelectionRecord_versionId_idx"
  ON "WorkbenchArtifactSelectionRecord"("versionId");
CREATE INDEX "WorkbenchArtifactSelectionRecord_verificationId_idx"
  ON "WorkbenchArtifactSelectionRecord"("verificationId");
CREATE INDEX "WorkbenchArtifactSelectionRecord_runId_selectedAt_idx"
  ON "WorkbenchArtifactSelectionRecord"("runId", "selectedAt");
CREATE INDEX "WorkbenchArtifactSelectionRecord_selectionHash_idx"
  ON "WorkbenchArtifactSelectionRecord"("selectionHash");

CREATE TRIGGER "WorkbenchArtifactSelection_insert_binding"
BEFORE INSERT ON "WorkbenchArtifactSelectionRecord"
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM "WorkbenchArtifactVersionRecord" AS artifact
    WHERE artifact."id" = NEW."versionId"
      AND artifact."taskId" = NEW."taskId"
      AND artifact."runId" = NEW."runId"
      AND artifact."artifactId" = NEW."artifactId"
      AND artifact."version" = NEW."version"
      AND 'artifact-version:' || artifact."id" = NEW."versionRef"
      AND artifact."contentHash" = NEW."contentHash"
      AND artifact."draftBodyHash" IS NEW."draftBodyHash"
  ) THEN RAISE(ABORT, 'WORKBENCH_ARTIFACT_SELECTION_VERSION_BINDING_INVALID') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM "WorkbenchVerificationRecord" AS verification
    WHERE verification."id" = NEW."verificationId"
      AND verification."taskId" = NEW."taskId"
      AND verification."runId" = NEW."runId"
      AND verification."subjectType" = 'artifact_version'
      AND verification."subjectId" = NEW."versionId"
      AND verification."status" = 'passed'
      AND verification."containsForumText" = 0
      AND verification."containsIdentity" = 0
      AND verification."observedAt" <= NEW."selectedAt"
      AND (verification."expiresAt" IS NULL OR verification."expiresAt" > NEW."selectedAt")
  ) THEN RAISE(ABORT, 'WORKBENCH_ARTIFACT_SELECTION_VERIFICATION_INVALID') END;
END;

CREATE TRIGGER "WorkbenchArtifactSelection_update_binding"
BEFORE UPDATE ON "WorkbenchArtifactSelectionRecord"
BEGIN
  SELECT CASE WHEN
    NEW."id" <> OLD."id" OR NEW."taskId" <> OLD."taskId" OR
    NEW."artifactId" <> OLD."artifactId" OR
    NEW."generation" <> OLD."generation" + 1 OR
    NEW."version" <= OLD."version"
  THEN RAISE(ABORT, 'WORKBENCH_ARTIFACT_SELECTION_CAS_INVALID') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM "WorkbenchArtifactVersionRecord" AS artifact
    WHERE artifact."id" = NEW."versionId"
      AND artifact."taskId" = NEW."taskId"
      AND artifact."runId" = NEW."runId"
      AND artifact."artifactId" = NEW."artifactId"
      AND artifact."version" = NEW."version"
      AND 'artifact-version:' || artifact."id" = NEW."versionRef"
      AND artifact."contentHash" = NEW."contentHash"
      AND artifact."draftBodyHash" IS NEW."draftBodyHash"
  ) THEN RAISE(ABORT, 'WORKBENCH_ARTIFACT_SELECTION_VERSION_BINDING_INVALID') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM "WorkbenchVerificationRecord" AS verification
    WHERE verification."id" = NEW."verificationId"
      AND verification."taskId" = NEW."taskId"
      AND verification."runId" = NEW."runId"
      AND verification."subjectType" = 'artifact_version'
      AND verification."subjectId" = NEW."versionId"
      AND verification."status" = 'passed'
      AND verification."containsForumText" = 0
      AND verification."containsIdentity" = 0
      AND verification."observedAt" <= NEW."selectedAt"
      AND (verification."expiresAt" IS NULL OR verification."expiresAt" > NEW."selectedAt")
  ) THEN RAISE(ABORT, 'WORKBENCH_ARTIFACT_SELECTION_VERIFICATION_INVALID') END;
END;
