"use client";

import { useState, useTransition } from "react";
import type {
  P4D1ReviewCase,
  P4D1ReviewDecision
} from "@/lib/golden-path/p4d1";
import type { P4FLiteScenarioId } from "@/lib/golden-path/p4f-lite";
import { GlassCard } from "@/components/ui/glass-card";
import { StatusPill } from "@/components/ui/status-pill";

type ReviewResult = {
  requestedDecision: P4D1ReviewDecision;
  decision: P4D1ReviewDecision;
  disposition:
    | "shadow_recorded"
    | "human_rejected"
    | "withdrawn_external_human_response"
    | "needs_re_review_target_changed";
  receiptHash: string;
  preflightReceiptHash: string;
  reviewedAt: string;
  wasEdited: boolean;
  reviewDurationMs: number;
  preflightScenario: P4FLiteScenarioId;
  preflightStatus: string;
  withdrawalCondition:
    | "target_version_changed"
    | "external_human_response"
    | null;
  eventCountBefore: number;
  eventCountAfter: number;
  externalWriteAttempted: false;
  message: string;
};

const functionLabels = {
  resource_connection: "资源连接",
  cognitive_conflict: "认知冲突",
  emotional_support: "情感支持"
} as const;

const moveLabels = {
  connect_resource_and_invite_application: "连接资源并邀请应用",
  pose_counterexample_and_request_explanation: "提出反例并邀请解释",
  acknowledge_contribution_and_invite_return: "承接贡献并邀请回到讨论"
} as const;

const preflightScenarios: Array<{
  id: P4FLiteScenarioId;
  label: string;
  description: string;
}> = [
  {
    id: "stable_target",
    label: "状态保持稳定",
    description: "目标版本与社区事件均未变化，记录 shadow 决定。"
  },
  {
    id: "post_as_of_human_response",
    label: "出现真人回复",
    description: "同伴已经形成连接，系统撤回原动作并让位。"
  },
  {
    id: "target_version_changed",
    label: "目标内容已更新",
    description: "旧目标哈希失效，草稿转入重新审阅。"
  }
];

function shortHash(value: string) {
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

async function readPayload(response: Response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "审阅决定未能保存。");
  return payload as ReviewResult;
}

