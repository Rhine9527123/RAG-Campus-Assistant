// 自动化测评：内置评测页的后端。
// 逐题走平台内问答流程 → 用平台大模型作 Judge 打分（三档 0/0.5/1）→ 汇总并本地存储。
// 全部使用平台内能力，无外部依赖。

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { answerQuestion } = require("./qa");
const llm = require("./llm");

const EVAL_DIR = path.join(__dirname, "..", "eval");
const RUNS_DIR = path.join(EVAL_DIR, "runs");
const DATASET_FILE = process.env.EVAL_DATASET || path.join(EVAL_DIR, "eval_dataset.json");
const OOS_FILE = process.env.EVAL_OOS || path.join(EVAL_DIR, "eval_oos.json");
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY || 3);
const LLM_INTERVAL_MS = Number(process.env.EVAL_LLM_INTERVAL_MS || 2100); // 平台限流 30 次/分钟
const DIMENSIONS = ["faithfulness", "relevancy", "correctness"];

function ensureRunsDir() {
  if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, { recursive: true });
}

function loadDataset() {
  const raw = JSON.parse(fs.readFileSync(DATASET_FILE, "utf-8"));
  const items = Array.isArray(raw) ? raw : raw.testset || raw.items || raw.data || [];
  return {
    meta: { version: raw.version, knowledge_version: raw.knowledge_version, description: raw.description },
    items,
  };
}

// 超纲题（知识库里没有答案），用于检验是否老实拒答
function loadOos() {
  if (!fs.existsSync(OOS_FILE)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(OOS_FILE, "utf-8"));
    return Array.isArray(raw) ? raw : raw.testset || raw.items || raw.data || [];
  } catch {
    return [];
  }
}

// 拒答判定：答案明确表示知识库没有/无法回答即视为“正确拒答”
const REFUSAL_RE =
  /(知识库(中)?(暂未|没有|未|无)|未(找到|收录|提及|说明|提供|包含)|没有(找到|相关|收录|提及)|暂无(相关|信息|内容)|无相关|不(涉及|在知识库)|无法(回答|确定|提供|得知|获知)|不清楚|不知道|抱歉|无法为您|资料(中)?(没有|未|不足)|未提及)/;

function isRefusal(answer) {
  return REFUSAL_RE.test(String(answer || ""));
}

function runFile(id) {
  return path.join(RUNS_DIR, `${id}.json`);
}

function saveRun(run) {
  ensureRunsDir();
  fs.writeFileSync(runFile(run.id), JSON.stringify(run, null, 2), "utf-8");
}

function loadRun(id) {
  const file = runFile(id);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function listRuns() {
  ensureRunsDir();
  return fs
    .readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), "utf-8"));
        return {
          id: r.id,
          created_at: r.created_at,
          status: r.status,
          total: r.total,
          completed: r.completed,
          summary: r.summary,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

// ---- Judge ----

function snap(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n >= 0.85) return 1;
  if (n >= 0.6) return 0.5;
  if (n >= 0.25) return 0.5;
  return 0;
}

function parseJudge(text) {
  const raw = String(text || "");
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]);
      return normalize(o.faithfulness, o.relevancy, o.correctness, o.comment);
    } catch {
      /* fall through to regex */
    }
  }
  const pick = (key) => {
    const mm = raw.match(new RegExp(`${key}[^0-9]{0,10}([01](?:\\.5)?)`, "i"));
    return mm ? mm[1] : null;
  };
  const f = pick("faithfulness");
  const r = pick("relevancy");
  const c = pick("correctness");
  if (f !== null && r !== null && c !== null) return normalize(f, r, c, "（正则解析）");
  return null;
}

function normalize(f, r, c, comment) {
  return {
    faithfulness: snap(f),
    relevancy: snap(r),
    correctness: snap(c),
    comment: String(comment || "").slice(0, 200),
  };
}

