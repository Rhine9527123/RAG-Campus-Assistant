#!/usr/bin/env bash
# 停止脚本：用 ss 提取占用端口的 PID 并终止。
# 说明：不使用 fuser/lsof；不使用 2>/dev/null（避免吞掉 command not found）。
set -u

cd "$(dirname "$0")" || exit 2
PORT="${PORT:-3001}"

listening() {
  ss -ltn | grep -qE "[:.]${PORT}[[:space:]]"
}

if ! listening; then
  echo "[stop] 端口 ${PORT} 未在监听，无需停止。"
  exit 0
fi

pids=$(ss -ltnp | grep -E "[:.]${PORT}[[:space:]]" | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)

if [ -z "$pids" ]; then
  echo "[stop] 已在监听，但未能解析出 PID（可能权限不足）。"
  exit 1
fi

echo "[stop] 终止进程: ${pids}"
for pid in $pids; do
  kill "$pid" || true
done

# 等待端口释放
for _ in $(seq 1 20); do
  if listening; then
    sleep 0.5
  else
    break
  fi
done

# 仍占用则强制终止
if listening; then
  echo "[stop] 普通终止未生效，强制结束: ${pids}"
  for pid in $pids; do
    kill -9 "$pid" || true
  done
  for _ in $(seq 1 10); do
    if listening; then
      sleep 0.5
    else
      break
    fi
  done
fi

if listening; then
  echo "[stop] 停止失败：端口 ${PORT} 仍被占用。"
  exit 1
fi

echo "[stop] 已停止，端口 ${PORT} 已释放。"
exit 0
