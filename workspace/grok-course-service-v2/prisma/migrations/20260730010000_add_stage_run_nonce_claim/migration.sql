CREATE TABLE "StageRunNonceClaim" (
    "runNonceHash" TEXT NOT NULL PRIMARY KEY,
    "expiresAt" DATETIME NOT NULL,
    "claimedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "StageRunNonceClaim_expiresAt_idx" ON "StageRunNonceClaim"("expiresAt");
CREATE INDEX "StageRunNonceClaim_claimedAt_idx" ON "StageRunNonceClaim"("claimedAt");
