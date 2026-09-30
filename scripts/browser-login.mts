/**
 * 打开一个**看得见**的浏览器窗口,让用户用自己的账号登录一次。
 * 登录态存在本机 data/browser-profile(不属于数据库、不出本机、界面上也不显示任何 Cookie)。
 * 之后「浏览器采集」渠道就能读到只有登录后才渲染出来的页面。
 *
 * 这个脚本刻意不做任何事:不模拟点击登录、不读密码、不绕过验证码 ——
 * 窗口打开后就是用户自己在正常浏览器里操作,关窗口即结束。
 */
import { chromium } from "playwright-core";
import { resolve } from "node:path";
import { browserProfileDir } from "../server/src/connectors/browserPage";

const target = process.argv[2] ?? "https://www.xiaohongshu.com/explore";
if (!/^https:\/\//i.test(target)) {
  console.error("[browser-login] 只接受 https 地址");
  process.exitCode = 1;
} else {
  const ctx = await chromium.launchPersistentContext(browserProfileDir(), {
    channel: "chrome",
    headless: false,
    viewport: { width: 1280, height: 860 },
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  console.log(`[browser-login] 已打开 ${resolve(process.cwd())} 下的本机浏览器档案目录`);
  console.log(`[browser-login] 请在弹出的窗口里登录,登录成功后**关掉窗口**即可(这个命令会自己结束)`);
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((e) => {
    console.warn("[browser-login] 首次打开页面失败:", e instanceof Error ? e.message.slice(0, 160) : String(e));
  });
  // 一直等到用户关闭窗口
  await new Promise<void>((r) => ctx.on("close", () => r()));
  console.log("[browser-login] 窗口已关闭,登录态保存在 data/browser-profile");
}
