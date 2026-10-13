import { useCallback, useEffect, useRef, useState } from "react";
import { getEvalResult, getEvalResults, runEval } from "../api";
import type { EvalItem, EvalRun, EvalRunBrief } from "../types";

function pct(v: number): string {
  return `${Math.round((v || 0) * 100)}%`;
}

function itemOverall(it: EvalItem): number {
  if (!it.scores) return 0;
  return (it.scores.faithfulness + it.scores.relevancy + it.scores.correctness) / 3;
}

function scoreClass(v: number): string {
  if (v >= 0.85) return "good";
  if (v >= 0.5) return "mid";
  return "bad";
}

const GRADE_LABEL: Record<string, string> = {
  full: "满分",
  partial: "部分",
  zero: "0分",
  nohit: "未命中",
  error: "错误",
  refuse: "正确拒答",
  hallucination: "幻觉",
  pending: "待测",
};

function gradeLabel(g?: string): string {
  return GRADE_LABEL[g || "pending"] || "待测";
}

function gradeClass(g?: string): string {
  if (g === "full" || g === "refuse") return "good";
  if (g === "partial") return "mid";
  return "bad";
}

export default function EvalPanel() {
  const [count, setCount] = useState(10);
  const [run, setRun] = useState<EvalRun | null>(null);
  const [history, setHistory] = useState<EvalRunBrief[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await getEvalResults());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadHistory();
    return () => {
      if (pollRef.current) window.clearTimeout(pollRef.current);
    };
  }, [loadHistory]);

  const poll = useCallback(
    (id: string) => {
      pollRef.current = window.setTimeout(async () => {
        try {
          const r = await getEvalResult(id);
          setRun(r);
          if (r.status === "running") {
            poll(id);
          } else {
            setBusy(false);
            loadHistory();
          }
        } catch {
          setBusy(false);
        }
      }, 1500);
    },
    [loadHistory],
  );

  const start = async () => {
    setError("");
    setBusy(true);
    setRun(null);
    setExpanded(null);
    try {
      const { run_id } = await runEval(count);
      const first = await getEvalResult(run_id);
      setRun(first);
      poll(run_id);
    } catch (e) {
      setError((e as Error).message || "测评启动失败");
      setBusy(false);
    }
  };

  const openHistory = async (id: string) => {
    if (pollRef.current) window.clearTimeout(pollRef.current);
    setBusy(false);
    setError("");
    try {
      setRun(await getEvalResult(id));
    } catch {
      setError("读取历史记录失败");
    }
  };

  const s = run?.summary;

  return (
    <div className="eval">
      <div className="eval__bar">
        <div className="eval__title">
          <span className="eval__title-icon" aria-hidden>
            📊
          </span>
          自动化测评
        </div>
        <div className="eval__controls">
          <label className="eval__count">
            题数
            <input
              type="number"
              min={1}
              max={51}
              value={count}
              onChange={(e) => setCount(Math.max(1, Math.min(51, Number(e.target.value) || 1)))}
            />
          </label>
          <button className="btn btn--primary" type="button" onClick={start} disabled={busy}>
            {busy ? "测评中…" : "开始测评"}
          </button>
        </div>
      </div>

      {error && <div className="eval__error">{error}</div>}

      {run && (
        <>
          <div className="eval__progress">
            <span>
              进度 {run.completed}/{run.total}
            </span>
            <span className={`eval__status eval__status--${run.status}`}>
              {run.status === "running" ? "运行中" : run.status === "done" ? "已完成" : "出错"}
            </span>
          </div>
          <div className="eval__progressbar">
            <i style={{ width: `${run.total ? (run.completed / run.total) * 100 : 0}%` }} />
          </div>

          <div className="eval__section-title">生成侧指标</div>
          <div className="eval__cards">
            <div className="eval-card">
              <div className="eval-card__label">忠实度 Faithfulness</div>
              <div className={`eval-card__value eval-card__value--${scoreClass(s!.avg_faithfulness)}`}>
                {pct(s!.avg_faithfulness)}
              </div>
            </div>
            <div className="eval-card">
              <div className="eval-card__label">相关性 Relevancy</div>
              <div className={`eval-card__value eval-card__value--${scoreClass(s!.avg_relevancy)}`}>
                {pct(s!.avg_relevancy)}
              </div>
            </div>
            <div className="eval-card">
              <div className="eval-card__label">正确性 Correctness</div>
              <div className={`eval-card__value eval-card__value--${scoreClass(s!.avg_correctness)}`}>
                {pct(s!.avg_correctness)}
              </div>
            </div>
            <div className="eval-card eval-card--total">
              <div className="eval-card__label">综合 Overall</div>
              <div className={`eval-card__value eval-card__value--${scoreClass(s!.avg_overall)}`}>
                {pct(s!.avg_overall)}
              </div>
            </div>
          </div>

          <div className="eval__section-title">检索侧指标（RAGAS）</div>
          <div className="eval__cards eval__cards--2">
            <div className="eval-card">
              <div className="eval-card__label">Context Precision 上下文精度</div>
              <div className={`eval-card__value eval-card__value--${scoreClass(s!.avg_context_precision ?? 0)}`}>
                {pct(s!.avg_context_precision ?? 0)}
              </div>
            </div>
            <div className="eval-card">
              <div className="eval-card__label">Context Recall 上下文召回</div>
              <div className={`eval-card__value eval-card__value--${scoreClass(s!.avg_context_recall ?? 0)}`}>
                {pct(s!.avg_context_recall ?? 0)}
              </div>
            </div>
          </div>
          {s!.diagnosis && <div className="eval__diag">诊断建议：{s!.diagnosis}</div>}

          <div className="eval-card eval-card--hallu">
            <div className="eval-card__label">防幻觉 · 正确拒答率（超纲题 {s!.oos_total ?? 0} 道）</div>
            <div className={`eval-card__value eval-card__value--${scoreClass(s!.refusal_rate ?? 0)}`}>
              {pct(s!.refusal_rate ?? 0)}
            </div>
            <div className="eval__hallu-sub">
              正确拒答 {s!.oos_refuse ?? 0} · 幻觉 {s!.oos_hallucination ?? 0} · 技术故障 {s!.oos_error ?? 0}
            </div>
          </div>

          <div className="eval__dist">
            <span className="eval__chip eval__chip--good">满分 {s!.counts?.full ?? 0}</span>
            <span className="eval__chip eval__chip--mid">部分 {s!.counts?.partial ?? 0}</span>
            <span className="eval__chip eval__chip--bad">0分 {s!.counts?.zero ?? 0}</span>
            <span className="eval__chip eval__chip--bad">未命中 {s!.counts?.nohit ?? 0}</span>
            <span className="eval__chip eval__chip--err">错误(排除) {s!.counts?.error ?? 0}</span>
            <span className="eval__chip eval__chip--good">正确拒答 {s!.oos_refuse ?? 0}</span>
            <span className="eval__chip eval__chip--bad">幻觉 {s!.oos_hallucination ?? 0}</span>
            <span className="eval__chip">计分题 {s!.scored}</span>
          </div>

          <div className="eval__table">
            <div className="eval__thead">
              <span>题号</span>
              <span>结果</span>
              <span>答案摘要</span>
            </div>
            {run.items.map((it) => (
              <div className="eval__rowwrap" key={it.id}>
                <button
                  className="eval__row"
                  type="button"
                  onClick={() => setExpanded(expanded === it.id ? null : it.id)}
                >
                  <span className="eval__qid">{it.id}</span>
                  <span className={`eval__score eval__score--${gradeClass(it.grade)}`}>
                    {it.grade === "pending"
                      ? "…"
                      : it.type === "oos" || it.grade === "error"
                        ? gradeLabel(it.grade)
                        : `${gradeLabel(it.grade)} ${pct(itemOverall(it))}`}
                  </span>
                  <span className="eval__excerpt">{it.answer ? it.answer.replace(/\n+/g, " ").slice(0, 70) : "待测评"}</span>
                </button>
                {expanded === it.id && (
                  <div className="eval__detail">
                    {it.grade === "refuse" && (
                      <p className="eval__reason eval__reason--ok">超纲题：系统正确拒答（未编造）。</p>
                    )}
                    {it.grade === "hallucination" && (
                      <p className="eval__reason">超纲题：系统在知识库无依据时仍给出答案，判定为幻觉。</p>
                    )}
                    {it.grade === "nohit" && <p className="eval__reason">未命中知识库，按 0 分计入均分。</p>}
                    {it.grade === "zero" && (
                      <p className="eval__reason">
                        未正确作答：检索未命中或关键事实与参考答案不一致，按 0 分计入均分。
                      </p>
                    )}
                    {it.grade === "error" && (
                      <p className="eval__reason">Judge 技术故障，已从均分中排除（非系统答错）。</p>
                    )}
                    <p>
                      <b>问题：</b>
                      {it.question}
                    </p>
                    {it.type !== "oos" && (
                      <p>
                        <b>参考答案：</b>
                        {it.reference}
                      </p>
                    )}
                    <p>
                      <b>系统答案：</b>
                      {it.answer || "（无）"}
                    </p>
                    {it.scores && (
                      <p>
                        <b>评分：</b> 忠实度 {it.scores.faithfulness} / 相关性 {it.scores.relevancy} / 正确性{" "}
                        {it.scores.correctness}
                        {it.scores.comment ? `　（${it.scores.comment}）` : ""}
                      </p>
                    )}
                    {it.context && (
                      <p>
                        <b>检索质量：</b> 精度 {pct(it.context.precision)} / 召回 {pct(it.context.recall)}
                      </p>
                    )}
                    {it.sources.length > 0 && (
                      <p>
                        <b>来源：</b>{" "}
                        {it.sources.map((x) => `${x.filename}(${x.score})`).join("、")}
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <div className="eval__history">
        <div className="eval__history-title">历史记录</div>
        {history.length === 0 && <div className="eval__empty">暂无记录</div>}
        {history.map((h) => (
          <button key={h.id} className="eval__history-item" type="button" onClick={() => openHistory(h.id)}>
            <span className="eval__history-time">{new Date(h.created_at).toLocaleString("zh-CN")}</span>
            <span className="eval__history-meta">
              {h.completed}/{h.total} · 综合 {pct(h.summary?.avg_overall || 0)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
