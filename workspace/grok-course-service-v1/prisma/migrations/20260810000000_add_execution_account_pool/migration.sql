-- Opaque account-pool leases.  No credential, identity, URL, cookie, token,
-- or forum body is stored; the two reference columns are SHA-256-like hashes.
CREATE TABLE "ExecutionAccountLease" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "leaseKey" TEXT NOT NULL,
    "accountRefHash" TEXT NOT NULL,
    "credentialRefHash" TEXT NOT NULL,
    "roleKey" TEXT NOT NULL,
    "courseAlias" TEXT NOT NULL,
    "invocationId" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME,
    "releasedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExecutionAccountLease_invocationId_fkey"
        FOREIGN KEY ("invocationId") REFERENCES "ScheduledInvocation" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ExecutionAccountLease_decisionId_fkey"
        FOREIGN KEY ("decisionId") REFERENCES "AutonomyDecision" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ExecutionAccountLease_leaseKey_key"
ON "ExecutionAccountLease"("leaseKey");

CREATE UNIQUE INDEX "ExecutionAccountLease_decisionId_key"
ON "ExecutionAccountLease"("decisionId");

CREATE INDEX "ExecutionAccountLease_courseAlias_status_idx"
ON "ExecutionAccountLease"("courseAlias", "status");

CREATE INDEX "ExecutionAccountLease_accountRefHash_status_idx"
ON "ExecutionAccountLease"("accountRefHash", "status");

CREATE INDEX "ExecutionAccountLease_expiresAt_idx"
ON "ExecutionAccountLease"("expiresAt");

-- Prisma schema cannot express this SQLite partial unique index.  It is the
-- database boundary for the one-active-lease-per-account invariant.
CREATE UNIQUE INDEX "ExecutionAccountLease_one_active_account_key"
ON "ExecutionAccountLease"("accountRefHash")
WHERE "status" = 'active';

ALTER TABLE "ExecutionPermit"
ADD COLUMN "executionAccountLeaseId" TEXT;

ALTER TABLE "ExecutionPermit"
ADD COLUMN "executionAccountRefHash" TEXT;

ALTER TABLE "ExecutionPermit"
ADD COLUMN "credentialRefHash" TEXT;

CREATE UNIQUE INDEX "ExecutionPermit_executionAccountLeaseId_key"
ON "ExecutionPermit"("executionAccountLeaseId");

ALTER TABLE "ExecutionAttempt"
ADD COLUMN "executionAccountRefHash" TEXT;

CREATE INDEX "ExecutionAttempt_executionAccountRefHash_idx"
ON "ExecutionAttempt"("executionAccountRefHash");
