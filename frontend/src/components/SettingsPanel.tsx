import { useState } from "react";
import type { HealthStatus } from "../types";

interface Props {
  open: boolean;
  backendUrl: string;
  health: HealthStatus;
  onClose: () => void;
  onSave: (url: string) => void;
  onRecheck: () => void;
}

export default function SettingsPanel({ open, backendUrl, health, onClose, onSave, onRecheck }: Props) {
  const [draft, setDraft] = useState(backendUrl);

  if (!open) return null;

  return (
    <div className="settings-mask" onClick={onClose}>
      <div className="settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings__head">
          <h2>后端服务设置</h2>
          <button className="settings__close" type="button" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <p className="settings__hint">
          问答由本平台后端完成（知识库检索 + 大模型生成）。默认同源即可；如需指向其它后端，可在下方填写地址覆盖。
        </p>
        <label className="settings__label" htmlFor="backend-url">
          后端地址（可选）
        </label>
        <input
          id="backend-url"
          className="settings__input"
          value={draft}
          placeholder="https://your-backend.example.com"
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="settings__row">
          当前状态：
          <span className={`settings__state settings__state--${health}`}>
            {health === "online" ? "服务在线" : health === "offline" ? "服务离线" : "检测中"}
          </span>
        </div>
        <div className="settings__actions">
          <button className="btn btn--ghost" type="button" onClick={onRecheck}>
            重新检测
          </button>
          <button
            className="btn btn--primary"
            type="button"
            onClick={() => {
              onSave(draft.trim());
            }}
          >
            保存并测试
          </button>
        </div>
      </div>
    </div>
  );
}
