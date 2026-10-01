export type DriftType =
  | 'none'
  | 'scope_creep'
  | 'rabbit_hole'
  | 'wrong_approach'
  | 'task_confusion'
  | 'yak_shaving';

export interface Message {
  role: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'system';
  content: string;
  timestamp?: number;
  toolName?: string;
  filePaths?: string[];
}

export interface Intent {
  description: string;
  constraints?: string[];
  context?: string;
}

export interface DriftResult {
  isDrifting: boolean;
  probability: number;
  severity: number;
  severityLabel: string;
  type: DriftType;
  typeConfidence: number;
  explanation: string;
  checkedAt: number;
  messageCount: number;
  windowTokenEstimate: number;
}

export interface DriftConfig {
  windowSize?: number;
  checkInterval?: number;
  threshold?: number;
  maxTokenBudget?: number;
}
