export type GraphWaveletNode = {
  id: string;
  label?: string;
  signal: number;
};

export type GraphWaveletEdge = {
  from: string;
  to: string;
  weight?: number;
};

export type GraphWaveletTopNode = {
  id: string;
  label: string;
  rawSignal: number;
  standardizedSignal: number;
  degree: number;
  pprMass: number;
  localRoughness: number;
  maxWaveletCoefficient: number;
  anomalyScore: number;
};

export type GraphWaveletScaleSummary = {
  scale: number;
  heatEnergyRatio: number;
  waveletXexpEnergyRatio: number;
  waveletX2expEnergyRatio: number;
};

export type GraphWaveletSnapshot = {
  method: string;
  nodeCount: number;
  edgeCount: number;
  scales: number[];
  graphRoughness: number;
  roughnessRatio: number;
  totalEnergy: number;
  highFrequencyEnergyRatio: number;
  pprMassConcentration: number;
  state: "insufficient_data" | "smooth_diffusion" | "localized_shift" | "fragmented_need_signal";
  scaleSummaries: GraphWaveletScaleSummary[];
  topNodes: GraphWaveletTopNode[];
};

const DEFAULT_SCALES = [0.5, 1, 2, 4];
const EPSILON = 1e-9;

function round(value: number, digits = 3) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : 0;
}

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

function standardDeviation(values: number[]) {
  if (values.length < 2) return 0;
  const center = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1));
}

function sumSquares(values: number[]) {
  return values.reduce((sum, value) => sum + value * value, 0);
}

function zScores(values: number[]) {
  const center = mean(values);
  const sd = standardDeviation(values) || 1;
  return values.map((value) => (value - center) / sd);
}

function identity(size: number): number[][] {
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (__, col) => (row === col ? 1 : 0)));
}

function buildWeightedAdjacency(nodes: GraphWaveletNode[], edges: GraphWaveletEdge[]) {
  const indexById = new Map(nodes.map((node, index) => [node.id, index]));
  const adjacency = Array.from({ length: nodes.length }, () => Array.from({ length: nodes.length }, () => 0));
  const seen = new Set<string>();
  const weightedEdges: Array<{ from: number; to: number; weight: number }> = [];
  for (const edge of edges) {
    const from = indexById.get(edge.from);
    const to = indexById.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const weight = Math.max(Number(edge.weight ?? 1) || 0, 0);
    if (weight <= 0) continue;
    adjacency[from][to] += weight;
    adjacency[to][from] += weight;
    weightedEdges.push({ from, to, weight });
    seen.add([edge.from, edge.to].sort().join("<->"));
  }
  return { adjacency, edgeCount: seen.size, weightedEdges };
}

function normalizedLaplacian(adjacency: number[][], degree: number[]) {
  return adjacency.map((row, i) =>
    row.map((weight, j) => {
      if (i === j) return degree[i] > 0 ? 1 : 0;
      if (weight <= 0 || degree[i] <= 0 || degree[j] <= 0) return 0;
      return -weight / Math.sqrt(degree[i] * degree[j]);
    })
  );
}

function jacobiEigenSymmetric(input: number[][]) {
  const size = input.length;
  const matrix = input.map((row) => row.slice());
  const vectors = identity(size);
  const maxIterations = Math.max(40, size * size * 12);

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let p = 0;
    let q = 1;
    let max = 0;
    for (let i = 0; i < size; i += 1) {
      for (let j = i + 1; j < size; j += 1) {
        const value = Math.abs(matrix[i][j]);
        if (value > max) {
          max = value;
          p = i;
          q = j;
        }
      }
    }
    if (max < 1e-10) break;

    const app = matrix[p][p];
    const aqq = matrix[q][q];
    const apq = matrix[p][q];
    const angle = 0.5 * Math.atan2(2 * apq, aqq - app);
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);

    for (let i = 0; i < size; i += 1) {
      if (i === p || i === q) continue;
      const aip = matrix[i][p];
      const aiq = matrix[i][q];
      matrix[i][p] = cosine * aip - sine * aiq;
      matrix[p][i] = matrix[i][p];
      matrix[i][q] = sine * aip + cosine * aiq;
      matrix[q][i] = matrix[i][q];
    }

    matrix[p][p] = cosine * cosine * app - 2 * sine * cosine * apq + sine * sine * aqq;
    matrix[q][q] = sine * sine * app + 2 * sine * cosine * apq + cosine * cosine * aqq;
    matrix[p][q] = 0;
    matrix[q][p] = 0;

    for (let i = 0; i < size; i += 1) {
      const vip = vectors[i][p];
      const viq = vectors[i][q];
      vectors[i][p] = cosine * vip - sine * viq;
      vectors[i][q] = sine * vip + cosine * viq;
    }
  }

  return {
    values: matrix.map((row, index) => Math.max(row[index], 0)),
    vectors
  };
}

