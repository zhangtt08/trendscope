/**
 * Topic quality evaluation (Stage 6B §60): npm run eval:topics
 * Runs the SAME graph-clustering path on the golden Chinese dataset with the
 * Lexical Fallback and reports Purity / Pairwise P/R/F1 / Noise.
 * §58: thresholds are the product defaults, never tuned for the dataset.
 */
import { lexicalEmbed } from "../server/src/semantic/lexicalProvider";
import { cosineSimilarity } from "../server/src/semantic/vectors";
import { defaultConfigFor } from "../server/src/topics/config";
import { clusterGolden, evaluateClusters } from "../server/src/topics/eval";
import { GOLDEN_ALL } from "../server/src/topics/goldenDataset";

const mode = "Lexical Baseline";
const cfg = defaultConfigFor("lexical");
const vectors = GOLDEN_ALL.map((g) => lexicalEmbed(g.text, 512));
const { clusters, noise } = clusterGolden(vectors, cfg);
const labelsByCluster = clusters.map((c) => c.members.map((i) => GOLDEN_ALL[i].expectedTopicLabel as string));
const avgCohesion = clusters.length ? clusters.reduce((a, b) => a + b.cohesion, 0) / clusters.length : 0;
const m = evaluateClusters(labelsByCluster, noise.length, GOLDEN_ALL.length, avgCohesion);

console.log("Mode:");
console.log(`  ${mode}`);
console.log("Topics:");
console.log(`  ${m.topicsFound}`);
console.log("Pairwise Precision:");
console.log(`  ${(m.pairwisePrecision * 100).toFixed(1)}%`);
console.log("Pairwise Recall:");
console.log(`  ${(m.pairwiseRecall * 100).toFixed(1)}%`);
console.log("Pairwise F1:");
console.log(`  ${(m.pairwiseF1 * 100).toFixed(1)}%`);
console.log("Purity:");
console.log(`  ${(m.purity * 100).toFixed(1)}%`);
console.log("Noise:");
console.log(`  ${(m.noiseRate * 100).toFixed(1)}%`);
console.log("Average Cohesion:");
console.log(`  ${(m.averageCohesion * 100).toFixed(1)}%`);
console.log(`(dataset: ${GOLDEN_ALL.length} items, 6 true topics + noise; thresholds = product defaults)`);
