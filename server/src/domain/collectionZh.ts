/**
 * 采集运行相关的中文展示文案(§78:运行事件时间线、错误列直接显示给用户)。
 *
 * 接口里存的仍是英文 code(RUN_ERROR_CODES / 事件类型),这里只负责"怎么说给人听";
 * 前端 src/lib/format.ts 有同一份取值的前端副本,两边都以 domain/collection.ts 的枚举为准。
 */
export const RUN_ERROR_ZH: Record<string, string> = {
  AUTH_ERROR: "鉴权失败",
  RATE_LIMITED: "触发频率限制",
  NETWORK_ERROR: "网络错误",
  REMOTE_5XX: "远端服务错误",
  TIMEOUT: "请求超时",
  INVALID_RESPONSE: "响应无法解析",
  SCHEMA_DRIFT: "上游结构变化",
  INVALID_CONFIG: "任务配置不合法",
  CANCELLED: "已取消",
  INTERRUPTED: "被中断",
  UNKNOWN: "未知错误",
};

export const RUN_STATUS_ZH: Record<string, string> = {
  queued: "排队中",
  running: "正在运行",
  completed: "完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
};

export const TRIGGER_ZH: Record<string, string> = {
  manual: "手动",
  schedule: "定时",
  resume: "断点续跑",
};

export function runErrorZh(code: string | null | undefined): string {
  if (!code) return "";
  return RUN_ERROR_ZH[code] ?? code;
}
