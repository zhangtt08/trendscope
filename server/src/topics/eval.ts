/**
 * Golden Topic Eval (Stage 6B §56-61) — Purity / Pairwise P/R/F1 / Noise Rate.
 * 聚类 ID 任意,Pairwise 才能回答"该在一起的在一起吗"(§57)。
 */
import { connectedComponents, buildEdges, clusterCohesion } from "./clustering";
import type { TopicClusteringConfig } from "./config";

export interface EvalMetrics {
  topicsFound: number;
  purity: number;
  pairwisePrecision: number;
  pairwiseRecall: number;
  pairwiseF1: number;
  noiseRate: number;
  averageCohesion: number;
}

interface ClusterResult {
  clusters: { members: number[]; cohesion: number }[];
  noise: number[];
}

/** 用与 pipeline 相同的图聚类路径跑 golden 文本(向量化由调用方注入) */
export function clusterGolden(vectors: number[][], cfg: TopicClusteringConfig): ClusterResult {
  const entries = vectors.map((vector, i) => ({ contentItemId: i, vector }));
  const edges = buildEdges(entries, cfg);
  const components = connectedComponents(entries.length, edges);
  const clusters: { members: number[]; cohesion: number }[] = [];
  const noise: number[] = [];
  for (const comp of components) {
    if (comp.length < cfg.minClusterSize) {
      noise.push(...comp);
      continue;
    }
    const { cohesion } = clusterCohesion(entries, comp);
    if (cohesion < cfg.minCohesion) {
      // 与 pipeline 一致:二次局部聚类一次(§13)
      const subEntries = comp.map((i) => entries[i]);
      const subCfg = { ...cfg, similarityThreshold: Math.min(0.98, cfg.similarityThreshold + 0.15) };
      const subEdges = buildEdges(subEntries, subCfg);
      const subComps = connectedComponents(subEntries.length, subEdges);
      let keptAny = false;
      for (const sc of subComps) {
        if (sc.length >= cfg.minClusterSize) {
          const { cohesion: ch } = clusterCohesion(subEntries, sc);
          if (ch >= cfg.minCohesion) {
            clusters.push({ members: sc.map((i) => comp[i]), cohesion: ch });
            keptAny = true;
          }
        }
      }
      if (!keptAny) noise.push(...comp);
    } else {
      clusters.push({ members: comp, cohesion });
    }
  }
  return { clusters, noise };
}

/** 全局成员对集合(同一真实标签的全部两两组合) */
function truthPairSet(labels: (string | null)[]): Set<string> {
  const byLabel = new Map<string, number[]>();
  labels.forEach((l, idx) => {
    if (l === null) return;
    let arr = byLabel.get(l);
    if (!arr) {
      arr = [];
      byLabel.set(l, arr);
    }
    arr.push(idx);
  });
  const pairs = new Set<string>();
  for (const members of byLabel.values()) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        pairs.add(`${members[i]}|${members[j]}`);
      }
    }
  }
  return pairs;
}

/**
 * §56 指标。labelsByCluster:每个簇的成员真实标签(噪声成员为 null)。
 */
export function evaluateClusters(
  labelsByCluster: (string | null)[][],
  noiseCount: number,
  totalItems: number,
  avgCohesion: number,
): EvalMetrics {
  // Purity
  let puritySum = 0;
  let clusteredCount = 0;
  for (const labels of labelsByCluster) {
    const counts = new Map<string, number>();
    for (const l of labels) if (l) counts.set(l, (counts.get(l) ?? 0) + 1);
    if (labels.length === 0) continue;
    puritySum += Math.max(0, ...counts.values());
    clusteredCount += labels.length;
  }
  const purity = clusteredCount > 0 ? puritySum / clusteredCount : 0;

  // Pairwise:全局唯一 id(簇内偏移 + 簇基址)
  let TP = 0;
  let FP = 0;
  let base = 0;
  const predicted = new Set<string>();
  for (const labels of labelsByCluster) {
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        predicted.add(`${base + i}|${base + j}`);
      }
    }
    base += labels.length;
  }
  const truth = new Set<string>();
  {
    // 重建全局标签数组
    const flat: (string | null)[] = [];
    for (const labels of labelsByCluster) flat.push(...labels);
    for (const p of truthPairSet(flat)) truth.add(p);
  }
  for (const p of predicted) {
    if (truth.has(p)) TP += 1;
    else FP += 1;
  }
  let FN = 0;
  for (const p of truth) FN += predicted.has(p) ? 0 : 1;

  const precision = TP + FP > 0 ? TP / (TP + FP) : 0;
  const recall = TP + FN > 0 ? TP / (TP + FN) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    topicsFound: labelsByCluster.length,
    purity,
    pairwisePrecision: precision,
    pairwiseRecall: recall,
    pairwiseF1: f1,
    noiseRate: totalItems > 0 ? noiseCount / totalItems : 0,
    averageCohesion: avgCohesion,
  };
}
