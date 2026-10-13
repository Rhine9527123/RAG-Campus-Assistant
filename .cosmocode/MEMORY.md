# 用户指令记忆

本文件记录了用户的指令、偏好和教导，用于在未来的交互中提供参考。

## 格式

### 用户指令条目
用户指令条目应遵循以下格式：

[用户指令摘要]
- Date: [YYYY-MM-DD]
- Context: [提及的场景或时间]
- Instructions:
  - [用户教导或指示的内容，逐行描述]

### 项目知识条目
Agent 在任务执行过程中发现的条目应遵循以下格式：

[项目知识摘要]
- Date: [YYYY-MM-DD]
- Context: Agent 在执行 [具体任务描述] 时发现
- Category: [运维部署|构建方法|测试方法|排错调试|工作流协作|环境配置]
- Instructions:
  - [具体的知识点，逐行描述]

## 去重策略
- 添加新条目前，检查是否存在相似或相同的指令
- 若发现重复，跳过新条目或与已有条目合并
- 合并时，更新上下文或日期信息
- 这有助于避免冗余条目，保持记忆文件整洁

## 条目

[平台内置大模型接入方式]
- Date: 2026-10-12
- Context: Agent 在实现校园问答 RAG 后端、接入大模型时发现
- Category: 环境配置
- Instructions:
  - 平台内置大模型通过环境变量提供：MCAI_LLM_BASE_URL、MCAI_LLM_API_KEY、MCAI_LLM_MODEL，协议为 OpenAI 兼容（chat/completions）
  - 该网关不提供 /embeddings 接口（返回 404），语义检索需在本平台内用关键词/TF-IDF 等本地算法实现
  - 该网关也不提供语音识别（ASR）：/audio/transcriptions 返回 404，且无任何 ASR 相关环境变量；语音输入采用浏览器原生 Web Speech API（前端），不新增后端接口
  - 内置模型为推理模型：流式响应同时含 delta.reasoning_content 与 delta.content，取答案时只应拼接 delta.content
  - 模型在产出正式答案前会先生成较多 reasoning token，建议 max_tokens 设为 1500 以上，避免答案被截断

[平台大模型限流与批量测评节流]
- Date: 2026-10-12
- Context: Agent 在实现自动化测评（逐题调用大模型 + Judge）时发现
- Category: 环境配置
- Instructions:
  - 平台内置大模型网关限流约 30 次/分钟，超限返回 HTTP 429（rate_limit_exceeded）
  - 批量任务（如 51 题测评，每题 2+ 次调用）必须全局限速：backend/llm.js 提供 setRateLimit(ms)，测评期间设为 ~2100ms（约 28 次/分钟），并在结束后重置为 0
  - callChat 内建 429/5xx 重试（指数退避，最多 5 次）
  - 推理模型做 Judge 时，max_tokens 需给足（≥1600，并递增重试），否则 content 为空导致解析失败；解析应 JSON 优先、按字段正则兜底
  - 用该模型做 LLM 重排（Rerank）时：候选 ≤6 条才较稳定；候选达 8-10 条时 reasoning 暴涨、content 常为空且耗时 15-30s
  - 重排设计（backend/rerank.js）：召回 top10 → 规则预过滤取前 5 条 → **一次批量调用**让模型输出排序编号 → 取 top3。含 LRU 缓存（64）、超时回退、失败回退
  - 智能跳过：候选 ≤3，或 top1 与 top2 分差 ≥0.08（召回已确定）→ 跳过重排。因归一化分被压在 0.97-0.99，"top>0.9" 无区分度，故用分差判不确定性
  - 该模型单次重排通常需 3-9s，2s 超时下几乎必然回退；默认超时设为 6s，可用 RERANK_TIMEOUT_MS / RERANK_CANDIDATES / RERANK_GAP_SKIP 调整
  - 网关不响应 reasoning_effort / enable_thinking 等关闭思考的参数（试过无效）

