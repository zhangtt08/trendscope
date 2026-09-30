# TrendScope

**English** | [简体中文](./README.zh-CN.md)

Tracking content trends across Douyin, Xiaohongshu, Zhihu, Bilibili and Weibo usually means scattered screenshots, spreadsheets and gut feeling. TrendScope replaces that with one local SQLite database: content from six channels is normalized and deduplicated into it, scored for breakout potential and topic opportunity, and turned into AI topic plans that must cite their evidence.

> **A local-first content trend & topic-decision workbench — six-platform content ingestion, breakout/lifecycle/opportunity scoring, and evidence-traceable AI topic plans. Your data never leaves your machine.**
>
> **本地优先的内容趋势与选题决策工作台：六平台内容标准化入库，算出爆发指数与机会指数，生成可溯源的 AI 选题方案。数据不出本机。**

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-Windows-blue)
![Node](https://img.shields.io/badge/node-%E2%89%A520.19-green)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)
![React](https://img.shields.io/badge/React-18-61DAFB)
![SQLite](https://img.shields.io/badge/SQLite-WAL%20%2B%20Drizzle-003B57)

## ✨ Features

- **Six-platform ingestion, one local database** — Douyin / Xiaohongshu / Zhihu / Bilibili / Weibo aggregator channels plus CSV / JSON / manual import, normalized into SQLite (WAL mode). Dedup is layered: platform + content ID → canonical URL (tracking params stripped) → fingerprint; fingerprint matches are only *flagged* as suspected duplicates and require human confirmation to merge.
- **One-click analysis pipeline** — vectorization → topic clustering → content scoring → topic trends → content intelligence → opportunity index. Each step reports progress, skip reasons or failure reasons; a failed step never rolls back already-computed results.
- **Explainable scores** — every index expands to its component breakdown, effective weights, positive signals and limiting factors. Missing values display `—`, never 0; unscorable topics say "insufficient data".
- **Evidence-traceable AI topic plans (optional)** — without an API key the topic studio provides deterministic evidence summaries; with one, AI-generated plans must cite evidence IDs, and unsupported sentences are flagged instead of passed off as model conclusions.
- **Desktop feel on Windows** — double-click `start-trendscope.bat`: it installs deps, builds, and opens a native window (own taskbar entry and icon, built with the OS-bundled C# compiler — no Visual Studio, no admin rights). Closing the window stops the service.
- **Secrets stay local** — API keys live only in `.env`, are never returned to the frontend, and never appear in responses, logs or run events. All external capabilities (Zhihu API, embeddings, AI plans) are optional; without them the app uses clearly-labeled deterministic fallbacks.
- **Zero-credential demo mode** — `npm run demo` runs a separate demo database with a simulated remote source, so you can walk the full ingest → analyze → decide pipeline before configuring anything.
- **Self-check and release gate** — `npm run doctor` (Node version, native modules, data dir, migrations, secrets, port, build artifacts, backups) and `npm run verify:release` (metadata + config templates + static scan + types + build + full tests + DB health, ~8–10 min).

## 🚀 Quick Start

**Prerequisites:** Node.js 20.19+ / 22.x / 24.x. No Docker, no external database — first launch creates and migrates `data/trendscope.db` automatically.

```bash
git clone https://github.com/zhangtt08/trendscope.git
cd trendscope
npm install
npm run build
npm start            # → http://localhost:5184
```

Windows one-click: double-click `start-trendscope.bat` instead. Port taken? `set PORT=5199 && npm start` (cmd) or `$env:PORT='5199'; npm start` (PowerShell).

Want a look before configuring anything?

```bash
npm run demo         # separate demo DB, port 5185, simulated remote source, zero platform credentials
npm run demo:reset   # wipe and reload the demo DB
```

Optional keys: copy `.env.example` to `.env` and fill in what you have (Zhihu `ZHIHU_ACCESS_SECRET`, embeddings `EMBEDDING_*`, AI plans `STUDIO_*`). Restart to apply; the UI tells you exactly which variable is missing when something is unconfigured.

## 🏗️ Architecture

Express API + React SPA over a single SQLite file (better-sqlite3, WAL, Drizzle-managed migrations):

```
server/src/domain     constants & scoring rules
server/src/adapters   platform content normalization
server/src/services   import / collection / analysis pipelines
server/src/db         schema, connection, migrations
drizzle/              SQL migrations
src/                  React frontend (Vite, TypeScript strict)
desktop/              Windows native shell (C#; Tauri variant also present)
tests/                Vitest: unit + integration + frontend components
docs/                 architecture, scoring models, decision records
```

The UI (Chinese) is ordered by actual usage: data overview · import · content browser · dedup · collection · semantics · topics · trends · opportunities · content candidates · topic studio · opportunity model · settings. Raw payloads are kept in `raw_records`, so every normalized row can be traced back to its source.

## 📄 License

[MIT](./LICENSE) © 2026 zhangtt08
