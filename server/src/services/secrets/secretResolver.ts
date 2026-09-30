/**
 * SecretResolver (Stage 5 §3/§12) — the ONLY place a secretref reference is
 * resolved into a secret value.
 *
 * 语法(遵循 Stage 4 secretref 架构,扩展来源段):
 *   secretref:env:ZHIHU_ACCESS_SECRET   → process.env.ZHIHU_ACCESS_SECRET
 *
 * 不变量:
 * - 数据库(Task config)只保存引用,不保存值;
 * - 引用本身可以出现在日志/事件(redactData 会脱敏值,引用字符串不含秘密);
 * - 解析失败永远不抛出含值的错误;reason 只描述缺失/不支持,不回显值。
 */
export type SecretResolution =
  | { ok: true; value: string }
  | { ok: false; reason: "missing_reference" | "unsupported_source" | "env_not_set"; detail: string };

export function resolveSecretRef(ref: string | undefined | null): SecretResolution {
  if (!ref || typeof ref !== "string" || !ref.startsWith("secretref:")) {
    return { ok: false, reason: "missing_reference", detail: "未提供 secretref 引用" };
  }
  const parts = ref.split(":");
  // secretref:<source>:<name...>
  if (parts.length < 3) {
    return {
      ok: false,
      reason: "unsupported_source",
      detail: `secretref 缺少来源段(支持 secretref:env:<NAME>):${ref}`,
    };
  }
  const source = parts[1];
  const name = parts.slice(2).join(":");
  if (source === "env") {
    const value = process.env[name];
    if (!value || value.trim().length === 0) {
      return {
        ok: false,
        reason: "env_not_set",
        detail: `环境变量 ${name} 未设置(凭证缺失,不是服务故障)`,
      };
    }
    return { ok: true, value: value.trim() };
  }
  return {
    ok: false,
    reason: "unsupported_source",
    detail: `不支持的 secretref 来源 "${source}"(当前支持 env)`,
  };
}

/** Non-throwing probe used by health/UI: where should the secret come from? */
export function describeSecretSource(ref: string | undefined | null): string {
  if (!ref || typeof ref !== "string" || !ref.startsWith("secretref:")) return "—";
  const parts = ref.split(":");
  if (parts[1] === "env") return `环境变量 ${parts.slice(2).join(":")}`;
  return parts.slice(1).join(":");
}
