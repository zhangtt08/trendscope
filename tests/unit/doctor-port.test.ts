/**
 * 体检的端口那一项必须报**地址**,不能报"端口 5184 可用"。
 *
 * 实测到的既有缺陷(本机 Windows,2026-10-05,量出来的):
 * 已经有一个进程在 `0.0.0.0:P` 上监听时,再往 `127.0.0.1:P` 上绑 —— **会成功**。
 * 旧体检只探回环那一个地址,于是它对着一整个对局域网开放的监听器打印
 * `端口 P PASS 可用`;而当时应用绑的也是 0.0.0.0,真启动必撞 EADDRINUSE。
 * 一句话:它报的"空闲"讲的是另一个 socket。
 *
 * 数据隔离:每一项都把 `TRENDSCOPE_DB` 指到临时目录 —— doctor 会在库目录里落一个写探针,
 * 绝不能拿 `data/`(使用者 3.9 GB 的真实库)当试验田。
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { runChecks } from "../../server/src/doctor";
import { LOCAL_BIND_HOST } from "../../server/src/local-guard";

const dirs: string[] = [];
const servers: net.Server[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function isolatedTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trendscope-doctor-test-"));
  dirs.push(dir);
  return dir;
}

/** 占住某个地址:返回端口。`0.0.0.0` 就是"对整个局域网开放"的那一种占用者。 */
async function occupy(host: string): Promise<number> {
  const srv = net.createServer();
  servers.push(srv);
  await new Promise<void>((res, rej) => {
    srv.once("error", rej);
    srv.once("listening", () => res());
    srv.listen(0, host);
  });
  // 让它活着:close() 由 afterEach 统一收
  return (srv.address() as net.AddressInfo).port;
}

async function portCheck(port: number) {
  const savedDb = process.env.TRENDSCOPE_DB;
  process.env.TRENDSCOPE_DB = path.join(isolatedTmpDir(), "doctor.db");
  try {
    const results = await runChecks({ port });
    const found = results.filter((r) => r.name.startsWith("端口"));
    return { found, all: results };
  } finally {
    if (savedDb === undefined) delete process.env.TRENDSCOPE_DB;
    else process.env.TRENDSCOPE_DB = savedDb;
  }
}

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((res) => srv.listen(0, LOCAL_BIND_HOST, () => res()));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((res) => srv.close(() => res()));
  return port;
}

describe("体检的端口检查报的是应用实际会绑的那个地址", () => {
  it("只有一条端口检查,名字里带着绑定地址", async () => {
    const port = await freePort();
    const { found } = await portCheck(port);
    expect(found.length).toBe(1);
    expect(found[0].name).toBe(`端口 ${LOCAL_BIND_HOST}:${port}`);
  });

  it("两侧都空 → PASS,并把两个地址都说明白(而不是没有主语的「可用」)", async () => {
    const port = await freePort();
    const { found } = await portCheck(port);
    expect(found[0].level).toBe("PASS");
    expect(found[0].detail).toContain(`127.0.0.1:${port}`);
    expect(found[0].detail).toContain(`0.0.0.0:${port}`);
  });

  it("回环上有人占 → WARN,报告里带端口与被占的地址", async () => {
    const port = await occupy(LOCAL_BIND_HOST);
    const { found } = await portCheck(port);
    expect(found[0].level).toBe("WARN");
    expect(found[0].detail).toContain("已被占用");
    expect(found[0].detail).toContain(LOCAL_BIND_HOST);
    expect(found[0].hint).toContain("PORT=");
  });

  it("有一个对所有网卡开放的监听者时,不许报「空闲」—— 这正是旧实现说错的那一格", async () => {
    const port = await occupy("0.0.0.0");
    // 前置事实(本机实测):回环那侧确实还能绑 —— 旧实现就是据此报了"可用"
    const loopbackStillBindable = await new Promise<boolean>((res) => {
      const probe = net.createServer();
      probe.once("error", () => res(false));
      probe.once("listening", () => probe.close(() => res(true)));
      probe.listen(port, LOCAL_BIND_HOST);
    });
    expect(loopbackStillBindable, "这台机器上 127.0.0.1 那侧绑不上,这条用例的前提变了").toBe(true);

    const { found } = await portCheck(port);
    expect(found[0].level).not.toBe("PASS");
    expect(found[0].detail).toContain("0.0.0.0");
    expect(found[0].detail).toMatch(/所有网卡|局域网/);
    expect(found[0].detail).not.toMatch(/空闲 ——/);
    expect(found[0].hint).toContain(LOCAL_BIND_HOST);
  });

  it("端口检查不许改变检查项总数(报得更准,不是报得更多)", async () => {
    const { all, found } = await portCheck(await freePort());
    expect(all.length).toBe(11);
    expect(found.length).toBe(1);
  });

  it("体检不碰真实库:库路径来自 TRENDSCOPE_DB,落点在临时目录", async () => {
    const dir = isolatedTmpDir();
    const savedDb = process.env.TRENDSCOPE_DB;
    process.env.TRENDSCOPE_DB = path.join(dir, "sub", "doctor.db");
    try {
      const results = await runChecks({ port: await freePort() });
      const dataFile = results.find((r) => r.name === "数据文件位置");
      expect(dataFile?.detail).toContain(path.join(dir, "sub", "doctor.db"));
      expect(fs.existsSync(path.join(dir, "sub", "doctor.db"))).toBe(true);
      // 写探针落在临时目录里,不是 data/
      expect(fs.existsSync(path.join(process.cwd(), "data", ".doctor-write-probe"))).toBe(false);
    } finally {
      if (savedDb === undefined) delete process.env.TRENDSCOPE_DB;
      else process.env.TRENDSCOPE_DB = savedDb;
    }
  });
});
