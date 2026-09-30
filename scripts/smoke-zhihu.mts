#!/usr/bin/env node
/**
 * Live smoke for the Zhihu Official Connector (Stage 5 §44/§45).
 *
 * - No ZHIHU_ACCESS_SECRET in env → prints SKIPPED_NO_CREDENTIAL, exit 0.
 *   (普通 npm test 永不依赖知乎服务器;本脚本是独立入口。)
 * - Secret present → ONE minimal official API call (zhihu_search Count=1),
 *   verifies authentication + response schema + a normalization sample.
 * - NEVER prints the token; secret exists only inside this process.
 *
 * Usage: npm run smoke:zhihu
 */
// .env 是本机唯一的配置入口(应用启动也走同一个加载器),冒烟脚本必须能看到它,否则填了 .env 仍会报 SKIPPED_NO_CREDENTIAL。
import { loadDotEnv } from "../server/src/env";

loadDotEnv();

const API = "https://developer.zhihu.com/api/v1/content/zhihu_search";

const secret = process.env.ZHIHU_ACCESS_SECRET;

// 无凭证不是失败:打印 SKIPPED 并跳过实连(不让它继续发请求,也不靠强制退出)
const skipLive = !secret || secret.trim().length === 0;
if (skipLive) {
  console.log("SKIPPED_NO_CREDENTIAL — ZHIHU_ACCESS_SECRET 未设置;Contract 测试已覆盖 Connector 正确性。");
}

function classify(body) {
  if (body && typeof body === "object" && "Code" in body) return body.Code;
  return undefined;
}

async function main() {
  console.log("LIVE TEST — 请求知乎官方 API(最小查询,zhihu_search Count=1)…");
  const url = `${API}?Query=${encodeURIComponent("知乎")}&Count=1`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${secret}`,
      "X-Request-Timestamp": String(Math.floor(Date.now() / 1000)),
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    console.error(`FAIL — HTTP ${res.status}(${res.status === 401 || res.status === 403 ? "凭证无效或无权限" : "外部错误"})`);
    process.exitCode = 1; return;
  }

  const body = await res.json();
  const code = classify(body);
  if (code === 20001) {
    console.error("FAIL — Invalid Credential(官方 Code 20001 鉴权失败)");
    process.exitCode = 1; return;
  }
  if (code === 30001) {
    console.error("FAIL — Rate Limited(官方 Code 30001,当日额度/频率受限)");
    process.exitCode = 1; return;
  }
  if (code !== 0) {
    console.error(`FAIL — 其他官方错误 Code=${code}: ${body.Message ?? ""}`);
    process.exitCode = 1; return;
  }

  const items = body?.Data?.Items;
  if (!Array.isArray(items) || items.length === 0) {
    console.error("FAIL — 响应 schema 不符合预期(Data.Items 为空或缺失)");
    process.exitCode = 1; return;
  }
  const first = items[0];
  const okSchema =
    typeof first.ContentID === "string" &&
    typeof first.Title === "string" &&
    typeof first.VoteUpCount === "number" &&
    typeof first.Url === "string";
  if (!okSchema) {
    console.error("FAIL — Item 核心字段(ContentID/Title/VoteUpCount/Url)缺失或变形 → 官方 schema 可能已变更");
    process.exitCode = 1; return;
  }

  // normalization sample(与 ZhihuSourceAdapter 相同的核心映射规则)
  const upvotes = Number(first.VoteUpCount);
  const comments = Number(first.CommentCount);
  const published = first.EditTime ? new Date(first.EditTime * 1000).toISOString() : null;

  console.log("PASS — 官方 API 认证与 schema 校验通过");
  console.log(`  采集样例: 1 条(Type: ${first.ContentType ?? "?"})`);
  console.log(`  归一化: upvotes=${upvotes}(→ upvotes 字段) comments=${comments} publishedAt=${published}`);
  console.log("  Real Data Collected: 1(冒烟样本,仅验证链路,未入库)");
  console.log("  Secret 已安全丢弃,未打印、未写入任何文件。");
  process.exitCode = 0;
}

if (!skipLive) main().catch((e) => {
  console.error(`FAIL — ${e && e.message ? e.message : String(e)}`);
  process.exitCode = 1; return;
});
