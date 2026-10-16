export default function AppLoading() {
  return (
    <div
      className="space-y-5"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="sr-only">正在载入课程运行数据</span>
      <div className="command-shell min-h-48 animate-pulse">
        <div className="h-8 w-48 rounded-md bg-slate-700/60" />
        <div className="mt-5 h-4 max-w-2xl rounded bg-slate-800" />
        <div className="mt-2 h-4 max-w-xl rounded bg-slate-800" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
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
    </div>
  );
}
