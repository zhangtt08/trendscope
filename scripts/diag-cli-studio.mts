/**
 * 诊断:把工作室真实提示词喂给本机 CLI,把模型原文与 schema 校验结果写到文件。
 * 只读库,不写任何业务数据;目的是回答"AI 输出不合 schema 到底不合在哪"。
 */
import { writeFileSync } from "node:fs";
import { openDb } from "../server/src/db/client";
import { loadDotEnv } from "../server/src/env";
import { buildEvidencePackage } from "../server/src/studio/evidencePackage";
import { buildStudioMessages } from "../server/src/studio/prompt";
import { localCliChat } from "../server/src/studio/localCli";
import { extractJsonObject } from "../server/src/studio/provider";
import { studioOutputSchema } from "../server/src/studio/schema";

loadDotEnv();
const file = process.argv[2] ?? "data/trendscope.db";
const topicId = Number(process.argv[3] ?? 8);

const handle = openDb(file);
const db = handle.db;

const pkg = await buildEvidencePackage(db, topicId);
if (!pkg) {
  writeFileSync(".tmp-cli-raw.txt", `话题 ${topicId} 不存在`, "utf8");
  console.log("topic missing");
  process.exitCode = 1;
} else {
const messages = buildStudioMessages(pkg);
const prompt = messages.map((m) => `${m.role}:\n${m.content}`).join("\n\n");

let raw = "";
let spawnError = "";
try {
  raw = await localCliChat(prompt);
} catch (e) {
  spawnError = e instanceof Error ? `${e.name}:${e.message}` : String(e);
}

let parsed = "";
if (raw) {
  try {
    const checked = studioOutputSchema.safeParse(extractJsonObject(raw));
    parsed = checked.success
      ? "SCHEMA OK\n" + JSON.stringify(checked.data, null, 1).slice(0, 1500)
      : "SCHEMA FAIL\n" + JSON.stringify(checked.error.issues.slice(0, 12), null, 1);
  } catch (e) {
    parsed = "NO JSON: " + (e instanceof Error ? e.message : String(e));
  }
}

writeFileSync(
  ".tmp-cli-raw.txt",
  [
    `promptChars=${prompt.length}`,
    `spawnError=${spawnError}`,
    `rawChars=${raw.length}`,
    "---------------- RAW (first 3000) ----------------",
    raw.slice(0, 3000),
    "---------------- PARSE ----------------",
    parsed,
  ].join("\n"),
  "utf8",
);
console.log(`done promptChars=${prompt.length} rawChars=${raw.length} spawnError=${spawnError ? "yes" : "no"}`);
process.exitCode = 0;
}