function spectralFilter(signal: number[], eigenvalues: number[], eigenvectors: number[][], kernel: (lambda: number) => number) {
  const size = signal.length;
  const spectral = Array.from({ length: size }, (_, k) =>
    signal.reduce((sum, value, i) => sum + eigenvectors[i][k] * value, 0)
  );
  return Array.from({ length: size }, (_, i) =>
    spectral.reduce((sum, value, k) => sum + eigenvectors[i][k] * kernel(eigenvalues[k]) * value, 0)
  );
}

function diffuse(signal: number[], adjacency: number[][], degree: number[], steps: number) {
  let current = signal.slice();
  const iterations = Math.max(1, Math.round(steps * 2));
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    current = current.map((value, i) => {
      if (degree[i] <= 0) return value;
      const neighborAverage = adjacency[i].reduce((sum, weight, j) => sum + weight * current[j], 0) / degree[i];
      return 0.5 * value + 0.5 * neighborAverage;
    });
  }
  return current;
}

function personalizedPageRank(seeds: number[], adjacency: number[][], degree: number[], damping = 0.85) {
  const seedTotal = seeds.reduce((sum, value) => sum + Math.max(value, 0), 0);
  const personalization = seedTotal > 0
    ? seeds.map((value) => Math.max(value, 0) / seedTotal)
    : seeds.map(() => 1 / Math.max(seeds.length, 1));
  let ranks = personalization.slice();
  for (let iteration = 0; iteration < 48; iteration += 1) {
    const next = personalization.map((seed) => (1 - damping) * seed);
    for (let i = 0; i < ranks.length; i += 1) {
      if (degree[i] <= 0) {
        next[i] += damping * ranks[i];
        continue;
      }
      for (let j = 0; j < ranks.length; j += 1) {
        if (adjacency[i][j] > 0) next[j] += damping * ranks[i] * adjacency[i][j] / degree[i];
      }
    }
    ranks = next;
  }
  return ranks;
}

function localRoughnessByNode(signal: number[], adjacency: number[][]) {
  return signal.map((value, i) =>
    adjacency[i].reduce((sum, weight, j) => sum + weight * (value - signal[j]) ** 2, 0)
  );
}

