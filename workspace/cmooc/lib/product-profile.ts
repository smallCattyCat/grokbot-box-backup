export type ProductProfile = Readonly<{
  productName: string;
  productShortName: string;
  productDescription: string;
  operatorLabel: string;
}>;

export const DEFAULT_PRODUCT_PROFILE: ProductProfile = Object.freeze({
  productName: "cMOOC 智能学伴",
  productShortName: "智能学伴",
  productDescription: "面向课程互动网络、运行证据与协作研判的课程运营工作台",
  operatorLabel: "课程运营团队"
});

const PROFILE_LIMITS = {
  productName: 48,
  productShortName: 24,
  productDescription: 140,
  operatorLabel: 32
} as const;

function publicLabel(
  value: string | undefined,
  fallback: string,
  maxLength: number
): string {
  const normalized = value
    ?.normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized || Array.from(normalized).length > maxLength) {
    return fallback;
  }
  return normalized;
}

/**
 * Public, non-secret white-label surface. A buyer can brand one isolated
 * deployment without changing protocol ids, stored evidence, or connector
 * semantics. Only NEXT_PUBLIC_* labels are read here; credentials and runtime
 * authority are deliberately outside this profile.
 */
export function resolveProductProfile(
  environment: Record<string, string | undefined> = process.env
): ProductProfile {
  return Object.freeze({
    productName: publicLabel(
      environment.NEXT_PUBLIC_PRODUCT_NAME,
      DEFAULT_PRODUCT_PROFILE.productName,
      PROFILE_LIMITS.productName
    ),
    productShortName: publicLabel(
      environment.NEXT_PUBLIC_PRODUCT_SHORT_NAME,
      DEFAULT_PRODUCT_PROFILE.productShortName,
      PROFILE_LIMITS.productShortName
    ),
    productDescription: publicLabel(
      environment.NEXT_PUBLIC_PRODUCT_DESCRIPTION,
      DEFAULT_PRODUCT_PROFILE.productDescription,
      PROFILE_LIMITS.productDescription
    ),
    operatorLabel: publicLabel(
      environment.NEXT_PUBLIC_OPERATOR_LABEL,
      DEFAULT_PRODUCT_PROFILE.operatorLabel,
      PROFILE_LIMITS.operatorLabel
    )
  });
}
