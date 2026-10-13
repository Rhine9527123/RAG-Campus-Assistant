import type { HealthStatus } from "../types";

const LABEL: Record<HealthStatus, string> = {
  checking: "检测中",
  online: "服务在线",
  offline: "服务离线",
};

export default function StatusDot({ status, onClick }: { status: HealthStatus; onClick?: () => void }) {
  return (
    <button className="status" type="button" onClick={onClick} title={`后端${LABEL[status]}`}>
      <span className={`status__dot status__dot--${status}`} />
      <span className="status__label">{LABEL[status]}</span>
    </button>
  );
}