const JUDGE_SYSTEM = [
  "你是严格、客观、不宽容的评测裁判。尤其在对同一模型自评时，必须严格：宁可给低分，也不要给高分。",
  "依据【问题】【参考答案】【检索上下文】【系统答案】打分。三个维度取值只能是 0、0.5、1：",
  "faithfulness（忠实度）：答案是否 100% 基于【检索上下文】。出现任何上下文之外或编造的信息记 0；完全基于上下文得 1。",
  "relevancy（相关性）：是否正面、完整地回答【问题】。答非所问、未作答、只堆砌无关信息记 0；部分回答得 0.5；切题且完整得 1。",
  "correctness（正确性）：关键事实是否与【参考答案】一致。事实错误或缺失核心要点记 0；仅覆盖部分要点得 0.5；完全一致得 1。",
  "评分从紧：不确定时给更低的一档。",
  '直接输出 JSON，不要输出其它内容：{"faithfulness":0/0.5/1,"relevancy":0/0.5/1,"correctness":0/0.5/1,"comment":"简要理由"}',
].join("\n");

async function judgeOnce(item, answer, sources, maxTokens) {
  const context = sources.map((s, i) => `[片段${i + 1}]（${s.metadata.filename}）\n${s.text}`).join("\n\n");
  const user = [
    `【问题】\n${item.question}`,
    `【参考答案】\n${item.reference}`,
    `【检索上下文】\n${context || "（无）"}`,
    `【系统答案】\n${answer}`,
  ].join("\n\n");
  const out = await llm.complete(
    [
      { role: "system", content: JUDGE_SYSTEM },
      { role: "user", content: user },
    ],
    { maxTokens, temperature: 0 },
  );
  return parseJudge(out);
}

async function judge(item, answer, sources) {
  // 递增加长输出上限重试：推理模型可能把额度耗在思考上
  for (const maxTokens of [1600, 2400, 3000]) {
    try {
      const parsed = await judgeOnce(item, answer, sources, maxTokens);
      if (parsed) return parsed;
    } catch {
      /* 尝试下一档 */
    }
  }
  return null;
}

// ---- 检索侧指标：Context Precision / Context Recall ----

const CONTEXT_SYSTEM = [
  "你是检索质量评估助手。给定【问题】【参考答案】【检索片段】（带编号 [0][1]…），请输出 JSON：",
  '- "relevant"：与【问题】相关的检索片段编号数组（只含编号，无相关则为空数组）；',
  '- "points"：把【参考答案】拆成若干关键要点，逐点判断能否在【检索片段】中找到依据，',
  '  输出 [{"text":"要点","covered":true/false}]。',
  '只输出 JSON，不要任何解释。',
].join("\n");

function parseContext(text, nSnippets) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const relevant = Array.isArray(obj.relevant)
    ? [...new Set(obj.relevant.map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x < nSnippets))]
    : [];
  const points = Array.isArray(obj.points)
    ? obj.points
        .map((p) => ({ text: String(p?.text || "").slice(0, 120), covered: Boolean(p?.covered) }))
        .filter((p) => p.text)
    : [];
  const precision = nSnippets > 0 ? relevant.length / nSnippets : 0;
  const recall = points.length > 0 ? points.filter((p) => p.covered).length / points.length : 0;
  return { precision, recall, relevant, points };
}

async function judgeContextOnce(item, sources, maxTokens) {
  const snippets = sources.map((s, i) => `[${i}] ${String(s.text).replace(/\s+/g, " ").slice(0, 240)}`).join("\n");
  const user = [`【问题】\n${item.question}`, `【参考答案】\n${item.reference}`, `【检索片段】\n${snippets}`].join("\n\n");
  const out = await llm.complete(
    [
      { role: "system", content: CONTEXT_SYSTEM },
      { role: "user", content: user },
    ],
    { maxTokens, temperature: 0 },
  );
  return parseContext(out, sources.length);
}

async function judgeContext(item, sources) {
  if (!sources.length) return { precision: 0, recall: 0, relevant: [], points: [] };
  for (const maxTokens of [1600, 2400]) {
    try {
      const parsed = await judgeContextOnce(item, sources, maxTokens);
      if (parsed) return parsed;
    } catch {
      /* 尝试下一档 */
    }
  }
  return null; // 技术失败
}

// ---- 运行器 ----

