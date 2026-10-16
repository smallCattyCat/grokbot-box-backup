const MAX_CLIENT_CLOCK_SKEW_MS = 30_000;

export function bindTrustedRuntimeTime(input: {
  claimedAt: string;
  trustedNow: string;
  label: string;
}): string {
  const claimedAt = Date.parse(input.claimedAt);
  const trustedNow = Date.parse(input.trustedNow);
  if (
    !Number.isFinite(claimedAt) ||
    !Number.isFinite(trustedNow) ||
    Math.abs(claimedAt - trustedNow) > MAX_CLIENT_CLOCK_SKEW_MS
  ) {
    throw new Error(`${input.label}未通过服务器时钟绑定。`);
  }
  return new Date(trustedNow).toISOString();
}
