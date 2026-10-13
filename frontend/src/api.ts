import type { ChatResponse, EvalRun, EvalRunBrief, Source } from "./types";

const STORAGE_KEY = "campus-qa.backend-url";

// 后端地址优先级：运行时设置 > 构建期环境变量 > 同源（走反向代理）
export function getBackendUrl(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null) return saved.trim();
  } catch {
    /* ignore */
  }
  const envUrl = import.meta.env.VITE_BACKEND_URL as string | undefined;
  return (envUrl || "").trim();
}

export function setBackendUrl(url: string): void {
  try {
    if (url.trim()) localStorage.setItem(STORAGE_KEY, url.trim());
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function join(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  return `${b}${path}`;
}

export async function checkHealth(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(join(getBackendUrl(), "/health"), { method: "GET", signal });
    return res.ok;
  } catch {
    return false;
  }
}

export async function runEval(count: number): Promise<{ run_id: string; status: string; total: number }> {
  const res = await fetch(join(getBackendUrl(), "/eval/run"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ count }),
  });
  if (!res.ok) throw new Error(`eval run http ${res.status}`);
  return res.json();
}

export async function getEvalResults(): Promise<EvalRunBrief[]> {
  const res = await fetch(join(getBackendUrl(), "/eval/results"));
  if (!res.ok) throw new Error(`eval results http ${res.status}`);
  const json = (await res.json()) as { runs: EvalRunBrief[] };
  return json.runs || [];
}

export async function getEvalResult(id: string): Promise<EvalRun> {
  const res = await fetch(join(getBackendUrl(), `/eval/results/${encodeURIComponent(id)}`));
  if (!res.ok) throw new Error(`eval result http ${res.status}`);
  return res.json();
}

export interface StreamHandlers {
  onStage?: (text: string) => void;
  onAnswer?: (chunk: string) => void;
  onSources?: (sources: Source[]) => void;
  onSession?: (sessionId: string) => void;
  onReset?: () => void;
  onDone?: (full: ChatResponse) => void;
  onError?: (message: string) => void;
}

/**
 * 调用 POST /chat/stream 并按 SSE 逐块回调。
 * 若流式接口不可用，自动回退到 /chat 一次性接口。
 */
export async function streamChat(
  question: string,
  sessionId: string | undefined,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const base = getBackendUrl();
  let answer = "";
  let sources: Source[] = [];
  let sid = sessionId || "";
  const controller = signal ? null : new AbortController();
  const effectiveSignal = signal || (controller ? controller.signal : undefined);

  try {
    const res = await fetch(join(base, "/chat/stream"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ question, session_id: sessionId || undefined }),
      signal: effectiveSignal,
    });

    if (!res.ok || !res.body) throw new Error(`stream http ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLines = rawEvent
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart());
        if (!dataLines.length) continue;
        const payload = dataLines.join("\n");
        if (!payload) continue;

        let evt: Record<string, unknown>;
        try {
          evt = JSON.parse(payload);
        } catch {
          continue;
        }
        const type = String(evt.type || "");
        if (type === "stage" && typeof evt.text === "string") {
          handlers.onStage?.(evt.text);
        } else if (type === "answer" && typeof evt.text === "string") {
          answer += evt.text;
          handlers.onAnswer?.(evt.text);
        } else if (type === "sources" && Array.isArray(evt.sources)) {
          sources = evt.sources as Source[];
          handlers.onSources?.(sources);
        } else if (type === "session" && typeof evt.session_id === "string") {
          sid = evt.session_id;
          handlers.onSession?.(sid);
        } else if (type === "error") {
          throw new Error(String(evt.message || "stream error"));
        }
      }
    }

    handlers.onDone?.({ answer, sources, session_id: sid });
  } catch (err) {
    if (signal && signal.aborted) return;
    // 流式失败时降级为普通 /chat；若已输出部分内容先重置，避免重复
    if (answer) handlers.onReset?.();
    answer = "";
    sources = [];
    try {
      const res = await fetch(join(base, "/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, session_id: sessionId || undefined }),
        signal,
      });
      if (!res.ok) throw new Error(`chat http ${res.status}`);
      const json = (await res.json()) as ChatResponse;
      handlers.onSession?.(json.session_id);
      handlers.onAnswer?.(json.answer);
      handlers.onSources?.(json.sources || []);
      handlers.onDone?.({ answer: json.answer, sources: json.sources || [], session_id: json.session_id });
    } catch (e2) {
      handlers.onError?.((e2 as Error).message || "request failed");
    }
  }
}
