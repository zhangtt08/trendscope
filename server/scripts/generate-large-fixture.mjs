/**
 * Generates server/fixtures/large-dataset.json — ~5000 ContentItem-equivalent
 * rows used by the Stage 2 performance verification (spec §24).
 * Deterministic (seeded PRNG). Run: node server/scripts/generate-large-fixture.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "..", "fixtures", "large-dataset.json");

// mulberry32 — tiny seeded PRNG
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260924);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const int = (min, max) => Math.floor(min + rand() * (max - min + 1));

const TITLE_A = ["深夜", "日常", "探店", "教程", "测评", "开箱", "挑战", "日记", "合集", "盘点"];
const TITLE_B = ["牛肉面", "咖啡厅", "氛围灯", "机械键盘", "羽绒服", "露营", "骑行", "火锅", "咖啡渣", "蓝牙耳机"];
const TITLE_C = ["推荐", "避雷", "实测", "全攻略", "初体验", "深度报告", "一个月使用感受", "Top5"];
const BODY_PARTS = [
  "真实体验分享",
  "细节都在视频里",
  "评论区有问题必答",
  "关注看下集",
  "价格和链接如下",
  "避坑指南请收好",
  "数据都是实测的",
  "欢迎理性讨论",
];
const TAGS = ["测评", "探店", "好物分享", "生活记录", "数码", "美食", "穿搭", "旅行", "健身", "学习"];
const AUTHORS = ["观测者小王", "生活家老李", "测评员阿花", "极客老张", "夜猫子小赵", "吃货小刘", "旅人小陈", "学委小周"];

const rows = [];
const TOTAL = 5000;

for (let i = 0; i < TOTAL; i++) {
  const id = `big_${String(i).padStart(5, "0")}`;
  const title = `${pick(TITLE_A)}${pick(TITLE_B)}${pick(TITLE_C)}`;
  const tags = `${pick(TAGS)} #${pick(TAGS)}`;
  const body = `${pick(BODY_PARTS)}，${pick(BODY_PARTS)}。#${tags}`;
  const views = int(0, 2_500_000);
  const likes = int(0, Math.max(1, Math.floor(views * 0.08)));
  const day = int(1, 28);
  const month = int(1, 9);
  const row = {
    id,
    标题: title,
    正文: body,
    作者: pick(AUTHORS),
    发布时间: `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(int(0, 23)).padStart(2, "0")}:${String(int(0, 59)).padStart(2, "0")}:00`,
    播放量: String(views),
    点赞数: String(likes),
    评论数: String(int(0, 20_000)),
    分享数: String(int(0, 5_000)),
    收藏数: String(int(0, 30_000)),
    粉丝数: String(int(100, 5_000_000)),
  };
  row.话题 = tags;
  rows.push(row);
}

// 250 exact duplicates (id+metrics identical → dedup path, snapshot dedup check)
const dupSourceStart = 0;
for (let d = 0; d < 250; d++) {
  rows.push({ ...rows[dupSourceStart + d] });
}

// 100 id-less rows in 50 same-title/author/day pairs → 50 fingerprint candidates
for (let p = 0; p < 50; p++) {
  const shared = {
    标题: `无ID疑似重复压测标题第${p}组`,
    正文: "压测候选生成",
    作者: `压测作者${p % 7}`,
    发布时间: `2026-08-${String((p % 28) + 1).padStart(2, "0")} 12:00:00`,
    播放量: String(int(10, 9_999)),
  };
  rows.push({ ...shared, note_variant: "A" });
  rows.push({ ...shared, note_variant: "B" });
}

const fixture = {
  name: "large-dataset",
  platform: "weibo",
  sourceType: "fixture",
  sourceTimezone: "Asia/Shanghai",
  mapping: {
    platform: "platform",
    platformContentId: "id",
    title: "标题",
    text: "正文",
    hashtags: "话题",
    authorName: "作者",
    publishedAt: "发布时间",
    views: "播放量",
    likes: "点赞数",
    comments: "评论数",
    shares: "分享数",
    favorites: "收藏数",
    authorFollowers: "粉丝数",
  },
  rows,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(fixture), "utf-8");
console.log(`written: ${OUT} — ${rows.length} rows, ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)} MB`);
