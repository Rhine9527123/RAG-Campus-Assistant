// 启动前确保前端构建产物存在；缺失则自动构建一次，避免“接口可用但页面 404/5xx”。
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const root = path.join(__dirname, "..");
const indexPath = path.join(root, "frontend", "dist", "index.html");

if (fs.existsSync(indexPath)) {
  console.log("[prestart] frontend/dist 已存在，跳过构建");
} else {
  console.log("[prestart] frontend/dist 缺失，开始构建前端...");
  execSync("npm --prefix frontend run build", { stdio: "inherit", cwd: root });
  console.log("[prestart] 前端构建完成");
}
