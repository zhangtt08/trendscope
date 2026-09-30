/**
 * 「一键抓热点」渠道表的静态契约测试(纯内存,不发任何请求)。
 *
 * 钉的是四件真出过事的事:
 *  1. 每个渠道必须有自动采集档 —— 实测有 7 条渠道任务停在 manual,
 *     用户点完一次「一键抓热点」后它们再也不会自己跑,界面表现就是"根本没有多平台数据";
 *  2. 渠道 config.platform 必须在平台枚举里 —— 写错会让整批内容逐行入库失败,
 *     而运行记录仍显示"已抓取 N 条"(genericHttp.ts 里注释过这个坑);
 *  3. 任务名由 label 拼出,label 重复会让两个渠道抢同一行任务;
 *  4. 「一键抓取」的范围不许包含会开窗口的按需渠道,但显式点名必须能点到它
 *     (按钮上写的渠道数 = 服务端真的会跑的条数)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { CHANNELS, channelSchedule, pickCaptureChannels } from "../../server/src/routes/hot";
import { PLATFORMS } from "../../server/src/domain/constants";

const MIN = 60_000;

describe("渠道表的自动采集档", () => {
  it("定时渠道都是 interval 档且不小于 30 分钟;要开窗口的渠道刻意留手动档", () => {
    expect(CHANNELS.length).toBeGreaterThanOrEqual(12);
    for (const c of CHANNELS) {
      const s = channelSchedule(c);
      if (c.onDemandOnly) {
        // 每 30 分钟弹一个浏览器窗口不是自动化,是骚扰 —— 这类渠道只能按需点
        expect(s.type).toBe("manual");
        continue;
      }
      expect(s.type).toBe("interval");
      expect(s.intervalMs).toBeGreaterThanOrEqual(30 * MIN);
      if (c.intervalMinutes !== undefined) {
        expect(Number.isInteger(c.intervalMinutes)).toBe(true);
      }
    }
    // 至少要有浏览器渠道在用这条豁免,否则这个分支就是死代码
    expect(CHANNELS.some((c) => c.onDemandOnly && c.connectorId === "browser-page")).toBe(true);
  });

  it("周榜类渠道用大间隔,不浪费 30 分钟一轮的轮询", () => {
    const weekly = CHANNELS.filter((c) => c.key.startsWith("douban-"));
    expect(weekly.length).toBeGreaterThanOrEqual(2);
    for (const c of weekly) {
      expect(channelSchedule(c).intervalMs).toBe(c.intervalMinutes * MIN);
      expect(c.intervalMinutes! * 60_000).toBeGreaterThanOrEqual(360 * MIN);
    }
  });
});

describe("渠道表的入库前提", () => {
  it("声明了 platform 的渠道必须用已知平台代码(未知代码会逐行静默失败)", () => {
    for (const c of CHANNELS) {
      const p = (c.config as { platform?: unknown }).platform;
      if (p === undefined) continue;
      expect(PLATFORMS).toContain(p);
    }
  });

  it("key 与 label 都不重复(label 决定任务名)", () => {
    const keys = CHANNELS.map((c) => c.key);
    const labels = CHANNELS.map((c) => c.label);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("每个渠道都有中文说明,界面不能只显示一串英文码", () => {
    for (const c of CHANNELS) {
      expect(c.note.length).toBeGreaterThan(0);
      expect(/[一-龥]/.test(c.note)).toBe(true);
      expect(c.needsEnv === undefined || /^[A-Z0-9_]+$/.test(c.needsEnv)).toBe(true);
    }
  });
});

/**
 * 「抓取 N 个渠道的热点」这个按钮到底跑哪些渠道。
 * 出过的事:加了会开窗口的按需渠道后,一键抓取把它也带上 ——
 * 用户点一次"抓热点"就被一个突然弹出来的浏览器窗口打断,而且这个界面按钮上的数字
 * 是"可用渠道数",和服务端真正跑的条数不是一回事。
 */
describe("pickCaptureChannels:一键抓取的渠道范围", () => {
  // 这组用例要按"凭证在/不在"两种情况判断,所以会动 process.env —— 用后即还原
  const savedCookie = process.env.WEIBO_COOKIE;
  afterEach(() => {
    if (savedCookie === undefined) delete process.env.WEIBO_COOKIE;
    else process.env.WEIBO_COOKIE = savedCookie;
  });

  it("不点名时排除按需渠道与缺凭证渠道", () => {
    delete process.env.WEIBO_COOKIE;
    const keys = pickCaptureChannels().map((c) => c.key);
    expect(keys.some((k) => CHANNELS.find((c) => c.key === k)!.onDemandOnly)).toBe(false);
    expect(keys).not.toContain("weibo-hot");
    // 排除不等于清空:零凭证的公开渠道仍然要在一键里
    expect(keys).toContain("douyin-hot");
    expect(keys.length).toBeGreaterThanOrEqual(10);
  });

  it("显式点名才能跑到按需渠道(界面上那个「开窗口采这一条」走的就是这条路)", () => {
    const onDemand = CHANNELS.filter((c) => c.onDemandOnly).map((c) => c.key);
    expect(onDemand.length).toBeGreaterThan(0);
    expect(pickCaptureChannels(onDemand).map((c) => c.key).sort()).toEqual([...onDemand].sort());
    // 点了名就不该被"缺凭证"挡在选择之外 —— 路由会另外给出 skipped + 原因,而不是静默不跑
    process.env.WEIBO_COOKIE = "fake=1";
    expect(pickCaptureChannels(["weibo-hot"]).map((c) => c.key)).toEqual(["weibo-hot"]);
  });

  it("点名里含未知渠道时返回数量变少,路由据此报 400", () => {
    expect(pickCaptureChannels(["zhihu-hot", "no-such-channel"]).map((c) => c.key)).toEqual(["zhihu-hot"]);
  });
});
