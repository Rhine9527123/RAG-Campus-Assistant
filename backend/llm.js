// OpenAI 兼容的大模型客户端（平台内置模型）。仅负责调用与流式解析。

const { resolveLLM } = require("./config");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 全局限速：平台大模型按 30 次/分钟限流。minIntervalMs>0 时串行化调用并保证最小间隔。
let minIntervalMs = 0;
let nextSlot = 0;
let chain = Promise.resolve();

function setRateLimit(ms) {
  minIntervalMs = Math.max(0, Number(ms) || 0);
  nextSlot = 0;
}

function schedule() {
  if (!minIntervalMs) return Promise.resolve();
  const p = chain.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    if (wait > 0) await sleep(wait);
    nextSlot = Date.now() + minIntervalMs;
  });
  chain = p.catch(() => {});
  return p;
}

async function callChat(messages, { stream, signal, maxTokens = 1600, temperature = 0.2, extra = {} }) {
  const cfg = resolveLLM();
  if (!cfg.configured) throw new Error("LLM not configured");

  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await schedule();
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        stream: Boolean(stream),
        max_tokens: maxTokens,
        temperature,
        ...extra,
      }),
      signal,
    });

    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after")) * 1000;
      await res.text().catch(() => "");
      if (attempt === maxAttempts - 1) throw new Error(`LLM http ${res.status} after ${maxAttempts} attempts`);
      await sleep(Math.min(retryAfter || 800 * (attempt + 1) + 400, 8000));
      continue;
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`LLM http ${res.status} ${detail.slice(0, 200)}`);
    }
    return res;
  }
  throw new Error("LLM request failed");
}

async function complete(messages, options = {}) {
  const res = await callChat(messages, { ...options, stream: false });
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("LLM returned no content");
  return content;
}

// 逐块回调 delta.content（忽略 reasoning_content），返回完整文本
async function stream(messages, onDelta, options = {}) {
  const res = await callChat(messages, { ...options, stream: true });
  if (!res.body) throw new Error("LLM stream has no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let full = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let evt;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = evt.choices?.[0]?.delta;
      const piece = delta?.content;
      if (typeof piece === "string" && piece) {
        full += piece;
        onDelta(piece);
      }
    }
  }
  return full;
}

module.exports = { complete, stream, resolveLLM, setRateLimit };
