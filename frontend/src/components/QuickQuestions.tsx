import { QUICK_QUESTIONS } from "../constants";

export default function QuickQuestions({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="quick">
      <div className="quick__title">高频问题，点击直接提问</div>
      <div className="quick__grid">
        {QUICK_QUESTIONS.map((q) => (
          <button key={q} className="quick__item" type="button" onClick={() => onPick(q)}>
            <span className="quick__spark" aria-hidden>
              ✦
            </span>
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
