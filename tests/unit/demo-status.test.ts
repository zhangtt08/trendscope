/**
 * 侧栏"关于"与演示横幅里的数据文件路径(§34/§35 的可见部分)。
 *
 * 曾经的缺陷:dbDisplay 写死成演示库文件名,于是**正式实例**的侧栏显示
 * "data/trendscope-demo.db" —— 用户会以为自己在看演示库。现在显示当前实例
 * 真正打开的那个文件(由 createApp 传入)。
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { createTestDb } from "../../server/src/db/client";
import { getDemoStatus } from "../../server/src/services/demoService";

describe("demo/status 的数据文件展示", () => {
  it("默认目录下的正式库显示 data/trendscope.db", async () => {
    const { db } = createTestDb();
    const status = await getDemoStatus(db, path.resolve(process.cwd(), "data", "trendscope.db"));
    expect(status.demoMode).toBe(false);
    expect(status.dbDisplay).toBe("data/trendscope.db");
    expect(status.dbDisplay).not.toContain("demo");
  });

  it("默认目录下的演示库显示 data/trendscope-demo.db", async () => {
    const { db } = createTestDb();
    process.env.TRENDSCOPE_DEMO = "1";
    try {
      const status = await getDemoStatus(db, path.resolve(process.cwd(), "data", "trendscope-demo.db"));
      expect(status.demoMode).toBe(true);
      expect(status.dbDisplay).toBe("data/trendscope-demo.db");
    } finally {
      delete process.env.TRENDSCOPE_DEMO;
    }
  });

  it("自定义路径(TRENDSCOPE_DB 指向别处)显示真实绝对路径,不假装在 data/ 下", async () => {
    const { db } = createTestDb();
    const elsewhere = path.resolve(process.cwd(), "..", "elsewhere.db");
    const status = await getDemoStatus(db, elsewhere);
    expect(status.dbDisplay).toBe(elsewhere);
  });

  it("不传实例文件时回落到环境变量推导路径(仍是当前实例的路径)", async () => {
    const { db } = createTestDb();
    const target = path.resolve(process.cwd(), "data", "from-env.db");
    process.env.TRENDSCOPE_DB = target;
    try {
      const status = await getDemoStatus(db);
      expect(status.dbDisplay).toBe("data/from-env.db");
    } finally {
      delete process.env.TRENDSCOPE_DB;
    }
  });
});
