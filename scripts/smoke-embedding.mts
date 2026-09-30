#!/usr/bin/env node
/**
 * Live smoke for the embedding provider (Stage 6A §53). Independent of npm test.
 *
 * - EMBEDDING_API_KEY / EMBEDDING_BASE_URL / EMBEDDING_MODEL unset →
 *   SKIPPED_NO_CREDENTIAL, exit 0 (lexical fallback covers dev/test without keys).
 * - Configured → ONE minimal /embeddings request; verifies auth, response
 *   schema, dimension. NEVER prints the key.
 *
 * Usage: npm run smoke:embedding
 */
// .env 是本机唯一的配置入口(应用启动也走同一个加载器),冒烟脚本必须能看到它,否则填了 .env 仍会报 SKIPPED_NO_CREDENTIAL。
import { loadDotEnv } from "../server/src/env";

loadDotEnv();

const key = process.env.EMBEDDING_API_KEY;
const base = process.env.EMBEDDING_BASE_URL;
const model = process.env.EMBEDDING_MODEL;

const skipLive = !key || !base || !model;
if (skipLive) {
  console.log("SKIPPED_NO_CREDENTIAL — 需要 EMBEDDING_API_KEY + EMBEDDING_BASE_URL + EMBEDDING_MODEL;未配置时系统使用本地词法回退,功能不受阻。");
  process.exitCode = 0;
}

async function main() {
  console.log(`LIVE TEST — 最小 embedding 请求(model=${model},1 条输入)…`);
  const url = `${base.replace(/\/+$/, "")}/embeddings`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input: ["语义冒烟测试"] }),
  });
  if (!res.ok) {
    console.error(`FAIL — HTTP ${res.status}${res.status === 401 || res.status === 403 ? "(凭证无效或无权限)" : res.status === 429 ? "(频率受限)" : ""}`);
    process.exitCode = 1; return;
  }
  const body = await res.json();
  const v = body?.data?.[0]?.embedding;
  if (!Array.isArray(v) || v.length === 0) {
    console.error("FAIL — 响应缺少 data[0].embedding,schema 不符合 OpenAI 兼容协议");
    process.exitCode = 1; return;
  }
  const finite = v.every((x) => Number.isFinite(x));
  if (!finite) {
    console.error("FAIL — 向量含非有限值");
    process.exitCode = 1; return;
  }
  console.log("PASS — 官方兼容 API 认证与 schema 校验通过");
  console.log(`  维度: ${v.length}`);
  console.log("  Real Embedding Collected: 1(冒烟样本,未入库)");
  console.log("  Secret 已安全丢弃,未打印、未写入任何文件。");
  process.exitCode = 0;
}

if (!skipLive) main().catch((e) => {
  console.error(`FAIL — ${e && e.message ? e.message : String(e)}`);
  process.exitCode = 1; return;
});
