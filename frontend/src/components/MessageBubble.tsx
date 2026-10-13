import type { ChatMessage } from "../types";
import SourceCard from "./SourceCard";
import StageHint from "./StageHint";

export default function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const isStreaming = message.status === "streaming";
  const hasContent = Boolean(message.content);

  return (
    <div className={`bubble-row bubble-row--${isUser ? "user" : "ai"}`}>
      <div className={`avatar avatar--${isUser ? "user" : "ai"}`}>{isUser ? "我" : "AI"}</div>
      <div className={`bubble bubble--${isUser ? "user" : "ai"}`}>
        {!isUser && isStreaming && <StageHint stage={message.stage || ""} exiting={hasContent} />}

        {hasContent && (
          <div className="bubble__text">
            {message.content}
            {!isUser && isStreaming && <span className="bubble__caret" aria-hidden />}
          </div>
        )}

        {!isUser && message.error && <div className="bubble__error">{message.error}</div>}

        {!isUser && message.sources && message.sources.length > 0 && (
          <div className="sources">
            <div className="sources__label">引用来源 · {message.sources.length} 条</div>
            {message.sources.map((s, i) => (
              <SourceCard key={`${s.metadata?.filename || "src"}-${i}`} source={s} index={i} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