// 依据三维得分归类：满分 / 部分得分 / 0 分（答错）
function classify(scores) {
  const vals = [scores.faithfulness, scores.relevancy, scores.correctness];
  if (vals.every((v) => v === 1)) return "full";
  if (scores.correctness === 0) return "zero"; // 关键事实错误/缺失 → 答错
  if (vals.every((v) => v === 0)) return "zero";
  return "partial";
}

async function processItem(item, entry) {
  try {
    const { answer, sources } = await answerQuestion(item.question, { history: [] });
    entry.answer = answer;
    entry.sources = sources.map((s) => ({
      filename: s.metadata.filename,
      category: s.metadata.category,
      score: s.score,
    }));

    // 超纲题：只判定“正确拒答 / 幻觉”，不做三维打分
    if (item.type === "oos") {
      entry.scores = null;
      if (!sources.length || isRefusal(answer)) {
        entry.grade = "refuse";
        entry.status = "done";
        entry.error = undefined;
      } else {
        entry.grade = "hallucination";
        entry.status = "done";
      }
      return;
    }

    // 检索侧指标：Context Precision / Context Recall
    entry.context = await judgeContext(item, sources);

    // 系统未命中知识库：这是真实结果，直接计 0 分并计入均分
    if (!sources.length) {
      entry.scores = { faithfulness: 0, relevancy: 0, correctness: 0, comment: "知识库未命中，计 0 分" };
      entry.grade = "nohit";
      entry.status = "done";
      return;
    }

    // Judge 技术故障（无有效输出/接口报错）才标 error，可排除
    const scores = await judge(item, answer, sources);
    if (!scores) {
      entry.scores = null;
      entry.grade = "error";
      entry.status = "error";
      entry.error = "judge unavailable (technical failure)";
      return;
    }

    entry.scores = scores;
    entry.grade = classify(scores);
    entry.status = "done";
  } catch (err) {
    entry.answer = entry.answer || "";
    // 生成阶段的技术故障也算 error（非“答错”）
    entry.scores = null;
    entry.grade = "error";
    entry.status = "error";
    entry.error = String(err.message || err);
  }
}

function summarize(run) {
  const normal = run.items.filter((it) => it.type !== "oos");
  const oos = run.items.filter((it) => it.type === "oos");
  const scored = normal.filter((it) => it.status === "done"); // 含未命中(0 分)，不含 error
  const n = scored.length || 1;
  const avg = (dim) => Number((scored.reduce((a, it) => a + (it.scores?.[dim] || 0), 0) / n).toFixed(3));
  const counts = { full: 0, partial: 0, zero: 0, nohit: 0, error: 0 };
  for (const it of normal) {
    if (it.status === "error") counts.error += 1;
    else if (it.grade && counts[it.grade] !== undefined) counts[it.grade] += 1;
  }

  // 检索侧指标（仅统计成功算出的项）
  const ctxItems = scored.filter((it) => it.context);
  const cn = ctxItems.length || 1;
  const avgPrecision = Number((ctxItems.reduce((a, it) => a + (it.context.precision || 0), 0) / cn).toFixed(3));
  const avgRecall = Number((ctxItems.reduce((a, it) => a + (it.context.recall || 0), 0) / cn).toFixed(3));
  const contextError = scored.filter((it) => !it.context).length;

  const oosRefuse = oos.filter((it) => it.grade === "refuse").length;
  const oosHallu = oos.filter((it) => it.grade === "hallucination").length;
  const oosError = oos.filter((it) => it.status === "error").length;
  return {
    avg_faithfulness: avg("faithfulness"),
    avg_relevancy: avg("relevancy"),
    avg_correctness: avg("correctness"),
    avg_overall: Number(((avg("faithfulness") + avg("relevancy") + avg("correctness")) / 3).toFixed(3)),
    scored: scored.length,
    error: counts.error,
    counts,
    avg_context_precision: avgPrecision,
    avg_context_recall: avgRecall,
    context_error: contextError,
    diagnosis: diagnose(avgPrecision, avgRecall, ctxItems.length),
    oos_total: oos.length,
    oos_refuse: oosRefuse,
    oos_hallucination: oosHallu,
    oos_error: oosError,
    refusal_rate: oosRefuse + oosHallu ? Number((oosRefuse / (oosRefuse + oosHallu)).toFixed(3)) : 0,
  };
}

