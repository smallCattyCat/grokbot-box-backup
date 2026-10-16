-- Teachable Episode Projector resolves the latest prior decision for the same
-- course/thread at a strict as-of cutoff. This index changes no data or
-- authority; it keeps cross-tick SHADOW reuse bounded as decision history grows.
CREATE INDEX "AutonomyDecision_courseAlias_threadKey_evidenceAsOf_idx"
ON "AutonomyDecision"("courseAlias", "threadKey", "evidenceAsOf");
