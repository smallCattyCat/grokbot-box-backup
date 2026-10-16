-- Historical queued tasks predate content/target fingerprints. They must be
-- regenerated and safety-checked before a new authorization can be issued.
UPDATE "InterventionTask"
SET "status" = 'review_required'
WHERE "status" = 'ready'
  AND (
    "safetyCheckedAt" IS NULL
    OR "contentHash" IS NULL
    OR "targetHash" IS NULL
  );
