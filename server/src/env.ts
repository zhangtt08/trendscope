/**
 * 极小的 .env 读取器(零依赖)。
 *
 * 为什么不装 dotenv:整个产品只依赖 express/react/sqlite 这一层,
 * 多一个运行时依赖就多一个安装失败面(本项目已经因 better-sqlite3 的 ABI 踩过一次)。
 * 这里只需要"把文件里的键值塞进 process.env"这一件事。
 *
 * 规则(与常见 .env 语义一致,便于用户预期):
 *  - 已存在的环境变量优先(不会被文件覆盖);
 *  - `#` 开头是注释;空行忽略;`KEY=VALUE`;值两侧的成对引号会被剥掉;
 *  - 文件不存在不是错误(正式部署通常直接给真实环境变量)。
 */
import fs from "node:fs";
import path from "node:path";

export interface EnvLoadResult {
  file: string;
  loaded: boolean;
  applied: string[];
  skipped: string[];
  malformed: number;
}

function stripQuotes(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** 只接受看起来像环境变量名的键,避免把误写的中文/表达式当成配置。 */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function loadDotEnv(dir = process.cwd(), env: NodeJS.ProcessEnv = process.env): EnvLoadResult {
  const file = path.resolve(dir, ".env");
  const result: EnvLoadResult = { file, loaded: false, applied: [], skipped: [], malformed: 0 };
  if (!fs.existsSync(file)) return result;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return result;
  }
  result.loaded = true;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      result.malformed += 1;
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (!KEY_RE.test(key)) {
      result.malformed += 1;
      continue;
    }
    const value = stripQuotes(line.slice(eq + 1).replace(/\s+#.*$/, ""));
    if (env[key] !== undefined && env[key] !== "") {
      result.skipped.push(key);
      continue;
    }
    env[key] = value;
    result.applied.push(key);
  }
  return result;
}

/** 供 doctor / 文档使用:哪些密钥类变量已经就位(只报状态,不报值)。 */
export const SECRET_ENV_NAMES = [
  "ZHIHU_ACCESS_SECRET",
  "EMBEDDING_API_KEY",
  "STUDIO_API_KEY",
] as const;

export function envPresence(env: NodeJS.ProcessEnv = process.env): Record<string, "set" | "missing"> {
  const out: Record<string, "set" | "missing"> = {};
  for (const k of SECRET_ENV_NAMES) out[k] = env[k]?.trim() ? "set" : "missing";
  return out;
}
