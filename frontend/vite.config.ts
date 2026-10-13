import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发模式下将 /chat、/health 反向代理到本平台后端（生产为同源单端口）
const backendTarget = process.env.BACKEND_TARGET || "http://localhost:3001";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: [".cosmoplat.cn", ".cosmoplat.com", ".cosmoplat.net"],
    proxy: {
      "/chat": { target: backendTarget, changeOrigin: true },
      "/health": { target: backendTarget, changeOrigin: true },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
  },
});
