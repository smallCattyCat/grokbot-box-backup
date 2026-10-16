-- Bind each autonomous course to the adapter that actually observed it, and
-- retain the body-free semantic feature receipt needed for deterministic
-- retries after a completed scan. Existing course rows remain nullable until
-- their next explicit manifest-backed tick binds them.
ALTER TABLE "AutonomyCourseManifest" ADD COLUMN "adapterId" TEXT;

ALTER TABLE "AutonomyObservation" ADD COLUMN "semanticReceiptHash" TEXT;
ALTER TABLE "AutonomyObservation" ADD COLUMN "semanticReceiptJson" TEXT;

CREATE INDEX "AutonomyCourseManifest_platformId_adapterId_idx"
  ON "AutonomyCourseManifest"("platformId", "adapterId");

CREATE UNIQUE INDEX "AutonomyObservation_semanticReceiptHash_key"
  ON "AutonomyObservation"("semanticReceiptHash");
