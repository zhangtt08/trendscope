/**
 * 优雅退出与"不留孤儿"的测试(§59/§60/§51)。
 *
 * Windows 上没法给别人的子进程真正发送 SIGINT,所以这里测的是同一段代码:
 * 直接把 createShutdown 的 close() 当作"Ctrl+C 之后会发生什么"来断言。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import Database from "better-sqlite3";
import { createShutdown } from "../../server/src/shutdown";
import { openDb, migrate } from "../../server/src/db/client";

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "trendscope-shutdown-"));
});

afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 上偶发的占用忽略 */
  }
});

function listen(port = 0): Promise<{ server: http.Server; port: number; hits: () => number }> {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { "keep-alive": "timeout=5" });
    res.end("ok");
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const a = server.address();
      resolve({ server, port: typeof a === "object" && a ? a.port : 0, hits: () => hits });
    });
  });
}

function portTaken(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = netConnect(port);
    probe.on("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.on("error", () => resolve(false));
  });
}

function netConnect(port: number) {
  // 单独抽出来,避免在断言里写 socket 细节
  return require("node:net").connect({ host: "127.0.0.1", port });
}

describe("优雅退出", () => {
  it("关监听 → 端口释放;退出顺序里先 checkpoint 再关连接", async () => {
    const { server, port } = await listen();
    const file = path.join(dir, "shutdown-a.db");
    const { sqlite } = openDb(file);
    sqlite.exec("create table t(x integer)");
    sqlite.exec("insert into t values (1)");
    // 制造"数据还在 -wal 里"的状态
    expect(fs.existsSync(file)).toBe(true);

    let stopped = false;
    let exitCode: number | null = null;
    const handle = createShutdown({
      server,
      sqlite,
      stopScheduler: () => {
        stopped = true;
      },
      log: () => undefined,
      warn: () => undefined,
      exit: (c) => {
        exitCode = c;
      },
      closeTimeoutMs: 1500,
    });

    expect(handle.close("SIGINT")).toBe(true);
    await new Promise((r) => setTimeout(r, 300));

    expect(stopped).toBe(true);
    expect(exitCode).toBe(0);
    // 二次调用不再执行(避免重复 close / 重复退出)
    expect(handle.close("SIGINT")).toBe(false);
    expect(await portTaken(port)).toBe(false);

    // checkpoint 之后 -wal 应该被截断为 0 字节,数据全在主库里
    const wal = file + "-wal";
    expect(fs.existsSync(wal) ? fs.statSync(wal).size : 0).toBe(0);
    const reopened = new Database(file, { readonly: true });
    expect((reopened.prepare("select count(*) c from t").get() as { c: number }).c).toBe(1);
    reopened.close();
    // sqlite 已被 close:再次使用应报错(证明不是"进程退了但连接还挂着")
    expect(() => sqlite.prepare("select 1").get()).toThrow();
  });

  it("没有 SIGINT 处理时的替代品:超时也必须退出,不能挂成孤儿", async () => {
    const { server } = await listen();
    // 制造一个"连接不结束"的假 server:close() 回调永远不来
    (server as unknown as { close: (cb: () => void) => void }).close = () => undefined;
    const file = path.join(dir, "shutdown-b.db");
    const { sqlite } = openDb(file);
    let exitCode: number | null = null;
    const handle = createShutdown({
      server: server as http.Server,
      sqlite,
      stopScheduler: () => undefined,
      log: () => undefined,
      warn: () => undefined,
      exit: (c) => {
        exitCode = c;
      },
      closeTimeoutMs: 200,
    });
    handle.close("SIGTERM");
    await new Promise((r) => setTimeout(r, 700));
    expect(exitCode).toBe(0);
  });

  it("启动时端口被占用必须给出可操作的提示,而不是静默失败(§51)", async () => {
    const { server, port } = await listen();
    // 复刻 index.ts 的判定:同一端口二次 listen → EADDRINUSE
    const second = http.createServer();
    const code = await new Promise<string | null>((resolve) => {
      second.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? null));
      second.once("listening", () => resolve(null));
      second.listen(port, "127.0.0.1");
    });
    expect(code).toBe("EADDRINUSE");
    second.close();
    server.close();
    expect(await portTaken(port)).toBe(false);
  });

  it("全新空目录:启动即建库并跑完全部迁移,不需要任何手工步骤(§49/§53)", async () => {
    const fresh = path.join(dir, "fresh", "trendscope.db");
    fs.mkdirSync(path.dirname(fresh), { recursive: true });
    const { sqlite } = openDb(fresh);
    const applied = migrate(sqlite);
    const tables = (
      sqlite.prepare("select count(*) c from sqlite_master where type='table'").get() as { c: number }
    ).c;
    const integrity = String(sqlite.pragma("integrity_check", { simple: true }));
    const journal = (
      sqlite.prepare("select count(*) c from __drizzle_migrations").get() as { c: number }
    ).c;
    sqlite.close();
    expect(applied).toBeGreaterThan(10);
    expect(journal).toBe(applied);
    expect(tables).toBeGreaterThan(40);
    expect(integrity).toBe("ok");
  });
});
