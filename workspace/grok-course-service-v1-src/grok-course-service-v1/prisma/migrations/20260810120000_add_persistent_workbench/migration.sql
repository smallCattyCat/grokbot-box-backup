CREATE TABLE "WorkbenchContextSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "schemaVersion" TEXT NOT NULL,
    "contextRef" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "courseAlias" TEXT,
    "invocationId" TEXT,
    "evidenceHash" TEXT,
    "contextJson" TEXT NOT NULL,
    "containsForumText" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "WorkbenchTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "contextSnapshotId" TEXT,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    CONSTRAINT "WorkbenchTask_contextSnapshotId_fkey"
      FOREIGN KEY ("contextSnapshotId") REFERENCES "WorkbenchContextSnapshot" ("id")
      ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "WorkbenchRunRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "projectLabel" TEXT NOT NULL,
    "snapshotJson" TEXT NOT NULL,
    "errorCode" TEXT,
    "recoveryState" TEXT,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    CONSTRAINT "WorkbenchRunRecord_taskId_fkey"
      FOREIGN KEY ("taskId") REFERENCES "WorkbenchTask" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "WorkbenchEventRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "agentLabel" TEXT,
    "agentRole" TEXT,
    "createdAt" DATETIME NOT NULL,
    CONSTRAINT "WorkbenchEventRecord_runId_fkey"
      FOREIGN KEY ("runId") REFERENCES "WorkbenchRunRecord" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "WorkbenchArtifactRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "observedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkbenchArtifactRecord_runId_fkey"
      FOREIGN KEY ("runId") REFERENCES "WorkbenchRunRecord" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "WorkbenchContextSnapshot_courseAlias_createdAt_idx" ON "WorkbenchContextSnapshot"("courseAlias", "createdAt");
CREATE INDEX "WorkbenchContextSnapshot_invocationId_idx" ON "WorkbenchContextSnapshot"("invocationId");
CREATE INDEX "WorkbenchTask_status_updatedAt_idx" ON "WorkbenchTask"("status", "updatedAt");
CREATE INDEX "WorkbenchTask_contextSnapshotId_idx" ON "WorkbenchTask"("contextSnapshotId");
CREATE INDEX "WorkbenchRunRecord_status_updatedAt_idx" ON "WorkbenchRunRecord"("status", "updatedAt");
CREATE INDEX "WorkbenchRunRecord_taskId_idx" ON "WorkbenchRunRecord"("taskId");
CREATE UNIQUE INDEX "WorkbenchEventRecord_runId_sequence_key" ON "WorkbenchEventRecord"("runId", "sequence");
CREATE INDEX "WorkbenchEventRecord_runId_createdAt_idx" ON "WorkbenchEventRecord"("runId", "createdAt");
CREATE UNIQUE INDEX "WorkbenchArtifactRecord_runId_artifactId_key" ON "WorkbenchArtifactRecord"("runId", "artifactId");
