// 平台内知识库：读取 data/ 下的文本，按「标题/小节」切分并保留标题路径，
// 检索时用「关键词(BM25) + 同义词扩展 + 主题/属性加权」找出最相关片段。
// 全部逻辑在本平台内运行，不依赖任何外部服务。

const fs = require("fs");
const path = require("path");
const { resolveDataDir } = require("./config");

const MAX_SUBSECTION = 1200; // 单个小节过长时再按段落切，避免超大片段
const SENTENCE_SPLIT = /(?<=[。！？!?；;])/;

let cache = { signature: "", index: null };

function listDocs(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && /\.(txt|md)$/i.test(e.name))
    .map((e) => {
      const full = path.join(dir, e.name);
      const stat = fs.statSync(full);
      return { name: e.name, full, mtimeMs: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

function readMetadata(dir) {
  const file = path.join(dir, "metadata.json");
  if (!fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    const map = {};
    const put = (filename, category, source) => {
      if (!filename) return;
      map[String(filename)] = {
        category: String(category || "未分类"),
        source: source ? String(source) : "",
      };
    };
    const putEntry = (it) => {
      if (!it || typeof it !== "object") return;
      put(it.filename || it.file || it.name, it.category || it.cat, it.source);
    };
    if (Array.isArray(raw)) {
      raw.forEach(putEntry);
    } else if (raw && typeof raw === "object") {
      const nested = raw.files || raw.documents;
      if (Array.isArray(nested)) {
        nested.forEach(putEntry);
      } else if (nested && typeof nested === "object") {
        for (const [f, v] of Object.entries(nested)) {
          if (v && typeof v === "object") put(f, v.category, v.source);
          else put(f, v, "");
        }
      }
      for (const [f, v] of Object.entries(raw)) {
        if (f.startsWith("_") || f === "files" || f === "documents") continue;
        if (v && typeof v === "object") put(f, v.category, v.source);
      }
    }
    return map;
  } catch {
    return {};
  }
}

// 返回标题层级（0 表示不是标题）。
// markdown=true 时只认 "#" 标题，避免把正文里的编号列表误判为标题；
// 非 markdown 文档才启用启发式（括号标题、中文序号、关键词结尾）。
function headingLevel(line, markdown) {
  const t = line.trim();
  if (!t) return 0;
  const m = t.match(/^(#{1,6})\s+(.+)$/);
  if (m) return m[1].length;
  if (markdown) return 0;
  if (t.length > 40) return 0;
  if (/^[【\[][^】\]]{1,30}[】\]]$/.test(t)) return 3;
  if (/(大纲|目录|指南|制度|办法|通知|说明|须知|规定|流程|条件|时间|地点|安排)$/.test(t) && t.length <= 24) {
    return 3;
  }
  if (/^[一二三四五六七八九十]+[、.．]\s*\S/.test(t)) return 2;
  return 0;
}

function cleanHeading(line) {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[【\[]/, "")
    .replace(/[】\]]$/, "")
    .replace(/\*\*/g, "")
    .replace(/^[一二三四五六七八九十]+[、.．]\s*/, "")
    .replace(/^\d+[、.．]\s*/, "")
    .trim();
}

function explodeBySentence(block, max) {
  const sentences = block.split(SENTENCE_SPLIT).filter((s) => s.trim());
  const out = [];
  let buf = "";
  const flush = () => {
    if (buf.trim()) out.push(buf.trim());
    buf = "";
  };
  for (const s of sentences) {
    let piece = s;
    while (piece.length > max) {
      out.push(piece.slice(0, max).trim());
      piece = piece.slice(max);
    }
    if (buf && buf.length + piece.length > max) flush();
    buf += piece;
  }
  flush();
  return out;
}

// 按「标题/小节」切分：每个小节作为一个片段，并携带完整标题路径（如「食堂 / 开放时间」）
function chunkDocument(filename, meta, raw) {
  const category = (meta && meta.category) || "未分类";
  const source = (meta && meta.source) || "";
  const text = String(raw).replace(/\r\n?/g, "\n");
  const lines = text.split("\n");

  const stack = [];
  let buffer = [];
  const sections = [];
  const markdown = lines.some((l) => /^#{1,6}\s+/.test(l.trim()));

  const currentTitle = () =>
    stack
      .map((s) => s.title)
      .filter(Boolean)
      .join(" / ");

  const flush = () => {
    const body = buffer.join("\n").trim();
    if (body) sections.push({ title: currentTitle(), body });
    buffer = [];
  };

  for (const line of lines) {
    const lvl = headingLevel(line, markdown);
    if (lvl > 0) {
      flush();
      const title = cleanHeading(line);
      while (stack.length && stack[stack.length - 1].level >= lvl) stack.pop();
      if (title) stack.push({ level: lvl, title });
    } else {
      buffer.push(line);
    }
  }
  flush();

  const out = [];
  for (const sec of sections) {
    if (sec.body.length <= MAX_SUBSECTION) {
      out.push(sec);
      continue;
    }
    const paras = sec.body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    let buf = "";
    const flushPara = () => {
      if (buf.trim()) out.push({ title: sec.title, body: buf.trim() });
      buf = "";
    };
    for (const p of paras) {
      const pieces = p.length > MAX_SUBSECTION ? explodeBySentence(p, MAX_SUBSECTION) : [p];
      for (const piece of pieces) {
        if (buf && buf.length + piece.length + 2 > MAX_SUBSECTION) flushPara();
        buf = buf ? `${buf}\n\n${piece}` : piece;
      }
    }
    flushPara();
  }

  return out.map((s, i) => ({
    id: `${filename}#${i + 1}`,
    filename,
    category,
    source,
    title: s.title || "",
    text: s.title ? `【${s.title}】\n${s.body}` : s.body,
    searchText: `${s.title}\n${s.body}`.toLowerCase(),
    order: i,
  }));
}

// ---- 分词与检索 ----

function tokenize(text) {
  const lower = String(text || "").toLowerCase();
  const tokens = [];
  for (const w of lower.match(/[a-z0-9]{2,}/g) || []) tokens.push(w);
  const han = lower.replace(/[^\u4e00-\u9fa5]/g, "");
  for (let i = 0; i < han.length - 1; i += 1) tokens.push(han.slice(i, i + 2));
  if (han.length === 1) tokens.push(han);
  return tokens;
}

// 同义词/相关词扩展：命中任一词即扩展出整组词，用于提升召回
const SYNONYM_GROUPS = [
  ["几点", "时间", "时候", "时段", "营业", "营业时间", "开放", "开放时间", "开门", "关门", "开始", "结束", "作息", "早餐", "午餐", "晚餐", "宵夜", "早中晚"],
  ["食堂", "餐厅", "饭堂", "饭馆", "就餐", "吃饭"],
  ["宿舍", "寝室", "公寓", "住宿", "门禁", "熄灯"],
  ["图书馆", "图书室", "自习室", "借书", "借阅"],
  ["校门", "大门", "门口", "进出"],
  ["转专业", "转系", "换专业", "调专业"],
  ["奖学金", "助学金", "奖助学金", "奖助", "补助"],
  ["校园卡", "一卡通", "饭卡"],
  ["请假", "缓考", "考勤", "病假", "事假"],
  ["选课", "退课", "补选", "抢课", "课程", "必修", "选修"],
  ["校医院", "医务室", "看病", "就医", "医疗", "医保", "报销"],
  ["快递", "取件", "驿站", "物流", "菜鸟"],
  ["体育馆", "操场", "健身房", "游泳", "体育", "运动"],
  ["缴费", "收费", "学费", "住宿费", "费用"],
  ["校园网", "网络", "wifi", "宽带", "上网", "流量", "vpn"],
  ["心理咨询", "心理", "情绪", "压力"],
  ["社团", "学生会", "组织", "活动"],
];

function expandQuery(question) {
  const q = String(question || "").toLowerCase();
  const terms = new Set();
  for (const group of SYNONYM_GROUPS) {
    if (group.some((w) => q.includes(w.toLowerCase()))) {
      for (const w of group) terms.add(w);
    }
  }
  return [...terms];
}

// 属性/疑问类词：多为“怎么问”的修饰词，信息量低，不应主导排序
const ATTRIBUTE_TERMS = new Set([
  "几点", "时间", "时候", "时段", "营业", "营业时间", "开放", "开放时间", "开门", "关门",
  "开始", "结束", "作息", "早餐", "午餐", "晚餐", "宵夜", "早中晚",
  "怎么", "如何", "什么", "哪些", "哪个", "哪里", "哪", "吗", "呢",
  "需要", "条件", "流程", "地点", "费用", "价格", "多少", "介绍", "说明", "情况", "时候",
]);

const W_TOPIC = 6; // 主题词权重
const W_ATTR = 1.2; // 属性词权重

function buildIndex() {
  const dir = resolveDataDir();
  const metas = readMetadata(dir);
  const docs = listDocs(dir);
  const signature = docs.map((d) => `${d.name}:${d.mtimeMs}:${d.size}`).join("|");

  const chunks = [];
  for (const d of docs) {
    let raw = "";
    try {
      raw = fs.readFileSync(d.full, "utf-8");
    } catch {
      continue;
    }
    chunks.push(...chunkDocument(d.name, metas[d.name] || {}, raw));
  }

  const df = new Map();
  const chunkTokens = chunks.map((c) => {
    const tokens = tokenize(c.text);
    const seen = new Set(tokens);
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
    const freq = new Map();
    for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
    return { freq, len: tokens.length || 1 };
  });

  const N = chunks.length || 1;
  const idf = new Map();
  for (const [t, d] of df) idf.set(t, Math.log(1 + (N - d + 0.5) / (d + 0.5)));
  const avgdl = chunks.length ? chunkTokens.reduce((a, c) => a + c.len, 0) / chunks.length : 1;

  return { dir, chunks, chunkTokens, idf, avgdl, docCount: docs.length, signature };
}

function getIndex() {
  const dir = resolveDataDir();
  const docsSignature = listDocs(dir)
    .map((d) => `${d.name}:${d.mtimeMs}:${d.size}`)
    .join("|");
  const metaFile = path.join(dir, "metadata.json");
  let metaSig = "";
  try {
    metaSig = String(fs.statSync(metaFile).mtimeMs);
  } catch {
    metaSig = "none";
  }
  const signature = `${docsSignature}||${metaSig}`;
  if (!cache.index || cache.signature !== signature) {
    cache = { signature, index: buildIndex() };
  }
  return cache.index;
}

function normalizeScore(raw, max) {
  if (!max) return 0;
  const rel = raw / max;
  const abs = 1 - Math.exp(-raw / 8);
  return Number(Math.max(0.3, Math.min(0.99, 0.55 + 0.44 * rel * (0.35 + 0.65 * abs))).toFixed(2));
}

function retrieve(question, topK = 5) {
  const index = getIndex();
  if (!index.chunks.length) return [];

  const qTokens = tokenize(question);
  if (!qTokens.length) return [];

  const { chunks, chunkTokens, idf, avgdl } = index;
  const k1 = 1.2;
  const b = 0.75;
  const qLower = String(question || "").toLowerCase();

  const N = chunks.length || 1;
  const IDF_MIN = 0.8; // 低于此值视为“泛词”，不作为有效证据

  // 候选词 = 同义词扩展 ∪ 问题自身的关键词（二元组），按长度降序以便去重
  const candidates = [
    ...new Set([...expandQuery(question), ...qTokens.filter((t) => t.length >= 2)]),
  ]
    .map((t) => t.toLowerCase())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  const dfCache = new Map();
  const dfTerm = (term) => {
    if (dfCache.has(term)) return dfCache.get(term);
    let d = 0;
    for (const c of chunks) if (c.searchText.includes(term)) d += 1;
    dfCache.set(term, d);
    return d;
  };
  // 词的信息量：越稀有越重要
  const idfTerm = (term) => Math.log(1 + N / (1 + dfTerm(term)));

  const isTopic = (term) => !ATTRIBUTE_TERMS.has(term);

  const scored = chunks.map((c, i) => {
    const { freq, len } = chunkTokens[i];
    let score = 0;
    for (const t of qTokens) {
      const f = freq.get(t);
      if (!f) continue;
      score += (idf.get(t) || 0) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avgdl)));
    }

    const title = (c.title || "").toLowerCase();
    const body = c.searchText;
    let specific = false;
    let bodyBoost = 0;
    const matched = [];

    for (const t of candidates) {
      // 跳过被更长命中词覆盖的重叠词，避免子串重复计数
      if (matched.some((m) => m.includes(t) || t.includes(m))) continue;
      const inTitle = title.includes(t);
      const inBody = body.includes(t);
      if (!inTitle && !inBody) continue;
      matched.push(t);

      const it = idfTerm(t);
      const topic = isTopic(t);
      if (topic && it >= IDF_MIN) specific = true;
      const w = topic ? W_TOPIC : W_ATTR;
      if (inTitle && topic && it >= 0.3) score += w * it;
      else if (inTitle) score += W_ATTR * it * 0.6;
      if (inBody && topic && it >= 0.5) bodyBoost += it * 1.2;
    }
    score += Math.min(bodyBoost, 8);

    // 同时命中「主题词 + 属性词」的片段更精确（如「食堂 + 开放时间」）
    const hasTopic = matched.some((t) => isTopic(t) && idfTerm(t) >= IDF_MIN);
    const hasAttr = matched.some((t) => !isTopic(t));
    if (hasTopic && hasAttr) score += 3;

    if (c.filename && qLower && c.filename.toLowerCase().includes(qLower.slice(0, 4))) score += 1.5;
    return { c, raw: score, specific };
  });

  scored.sort((a, b) => b.raw - a.raw);
  const best = scored[0];
  // 必须命中至少一个高信息量词，否则视为未找到（避免无关问题被硬召回）
  if (!best || best.raw <= 0 || !best.specific) return [];

  const max = best.raw;
  return scored
    .filter((s) => s.raw >= max * 0.35 && s.specific)
    .slice(0, topK)
    .map((s) => ({
      text: s.c.text,
      score: normalizeScore(s.raw, max),
      metadata: {
        filename: s.c.filename,
        category: s.c.category,
        ...(s.c.source ? { source: s.c.source } : {}),
      },
    }));
}

function stats() {
  const index = getIndex();
  return { files: index.docCount, chunks: index.chunks.length, dir: index.dir };
}

module.exports = { retrieve, stats, getIndex };
