// 复合问题拆分：规则粗判优先，只有规则判断不了时才用 LLM 复核。
// 目的：尽量减少前置 LLM 调用，降低首字延迟。

const llm = require("./llm");

// 强分隔：问号/分号/句号，以及明确引出另一问的连接词
const STRONG_SPLIT = /[？?；;。]+|另外|顺便|同时|并且|以及/g;
// 弱连接词：可能是并列，也可能是词内字，需谨慎，交给 LLM 复核
const WEAK_MARKER = /(?:和|与|跟|还有)/;

function ruleSplit(question) {
  return String(question || "")
    .split(STRONG_SPLIT)
    .map((s) => s.replace(/^[，,、\s]+|[，,、\s]+$/g, "").trim())
    .filter((s) => s.length >= 3);
}

async function llmSplit(question) {
  const out = await llm.complete(
    [
      {
        role: "system",
        content:
          "判断用户问题是否包含多个可独立回答的子问题。若有，按行输出每个子问题（不要编号、不要多余文字）；若只有一个问题，原样输出该问题。",
      },
      { role: "user", content: question },
    ],
    { maxTokens: 200, temperature: 0 },
  );
  const parts = String(out || "")
    .split(/\n+/)
    .map((s) => s.replace(/^[\-*\d.、)）\s]+/, "").trim())
    .filter((s) => s.length >= 3);
  return parts.length ? parts : [question];
}

// 返回子问题数组；长度为 1 表示单一问题
async function splitQuestion(question) {
  const q = String(question || "").trim();
  if (!q) return [];

  const parts = ruleSplit(q);
  if (parts.length >= 2) return parts; // 规则已确认为复合问题

  // 规则判断不了：含弱连接词且问题较长 → 用 LLM 复核
  if (WEAK_MARKER.test(q) && q.length >= 12) {
    try {
      return await llmSplit(q);
    } catch {
      return [q];
    }
  }
  return [q];
}

module.exports = { splitQuestion, ruleSplit };
