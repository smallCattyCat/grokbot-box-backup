type BriefIconName =
  | "arrow"
  | "world"
  | "decisions"
  | "outcomes"
  | "cockpit"
  | "check"
  | "lock"
  | "alert"
  | "history";

type BriefIconProps = {
  name: BriefIconName;
  className?: string;
};

export function BriefIcon({ name, className }: BriefIconProps) {
  const content = (() => {
    switch (name) {
      case "arrow":
        return (
          <>
            <path d="M5 12h14" />
            <path d="m14 7 5 5-5 5" />
          </>
        );
      case "world":
        return (
          <>
            <circle cx="12" cy="12" r="8.5" />
            <path d="M3.8 12h16.4M12 3.5c2.2 2.3 3.2 5.1 3.2 8.5s-1 6.2-3.2 8.5M12 3.5C9.8 5.8 8.8 8.6 8.8 12s1 6.2 3.2 8.5" />
          </>
        );
      case "decisions":
        return (
          <>
            <circle cx="6" cy="6" r="2" />
            <circle cx="18" cy="6" r="2" />
            <circle cx="12" cy="18" r="2" />
            <path d="M7.8 6.8 10.9 16M16.2 6.8 13.1 16M8 6h8" />
          </>
        );
      case "outcomes":
        return (
          <>
            <path d="M3 12s3.4-5.3 9-5.3 9 5.3 9 5.3-3.4 5.3-9 5.3S3 12 3 12Z" />
            <circle cx="12" cy="12" r="2.4" />
          </>
        );
      case "cockpit":
        return (
          <>
            <path d="M4.2 17.5a8.5 8.5 0 1 1 15.6 0" />
            <path d="m12 12 4.4-3.3M7.2 15.8h9.6" />
            <circle cx="12" cy="12" r="1.25" />
          </>
        );
      case "check":
        return (
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="m8 12 2.6 2.6L16.5 9" />
          </>
        );
      case "lock":
        return (
          <>
            <rect x="5" y="10" width="14" height="10" rx="2" />
            <path d="M8 10V7.5a4 4 0 0 1 8 0V10M12 14v2.5" />
          </>
        );
      case "alert":
        return (
          <>
            <path d="M12 3.5 21 20H3L12 3.5Z" />
            <path d="M12 9v5M12 17.2v.1" />
          </>
        );
      case "history":
        return (
          <>
            <path d="M4.6 8.2A8 8 0 1 1 4 14" />
            <path d="M4.6 3.8v4.4H9M12 8v4.5l3 1.8" />
          </>
        );
    }
  })();

  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      focusable="false"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {content}
    </svg>
  );
}
