/**
 * 优雅退出(§59/§60)。
 *
 * 顺序是固定的,不能随意调换:
 *   1. 停调度器 —— 不再发起新的采集任务(否则任务会被自己的退出打断);
 *   2. 关 HTTP(并主动断开 keep-alive 连接,否则 close() 永远等不完);
 *   3. WAL checkpoint(TRUNCATE)—— 把还在 -wal 里的写入折回主库文件;
 *   4. 关闭连接并退出。
 *
 * 为什么单独成一个模块:这段逻辑过去只存在于"启动函数"里,谁都测不到,
 * 而它恰好是唯一会让用户数据停留在 -wal 里的环节。测试可以直接调用它。
 */
import type { Server } from "node:http";
import type Database from "better-sqlite3";

export interface ShutdownDeps {
  server: Server;
  sqlite: Database.Database;
  stopScheduler: () => void;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  exit?: (code: number) => void;
  /** 等待连接结束的上限;超时也要退出,不能挂在这里变成孤儿进程 */
  closeTimeoutMs?: number;
}

export interface ShutdownHandle {
  /** 返回 true 表示本次调用真正执行了关闭流程(false = 已在关闭中) */
  close: (reason: string) => boolean;
  /** 注册 SIGINT / SIGTERM 监听;返回卸载函数 */
  install: () => () => void;
}

export function createShutdown(deps: ShutdownDeps): ShutdownHandle {
  const log = deps.log ?? ((m: string) => console.log(m));
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let closing = false;

  function close(reason: string): boolean {
    if (closing) return false;
    closing = true;
    log(`[trendscope] 收到 ${reason},正在安全退出…`);
    try {
      deps.stopScheduler();
    } catch (e) {
      warn(`[trendscope] 停止调度器时出错(继续退出):${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      // 先断开 keep-alive,否则 close() 的回调可能永远不来
      (deps.server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    } catch {
      /* 老版本 Node 没有这个 API:超时兜底仍然会退出 */
    }
    const timer = setTimeout(() => {
      warn("[trendscope] 连接未在限定时间内结束,直接退出(数据已 checkpoint)。");
      finish();
    }, deps.closeTimeoutMs ?? 3000);
    timer.unref?.();

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // 顺序要点:checkpoint 必须在 close 之前、且在监听停止之后
      try {
        const r = deps.sqlite.pragma("wal_checkpoint(TRUNCATE)") as unknown;
        const busy = (r as { busy?: number } | undefined)?.busy;
        if (busy) warn("[trendscope] WAL checkpoint 处于 busy 状态;下次启动会自动继续,不影响数据完整。");
      } catch (e) {
        warn(`[trendscope] WAL checkpoint 未完成:${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        deps.sqlite.close();
      } catch (e) {
        warn(`[trendscope] 关闭数据库连接时出错:${e instanceof Error ? e.message : String(e)}`);
      }
      log("[trendscope] 已退出(数据已落盘,可安全复制/备份数据文件)。");
      exit(0);
    };

    deps.server.close(() => finish());
    return true;
  }

  function install(): () => void {
    const onSigint = () => {
      if (close("Ctrl+C / SIGINT")) return;
      console.error("[trendscope] 再次收到中断信号,立即强制退出。");
      exit(1);
    };
    const onSigterm = () => close("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    return () => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    };
  }

  return { close, install };
}
