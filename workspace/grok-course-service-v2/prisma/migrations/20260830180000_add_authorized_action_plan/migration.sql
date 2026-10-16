-- Persist the policy/governance/connector handoff required by continuous AUTO.
-- Existing one-shot permits retain their trusted_stage proof semantics.
CREATE TABLE "AuthorizedActionPlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "decisionId" TEXT NOT NULL,
    "invocationId" TEXT NOT NULL,
    "courseAlias" TEXT NOT NULL,
    "manifestHash" TEXT NOT NULL,
    "governanceHash" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "policyHash" TEXT NOT NULL,
    "connectorBindingHash" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "executionProofKind" TEXT NOT NULL,
    "planHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "validUntil" DATETIME NOT NULL,
    "permitIssuedAt" DATETIME,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AuthorizedActionPlan_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "AutonomyDecision" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AuthorizedActionPlan_decisionId_key" ON "AuthorizedActionPlan"("decisionId");
CREATE UNIQUE INDEX "AuthorizedActionPlan_planHash_key" ON "AuthorizedActionPlan"("planHash");
CREATE INDEX "AuthorizedActionPlan_courseAlias_status_validUntil_idx" ON "AuthorizedActionPlan"("courseAlias", "status", "validUntil");
CREATE INDEX "AuthorizedActionPlan_invocationId_idx" ON "AuthorizedActionPlan"("invocationId");
CREATE INDEX "AuthorizedActionPlan_policyHash_idx" ON "AuthorizedActionPlan"("policyHash");
CREATE INDEX "AuthorizedActionPlan_governanceHash_idx" ON "AuthorizedActionPlan"("governanceHash");

ALTER TABLE "ExecutionPermit" ADD COLUMN "executionProofKind" TEXT NOT NULL DEFAULT 'trusted_stage';
ALTER TABLE "ExecutionPermit" ADD COLUMN "actionPlanHash" TEXT;
CREATE INDEX "ExecutionPermit_actionPlanHash_idx" ON "ExecutionPermit"("actionPlanHash");
