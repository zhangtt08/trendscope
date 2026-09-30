/**
 * 版本号只有一个来源:package.json 的 version(§Release 1.0)。
 * 服务端运行时读取(不打包进产物,避免 rootDir 之外的 JSON 参与编译)。
 */
import fs from "node:fs";
import path from "node:path";

let cached: string | null = null;

export function appVersion(): string {
  if (cached) return cached;
  const candidates = [
    path.resolve(process.cwd(), "package.json"),
    path.resolve(__dirname, "..", "..", "package.json"),
    path.resolve(__dirname, "..", "..", "..", "package.json"),
  ];
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version) {
        cached = parsed.version;
        return cached;
      }
    } catch {
      // 继续尝试下一个候选路径
    }
  }
  cached = "0.0.0-dev";
  return cached;
}
