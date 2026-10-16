type RiskBadgeProps = {
  value?: number | string | null;
};

export function RiskBadge({ value }: RiskBadgeProps) {
  const unrated =
    value === null || value === undefined || value === "";
  const numeric =
    typeof value === "number" ? value : Number(value);
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  const tone =
    unrated
      ? "muted"
      : normalized === "high" ||
          (Number.isFinite(numeric) && numeric >= 70)
      ? "danger"
      : normalized === "medium" || (Number.isFinite(numeric) && numeric >= 40)
        ? "amber"
        : "emerald";
  const label =
    unrated
      ? "未评估"
      : normalized === "high"
        ? "高"
        : normalized === "medium"
          ? "中"
          : normalized === "low"
            ? "低"
            : String(value);
  return <span className={`risk-badge risk-${tone}`}>风险 {label}</span>;
}