export function graphWaveletSnapshot(
  nodes: GraphWaveletNode[],
  edges: GraphWaveletEdge[],
  options: { scales?: number[]; maxSpectralNodes?: number } = {}
): GraphWaveletSnapshot {
  const usableNodes = nodes.filter((node) => node.id);
  const scales = options.scales?.length ? options.scales : DEFAULT_SCALES;
  const { adjacency, edgeCount, weightedEdges } = buildWeightedAdjacency(usableNodes, edges);
  const degree = adjacency.map((row) => row.reduce((sum, value) => sum + value, 0));
  const rawSignal = usableNodes.map((node) => Number(node.signal) || 0);
  const standardized = zScores(rawSignal);
  const weaknessSignal = standardized.map((value) => Math.max(value, 0));
  const signal = sumSquares(weaknessSignal) > EPSILON ? weaknessSignal : rawSignal;
  const totalEnergy = sumSquares(signal);

  if (usableNodes.length < 3 || edgeCount < 2 || totalEnergy <= EPSILON) {
    return {
      method: "Graph-PVI transfer: heat diffusion + spectral graph wavelet + PPR + graph roughness",
      nodeCount: usableNodes.length,
      edgeCount,
      scales,
      graphRoughness: 0,
      roughnessRatio: 0,
      totalEnergy: round(totalEnergy),
      highFrequencyEnergyRatio: 0,
      pprMassConcentration: 0,
      state: "insufficient_data",
      scaleSummaries: [],
      topNodes: []
    };
  }

  const useSpectral = usableNodes.length <= (options.maxSpectralNodes ?? 120);
  const eigen = useSpectral ? jacobiEigenSymmetric(normalizedLaplacian(adjacency, degree)) : null;
  const ppr = personalizedPageRank(signal, adjacency, degree);
  const localRoughness = localRoughnessByNode(signal, adjacency);
  const graphRoughness = weightedEdges.reduce((sum, edge) => {
    return sum + edge.weight * (signal[edge.from] - signal[edge.to]) ** 2;
  }, 0);
  const roughnessRatio = graphRoughness / Math.max(totalEnergy * Math.max(weightedEdges.length, 1), EPSILON);

  const nodeWaveletEnergy = Array.from({ length: usableNodes.length }, () => 0);
  const nodeMaxCoefficient = Array.from({ length: usableNodes.length }, () => 0);
  const scaleSummaries = scales.map((scale) => {
    const heat = eigen
      ? spectralFilter(signal, eigen.values, eigen.vectors, (lambda) => Math.exp(-scale * lambda))
      : diffuse(signal, adjacency, degree, scale);
    const waveletXexp = eigen
      ? spectralFilter(signal, eigen.values, eigen.vectors, (lambda) => {
        const x = scale * lambda;
        return x * Math.exp(-x);
      })
      : signal.map((value, index) => value - heat[index]);
    const waveletX2exp = eigen
      ? spectralFilter(signal, eigen.values, eigen.vectors, (lambda) => {
        const x = scale * lambda;
        return x * x * Math.exp(-x);
      })
      : waveletXexp.map((value) => value * Math.min(scale, 4));

    for (let index = 0; index < usableNodes.length; index += 1) {
      const coefficient = Math.max(Math.abs(waveletXexp[index]), Math.abs(waveletX2exp[index]));
      nodeMaxCoefficient[index] = Math.max(nodeMaxCoefficient[index], coefficient);
      nodeWaveletEnergy[index] += waveletXexp[index] ** 2 + waveletX2exp[index] ** 2;
    }

    return {
      scale,
      heatEnergyRatio: round(sumSquares(heat) / Math.max(totalEnergy, EPSILON), 4),
      waveletXexpEnergyRatio: round(sumSquares(waveletXexp) / Math.max(totalEnergy, EPSILON), 4),
      waveletX2expEnergyRatio: round(sumSquares(waveletX2exp) / Math.max(totalEnergy, EPSILON), 4)
    };
  });

  const highFrequencyEnergyRatio = mean(scaleSummaries.map((summary) => summary.waveletXexpEnergyRatio + summary.waveletX2expEnergyRatio));
  const pprMean = mean(ppr);
  const pprMassConcentration = Math.max(...ppr) / Math.max(pprMean, EPSILON);
  const anomalyBase = zScores(nodeWaveletEnergy.map((energy, index) => energy + localRoughness[index] * 0.2 + ppr[index] * 0.5));
  const topNodes = usableNodes
    .map((node, index) => ({
      id: node.id,
      label: node.label || node.id,
      rawSignal: round(rawSignal[index], 3),
      standardizedSignal: round(standardized[index], 3),
      degree: round(degree[index], 3),
      pprMass: round(ppr[index], 4),
      localRoughness: round(localRoughness[index], 3),
      maxWaveletCoefficient: round(nodeMaxCoefficient[index], 3),
      anomalyScore: round(anomalyBase[index], 3)
    }))
    .sort((left, right) => right.anomalyScore - left.anomalyScore || right.maxWaveletCoefficient - left.maxWaveletCoefficient)
    .slice(0, 5);

  const state = highFrequencyEnergyRatio > 0.45 || roughnessRatio > 0.35
    ? "fragmented_need_signal"
    : topNodes[0]?.anomalyScore > 1.5
      ? "localized_shift"
      : "smooth_diffusion";

  return {
    method: useSpectral
      ? "Graph-PVI transfer: normalized-Laplacian spectral wavelet kernels xexp/x2exp + heat diffusion + PPR + graph roughness"
      : "Graph-PVI transfer: diffusion wavelet approximation + PPR + graph roughness",
    nodeCount: usableNodes.length,
    edgeCount,
    scales,
    graphRoughness: round(graphRoughness, 3),
    roughnessRatio: round(roughnessRatio, 4),
    totalEnergy: round(totalEnergy, 3),
    highFrequencyEnergyRatio: round(highFrequencyEnergyRatio, 4),
    pprMassConcentration: round(pprMassConcentration, 3),
    state,
    scaleSummaries,
    topNodes
  };
}
