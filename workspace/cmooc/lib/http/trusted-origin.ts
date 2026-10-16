function isLoopbackHost(hostname: string) {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "[::1]" ||
    normalized === "::1";
}

function configuredAppOrigin(): URL | null | "invalid" {
  const raw = process.env.APP_ORIGIN?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return "invalid";
  }
}

export function isTrustedApplicationOrigin(value: string): boolean {
  let requested: URL;
  try {
    requested = new URL(value);
  } catch {
    return false;
  }

  const configured = configuredAppOrigin();
  if (configured === "invalid") return false;
  if (!configured) return isLoopbackHost(requested.hostname);
  if (isLoopbackHost(configured.hostname)) {
    return isLoopbackHost(requested.hostname) &&
      requested.protocol === configured.protocol &&
      requested.port === configured.port;
  }
  return requested.origin === configured.origin;
}

export function requestOriginFromHeaders(
  headers: Headers,
  fallbackProtocol: string
): string {
  const host = headers.get("host")?.trim();
  if (!host) return "";
  const forwardedProtocol = headers
    .get("x-forwarded-proto")
    ?.split(",", 1)[0]
    ?.trim()
    .toLowerCase();
  const protocol = forwardedProtocol ||
    fallbackProtocol.replace(/:$/, "").toLowerCase();
  if (protocol !== "http" && protocol !== "https") return "";
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return "";
  }
}
