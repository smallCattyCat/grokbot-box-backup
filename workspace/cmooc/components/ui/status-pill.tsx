type StatusPillProps = {
  label: string;
  tone?: "cyan" | "blue" | "violet" | "emerald" | "amber" | "danger" | "muted";
  pulse?: boolean;
};

export function StatusPill({ label, tone = "cyan", pulse = false }: StatusPillProps) {
  return (
    <span className={`status-pill status-${tone}`}>
      {pulse ? (
        <span
          className="status-dot status-dot-pulse"
          aria-hidden="true"
        />
      ) : null}
      {label}
    </span>
  );
}
