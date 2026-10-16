type CockpitMetricCardProps = {
  label: string;
  value: number | string;
  hint?: string;
  tone?: "cyan" | "emerald" | "violet" | "amber" | "danger";
};

export function CockpitMetricCard({ label, value, hint, tone = "cyan" }: CockpitMetricCardProps) {
  return (
    <div className={`cockpit-metric metric-${tone}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {hint ? <div className="metric-hint">{hint}</div> : null}
    </div>
  );
}
