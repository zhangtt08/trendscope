/**
 * zod 报错的中文表述(§78:用户可见文本不得中英混杂)。
 *
 * zod 内置 message 是英文,直接透传到界面就是"参数不合法: String must contain…"。
 * 这里按 issue.code 分类,只有我们自己写的(custom/含中文)message 才原样保留。
 */
import type { ZodError, ZodIssue } from "zod";

const TYPE_ZH: Record<string, string> = {
  string: "文本",
  number: "数字",
  integer: "整数",
  boolean: "是/否",
  array: "数组",
  object: "对象",
  date: "日期",
  enum: "枚举值",
  nan: "数字",
  null: "空值",
  undefined: "填写值",
};

const HAS_CJK = /[一-鿿]/;

export function zodField(i: ZodIssue): string {
  return i.path.length ? i.path.join(".") : "body";
}

/** 单个 issue 的中文原因(不含字段名)。 */
export function zodReason(i: ZodIssue): string {
  switch (i.code) {
    case "invalid_type":
      return `应为${TYPE_ZH[i.expected] ?? i.expected}`;
    case "too_small":
      return "低于允许下限";
    case "too_big":
      return "超过允许上限";
    case "unrecognized_keys": {
      const keys = (i as { keys?: string[] }).keys ?? [];
      return `含未知字段${keys.length ? `(${keys.join("、")})` : ""}`;
    }
    case "invalid_enum_value": {
      const options = (i as { options?: string[] }).options ?? [];
      return `取值不在允许范围内${options.length ? `(可选:${options.join("/")})` : ""}`;
    }
    case "invalid_literal":
      return "取值不正确";
    case "custom":
      return HAS_CJK.test(i.message) ? i.message : "格式不正确";
    default:
      return HAS_CJK.test(i.message) ? i.message : "格式不正确";
  }
}

/** `字段: 中文原因`,用于逐行报错列表(导入失败原因、连接器校验结果)。 */
export function zodIssueLine(i: ZodIssue): string {
  return `${zodField(i)}: ${zodReason(i)}`;
}

export function zodIssueLines(err: ZodError, limit = 8): string {
  return err.issues
    .slice(0, limit)
    .map(zodIssueLine)
    .join("；");
}

/** 压成一行 HTTP 错误信息。 */
export function describeZod(err: ZodError, limit = 8): string {
  return `参数不合法：${err.issues
    .slice(0, limit)
    .map((i) => `${zodField(i)} ${zodReason(i)}`)
    .join("；")}`;
}
