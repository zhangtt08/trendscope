/**
 * Stage 6A §52 — OpenAICompatibleEmbeddingProvider contract tests over a
 * Replay transport. No public network. Covers: request schema, batch,
 * response vector validation, auth header, secret redaction, errors.
 */
import { describe, it, expect } from "vitest";
import { OpenAICompatibleEmbeddingProvider } from "../../server/src/semantic/openaiProvider";
import type { HttpTransport } from "../../server/src/connectors/httpClient";

const SECRET = "test-embedding-key-NOT-REAL";

interface Recorded extends HttpTransport {
  urls: string[];
  headerLog: Record<string, Record<string, string>>;
  bodies: unknown[];
}

function replay(responses: { status: number; body: unknown }[]): Recorded {
  let i = 0;
  const t = Object.assign(
    async (url: string, init: { headers?: Record<string, string> }) => {
      t.urls.push(url);
      t.headerLog[url] = init.headers ?? {};
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return { status: r.status, body: r.body };
    },
    { urls: [] as string[], headerLog: {} as Record<string, Record<string, string>>, bodies: [] as unknown[] },
  );
  return t;
}

function makeProvider(transport: Recorded, dim?: number) {
  // Config carries a secretref — the provider resolves via SecretResolver;
  // credential env is managed per-test (see setCredential/clearCredential).
  return new OpenAICompatibleEmbeddingProvider(
    {
      baseUrl: "http://replay.test/v1",
      model: "text-embedding-test",
      apiKeySecretRef: "secretref:env:EMBEDDING_API_KEY",
      ...(dim ? { dimension: dim } : {}),
      batchSize: 4,
    },
    { transport, clock: () => 1742822400 },
  );
}

function setCredential(v: string | null): void {
  if (v === null) delete process.env.EMBEDDING_API_KEY;
  else process.env.EMBEDDING_API_KEY = v;
}

describe("§52 OpenAI-compatible contract (replay)", () => {
  it("sends auth header + model + input array to {baseUrl}/embeddings", async () => {
    setCredential(SECRET);
    const transport = replay([
      { status: 200, body: { data: [{ embedding: [0.1, 0.2, 0.3] }] } },
    ]);
    const p = makeProvider(transport);
    const v = await p.embed("hello world");
    expect(v).toEqual([0.1, 0.2, 0.3]);
    expect(transport.urls[0]).toBe("http://replay.test/v1/embeddings");
    const headers = Object.values(transport.headerLog)[0];
    expect(headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("embedBatch respects provider batchSize declaration and preserves order", async () => {
    setCredential(SECRET);
    // dimension 未声明时由响应决定(首个向量长度),并做一致性校验
    const transport = replay([
      {
        status: 200,
        body: {
          // 返回时乱序 index,provider 必须按 index 恢复顺序
          data: [
            { embedding: [0, 0, 0, 3], index: 2 },
            { embedding: [0, 0, 2, 0], index: 1 },
            { embedding: [1, 0, 0, 0], index: 0 },
          ],
        },
      },
    ]);
    const p = makeProvider(transport);
    expect(p.batchSize).toBe(4);
    const out = await p.embedBatch(["a", "b", "c"]);
    expect(out[0]).toEqual([1, 0, 0, 0]);
    expect(out[1]).toEqual([0, 0, 2, 0]);
    expect(out[2]).toEqual([0, 0, 0, 3]);
  });

  it("count mismatch / dimension mismatch → INVALID_RESPONSE", async () => {
    setCredential(SECRET);
    const p = makeProvider(
      replay([{ status: 200, body: { data: [{ embedding: [1, 2] }, { embedding: [1, 2, 3, 4] }] } }]),
    );
    // 声明式维度未给出 → 由首条响应(2 维)确定;第二条 4 维 ≠ 2 → 维度不一致
    await expect(p.embedBatch(["a", "b"])).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const p2 = makeProvider(
      replay([{ status: 200, body: { data: [{ embedding: [1, 2, 3, 4] }, { embedding: [1, 2, 3] }] } }]),
    );
    await expect(p2.embedBatch(["a", "b"])).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("HTTP 401 → AUTH_ERROR; 429 → RATE_LIMITED; secret never in error text", async () => {
    setCredential(SECRET);
    const p1 = makeProvider(replay([{ status: 401, body: {} }]));
    await expect(p1.embed("x")).rejects.toMatchObject({ code: "AUTH_ERROR" });
    const p2 = makeProvider(replay([{ status: 429, body: {} }]));
    await expect(p2.embed("x")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    try {
      const p3 = makeProvider(replay([{ status: 401, body: {} }]));
      await p3.embed("x");
    } catch (e) {
      expect(String(e)).not.toContain(SECRET);
    }
  });

  it("missing credential → INVALID_CONFIG before any request", async () => {
    delete process.env.EMBEDDING_API_KEY;
    const transport = replay([]);
    const p = makeProvider(transport);
    expect(p.validateConfig().ok).toBe(false);
    await expect(p.embed("x")).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    expect(transport.urls.length).toBe(0); // 请求从未发出
    process.env.EMBEDDING_API_KEY = SECRET;
  });
});
