type OperationalPageLoadingProps = {
  variant: "world" | "records" | "run";
};

const metricCount = {
  world: 0,
  records: 5,
  run: 4
} as const;

export function OperationalPageLoading({
  variant
}: OperationalPageLoadingProps) {
  return (
    <div
      className="space-y-5"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="sr-only">正在载入课程运行数据</span>
      <div
        className="command-shell animate-pulse"
        data-variant="operational"
      >
        <div className="h-5 w-40 rounded bg-slate-700/60" />
        <div className="mt-2 h-3 max-w-xl rounded bg-slate-800" />
        <div className="mt-3 flex gap-2">
          <div className="h-6 w-28 rounded-full bg-slate-800" />
          <div className="h-6 w-32 rounded-full bg-slate-800" />
        </div>
      </div>
      {variant === "world" ? (
        <div className="glass-card min-h-[28rem] animate-pulse" aria-hidden="true" />
      ) : (
        <div
          className={`grid gap-3 sm:grid-cols-2 ${
            variant === "records" ? "xl:grid-cols-5" : "xl:grid-cols-4"
          }`}
        >
          {Array.from({ length: metricCount[variant] }, (_, index) => (
            <div
              key={index}
              className="cockpit-metric min-h-32 animate-pulse"
              aria-hidden="true"
            >
              <div className="h-3 w-24 rounded bg-slate-700/60" />
              <div className="mt-5 h-8 w-20 rounded bg-slate-700/50" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
