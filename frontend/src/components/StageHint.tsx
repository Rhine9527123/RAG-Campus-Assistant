import { useEffect, useMemo, useRef, useState } from "react";

// 真实阶段 → 有温度的文案（由后端 stage 事件驱动，不随机切）
const PHASE_LISTS: Record<string, string[]> = {
  start: ["正在读懂你的问题…", "正在翻找校园知识库…", "正在从 11 份校园文档里找线索…"],
  rerank: ["正在挑出最相关的几条资料…", "正在给资料排排队…", "正在从 11 份校园文档里找线索…"],
  consolidate: ["资料有点多，正在仔细整理…", "正在把重复的内容合并…"],
  generate: ["正在组织答案，马上就好…", "答案马上就来…"],
};

const SLOW_TIP = "资料有点多，正在仔细整理…";

function pickPhase(stage: string): string {
  if (!stage) return "start";
  if (stage.includes("重排")) return "rerank";
  if (stage.includes("整理")) return "consolidate";
  if (stage.includes("生成")) return "generate";
  return "start"; // 「理解问题」等 → 读懂/检索阶段
}

export default function StageHint({ stage, exiting }: { stage: string; exiting: boolean }) {
  const phase = pickPhase(stage);
  const [text, setText] = useState("");
  const [phraseKey, setPhraseKey] = useState(0);
  const [slow, setSlow] = useState(false);
  const idxRef = useRef(0);
  const timers = useRef<number[]>([]);

  const list = useMemo(() => {
    const base = PHASE_LISTS[phase] || PHASE_LISTS.start;
    return slow && !base.includes(SLOW_TIP) ? [...base, SLOW_TIP] : base;
  }, [phase, slow]);

  // 等待较久 → 追加兜底文案
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), 9000);
    return () => window.clearTimeout(t);
  }, []);

  // 阶段变化 → 从该阶段第一句开始
  useEffect(() => {
    idxRef.current = 0;
  }, [phase]);

  // 逐字浮现 + 轮播
  useEffect(() => {
    let alive = true;
    const clear = () => {
      timers.current.forEach((t) => window.clearTimeout(t));
      timers.current = [];
    };
    clear();

    const run = (i: number) => {
      if (!alive) return;
      const phrase = list[i % list.length];
      idxRef.current = i % list.length;
      setPhraseKey((k) => k + 1);
      let n = 0;
      const type = () => {
        if (!alive) return;
        n += 1;
        setText(phrase.slice(0, n));
        if (n < phrase.length) {
          timers.current.push(window.setTimeout(type, 45));
        } else {
          timers.current.push(window.setTimeout(() => run(i + 1), 1100));
        }
      };
      setText("");
      type();
    };

    run(idxRef.current);
    return () => {
      alive = false;
      clear();
    };
  }, [list]);

  return (
    <div className={`stage-hint${exiting ? " stage-hint--out" : ""}`} aria-live="polite">
      <span className="stage-hint__glow" aria-hidden />
      <span key={phraseKey} className="stage-hint__text">
        {text || "\u00A0"}
      </span>
      <span className="stage-hint__dots" aria-hidden>
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}
