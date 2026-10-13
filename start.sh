#!/usr/bin/env bash
# 启动脚本：端口固定（默认 3001）
# 退出码：已启动→0；启动成功→0；启动失败→2
# 说明：不使用 timeout 启动服务；生产模式构建以规避 dev 热重载的内存峰值(OOM)。
set -u

cd "$(dirname "$0")" || exit 2
PORT="${PORT:-3001}"
LOG="logs/server.log"

listening() {
  ss -ltn | grep -qE "[:.]${PORT}[[:space:]]"
}

# 1) 已启动 → 直接返回 0
if listening; then
  echo "[start] 服务已在端口 ${PORT} 运行，直接返回。"
  exit 0
fi

# 2) 清理旧进程（用 stop.sh，避免残留子进程占用端口）
if [ -f ./stop.sh ]; then
  bash ./stop.sh
fi

# 3) 清理构建缓存并做生产构建（避免 dev 模式内存峰值）
echo "[start] 清理构建缓存并构建前端（生产模式）..."
rm -rf frontend/dist frontend/node_modules/.vite

if [ ! -d frontend/node_modules ]; then
  npm --prefix frontend install --no-audit --no-fund || { echo "[start] 前端依赖安装失败"; exit 2; }
fi
npm --prefix frontend run build || { echo "[start] 前端构建失败"; exit 2; }

if [ ! -d backend/node_modules ]; then
  npm --prefix backend install --no-audit --no-fund || { echo "[start] 后端依赖安装失败"; exit 2; }
fi

# 4) 启动服务：先 export 再 nohup（不要把 VAR=... 写在 nohup 前面）
mkdir -p logs
export NODE_ENV=production
export PORT
export NODE_OPTIONS="--max-old-space-size=512"
nohup node backend/server.js >> "$LOG" 2>&1 &
PID=$!

# 5) 就绪检测（轮询端口，不使用 timeout，不阻塞）
for _ in $(seq 1 40); do
  if listening; then
    echo "[start] 启动成功：pid ${PID}，监听端口 ${PORT}。"
    exit 0
  fi
  if ! ps -p "$PID" >/dev/null; then
    echo "[start] 启动失败：进程已退出，请查看日志 ${LOG}。"
    exit 2
  fi
  sleep 0.5
done

echo "[start] 启动失败：等待超时，端口 ${PORT} 未监听，请查看日志 ${LOG}。"
exit 2
