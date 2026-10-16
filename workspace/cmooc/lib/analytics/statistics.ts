export type NumericSummary = {
  n: number;
  mean: number;
  sd: number;
  min: number;
  max: number;
};

export type DifferenceInDifferencesResult = {
  treatmentPre: NumericSummary;
  treatmentPost: NumericSummary;
  controlPre: NumericSummary;
  controlPost: NumericSummary;
  treatmentChange: number;
  controlChange: number;
  did: number;
  cohenD: number;
  hedgesG: number;
  validity: {
    hasTreatmentPrePost: boolean;
    hasControlPrePost: boolean;
    minCellSize: number;
    analysisReady: boolean;
  };
};

export type KappaResult = {
  labels: string[];
  matrix: number[][];
  observedAgreement: number;
  expectedAgreement: number;
  kappa: number;
  adjacentAgreement: number;
  n: number;
};

export function round(value: number, digits = 3): number {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : 0;
}

export function safeDivide(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function mean(values: number[]): number {
  return safeDivide(values.reduce((sum, value) => sum + value, 0), values.length);
}

export function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const center = mean(values);
  return safeDivide(values.reduce((sum, value) => sum + (value - center) ** 2, 0), values.length - 1);
}

export function standardDeviation(values: number[]): number {
  return Math.sqrt(variance(values));
}

export function summarize(values: number[]): NumericSummary {
  return {
    n: values.length,
    mean: round(mean(values), 3),
    sd: round(standardDeviation(values), 3),
    min: values.length ? Math.min(...values) : 0,
    max: values.length ? Math.max(...values) : 0
  };
}

export function cohenD(left: number[], right: number[]): number {
  if (left.length < 2 || right.length < 2) return 0;
  const pooled = Math.sqrt(safeDivide((left.length - 1) * variance(left) + (right.length - 1) * variance(right), left.length + right.length - 2));
  return round(safeDivide(mean(left) - mean(right), pooled || 1), 3);
}

export function hedgesG(left: number[], right: number[]): number {
  const d = cohenD(left, right);
  const df = left.length + right.length - 2;
  const correction = df > 1 ? 1 - 3 / (4 * df - 1) : 1;
  return round(d * correction, 3);
}

export function differenceInDifferences(input: {
  treatmentPre: number[];
  treatmentPost: number[];
  controlPre: number[];
  controlPost: number[];
}): DifferenceInDifferencesResult {
  const treatmentPreMean = mean(input.treatmentPre);
  const treatmentPostMean = mean(input.treatmentPost);
  const controlPreMean = mean(input.controlPre);
  const controlPostMean = mean(input.controlPost);
  const treatmentChange = treatmentPostMean - treatmentPreMean;
  const controlChange = controlPostMean - controlPreMean;
  const did = treatmentChange - controlChange;
  const postEffectLeft = input.treatmentPost.map((value) => value - treatmentPreMean);
  const postEffectRight = input.controlPost.map((value) => value - controlPreMean);
  const minCellSize = Math.min(input.treatmentPre.length, input.treatmentPost.length, input.controlPre.length, input.controlPost.length);

  return {
    treatmentPre: summarize(input.treatmentPre),
    treatmentPost: summarize(input.treatmentPost),
    controlPre: summarize(input.controlPre),
    controlPost: summarize(input.controlPost),
    treatmentChange: round(treatmentChange, 3),
    controlChange: round(controlChange, 3),
    did: round(did, 3),
    cohenD: cohenD(postEffectLeft, postEffectRight),
    hedgesG: hedgesG(postEffectLeft, postEffectRight),
    validity: {
      hasTreatmentPrePost: input.treatmentPre.length > 0 && input.treatmentPost.length > 0,
      hasControlPrePost: input.controlPre.length > 0 && input.controlPost.length > 0,
      minCellSize,
      analysisReady: minCellSize >= 3
    }
  };
}

export function cohenKappa(pairs: Array<{ a: string | number; b: string | number }>, orderedLabels?: Array<string | number>): KappaResult {
  const labelValues = orderedLabels?.length
    ? orderedLabels
    : Array.from(new Set(pairs.flatMap((pair) => [pair.a, pair.b]))).sort((a, b) => String(a).localeCompare(String(b), "zh-Hans-CN"));
  const labels = labelValues.map(String);
  const indexByLabel = new Map(labels.map((label, index) => [label, index]));
  const matrix = Array.from({ length: labels.length }, () => Array.from({ length: labels.length }, () => 0));

  for (const pair of pairs) {
    const a = indexByLabel.get(String(pair.a));
    const b = indexByLabel.get(String(pair.b));
    if (a === undefined || b === undefined) continue;
    matrix[a][b] += 1;
  }

  const n = matrix.flat().reduce((sum, value) => sum + value, 0);
  const observedAgreement = safeDivide(matrix.reduce((sum, row, index) => sum + row[index], 0), n);
  const rowTotals = matrix.map((row) => row.reduce((sum, value) => sum + value, 0));
  const colTotals = labels.map((_, colIndex) => matrix.reduce((sum, row) => sum + row[colIndex], 0));
  const expectedAgreement = safeDivide(rowTotals.reduce((sum, rowTotal, index) => sum + rowTotal * colTotals[index], 0), n * n);
  const adjacentAgreement = safeDivide(
    matrix.reduce((sum, row, rowIndex) => sum + row.reduce((inner, value, colIndex) => inner + (Math.abs(rowIndex - colIndex) <= 1 ? value : 0), 0), 0),
    n
  );

  return {
    labels,
    matrix,
    observedAgreement: round(observedAgreement, 3),
    expectedAgreement: round(expectedAgreement, 3),
    kappa: round(safeDivide(observedAgreement - expectedAgreement, 1 - expectedAgreement), 3),
    adjacentAgreement: round(adjacentAgreement, 3),
    n
  };
}