// 依据检索侧指标给出优化方向
function diagnose(precision, recall, sampleCount) {
  if (!sampleCount) return "检索侧样本不足，暂无法诊断。";
  const HI = 0.7;
  const hiP = precision >= HI;
  const hiR = recall >= HI;
  if (hiR && !hiP) return "高召回、低精度 → 建议加重排序（Rerank），把不相关片段排后。";
  if (!hiR && hiP) return "低召回、高精度 → 建议扩充知识库或改进检索策略（召回更多相关内容）。";
  if (!hiR && !hiP) return "召回与精度都偏低 → 检索策略需要重构（切分/关键词/扩召回）。";
  return "检索质量良好（召回与精度都较高）。";
}

async function runEval(runId, count) {
  const run = loadRun(runId);
  if (!run) return;
  // 测评期间对平台大模型限速，避免触发 30 次/分钟限流
  llm.setRateLimit(LLM_INTERVAL_MS);
  try {
    const queue = run.items.filter((it) => it.status === "pending");
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const idx = cursor;
        cursor += 1;
        if (idx >= queue.length) return;
        const entry = queue[idx];
        await processItem(entry, entry);
        run.completed = run.items.filter((it) => it.status !== "pending").length;
        run.summary = summarize(run);
        saveRun(run);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, worker));
    run.status = "done";
    run.completed = run.total;
    run.summary = summarize(run);
    run.finished_at = new Date().toISOString();
    saveRun(run);
  } catch (err) {
    run.status = "error";
    run.error = String(err.message || err);
    saveRun(run);
  } finally {
    llm.setRateLimit(0);
  }
}

// ---- 路由 ----

function registerEvalRoutes(app) {
  app.post("/eval/run", async (req, res) => {
    const count = Math.max(1, Math.min(Number((req.body && req.body.count) || 10) || 10, 51));
    let dataset;
    try {
      dataset = loadDataset();
    } catch (err) {
      return res.status(500).json({ error: "dataset not found", detail: String(err.message || err) });
    }

    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
    const normalItems = dataset.items.slice(0, count).map((it) => ({
      id: it.id,
      question: it.question,
      reference: it.reference,
      source: it.source,
      category: it.category,
      type: "normal",
      status: "pending",
      answer: "",
      sources: [],
      scores: null,
    }));
    const oosItems = loadOos().map((it) => ({
      id: it.id,
      question: it.question,
      reference: "",
      source: "",
      category: it.category || "超纲（知识库无）",
      type: "oos",
      expect: it.expect || "refuse",
      status: "pending",
      answer: "",
      sources: [],
      scores: null,
    }));
    const items = [...normalItems, ...oosItems];

    const run = {
      id,
      created_at: new Date().toISOString(),
      status: "running",
      total: items.length,
      completed: 0,
      dataset_version: dataset.meta.version,
      items,
      summary: {
        avg_faithfulness: 0,
        avg_relevancy: 0,
        avg_correctness: 0,
        avg_overall: 0,
        scored: 0,
        error: 0,
        counts: { full: 0, partial: 0, zero: 0, nohit: 0, error: 0 },
        avg_context_precision: 0,
        avg_context_recall: 0,
        context_error: 0,
        diagnosis: "",
        oos_total: oosItems.length,
        oos_refuse: 0,
        oos_hallucination: 0,
        oos_error: 0,
        refusal_rate: 0,
      },
    };
    saveRun(run);

    // 后台异步跑，避免请求长时间阻塞（前端轮询查询进度）
    setImmediate(() => runEval(id, count));

    return res.json({ run_id: id, status: "running", total: items.length, ...run.summary });
  });

  app.get("/eval/results", (req, res) => {
    res.json({ runs: listRuns() });
  });

  app.get("/eval/results/:id", (req, res) => {
    const run = loadRun(req.params.id);
    if (!run) return res.status(404).json({ error: "run not found" });
    return res.json(run);
  });
}

module.exports = { registerEvalRoutes, loadDataset };
