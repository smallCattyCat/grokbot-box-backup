"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type IncidentGovernanceActionsProps = {
  incidentId: string;
  evidenceHash: string;
  status: string;
};

type IncidentAction = "acknowledge" | "resolve";

function actionLabel(action: IncidentAction): string {
  return action === "acknowledge" ? "确认异常" : "标记已解决";
}

export function IncidentGovernanceActions({
  incidentId,
  evidenceHash,
  status
}: IncidentGovernanceActionsProps) {
  const router = useRouter();
  const [pendingAction, setPendingAction] =
    useState<IncidentAction | null>(null);
  const [error, setError] = useState(false);

  const normalizedStatus = status.toLowerCase();
  const actions: IncidentAction[] =
    normalizedStatus === "open"
      ? ["acknowledge", "resolve"]
      : normalizedStatus === "acknowledged"
        ? ["resolve"]
        : [];

  if (actions.length === 0) return null;

  async function transition(action: IncidentAction) {
    if (pendingAction !== null) return;
    setPendingAction(action);
    setError(false);
    try {
      const response = await fetch(
        `/api/autonomy/incidents/${encodeURIComponent(incidentId)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          body: JSON.stringify({
            action,
            expectedEvidenceHash: evidenceHash
          })
        }
      );
      const payload = await response.json().catch(() => null);
      if (
        !response.ok ||
        !payload ||
        payload.containsForumText !== false
      ) {
        throw new Error("INCIDENT_GOVERNANCE_ACTION_FAILED");
      }
      router.refresh();
    } catch {
      // Do not surface server details, incident ids, or evidence values.
      setError(true);
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <button
            key={action}
            type="button"
            onClick={() => transition(action)}
            disabled={pendingAction !== null}
            className={
              action === "resolve"
                ? "rounded-md border border-emerald-400/60 px-3 py-2 text-sm font-semibold text-emerald-200 hover:bg-emerald-400 hover:text-slate-950 disabled:cursor-wait disabled:opacity-50"
                : "rounded-md border border-amber-400/60 px-3 py-2 text-sm font-semibold text-amber-200 hover:bg-amber-400 hover:text-slate-950 disabled:cursor-wait disabled:opacity-50"
            }
          >
            {pendingAction === action
              ? "处理中…"
              : actionLabel(action)}
          </button>
        ))}
      </div>
      {error ? (
        <p
          role="alert"
          className="mt-2 max-w-xs text-xs leading-5 text-rose-200"
        >
          异常状态未更新，请刷新后重试。
        </p>
      ) : null}
    </div>
  );
}
