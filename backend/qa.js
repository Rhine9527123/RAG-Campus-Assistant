// 可复用的单轮问答逻辑：检索 → (可选)资料整理 → 生成 → 清理。
// 供在线问答（server.js）与自动化测评（eval.js）共用。

const { retrieve } = require("./rag");
const llm = require("./llm");
const { consolidateSources, shouldConsolidate, cleanAnswer } = require("./cleanup");
const { splitQuestion } = require("./split");
const { rerank } = require("./rerank");

const HISTORY_LIMIT = 6;
const RECALL_K = 10; // 召回候选数
const RERANK_K = 3; // 重排后交给生成的片段数

const SYSTEM_PROMPT = [
  "你是「校园智能问答助手」，服务对象是本校大学生。",
  "请严格依据用户消息中提供的【知识片段】回答，不得使用片段之外的信息，也不得编造。",
  "若知识片段不足以回答，请明确说明“知识库中暂未找到相关信息”，并建议用户补充问题或咨询相关部门。",
  "回答要简洁、准确、条理清晰，可使用分点；涉及时间、地点、金额等请与片段保持一致。",
  "同一信息只讲一次，不要重复复述。",
].join("");

const NOT_FOUND =
  "知识库中暂未找到与该问题相关的内容。请补充更具体的信息（如院系、时间、场景），或咨询学校相关部门确认。";

function buildMessages(history, question, sources, consolidated) {
  // 优先使用「去重整理后」的参考资料；整理失败时回退到原始片段
  const context =
    consolidated ||
    sources
      .map((s, i) => `[片段${i + 1}]（文件：${s.metadata.filename} / 分类：${s.metadata.category}）\n${s.text}`)
      .join("\n\n");

  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  for (const m of (history || []).slice(-HISTORY_LIMIT)) {
    messages.push({ role: m.role, content: m.content });
  }
  messages.push({
    role: "user",
    content: `【知识片段】\n${context}\n\n【用户问题】\n${question}`,
  });
  return messages;
}

function retrievalQuery(history, question) {
  const lastUser = [...(history || [])].reverse().find((m) => m.role === "user");
  if (lastUser && String(question).length <= 8) return `${lastUser.content} ${question}`;
  return question;
}

// 合并多路子问题的召回结果并去重
function mergeSources(lists, cap = 14) {
  const seen = new Set();
  const out = [];
  for (const s of lists) {
    const key = `${s.metadata.filename}::${s.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

// 复合问题 → 多路召回；简单问题 → 单路召回
function collectSources(query, subQuestions) {
  const base = retrieve(query, RECALL_K);
  if (!subQuestions || subQuestions.length <= 1) return base;
  const extra = subQuestions.flatMap((q) => retrieve(q, RECALL_K));
  return mergeSources([...base, ...extra], 14);
}

// 召回 top N → LLM 重排 → 取 top K
async function retrieveSources(question, query, subQuestions) {
  const candidates = collectSources(query, subQuestions);
  if (!candidates.length) return [];
  return rerank(question, candidates, RERANK_K);
}

// 单轮问答：返回 { answer, sources }
async function answerQuestion(question, { history = [] } = {}) {
  const subQuestions = await splitQuestion(question);
  const query = retrievalQuery(history, question);
  const sources = await retrieveSources(question, query, subQuestions);

  if (!sources.length) return { answer: NOT_FOUND, sources: [] };

  const consolidated = shouldConsolidate(sources) ? await consolidateSources(question, sources) : null;
  const messages = buildMessages(history, question, sources, consolidated);
  const raw = await llm.complete(messages);
  return { answer: cleanAnswer(raw), sources };
}

module.exports = {
  SYSTEM_PROMPT,
  NOT_FOUND,
  HISTORY_LIMIT,
  RECALL_K,
  RERANK_K,
  buildMessages,
  retrievalQuery,
  mergeSources,
  collectSources,
  retrieveSources,
  answerQuestion,
};
