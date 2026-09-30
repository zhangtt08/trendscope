/**
 * Similarity graph clustering (Stage 6B §7/§8/§13-16).
 *
 * 邻居检索策略(§8 禁全量 O(n²) 精确比较):
 *   1. **确定性随机投影预筛**(JL 引理):全部向量经 seeded Gaussian 投影到
 *      32 维(可重复,§6),预筛点积 ~ threshold-margin 的对才进入精算;
 *      32 维全配对 = 2500 万 × 32 ≈ 8 亿次乘加,JS 约 1-3s(实测见 benchmark)。
 *   2. 精确 cosine 复核(512 维,仅候选对)。
 *   3. 每节点最多保留 neighborLimit 条 ≥threshold 的边(§8)。
 * 然后并查集连通分量 → cluster validation → cohesion → representative。
 */
import { CLUSTERING_ALGORITHM_VERSION } from "./config";
import type { TopicClusteringConfig } from "./config";

export interface VectorEntry {
  contentItemId: number;
  vector: number[];
}

export interface GraphEdge {
  a: number; // index into entries
  b: number;
  similarity: number;
}

export interface RawCluster {
  memberIndexes: number[];
  cohesion: number;
  /** 代表内容:与簇内其它成员平均 cosine 最高的前 3(§15 medoid,非点赞) */
  representativeIndexes: number[];
}

/* ---------------- deterministic projection (§6 可重复) ---------------- */

/** mulberry32 seeded PRNG — 同 seed 永远同一投影矩阵 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  // Box-Muller
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const PROJECTION_DIM = 32;
const PROJECTION_MARGIN = 0.12; // 预筛阈值下探余量(JL 误差界 + 浮点安全)

function projectMatrix(vectors: number[][]): Float32Array {
  const n = vectors.length;
  const d = vectors[0]?.length ?? 0;
  const rand = mulberry32(0x5eed6b6b); // 固定 seed:可复现(§6)
  const proj = new Float32Array(PROJECTION_DIM * d);
  for (let i = 0; i < proj.length; i++) proj[i] = gaussian(rand);
  const out = new Float32Array(n * PROJECTION_DIM);
  for (let i = 0; i < n; i++) {
    const v = vectors[i];
    for (let p = 0; p < PROJECTION_DIM; p++) {
      let acc = 0;
      const off = p * d;
      for (let k = 0; k < d; k++) acc += v[k] * proj[off + k];
      out[i * PROJECTION_DIM + p] = acc;
    }
  }
  return out;
}

export function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/* ---------------- sparse vectors (§64 性能路径) ---------------- */

export interface SparseVector {
  /** 升序的非零维度下标 */
  idx: Int32Array;
  val: Float64Array;
}

/**
 * 稠密 → 稀疏。词法向量只有 ~5% 维度非零,而精确复核要为每一对扫完 512 维:
 * n=5000 时是 1250 万 × 512 ≈ 64 亿次乘加,绝大多数在乘 0。
 *
 * 稀疏点积按升序遍历两侧共有的非零下标,与原稠密循环的累加顺序完全一致
 * (被跳过的项都是 + 0.0,对 IEEE 双精度是精确无副作用的),所以输出逐位不变。
 */
export function toSparse(v: readonly number[]): SparseVector {
  const idx: number[] = [];
  const val: number[] = [];
  for (let i = 0; i < v.length; i++) {
    if (v[i] !== 0) {
      idx.push(i);
      val.push(v[i]);
    }
  }
  return { idx: Int32Array.from(idx), val: Float64Array.from(val) };
}

export function sparseDot(a: SparseVector, b: SparseVector): number {
  let s = 0;
  let i = 0;
  let j = 0;
  const an = a.idx.length;
  const bn = b.idx.length;
  while (i < an && j < bn) {
    const ai = a.idx[i];
    const bj = b.idx[j];
    if (ai === bj) {
      s += a.val[i] * b.val[j];
      i++;
      j++;
    } else if (ai < bj) {
      i++;
    } else {
      j++;
    }
  }
  return s;
}

