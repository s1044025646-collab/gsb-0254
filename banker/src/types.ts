// 银行家算法模拟服务的核心数据类型

export type ProcessStatus = "active" | "finished";

export interface ProcessRecord {
  id: number; // 固定编号，从 0 开始，永不复用
  name: string;
  max: number[]; // 最大需求
  allocation: number[]; // 当前已分配
  status: ProcessStatus;
}

export interface Scenario {
  version: number; // 场景状态版本，每次成功变更 +1
  resourceCount: number;
  total: number[]; // 各类资源总量
  processes: ProcessRecord[];
  updatedAt: string;
}

export interface SafetyStep {
  order: number; // 该步在安全序列中的位置（从 1 开始）
  processId: number;
  processName: string;
  needBefore: number[];
  availableBefore: number[];
  availableAfter: number[]; // 完成并归还后的可用量
  released: number[]; // 本步归还的分配量
}

export interface BlockedInfo {
  processId: number;
  processName: string;
  need: number[];
  available: number[];
  shortfall: number[]; // 相对当前可用仍缺少的资源（max(need-available,0)）
}

export type SafetyResult =
  | {
      safe: true;
      sequence: number[];
      sequenceNames: string[];
      workTrace: number[][]; // 每步开始时的 work/可用向量
      steps: SafetyStep[];
      available: number[];
    }
  | {
      safe: false;
      sequence: number[];
      sequenceNames: string[];
      workTrace: number[][];
      steps: SafetyStep[];
      blocked: BlockedInfo[];
      available: number[];
    };

export type DecisionOutcome = "granted" | "rejected";

export interface RequestDecision {
  id: number;
  scenarioVersion: number; // 决策所基于的场景版本
  type: "request" | "release" | "complete";
  processId: number;
  requested: number[];
  outcome: DecisionOutcome;
  reasonCode: string | null;
  reasonMessage: string | null;
  safetySequence: number[] | null;
  evaluatedAt: string;
  snapshot: Scenario; // 决策当时的完整场景快照
}

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}
