import type { ReactNode } from "react";

type GlassCardProps = {
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
  tone?: "default" | "highlight" | "danger" | "success" | "warning";
};

const toneClass = {
  default: "",
  highlight: "glass-card-highlight",
  danger: "glass-card-danger",
  success: "glass-card-success",
  warning: "glass-card-warning"
};

export function GlassCard({
  children,
  className = "",
  "data-testid": testId,
  tone = "default"
}: GlassCardProps) {
  return (
    <div
      className={`glass-card ${toneClass[tone]} ${className}`}
      data-testid={testId}
    >
      {children}
    </div>
  );
}
