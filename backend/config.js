// 大模型与知识库配置解析。
// 优先使用平台内置大模型（MCAI_*），其次读取显式 LLM_* 配置。
// 不在代码中硬编码任何地址或密钥。

function firstNonEmpty(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function resolveLLM() {
  const baseUrl = firstNonEmpty(
    process.env.LLM_BASE_URL,
    process.env.MCAI_LLM_BASE_URL,
    process.env.OPENAI_BASE_URL,
  );
  const apiKey = firstNonEmpty(
    process.env.LLM_API_KEY,
    process.env.MCAI_LLM_API_KEY,
    process.env.OPENAI_API_KEY,
  );
  const model = firstNonEmpty(
    process.env.LLM_MODEL,
    process.env.MCAI_LLM_MODEL,
    "deepseek-chat",
  );
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    model,
    configured: Boolean(baseUrl),
  };
}

function resolveDataDir() {
  return firstNonEmpty(process.env.DATA_DIR) || require("path").join(__dirname, "..", "data");
}

module.exports = { resolveLLM, resolveDataDir };
