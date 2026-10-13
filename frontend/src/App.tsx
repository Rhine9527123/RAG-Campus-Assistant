import { useCallback, useEffect, useRef, useState } from "react";
import Composer from "./components/Composer";
import EvalPanel from "./components/EvalPanel";
import MessageBubble from "./components/MessageBubble";
import QuickQuestions from "./components/QuickQuestions";
import SettingsPanel from "./components/SettingsPanel";
import StatusDot from "./components/StatusDot";
import { checkHealth, getBackendUrl, setBackendUrl, streamChat } from "./api";
import type { ChatMessage, HealthStatus } from "./types";

const SERVICE_DOWN = "服务暂时不可用，请稍后重试";

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string>("");
  const [sending, setSending] = useState(false);
  const [health, setHealth] = useState<HealthStatus>("checking");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [backendUrl, setBackendUrlState] = useState<string>(getBackendUrl());
  const [view, setView] = useState<"chat" | "eval">("chat");

  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 客户端打字机：无论网络/代理如何聚合，都逐字渲染
  interface Pump {
    buf: string;
    timer: number | null;
    done: boolean;
  }
  const pumps = useRef<Map<string, Pump>>(new Map());

  const refreshHealth = useCallback(async () => {
    setHealth("checking");
    const ok = await checkHealth();
    setHealth(ok ? "online" : "offline");
    return ok;
  }, []);

  useEffect(() => {
    refreshHealth();
    const timer = window.setInterval(refreshHealth, 15000);
    return () => window.clearInterval(timer);
  }, [refreshHealth]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const patchMessage = (id: string, patch: Partial<ChatMessage>) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  };

  const runPump = (id: string) => {
    const p = pumps.current.get(id);
    if (!p || p.timer !== null) return;
    p.timer = window.setTimeout(() => {
      const s = pumps.current.get(id);
      if (!s) return;
      s.timer = null;
      if (s.buf.length) {
        const next = s.buf.slice(0, 1);
        s.buf = s.buf.slice(1);
        setMessages((prev) =>
          prev.map((m) => (m.id === id ? { ...m, content: m.content + next } : m)),
        );
        runPump(id);
      } else if (s.done) {
        pumps.current.delete(id);
        patchMessage(id, { status: "done", stage: "" });
      }
    }, 14);
  };

  const enqueueAnswer = (id: string, text: string) => {
    let p = pumps.current.get(id);
    if (!p) {
      p = { buf: "", timer: null, done: false };
      pumps.current.set(id, p);
    }
    p.buf += text;
    runPump(id);
  };

  const finishAnswer = (id: string) => {
    const p = pumps.current.get(id);
    if (!p) {
      patchMessage(id, { status: "done", stage: "" });
      return;
    }
    p.done = true;
    runPump(id);
  };

  const send = useCallback(
    async (text: string) => {
      const question = text.trim();
      if (!question || sending) return;

      setSending(true);
      const assistantId = uid();
      setMessages((prev) => [
        ...prev,
        { id: uid(), role: "user", content: question, createdAt: Date.now(), status: "done" },
        { id: assistantId, role: "assistant", content: "", status: "streaming", createdAt: Date.now() },
      ]);

      const controller = new AbortController();
      abortRef.current = controller;

      await streamChat(
        question,
        sessionId || undefined,
        {
          onSession: (sid) => sid && setSessionId(sid),
          onStage: (text) => patchMessage(assistantId, { stage: text }),
          onAnswer: (chunk) => enqueueAnswer(assistantId, chunk),
          onReset: () => {
            pumps.current.delete(assistantId);
            patchMessage(assistantId, { content: "", sources: [], stage: "" });
          },
          onSources: (sources) => patchMessage(assistantId, { sources }),
          onDone: () => finishAnswer(assistantId),
          onError: () => {
            pumps.current.delete(assistantId);
            patchMessage(assistantId, { status: "error", error: SERVICE_DOWN, stage: "" });
            setHealth("offline");
          },
        },
        controller.signal,
      );

      setSending(false);
      abortRef.current = null;
    },
    [sending, sessionId],
  );

  const clearChat = () => {
    abortRef.current?.abort();
    pumps.current.clear();
    setMessages([]);
    setSessionId("");
    setSending(false);
    refreshHealth();
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__brand">
          <span className="topbar__logo" aria-hidden>
            ◎
          </span>
          <div>
            <h1 className="topbar__title">校园智能问答助手</h1>
            <p className="topbar__sub">感知 · 推理 · 决策</p>
          </div>
        </div>
        <div className="topbar__right">
          <StatusDot status={health} onClick={refreshHealth} />
          <button
            className={`topbar__tab${view === "eval" ? " topbar__tab--active" : ""}`}
            type="button"
            onClick={() => setView(view === "eval" ? "chat" : "eval")}
          >
            📊 测评
          </button>
          <button className="topbar__icon" type="button" onClick={() => setSettingsOpen(true)} title="后端设置">
            ⚙
          </button>
        </div>
      </header>

      {view === "eval" ? (
        <main className="chat">
          <EvalPanel />
        </main>
      ) : (
        <>
          <main className="chat" ref={scrollRef}>
            {messages.length === 0 ? (
              <div className="hero">
                <div className="hero__badge">AI 校园助手</div>
                <h2 className="hero__title">
                  随时问我
                  <br />
                  校园里的任何事
                </h2>
                <p className="hero__desc">食堂、宿舍、转专业、奖学金、校门、图书馆……答案全部来自校园知识库并可溯源。</p>
                <QuickQuestions onPick={send} />
              </div>
            ) : (
              <div className="thread">
                {messages.map((m) => (
                  <MessageBubble key={m.id} message={m} />
                ))}
              </div>
            )}
          </main>

          <footer className="footer">
            {messages.length > 0 && (
              <div className="thread-actions">
                <QuickQuestions onPick={send} />
                <button className="btn btn--ghost btn--small" type="button" onClick={clearChat}>
                  清空会话
                </button>
              </div>
            )}
            {health === "offline" && <div className="offline-bar">{SERVICE_DOWN}</div>}
            <Composer disabled={sending} onSend={send} />
            <p className="footer__note">答案由后端知识库检索生成，不编造内容；点击来源卡片可查看引用原文。</p>
          </footer>
        </>
      )}

      <SettingsPanel
        open={settingsOpen}
        backendUrl={backendUrl}
        health={health}
        onClose={() => setSettingsOpen(false)}
        onSave={(url) => {
          setBackendUrl(url);
          setBackendUrlState(url);
          setSettingsOpen(false);
          refreshHealth();
        }}
        onRecheck={refreshHealth}
      />
    </div>
  );
}
