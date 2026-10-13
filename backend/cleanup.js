// 答案去重清理能力
// 1) 参考资料去重：生成答案前，用大模型合并重复信息、只保留与问题相关的要点
// 2) 答案去重：生成后按规则清理正文（连续重复句 / 前缀重复 / 尾部重复）
// 只作用于答案正文，不影响 sources 列表与接口返回格式。

const llm = require("./llm");

const CONSOLIDATE_SYSTEM = [
  "你是资料整理助手。请把给定的知识片段整理成一份干净的参考资料，供后续答题使用。",
  "要求：1) 合并重复信息，同一信息只保留一次；2) 只保留与问题相关的要点；",
  "3) 用简洁中文重新组织语言，可使用分点；4) 不要回答问题，不要添加片段之外的信息，不要编造。",
  "直接输出整理后的要点。",
].join("");

const MIN_MATERIAL = 50; // 资料过短则跳过去重整理

const SENT_SPLIT_FOR_DUP = /[。！？!?\n]+/;

// 明显重复：不同片段里出现同一条较长句子
function hasObviousDuplication(sources) {
  if (!sources || sources.length < 2) return false;
  const sets = sources.map(
    (s) =>
      new Set(
        String(s.text || "")
          .split(SENT_SPLIT_FOR_DUP)
          .map((t) => t.replace(/[\s　]+/g, ""))
          .filter((t) => t.length >= 8),
      ),
  );
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      for (const sent of sets[i]) {
        if (sets[j].has(sent)) return true;
      }
    }
  }
  return false;
}

// 是否需要调用大模型整理资料：
// - 检测到明显重复（同一句子出现在多个片段）→ 需要
// - 片段较多且彼此高度相似 → 需要
// 其余（大多数简单问题）直接跳过，避免不必要的前置调用
function shouldConsolidate(sources, maxSimple = 3) {
  if (!sources || !sources.length) return false;
  if (hasObviousDuplication(sources)) return true;
  if (sources.length > maxSimple) return avgPairwiseSimilarity(sources) >= 0.3;
  return false;
}

function bigrams(text) {
  const s = String(text || "").toLowerCase().replace(/[\s　]+/g, "");
  const set = new Set();
  for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
  return set;
}

function avgPairwiseSimilarity(sources) {
  if (sources.length < 2) return 0;
  const sets = sources.map((s) => bigrams(s.text));
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      let inter = 0;
      for (const g of sets[i]) if (sets[j].has(g)) inter += 1;
      const uni = sets[i].size + sets[j].size - inter;
      sum += uni ? inter / uni : 0;
      cnt += 1;
    }
  }
  return cnt ? sum / cnt : 0;
}

async function consolidateSources(question, sources) {
  if (!sources || !sources.length) return null;
  const joined = sources.map((s, i) => `[${i + 1}] ${s.text}`).join("\n\n");
  if (joined.replace(/[\s　]/g, "").length < MIN_MATERIAL) return null;

  try {
    const out = await llm.complete(
      [
        { role: "system", content: CONSOLIDATE_SYSTEM },
        { role: "user", content: `【问题】\n${question}\n\n【知识片段】\n${joined}` },
      ],
      { maxTokens: 700, temperature: 0 },
    );
    const text = String(out || "").trim();
    return text || null;
  } catch {
    return null; // 整理失败则回退到原始片段，不阻断答题
  }
}

// ---- 规则清理 ----

function normalizeSentence(s) {
  return String(s || "")
    .replace(/[\s　]+/g, "")
    .replace(/^[\-*·•>]+/, "")
    .replace(/^\d+[\.、)）]\s*/, "")
    .replace(/[。！？!?，,；;：:、"'“”‘’()（）\[\]【】]/g, "")
    .toLowerCase();
}

// 句子级：删除连续重复的句子（跨行也判定，如重复的条目）
function dedupeConsecutiveSentences(text) {
  const tokens = String(text).match(/[^\n]+|\n/g) || [];
  const out = [];
  let prev = "";
  for (const tok of tokens) {
    if (tok === "\n") {
      out.push("\n");
      continue;
    }
    for (const s of tok.split(/(?<=[。！？!?])/)) {
      if (!s) continue;
      const n = normalizeSentence(s);
      if (n && n === prev) continue; // 连续重复，丢弃后一句
      if (n) prev = n;
      out.push(s);
    }
  }
  return out.join("");
}

// 前缀重复：答案前 30-60 字若在后段再次出现，截断到重复处
function truncatePrefixRepeat(text, min = 30, max = 60) {
  const n = text.length;
  if (n < min * 2) return text;
  for (let L = max; L >= min; L -= 1) {
    const prefix = text.slice(0, L);
    if (prefix.trim().length < min) continue;
    const idx = text.indexOf(prefix, L);
    if (idx >= L && idx >= n * 0.3) {
      return text.slice(0, idx).replace(/[\s　]+$/, "");
    }
  }
  return text;
}

// 尾部重复：末尾 30-50 字若在更早处出现过，去掉重复的尾部
function truncateTailRepeat(text, min = 30, max = 50) {
  const n = text.length;
  if (n < min * 2) return text;
  const half = Math.floor(n / 2);
  for (let L = max; L >= min; L -= 1) {
    const start = n - L;
    if (start <= half) continue;
    const needle = text.slice(start);
    const first = text.indexOf(needle);
    if (first >= 0 && first < start) {
      return text.slice(0, start).replace(/[\s　]+$/, "");
    }
  }
  return text;
}

function cleanAnswer(text) {
  if (!text) return text;
  let t = dedupeConsecutiveSentences(text);
  t = truncatePrefixRepeat(t);
  t = truncateTailRepeat(t);
  return t.replace(/\n{3,}/g, "\n\n").trim();
}

// 流式去重器：实时抑制连续重复句，保持逐字/逐句输出
class StreamingDeduper {
  constructor() {
    this.buffer = "";
    this.prev = "";
  }

  push(delta) {
    this.buffer += delta;
    const m = this.buffer.match(/[\s\S]*[。！？!?\n]/);
    if (!m) return "";
    const complete = m[0];
    this.buffer = this.buffer.slice(complete.length);
    return this._emit(complete);
  }

  flush() {
    const rest = this.buffer;
    this.buffer = "";
    if (!rest) return "";
    const n = normalizeSentence(rest);
    if (n && n === this.prev) return "";
    if (n) this.prev = n;
    return rest;
  }

  _emit(complete) {
    let out = "";
    for (const tok of complete.match(/[^\n]+|\n/g) || []) {
      if (tok === "\n") {
        out += "\n";
        continue;
      }
      for (const s of tok.split(/(?<=[。！？!?])/)) {
        if (!s) continue;
        const n = normalizeSentence(s);
        if (n && n === this.prev) continue;
        if (n) this.prev = n;
        out += s;
      }
    }
    return out;
  }
}

module.exports = { consolidateSources, shouldConsolidate, hasObviousDuplication, cleanAnswer, StreamingDeduper };
