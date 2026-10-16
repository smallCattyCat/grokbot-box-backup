export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export async function callSiliconFlowChat(messages: ChatMessage[]): Promise<string> {
  const apiKey = process.env.SILICONFLOW_API_KEY;
  if (!apiKey) {
    throw new Error("缺少 SILICONFLOW_API_KEY");
  }
  const response = await fetch(`${process.env.SILICONFLOW_BASE_URL ?? "https://api.siliconflow.cn/v1"}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.SILICONFLOW_MODEL ?? "Pro/zai-org/GLM-5.1",
      messages,
      temperature: 0.65
    })
  });
  if (!response.ok) {
    throw new Error(`SiliconFlow 调用失败：${response.status} ${await response.text()}`);
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("SiliconFlow 返回内容为空");
  }
  return content;
}
