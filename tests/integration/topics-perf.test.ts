/** Stage 6B §64 performance — isolated DB so 5000 items never pollute other tests */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type DB } from '../../server/src/db/client';
import { contentItems } from '../../server/src/db/schema';
import { LexicalFallbackEmbeddingProvider, lexicalEmbed } from '../../server/src/semantic/lexicalProvider';
import { defaultConfigFor } from '../../server/src/topics/config';
import { buildEdges, connectedComponents, validateClusters } from '../../server/src/topics/clustering';

let db: DB;
beforeAll(async () => { const { sqlite, db: d } = createTestDb(); sqlite.close; db = d; });
afterAll(() => { const anyDb = db as any; if (anyDb?.$client) anyDb.$client.close(); });

describe("§64 performance: 5000 embeddings", () => {
  it("neighbor retrieval + graph + clustering without O(n²) blowup", async () => {
    const cfg = defaultConfigFor("lexical");
    const N = 5000;
    const words = ["旅行", "美食", "编程", "健身", "电影", "音乐", "读书", "理财", "职场", "教育", "情侣", "旅游", "手机", "校园", "加班"];
    const vectors: number[][] = [];
    for (let i = 0; i < N; i++) {
      const w1 = words[i % words.length];
      const w2 = words[(i * 3 + 1) % words.length];
      const w3 = words[(i * 7 + 3) % words.length];
      vectors.push(lexicalEmbed(`${w1}${w2}话题讨论第${i}条 ${w3}相关内容分享`, 512));
    }
    const entries = vectors.map((vector, i) => ({ contentItemId: i, vector }));
    const t0 = Date.now();
    const edges = buildEdges(entries, cfg);
    const neighborMs = Date.now() - t0;
    const t1 = Date.now();
    const comps = connectedComponents(N, edges);
    const { clusters } = validateClusters(entries, comps, cfg);
    const clusterMs = Date.now() - t1;
    console.log(`[perf-6b] 5000 items: neighbor=${neighborMs}ms cluster=${clusterMs}ms edges=${edges.length} clusters≥min=${clusters.length}`);
    // 不能 O(n²) 爆炸:全流程预算 < 30s(实测应在数秒级)
    expect(neighborMs + clusterMs).toBeLessThan(30_000);
    // 图不是全连通垃圾:簇数在合理范围
    expect(clusters.length).toBeGreaterThan(1);
    expect(clusters.length).toBeLessThan(N / cfg.minClusterSize);
  }, 60_000);
});

