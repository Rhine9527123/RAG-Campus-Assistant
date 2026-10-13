// LLM 重排序（Rerank）：用平台内置大模型对召回片段按"能否回答该问题"重排。
// 含 LRU 缓存、超时与失败回退，绝不阻断问答。
//
// 说明：平台内置为推理模型，候选过多会导致 reasoning 暴涨（content 为空、耗时 15-30s）。
// 因此召回仍是 top 10，但只把排名靠前的 RERANK_CANDIDATES 条交给模型重排，
// 其余候选保留在尾部作为回退。

const llm = require("./llm");

const CACHE_MAX = Number(process.env.RERANK_CACHE_MAX || 64); // LRU 容量
const cache = new Map(); // LRU：key = query + 候选签名
const RERANK_CANDIDATES = Number(process.env.RERANK_CANDIDATES || 5); // 粗筛后交给 LLM 的候选数
const TIMEOUT_MS = Number(process.env.RERANK_TIMEOUT_MS || 6000); // 单次重排超时（超时即回退原始顺序）
const SKIP_SCORE = Number(process.env.RERANK_SKIP_SCORE || 0.9); // 最高分阈值
const GAP_SKIP = Number(process.env.RERANK_GAP_SKIP || 0.08); // top1 与 top2 的分差阈值

// 是否需要重排：
// - 候选 ≤3 → 跳过
// - 最高分已很高且与第二名有明显差距 → 召回已准 → 跳过
// 分差小说明召回存在歧义，才走重排
function shouldRerank(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (list.length <= 3) return false;
  const top = list[0]?.score ?? 0;
  const second = list[1]?.score ?? 0;
  if (top >= SKIP_SCORE && top - second >= GAP_SKIP) return false;
  return true;
}

const RERANK_SYSTEM = [
  "你是检索重排序助手。给定一个用户问题和若干候选片段，",
  "请只依据『该片段能否回答该问题』判断相关性，并从高到低排序。",
  "不要受片段长短、措辞风格、出现次数的影响，只按信息是否切题。",
  "只输出 JSON，不要任何解释。",
].join("");

function hash(str) {
  let h = 5381;
  const s = String(str || "");
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function cacheKey(question, subset) {
  const sig = subset.map((c) => `${c.metadata?.filename || ""}:${hash(c.text)}`).join("|");
  return `${question}||${sig}`;
}

function cacheGet(key) {
  if (!cache.has(key)) return null;
  const v = cache.get(key);
  cache.delete(key);
  cache.set(key, v);
  return v;
}

function cacheSet(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

function truncate(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function parseOrder(text, n) {
  const m = String(text || "").match(/\[[\s\S]*?\]/);
  if (!m) return null;
  const nums = (m[0].match(/\d+/g) || []).map(Number);
  const seen = new Set();
  const order = [];
  for (const x of nums) {
    if (Number.isInteger(x) && x >= 0 && x < n && !seen.has(x)) {
      seen.add(x);
      order.push(x);
    }
  }
  return order.length ? order : null;
}

async function callRerank(question, subset) {
  const prompt = [
    `【问题】\n${question}`,
    `【候选片段】\n${subset.map((c, i) => `[${i}] ${truncate(c.text, 220)}`).join("\n\n")}`,
    `请只输出按相关性从高到低排列的片段编号 JSON 数组，例如 [2,0,3,1]。`,
  ].join("\n\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const out = await llm.complete(
      [
        { role: "system", content: RERANK_SYSTEM },
        { role: "user", content: prompt },
      ],
      { maxTokens: 2000, temperature: 0, signal: controller.signal },
    );
    return parseOrder(out, subset.length);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @returns 重排后的片段数组（长度 ≤ topK）。失败时回退为原始顺序的前 topK。
 */
async function rerank(question, candidates, topK = 3) {
  const list = Array.isArray(candidates) ? candidates : [];
  // 智能跳过：候选太少，或最高分已很高（召回已准）
  if (!shouldRerank(list)) return list.slice(0, Math.max(topK, Math.min(list.length, 3)));

  // 规则预过滤：只把 BM25 分最高的前 N 条交给 LLM，明显不相关的直接丢弃
  const subset = list.slice(0, RERANK_CANDIDATES);
  const key = cacheKey(question, subset);
  const cached = cacheGet(key);
  if (cached) return cached.slice(0, topK);

  try {
    const order = await callRerank(question, subset);
    if (!order) return list.slice(0, topK); // 格式不对 → 回退原顺序

    const ranked = order.map((i) => subset[i]);
    for (let i = 0; i < list.length; i += 1) {
      if (!ranked.includes(list[i])) ranked.push(list[i]);
    }
    cacheSet(key, ranked);
    return ranked.slice(0, topK);
  } catch {
    return list.slice(0, topK); // 报错/超时 → 回退原顺序
  }
}

module.exports = { rerank, shouldRerank };
