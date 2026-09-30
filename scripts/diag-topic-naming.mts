/**
 * 诊断:话题 AI 命名走本机 CLI 是否真的出得来名字(一次调用)。
 * 目的:证明 chatBridge → AiTopicNameProvider 这条路通,而不是只在单测里假设它通。
 */
import { writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { openDb } from "../server/src/db/client";
import { topics } from "../server/src/db/schema";
import { loadDotEnv } from "../server/src/env";
import { topicNameProviderIfConfigured } from "../server/src/topics/nameProvider";

loadDotEnv();
const db = openDb(process.argv[2] ?? "data/trendscope.db").db;
const topicId = Number(process.argv[3] ?? 8);

const [t] = await db.select().from(topics).where(eq(topics.id, topicId));
if (!t) {
  writeFileSync(".tmp-naming.txt", `话题 ${topicId} 不存在`, "utf8");
  process.exitCode = 1;
} else {
  const provider = topicNameProviderIfConfigured();
  const input = {
    keywords: JSON.parse(t.keywords || "[]") as string[],
    hashtags: JSON.parse(t.hashtags || "[]") as string[],
    representativeTitles: ["亚运会乒乓球混双决赛 王楚钦 孙颖莎 0-4 林诗栋 蒯曼", "孙颖莎赛后采访 后程体能跟不上", "国乒男团决赛 2-3 日本 丢掉八连冠"],
  };
  const result = provider ? await provider.generate(input) : null;
  writeFileSync(
    ".tmp-naming.txt",
    [
      `provider=${provider ? "configured" : "none"}`,
      `原名=${t.name}`,
      `结果=${JSON.stringify(result, null, 1)}`,
    ].join("\n"),
    "utf8",
  );
  console.log(`provider=${provider ? "configured" : "none"} named=${result ? "yes" : "no"}`);
  process.exitCode = 0;
}