export function GoldenPathReview({
  reviewCase
}: {
  reviewCase: P4D1ReviewCase;
}) {
  const [draft, setDraft] = useState(reviewCase.deterministicDraft);
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [message, setMessage] = useState("");
  const [reviewStartedAt] = useState(() => new Date().toISOString());
  const [preflightScenario, setPreflightScenario] =
    useState<P4FLiteScenarioId>("stable_target");
  const [pending, startTransition] = useTransition();
  const changed = draft.trim() !== reviewCase.deterministicDraft;

  function submit(decision: P4D1ReviewDecision) {
    setMessage("正在固化本地审阅回执…");
    startTransition(async () => {
      try {
        const response = await fetch("/api/review/golden-path", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fixtureId: reviewCase.fixtureId,
            decision,
            draftText: draft,
            reviewBundleHash: reviewCase.reviewBundleHash,
            targetHash: reviewCase.targetHash,
            reviewStartedAt,
            preflightScenario
          })
        });
        const payload = await readPayload(response);
        setResult(payload);
        setMessage(payload.message);
      } catch (error) {
        setResult(null);
        setMessage(
          error instanceof Error ? error.message : "审阅决定未能保存。"
        );
      }
    });
  }

  return (
    <GlassCard tone="highlight">
      <article aria-labelledby="golden-path-title">
        <ol
          aria-label="感知、择机、促成、让位工作流"
          className="mb-5 grid gap-2 sm:grid-cols-4"
        >
          {[
            ["感知", "固定时点只读状态"],
            [
              "择机",
              `预算内候选 ${reviewCase.candidate.priorityRank}/${reviewCase.candidate.candidateCount}`
            ],
            ["促成", "Intent + 可编辑草稿"],
            ["让位", "提交前重读社区"]
          ].map(([step, detail], index) => (
            <li
              key={step}
              className="rounded-md border border-slate-800 bg-slate-950/30 px-3 py-2"
            >
              <p className="text-xs font-semibold text-cyan-200">
                {index + 1}. {step}
              </p>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                {detail}
              </p>
            </li>
          ))}
        </ol>

        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex flex-wrap gap-2">
              <StatusPill label="固定合成促进机会" tone="cyan" />
              <StatusPill label="时点证据已核验" tone="emerald" />
              <StatusPill label="Shadow · 不发布" tone="muted" />
            </div>
            <h2
              id="golden-path-title"
              className="mt-3 text-xl font-semibold text-slate-50"
            >
              {reviewCase.title}
            </h2>
            <p className="mt-2 text-sm text-slate-400">
              决策时点 {reviewCase.candidate.decisionAt} · 固定时钟{" "}
              {reviewCase.fixedClock} · 正文版本已在决策时点核验
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusPill
              label={`预算内第 ${reviewCase.candidate.priorityRank}/${reviewCase.candidate.candidateCount}`}
              tone="amber"
            />
            <StatusPill
              label={`当轮名额 ${reviewCase.candidate.budgetSlots}`}
              tone="violet"
            />
          </div>
        </div>

        <div className="mt-5 grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
          <section className="space-y-4">
            <div className="rounded-md border border-slate-800 bg-slate-950/35 p-4">
              <h3 className="text-sm font-semibold text-slate-100">
                合成主题内容
              </h3>
              <p className="mt-2 text-sm leading-7 text-slate-200">
                {reviewCase.syntheticSourceText}
              </p>
              <p className="mt-3 text-xs text-slate-500">
                fixture: {reviewCase.fixtureId} · 仅用于可复现产品验收
              </p>
            </div>

            <div className="rounded-md border border-slate-800 bg-slate-950/35 p-4">
              <h3 className="text-sm font-semibold text-slate-100">
                为什么进入本轮
              </h3>
              <dl className="mt-3 space-y-4 text-sm leading-6">
                <div>
                  <dt className="font-medium text-cyan-200">为何此时</dt>
                  <dd className="mt-1 text-slate-300">
                    {reviewCase.candidate.whyNow}
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-cyan-200">为何该对象</dt>
                  <dd className="mt-1 text-slate-300">
                    {reviewCase.candidate.whyTarget}
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-cyan-200">预算依据</dt>
                  <dd className="mt-1 text-slate-300">
                    {reviewCase.candidate.budgetBasis}
                  </dd>
                </div>
              </dl>
            </div>
          </section>

          <section className="space-y-4">
            <div className="rounded-md border border-slate-800 bg-slate-950/35 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-slate-100">
                  Intent + MoveSpec
                </h3>
                <StatusPill label="协议校验通过" tone="emerald" />
              </div>
              <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-slate-500">促进功能</dt>
                  <dd className="mt-1 text-slate-200">
                    {functionLabels[
                      reviewCase.intent.facilitationFunction as keyof typeof functionLabels
                    ]}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">促进动作</dt>
                  <dd className="mt-1 text-slate-200">
                    {moveLabels[
                      reviewCase.moveSpec.facilitationMove as keyof typeof moveLabels
                    ]}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">机制目标</dt>
                  <dd className="mt-1 text-slate-200">
                    降低概念与讨论资源之间的连接成本
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">观察成功判据</dt>
                  <dd className="mt-1 text-slate-200">
                    外部回应 / 资源应用尝试
                  </dd>
                </div>
              </dl>
              <details className="mt-4 border-t border-slate-800 pt-3">
                <summary className="cursor-pointer text-xs font-semibold text-slate-400">
                  查看去正文追溯哈希
                </summary>
                <dl className="mt-3 space-y-2 font-mono text-xs text-slate-400">
                  <div className="flex justify-between gap-3">
                    <dt>evidence</dt>
                    <dd>{shortHash(reviewCase.evidenceRefHash)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>intent</dt>
                    <dd>{shortHash(reviewCase.intentHash)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>move</dt>
                    <dd>{shortHash(reviewCase.moveSpecHash)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>review bundle</dt>
                    <dd>{shortHash(reviewCase.reviewBundleHash)}</dd>
                  </div>
                </dl>
              </details>
            </div>

            <div className="rounded-md border border-cyan-400/25 bg-slate-950/45 p-4">
              <label
                htmlFor="p4d1-draft"
                className="text-sm font-semibold text-slate-100"
              >
                可编辑促进草稿
              </label>
              <textarea
                id="p4d1-draft"
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setResult(null);
                }}
                rows={7}
                className="mt-3 w-full resize-y rounded-md border border-slate-700 bg-slate-950/70 p-3 text-sm leading-7 text-slate-100 outline-none transition focus:border-cyan-400"
              />
              <fieldset className="mt-4 border-t border-slate-800 pt-4">
                <legend className="text-sm font-semibold text-slate-100">
                  提交前重读情境
                </legend>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  选择一个固定合成平台状态，系统将在保存人工决定前重新观察目标与社区事件。此演示不访问真实论坛。
                </p>
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  {preflightScenarios.map((scenario) => {
                    const selected = preflightScenario === scenario.id;
                    return (
                      <label
                        key={scenario.id}
                        className={`cursor-pointer rounded-md border p-3 transition ${
                          selected
                            ? "border-cyan-400/60 bg-cyan-950/30"
                            : "border-slate-800 bg-slate-950/30 hover:border-slate-600"
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <input
                            type="radio"
                            name="preflight-scenario"
                            value={scenario.id}
                            checked={selected}
                            onChange={() => {
                              setPreflightScenario(scenario.id);
                              setResult(null);
                              setMessage("");
                            }}
                          />
                          <span className="text-xs font-semibold text-slate-200">
                            {scenario.label}
                          </span>
                        </span>
                        <span className="mt-2 block text-xs leading-5 text-slate-500">
                          {scenario.description}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => submit("accept")}
                  disabled={pending || changed}
                  className="rounded-md bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  重读并接受原稿
                </button>
                <button
                  type="button"
                  onClick={() => submit("modify")}
                  disabled={pending || !changed || !draft.trim()}
                  className="rounded-md border border-amber-400/60 px-4 py-2 text-sm font-semibold text-amber-200 hover:bg-amber-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  重读并保存修改
                </button>
                <button
                  type="button"
                  onClick={() => submit("reject")}
                  disabled={pending}
                  className="rounded-md border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-300 hover:border-slate-500 disabled:opacity-45"
                >
                  放弃本次动作
                </button>
              </div>
              <p
                role="status"
                aria-live="polite"
                className="mt-3 text-xs leading-5 text-slate-400"
              >
                {message ||
                  "人工决定提交时先重读合成 adapter；只生成本地去正文回执，不会发送到论坛或模型。"}
              </p>
              {result ? (
                <div
                  className={`mt-3 rounded-md border p-3 text-xs leading-5 ${
                    result.disposition === "shadow_recorded"
                      ? "border-emerald-400/25 bg-emerald-950/20 text-emerald-200"
                      : "border-amber-400/30 bg-amber-950/20 text-amber-100"
                  }`}
                >
                  <p className="font-semibold">{result.message}</p>
                  <dl className="mt-2 grid gap-2 sm:grid-cols-2">
                    <div>
                      <dt className="text-slate-500">人工原决定</dt>
                      <dd>
                        {result.requestedDecision === "accept"
                          ? "接受原稿"
                          : result.requestedDecision === "modify"
                            ? "保存修改"
                            : "放弃动作"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">系统最终处理</dt>
                      <dd>
                        {result.disposition === "shadow_recorded"
                          ? "记录 shadow 决定"
                          : result.disposition ===
                              "withdrawn_external_human_response"
                            ? "社区已连接，系统让位"
                            : result.disposition ===
                                "needs_re_review_target_changed"
                              ? "目标变化，转重新审阅"
                              : "按人工决定放弃"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">事件数重读</dt>
                      <dd>
                        {result.eventCountBefore} → {result.eventCountAfter}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">本次审阅用时</dt>
                      <dd>
                        {(result.reviewDurationMs / 1000).toFixed(1)} 秒
                      </dd>
                    </div>
                  </dl>
                  <p className="mt-2">
                    外部写入：0 · 学习者在 shadow 模式下看不到任何系统内容
                  </p>
                  <details className="mt-2 border-t border-current/20 pt-2">
                    <summary className="cursor-pointer">
                      查看去正文双回执
                    </summary>
                    <p className="mt-2 break-all font-mono">
                      review {result.receiptHash}
                    </p>
                    <p className="mt-1 break-all font-mono">
                      preflight {result.preflightReceiptHash}
                    </p>
                  </details>
                </div>
              ) : null}
            </div>
          </section>
        </div>
      </article>
    </GlassCard>
  );
}
