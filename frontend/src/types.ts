export interface SourceMeta {
  filename?: string;
  category?: string;
  [key: string]: unknown;
}

export interface Source {
  text: string;
  score: number;
  metadata?: SourceMeta;
}

export interface ChatResponse {
  answer: string;
  sources: Source[];
  session_id: string;
}

export type MessageStatus = "streaming" | "done" | "error";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  stage?: string;
  sources?: Source[];
  status?: MessageStatus;
  error?: string;
  createdAt: number;
}

export type HealthStatus = "checking" | "online" | "offline";

export interface EvalScores {
  faithfulness: number;
  relevancy: number;
  correctness: number;
  comment?: string;
}

export interface EvalContext {
  precision: number;
  recall: number;
  relevant?: number[];
  points?: { text: string; covered: boolean }[];
}

export interface EvalItem {
  id: string;
  question: string;
  reference: string;
  source?: string;
  category?: string;
  type?: "normal" | "oos";
  status: string;
  grade?: "full" | "partial" | "zero" | "nohit" | "error" | "refuse" | "hallucination" | "pending";
  error?: string;
  answer: string;
  sources: { filename: string; category?: string; score: number }[];
  scores: EvalScores | null;
  context?: EvalContext | null;
}

export interface EvalCounts {
  full: number;
  partial: number;
  zero: number;
  nohit: number;
  error: number;
}

export interface EvalSummary {
  avg_faithfulness: number;
  avg_relevancy: number;
  avg_correctness: number;
  avg_overall: number;
  scored: number;
  error: number;
  counts: EvalCounts;
  avg_context_precision: number;
  avg_context_recall: number;
  context_error: number;
  diagnosis: string;
  oos_total: number;
  oos_refuse: number;
  oos_hallucination: number;
  oos_error: number;
  refusal_rate: number;
}

export interface EvalRun {
  id: string;
  created_at: string;
  status: "running" | "done" | "error";
  total: number;
  completed: number;
  items: EvalItem[];
  summary: EvalSummary;
  error?: string;
}

export interface EvalRunBrief {
  id: string;
  created_at: string;
  status: string;
  total: number;
  completed: number;
  summary: EvalSummary;
}
