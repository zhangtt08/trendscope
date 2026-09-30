/**
 * 话题命名的 AI 提供器(Stage 6B §20/§70)。
 *
 * 判定只有一份:见 studio/chatBridge —— 有 Key 走 HTTP,没 Key 但设了本机 CLI 就走 CLI,
 * 两者都没有才回退关键词命名。之前这里读 EMBEDDING_*,而那个地址指向一个只提供向量化的
 * 本机服务(没有 chat 接口),于是"一键全分析"永远把话题命名成关键词碎片
 * ("magic9 荣耀 机发" 这种),而设置页同时告诉你 AI 未配置 —— 两处各说各话。
 */
import { AiTopicNameProvider } from "./keywords";
import { studioChatFetch } from "../studio/chatBridge";

export function topicNameProviderIfConfigured(): AiTopicNameProvider | undefined {
  const fetchChat = studioChatFetch();
  if (!fetchChat) return undefined;
  return new AiTopicNameProvider({
    fetchChat: (prompt: string) => fetchChat(prompt),
  });
}
