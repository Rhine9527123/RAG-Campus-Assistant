import { useState } from "react";
import type { Source } from "../types";

function toPercent(score: number): number {
  const value = score <= 1 ? score * 100 : score;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export default function SourceCard({ source, index }: { source: Source; index: number }) {
  const [open, setOpen] = useState(false);
  const meta = source.metadata || {};
  const filename = (meta.filename as string) || `来源文档 ${index + 1}`;
  const category = meta.category as string | undefined;
  const similarity = toPercent(source.score ?? 0);

  return (
    <div className={`source-card${open ? " source-card--open" : ""}`}>
      <button className="source-card__head" type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="source-card__chevron">{open ? "▾" : "▸"}</span>
        <span className="source-card__title" title={filename}>
          {category && <span className="source-card__tag">{category}</span>}
          {filename}
        </span>
        <span className="source-card__score" title={`相关度 ${similarity}%`}>
          <span className="source-card__score-bar">
            <i style={{ width: `${similarity}%` }} />
          </span>
          <span className="source-card__score-num">{similarity}%</span>
        </span>
      </button>
      {open && <p className="source-card__text">{source.text}</p>}
    </div>
  );
}
