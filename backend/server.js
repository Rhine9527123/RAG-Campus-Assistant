// 校园智能问答助手 · 平台内后端
// 全流程在本平台内运行：读取 data/ 知识库 → 检索 → 调用平台内置大模型生成 → 返回答案与来源。
// 不再依赖任何外部 BACKEND_URL。

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { stats } = require("./rag");
const llm = require("./llm");
const { StreamingDeduper, consolidateSources, shouldConsolidate } = require("./cleanup");
const { splitQuestion } = require("./split");
const {
  NOT_FOUND,
  buildMessages,
  retrievalQuery,
  collectSources,
  answerQuestion,
} = require("./qa");
const { rerank, shouldRerank } = require("./rerank");
const { registerEvalRoutes } = require("./eval");

const app = express();
const PORT = Number(process.env.PORT || 3001);
const DIST = path.join(__dirname, "..", "frontend", "dist");

// 打开 SSE：设置防缓冲响应头、禁用压缩与 Nagle，并用注释撑开代理缓冲。
// 每次写事件后显式 flush，保证前端能逐字收到。
function openSse(req, res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Content-Encoding", "identity");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  if (req.socket && req.socket.setNoDelay) req.socket.setNoDelay(true);
  if (res.socket && res.socket.setNoDelay) res.socket.setNoDelay(true);

  // 2KB 注释，先一步撑开 nginx 等代理的缓冲区
  res.write(`:${" ".repeat(2048)}\n\n`);

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(":keep-alive\n\n");
  }, 15000);

  const write = (obj) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
    if (typeof res.flush === "function") res.flush();
  };

  const close = () => {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  };

  return { write, close };
}

app.use(express.json({ limit: "1mb" }));

// 会话上下文：保留最近几轮，用于连续追问
const sessions = new Map();

function getSession(id) {
  const sid = id || crypto.randomUUID();
  const rec = sessions.get(sid) || { history: [] };
  sessions.set(sid, rec);
  return { sid, rec };
}

// 逐字吐字器：把已去重的句子按固定速率逐字写出（打字机效果）
function createTypewriter(write, { tickMs = 12 } = {}) {
  let queue = "";
  let running = false;
  const waiters = [];
  const settle = () => {
    while (waiters.length) waiters.shift()();
  };
  const tick = () => {
    if (queue.length) {
      write(queue.slice(0, 1));
      queue = queue.slice(1);
      setTimeout(tick, tickMs);
    } else {
      running = false;
      settle();
    }
  };
  return {
    push(text) {
      if (!text) return;
      queue += text;
      if (!running) {
        running = true;
        setTimeout(tick, tickMs);
      }
    },
    idle() {
      if (!running && !queue.length) return Promise.resolve();
      return new Promise((res) => waiters.push(res));
    },
  };
}

function answer(question, sessionId) {
  return (async () => {
    const { sid, rec } = getSession(sessionId);
    const out = await answerQuestion(question, { history: rec.history });
    rec.history.push({ role: "user", content: question });
    rec.history.push({ role: "assistant", content: out.answer });
    return { answer: out.answer, sources: out.sources, session_id: sid };
  })();
}

app.get("/health", (req, res) => {
  const s = stats();
  const cfg = llm.resolveLLM();
  res.json({
    status: "ok",
    service: "campus-qa-rag",
    knowledge: { files: s.files, chunks: s.chunks },
    llm: { model: cfg.model, configured: cfg.configured },
    time: new Date().toISOString(),
  });
});

app.post("/chat", async (req, res) => {
  const question = String((req.body && req.body.question) || "").trim();
  if (!question) return res.status(400).json({ error: "question is required" });
  try {
    const out = await answer(question, req.body && req.body.session_id);
    return res.json(out);
  } catch (err) {
    return res.status(502).json({ error: "generation failed", detail: String(err.message || err) });
  }
});

app.post("/chat/stream", async (req, res) => {
  const question = String((req.body && req.body.question) || "").trim();

  const { write, close } = openSse(req, res);

  if (!question) {
    write({ type: "error", message: "question is required" });
    return close();
  }

  const { sid, rec } = getSession(req.body && req.body.session_id);
  write({ type: "session", session_id: sid });

  const controller = new AbortController();
  res.on("close", () => controller.abort());

  // 阶段 1：立即推给前端，用户一提问就有反馈
  write({ type: "stage", text: "🔍 正在理解问题…" });

  // 规则拆分（快）；先召回较多候选，再做 LLM 重排
  const subQuestions = await splitQuestion(question);
  const candidates = collectSources(retrievalQuery(rec.history, question), subQuestions);

  if (!candidates.length) {
    write({ type: "answer", text: NOT_FOUND });
    write({ type: "sources", sources: [] });
    write({ type: "done" });
    rec.history.push({ role: "user", content: question });
    rec.history.push({ role: "assistant", content: NOT_FOUND });
    return close();
  }

  // 重排序：仅当"召回质量不确定"时才走 LLM 重排，简单问题直接跳过以恢复速度
  let sources = candidates.slice(0, 3);
  if (shouldRerank(candidates)) {
    write({ type: "stage", text: `🔍 检索到 ${candidates.length} 条，正在重排序…` });
    sources = await rerank(question, candidates, 3);
    if (controller.signal.aborted) return;
  }

  // 阶段 2：仅在需要时整理资料（片段多或明显重复），简单问题直接跳过
  let consolidated = null;
  if (shouldConsolidate(sources)) {
    write({ type: "stage", text: "📚 正在整理检索资料…" });
    consolidated = await consolidateSources(question, sources);
    if (controller.signal.aborted) return;
  }

  // 阶段 3：生成回答
  write({ type: "stage", text: "✍️ 正在生成回答…" });

  const typewriter = createTypewriter((chunk) => write({ type: "answer", text: chunk }));
  const deduper = new StreamingDeduper();
  let full = "";
  try {
    await llm.stream(
      buildMessages(rec.history, question, sources, consolidated),
      (delta) => {
        const out = deduper.push(delta); // 按句缓冲 + 去重
        if (out) {
          full += out;
          typewriter.push(out); // 去重后的句子再逐字吐出
        }
      },
      { signal: controller.signal },
    );
    const tail = deduper.flush();
    if (tail) {
      full += tail;
      typewriter.push(tail);
    }
    await typewriter.idle();
  } catch (err) {
    write({ type: "error", message: String(err.message || err) });
    return close();
  }

  rec.history.push({ role: "user", content: question });
  rec.history.push({ role: "assistant", content: full });
  write({ type: "sources", sources });
  write({ type: "done" });
  close();
});

// 自动化测评路由（/eval/run、/eval/results、/eval/results/:id）
registerEvalRoutes(app);

// 托管前端构建产物
app.use(express.static(DIST));
app.get("*", (req, res, next) => {
  if (req.method !== "GET") return next();
  res.sendFile(path.join(DIST, "index.html"), (err) => {
    if (err) next();
  });
});

app.listen(PORT, "0.0.0.0", () => {
  const cfg = llm.resolveLLM();
  const s = stats();
  console.log(`[campus-qa] listening on http://0.0.0.0:${PORT}`);
  console.log(`[campus-qa] knowledge: ${s.files} files / ${s.chunks} chunks (${s.dir})`);
  console.log(`[campus-qa] llm: ${cfg.model} @ ${cfg.baseUrl || "(未配置)"}`);
});
