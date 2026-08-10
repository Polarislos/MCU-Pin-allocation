import { MODULE_CATALOG } from "../../data/moduleCatalog.js";
import { analysisFromEnvelope } from "./assistant.js";

const REQUEST_TIMEOUT_MS = 45_000;

function moduleCatalogPrompt() {
  return MODULE_CATALOG.map((module) => {
    const variants = Object.entries(module.variants || {})
      .map(([id, variant]) => `${id}: ${variant.requirements.map((requirement) => `${requirement.type}/${requirement.variant}`).join(", ")}`)
      .join("; ");
    return `- ${module.id} (${module.name}): ${variants}`;
  }).join("\n");
}

export function buildRequirementsSystemPrompt({ mcuId = null } = {}) {
  return `你是嵌入式硬件需求分析助手。当前 MCU 为 ${mcuId || "用户选择的 MCU"}。
你的任务是把用户的板级描述转换成 JSON 需求草案，不要分配物理引脚，不要输出 pin number、pin name 或 assignment。
只能从以下数字外设类型中选择：SPI、I2C、UART、FDCAN、SDMMC、QUADSPI、USB、ETH、TIM。
可以输出模块、接口数量、variant、实例（例如 I2C4 / USART3）、出线方向（left/right/top/bottom）和保护约束。

常用模块目录：
${moduleCatalogPrompt()}

只返回 JSON，不要 Markdown 代码围栏，格式必须是：
{
  "version": "0.1",
  "mcuId": "${mcuId || ""}",
  "modules": [{"id":"module-id","name":"模块名","variant":"variant-id","requirements":[{"type":"SPI","variant":"full3","count":1,"instance":null,"side":null,"role":"用途"}]}],
  "constraints": [{"kind":"side","value":"right","label":"优先从右侧出线"}],
  "notes": ["尚未建模但需要工程师确认的 GPIO、供电、时钟或电平约束"]
}`;
}

function contentFromResponse(payload) {
  const candidate = payload?.choices?.[0]?.message?.content
    ?? payload?.output_text
    ?? payload?.content
    ?? payload;
  if (Array.isArray(candidate)) return candidate.map((part) => part?.text || part?.content || "").join("");
  return candidate;
}

function parseJsonContent(content) {
  if (content && typeof content === "object") return content;
  const text = String(content || "").trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("AI 返回内容不是合法 JSON");
  }
}

export async function analyzeRequirementsRemote({ endpoint, model, apiKey = "", input, mcuId } = {}) {
  if (!endpoint?.trim()) throw new Error("请先配置 AI 接口地址");
  if (!model?.trim()) throw new Error("请先配置 AI 模型名称");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint.trim(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {}),
      },
      body: JSON.stringify({
        model: model.trim(),
        temperature: 0.1,
        messages: [
          { role: "system", content: buildRequirementsSystemPrompt({ mcuId }) },
          { role: "user", content: input || "请根据当前工程上下文给出接口需求。" },
        ],
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error(`AI 服务返回了非 JSON 响应（HTTP ${response.status}）`);
    }
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
      throw new Error(`AI 服务请求失败：${detail}`);
    }
    const envelope = parseJsonContent(contentFromResponse(payload));
    return analysisFromEnvelope(envelope, { input, mcuId, source: "remote" });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("AI 请求超时（45 秒）");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