export function norm(a: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s);
}

/* ---------------- edge building (§7/§8) ---------------- */

export function buildEdges(entries: VectorEntry[], cfg: TopicClusteringConfig): GraphEdge[] {
  const n = entries.length;
  if (n < 2) return [];
  const projected = projectMatrix(entries.map((e) => e.vector));
  const coarseThreshold = Math.max(0.01, cfg.similarityThreshold - PROJECTION_MARGIN);
  // 投影向量范数缓存(每条算一次,省一半预筛计算)
  const projNorms = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let p = 0; p < PROJECTION_DIM; p++) {
      const x = projected[i * PROJECTION_DIM + p];
      s += x * x;
    }
    projNorms[i] = Math.sqrt(s);
  }

  // per-node top-(neighborLimit) 邻居(§8);候选来自预筛
  const neighbors: Map<number, { j: number; sim: number }[]> = new Map();
  const push = (i: number, j: number, sim: number) => {
    let list = neighbors.get(i);
    if (!list) {
      list = [];
      neighbors.set(i, list);
    }
    list.push({ j, sim });
  };

  // 原向量范数预计算(精确复核阶段每对只需一次点积;范数每对重算在 n 大时是热点)
  const vecNorms = new Float64Array(n);
  for (let i = 0; i < n; i++) vecNorms[i] = norm(entries[i].vector);

  // ---- 预筛热点(n=5000 时 1250 万对 × 32 维) ----
  // 每行提成独立的 Float64Array,并把 i 行的 32 个分量提到局部常量:内层只剩
  // "读 j 行 + 乘加",省掉一半内存读取与全部 io+p 下标运算。Float32 → Float64
  // 是精确转换,累加顺序仍是 p=0..31 从左到右,所以候选集与边集逐位不变。
  // (判据由 coarse/(|pi||pj|) < t 改为等价的 coarse < t·|pi|·|pj|,少 1250 万次除法;
  //  已用 5000×512 的边集校验和验证输出完全一致。)
  const projRows: Float64Array[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const row = new Float64Array(PROJECTION_DIM);
    const io = i * PROJECTION_DIM;
    for (let p = 0; p < PROJECTION_DIM; p++) row[p] = projected[io + p];
    projRows[i] = row;
  }
  const limitScale = new Float64Array(n); // coarseThreshold · |proj_i|
  for (let i = 0; i < n; i++) limitScale[i] = coarseThreshold * projNorms[i];
  // 精确复核走稀疏点积:512 维里平均只有 ~28 维非零
  const sparse: SparseVector[] = new Array(n);
  for (let i = 0; i < n; i++) sparse[i] = toSparse(entries[i].vector);

  for (let i = 0; i < n; i++) {
    if (projNorms[i] === 0) continue;
    const si = sparse[i];
    const ni = vecNorms[i];
    const limitBase = limitScale[i];
    const A = projRows[i];

    for (let j = i + 1; j < n; j++) {
      if (projNorms[j] === 0) continue;
      const B = projRows[j];
      const coarse =
        A[0] * B[0] + A[1] * B[1] + A[2] * B[2] + A[3] * B[3] +
        A[4] * B[4] + A[5] * B[5] + A[6] * B[6] + A[7] * B[7] +
        A[8] * B[8] + A[9] * B[9] + A[10] * B[10] + A[11] * B[11] +
        A[12] * B[12] + A[13] * B[13] + A[14] * B[14] + A[15] * B[15] +
        A[16] * B[16] + A[17] * B[17] + A[18] * B[18] + A[19] * B[19] +
        A[20] * B[20] + A[21] * B[21] + A[22] * B[22] + A[23] * B[23] +
        A[24] * B[24] + A[25] * B[25] + A[26] * B[26] + A[27] * B[27] +
        A[28] * B[28] + A[29] * B[29] + A[30] * B[30] + A[31] * B[31];
      if (coarse < limitBase * projNorms[j]) continue;

      // 精确复核(范数已预计算,累加顺序与旧实现一致,输出逐位相同)
      const sim = sparseDot(si, sparse[j]) / (ni * vecNorms[j] || 1);
      if (sim >= cfg.similarityThreshold) {
        push(i, j, sim);
        push(j, i, sim);
      }
    }
  }

  // 每节点截断到 neighborLimit(取最高相似度)
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const [i, list] of neighbors) {
    list.sort((x, y) => y.sim - x.sim);
    const kept = list.slice(0, cfg.neighborLimit);
    for (const { j, sim } of kept) {
      const key = i < j ? `${i}:${j}` : `${j}:${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ a: Math.min(i, j), b: Math.max(i, j), similarity: sim });
    }
  }
  return edges;
}

/* ---------------- connected components (§7) ---------------- */

export function connectedComponents(n: number, edges: GraphEdge[]): number[][] {
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (x: number, y: number) => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent[rx] = ry;
  };
  for (const e of edges) union(e.a, e.b);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) {
      g = [];
      groups.set(r, g);
    }
    g.push(i);
  }
  return [...groups.values()];
}

/* ---------------- cohesion + representative (§14/§15) ---------------- */

export function clusterCohesion(entries: VectorEntry[], memberIndexes: number[]): {
  cohesion: number;
  representativeIndexes: number[];
} {
  if (memberIndexes.length === 0) return { cohesion: 0, representativeIndexes: [] };
  if (memberIndexes.length === 1) return { cohesion: 1, representativeIndexes: [memberIndexes[0]] };

  // 平均向量(medoid 思路的质心)
  const dim = entries[0].vector.length;
  const centroid = new Array<number>(dim).fill(0);
  for (const idx of memberIndexes) {
    const v = entries[idx].vector;
    for (let k = 0; k < dim; k++) centroid[k] += v[k];
  }
  for (let k = 0; k < dim; k++) centroid[k] /= memberIndexes.length;

  // 每个成员与质心的 cosine(全为归一化向量,centroid 需自归一)
  const cNorm = norm(centroid) || 1;
  const sims = memberIndexes.map((idx) => {
    const v = entries[idx].vector;
    let s = 0;
    for (let k = 0; k < dim; k++) s += v[k] * centroid[k];
    return s / (cNorm * (norm(v) || 1));
  });

  // cohesion = 平均代表相似度(与质心的平均 cosine)——透明可解释(§14)
  let sum = 0;
  for (const s of sims) sum += s;
  const cohesion = Math.max(0, Math.min(1, sum / sims.length));

  // representative:与质心最接近的 top3(§15)
  const order = memberIndexes
    .map((idx, i) => ({ idx, sim: sims[i] }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 3)
    .map((x) => x.idx);

  return { cohesion, representativeIndexes: order };
}

/* ---------------- cluster validation (§11/§13) ---------------- */

export interface ValidatedCluster extends RawCluster {
  /** ok=正常;giant=超 maxClusterSize;incohesive=低于 minCohesion;noise=低于 minClusterSize */
  verdict: "ok" | "giant" | "incohesive" | "noise";
}

export function validateClusters(
  entries: VectorEntry[],
  components: number[][],
  cfg: TopicClusteringConfig,
): { clusters: ValidatedCluster[]; noiseIndexes: number[] } {
  const clusters: ValidatedCluster[] = [];
  const noiseIndexes: number[] = [];
  for (const comp of components) {
    if (comp.length < cfg.minClusterSize) {
      noiseIndexes.push(...comp);
      continue;
    }
    const { cohesion, representativeIndexes } = clusterCohesion(entries, comp);
    let verdict: ValidatedCluster["verdict"] = "ok";
    if (comp.length > cfg.maxClusterSize) verdict = "giant";
    else if (cohesion < cfg.minCohesion) verdict = "incohesive";
    clusters.push({ memberIndexes: comp, cohesion, representativeIndexes, verdict });
  }
  return { clusters, noiseIndexes };
}

export const GRAPH_VERSION = CLUSTERING_ALGORITHM_VERSION;
