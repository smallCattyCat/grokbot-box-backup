import type { ReactNode } from "react";

type CommandShellProps = {
  variant?: "default" | "operational";
  testId?: string;
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  status?: ReactNode;
  children?: ReactNode;
};

export function CommandShell({
  variant = "default",
  testId,
  eyebrow,
  title,
  description,
  actions,
  status,
  children
}: CommandShellProps) {
  return (
    <section
      className="command-shell"
      data-variant={variant}
      data-testid={testId}
    >
      <div className="command-shell-summary flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="min-w-0">
          {eyebrow ? <p className="command-context">{eyebrow}</p> : null}
          <h1 className={eyebrow ? "mt-2" : undefined}>{title}</h1>
          {description ? <p className="command-description">{description}</p> : null}
        </div>
        <div className="flex min-w-0 flex-col gap-3 xl:items-end">
          {status ? <div className="flex flex-wrap gap-2 xl:justify-end">{status}</div> : null}
          {actions ? <div className="min-w-0 max-w-full">{actions}</div> : null}
        </div>
      </div>
      {children ? <div className="command-shell-content">{children}</div> : null}
    </section>
  );
}
