/**
 * 「登录一次」会话:由界面按钮打开一个**看得见**的浏览器窗口,用户在里面用自己的账号登录,
 * 登录态落在本机 data/browser-profile 里(不进数据库、不出本机、界面也不显示任何 Cookie)。
 *
 * 刻意不做的事:不代替用户点登录、不读账号密码、不绕过验证码或风控页。
 * 窗口最多开 10 分钟自动关闭,避免服务里留一个没人管的浏览器进程。
 */
import { browserProfileDir, launchInstalledBrowser, type BrowserLike } from "../connectors/browserPage";

const IDLE_MS = 10 * 60_000;

type Session = { browser: BrowserLike; url: string; openedAt: string; timer: NodeJS.Timeout };
let session: Session | null = null;

export function loginWindowState() {
  return {
    open: Boolean(session),
    url: session?.url ?? null,
    openedAt: session?.openedAt ?? null,
    profileDir: browserProfileDir(),
  };
}

export async function openLoginWindow(url: string) {
  if (session) return { ...loginWindowState(), alreadyOpen: true };
  const browser = await launchInstalledBrowser(false);
  try {
    const page = browser.pages()[0] ?? (await browser.newPage());
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
  } catch (e) {
    await browser.close().catch(() => undefined);
    throw e;
  }
  const timer = setTimeout(() => {
    void closeLoginWindow();
  }, IDLE_MS);
  // 定时器本身不该拖住进程退出
  timer.unref?.();
  session = { browser, url, openedAt: new Date().toISOString(), timer };
  return { ...loginWindowState(), alreadyOpen: false };
}

export async function closeLoginWindow() {
  const s = session;
  session = null;
  if (s) {
    clearTimeout(s.timer);
    await s.browser.close().catch(() => undefined);
  }
  return { closed: Boolean(s), ...loginWindowState() };
}
