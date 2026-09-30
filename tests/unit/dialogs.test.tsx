// @vitest-environment jsdom
/**
 * 产品内对话框(§67 治理动作的输入路径)。
 *
 * 之前重命名话题、复制模型走的是 window.prompt:原生弹窗在桌面产品里既不可样式化,
 * 也可能被宿主环境直接拦掉 —— 按钮看起来就是"死的"。这里锁定替代品的行为。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PromptDialog, PickDialog, type PromptSpec } from "../../src/components/Dialogs";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

function render(node: ReactNode) {
  act(() => root.render(node));
}

const q = (sel: string) => host.querySelector(sel) as HTMLElement | null;
const text = () => host.textContent ?? "";

function typeInto(value: string) {
  const input = q("input") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

function clickButton(name: string) {
  const btn = [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === name) as HTMLButtonElement;
  act(() => btn.click());
}

const spec = (over: Partial<PromptSpec> = {}): PromptSpec => ({
  title: "重命名话题",
  hint: "人工命名后自动分析不会覆盖",
  initialValue: "减脂餐",
  onSubmit: () => undefined,
  ...over,
});

describe("PromptDialog", () => {
  it("渲染标题、说明并预填当前值", () => {
    render(<PromptDialog spec={spec()} onClose={() => undefined} />);
    expect(text()).toContain("重命名话题");
    expect(text()).toContain("人工命名后自动分析不会覆盖");
    expect((q("input") as HTMLInputElement).value).toBe("减脂餐");
    expect(q('[role="dialog"]')).not.toBeNull();
  });

  it("确定提交去掉首尾空格的值,并关闭", () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(<PromptDialog spec={spec({ onSubmit })} onClose={onClose} />);
    typeInto("  新名字  ");
    clickButton("确定");
    expect(onSubmit).toHaveBeenCalledWith("新名字");
    expect(onClose).toHaveBeenCalled();
  });

  it("空值不提交,并在框内给出原因", () => {
    const onSubmit = vi.fn();
    render(<PromptDialog spec={spec({ onSubmit, initialValue: "" })} onClose={() => undefined} />);
    typeInto("   ");
    clickButton("确定");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(text()).toContain("不能为空");
  });

  it("validate 拒绝时留在对话框内提示原因", () => {
    const onSubmit = vi.fn();
    render(
      <PromptDialog
        spec={spec({
          onSubmit,
          validate: (v) => (/^[a-z]/.test(v) ? null : "需要以小写字母开头"),
        })}
        onClose={() => undefined}
      />,
    );
    typeInto("Bad Key");
    clickButton("确定");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(text()).toContain("需要以小写字母开头");
    typeInto("good_key");
    clickButton("确定");
    expect(onSubmit).toHaveBeenCalledWith("good_key");
  });

  it("取消提交 null", () => {
    const onSubmit = vi.fn();
    render(<PromptDialog spec={spec({ onSubmit })} onClose={() => undefined} />);
    clickButton("取消");
    expect(onSubmit).toHaveBeenCalledWith(null);
  });

  it("回车等于确定,Esc 等于取消", () => {
    const onSubmit = vi.fn();
    render(<PromptDialog spec={spec({ onSubmit })} onClose={() => undefined} />);
    const input = q("input") as HTMLInputElement;
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onSubmit).toHaveBeenLastCalledWith("减脂餐");

    const onSubmit2 = vi.fn();
    render(<PromptDialog spec={spec({ onSubmit: onSubmit2 })} onClose={() => undefined} />);
    const input2 = q("input") as HTMLInputElement;
    act(() => {
      input2.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onSubmit2).toHaveBeenLastCalledWith(null);
  });
});

describe("PickDialog", () => {
  it("列出选项并把选中值回传给 onPick", () => {
    const onPick = vi.fn();
    const onCancel = vi.fn();
    render(
      <PickDialog
        title="把哪个话题合并进来?"
        hint="成员将全部转移"
        options={[
          { value: "1", label: "#1 减脂餐(12 成员)" },
          { value: "2", label: "#2 探店(5 成员)" },
        ]}
        confirmLabel="合并"
        onCancel={onCancel}
        onPick={onPick}
      />,
    );
    expect(host.querySelectorAll("option")).toHaveLength(2);
    const select = q("select") as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
    act(() => {
      setter.call(select, "2");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    clickButton("合并");
    expect(onPick).toHaveBeenCalledWith("2");
    expect(onCancel).toHaveBeenCalled();
  });

  it("没有可选项时确认按钮禁用并说明,而不是弹空框", () => {
    const onPick = vi.fn();
    render(
      <PickDialog
        title="把哪个话题合并进来?"
        options={[]}
        emptyText="当前只有一个活跃话题"
        onCancel={() => undefined}
        onPick={onPick}
      />,
    );
    expect(text()).toContain("当前只有一个活跃话题");
    const confirm = [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "确定") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(confirm.title).toBe("没有可选项");
    expect(onPick).not.toHaveBeenCalled();
  });
});
