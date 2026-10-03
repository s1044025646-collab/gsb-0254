import {
  checkSafety,
  cloneScenario,
  computeAvailable,
  isNonNegIntVec,
  needOf,
  validateInvariant,
  vecLE,
  vecSub,
} from "./algorithm";
import { AppError, SafetyResult, Scenario } from "./types";

export interface ScenarioInput {
  total: number[];
  processes: Array<{ name: string; max: number[]; allocation?: number[] }>;
}

// 导入并规范化场景：编号从 0 开始顺序分配，完成校验。
export function importScenario(input: ScenarioInput): Scenario {
  if (!isNonNegIntVec(input.total) || input.total.length === 0) {
    throw new AppError("INVALID_TOTAL", "资源总量必须是非空的非负整数向量");
  }
  if (!Array.isArray(input.processes) || input.processes.length === 0) {
    throw new AppError("INVALID_PROCESSES", "至少需要一个进程");
  }
  const names = new Set<string>();
  const scenario: Scenario = {
    version: 1,
    resourceCount: input.total.length,
    total: [...input.total],
    processes: input.processes.map((p, idx) => {
      if (!p.name || typeof p.name !== "string") {
        throw new AppError("INVALID_PROCESS_NAME", `第 ${idx} 个进程缺少名称`);
      }
      if (names.has(p.name)) throw new AppError("DUPLICATE_PROCESS_NAME", `进程名称重复: ${p.name}`);
      names.add(p.name);
      if (!Array.isArray(p.max) || !p.max.every((x) => Number.isInteger(x) && x >= 0)) {
        throw new AppError("INVALID_MAX", `进程 ${p.name} 的最大需求必须是非负整数向量`);
      }
      const allocation =
        p.allocation === undefined
          ? input.total.map(() => 0)
          : p.allocation;
      if (!Array.isArray(allocation) || !allocation.every((x) => Number.isInteger(x) && x >= 0)) {
        throw new AppError("INVALID_ALLOCATION", `进程 ${p.name} 的分配量必须是非负整数向量`);
      }
      return {
        id: idx,
        name: p.name,
        max: [...p.max],
        allocation: [...allocation],
        status: "active" as const,
      };
    }),
    updatedAt: new Date().toISOString(),
  };
  validateInvariant(scenario);
  return scenario;
}

function getProcess(s: Scenario, id: number) {
  const p = s.processes.find((x) => x.id === id);
  if (!p) throw new AppError("PROCESS_NOT_FOUND", `进程 ${id} 不存在`);
  return p;
}

export interface RequestEval {
  granted: boolean;
  reasonCode: string | null;
  reasonMessage: string | null;
  safety: SafetyResult;
  candidate: Scenario; // 暂分配后的候选场景（无论是否批准都返回，便于报告）
}

// 试算一笔申请：做完整输入校验 + 暂分配 + 安全性检查，但不落库。
export function evaluateRequest(scenario: Scenario, processId: number, request: number[]): RequestEval {
  if (!isNonNegIntVec(request)) {
    throw new AppError("INVALID_REQUEST", "申请向量必须是非负整数向量");
  }
  if (request.length !== scenario.resourceCount) {
    throw new AppError(
      "DIMENSION_MISMATCH",
      `申请维度 ${request.length} 与资源维度 ${scenario.resourceCount} 不一致`
    );
  }
  const p = getProcess(scenario, processId);
  if (p.status === "finished") {
    throw new AppError("PROCESS_FINISHED", `进程 ${p.name} 已完成，不能再申请`);
  }
  const need = needOf(p);
  if (!vecLE(request, need)) {
    throw new AppError(
      "REQUEST_EXCEEDS_NEED",
      `申请 ${JSON.stringify(request)} 超过剩余需求 ${JSON.stringify(need)}`
    );
  }
  const available = computeAvailable(scenario);
  if (!vecLE(request, available)) {
    // 请求当前无法满足：这不是安全性拒绝，而是前置条件不成立
    const candidate = cloneScenario(scenario);
    const safety = checkSafety(scenario);
    return {
      granted: false,
      reasonCode: "REQUEST_EXCEEDS_AVAILABLE",
      reasonMessage: `申请 ${JSON.stringify(request)} 超过当前可用 ${JSON.stringify(available)}`,
      safety,
      candidate,
    };
  }

  const candidate = cloneScenario(scenario);
  const cp = candidate.processes.find((x) => x.id === processId)!;
  cp.allocation = cp.allocation.map((x, i) => x + request[i]);
  const safety = checkSafety(candidate);
  if (!safety.safe) {
    return {
      granted: false,
      reasonCode: "UNSAFE_AFTER_GRANT",
      reasonMessage: "暂分配后不存在安全序列，拒绝申请（当前状态仍安全，不等于已死锁）",
      safety,
      candidate,
    };
  }
  candidate.version = scenario.version + 1;
  candidate.updatedAt = new Date().toISOString();
  return { granted: true, reasonCode: null, reasonMessage: null, safety, candidate };
}

// 主动释放：归还不超过当前持有量的资源。
export function evaluateRelease(
  scenario: Scenario,
  processId: number,
  release: number[]
): { candidate: Scenario; safety: SafetyResult } {
  if (!isNonNegIntVec(release)) {
    throw new AppError("INVALID_RELEASE", "释放向量必须是非负整数向量");
  }
  if (release.length !== scenario.resourceCount) {
    throw new AppError("DIMENSION_MISMATCH", "释放向量维度与资源维度不一致");
  }
  const p = getProcess(scenario, processId);
  if (p.status === "finished") {
    throw new AppError("PROCESS_FINISHED", `进程 ${p.name} 已完成`);
  }
  if (!vecLE(release, p.allocation)) {
    throw new AppError(
      "RELEASE_EXCEEDS_ALLOCATION",
      `释放 ${JSON.stringify(release)} 超过持有量 ${JSON.stringify(p.allocation)}`
    );
  }
  const candidate = cloneScenario(scenario);
  const cp = candidate.processes.find((x) => x.id === processId)!;
  cp.allocation = vecSub(cp.allocation, release);
  candidate.version = scenario.version + 1;
  candidate.updatedAt = new Date().toISOString();
  return { candidate, safety: checkSafety(candidate) };
}

// 完成进程：返还其全部持有量，置为 finished。重复完成幂等，不再增发资源。
export function evaluateComplete(
  scenario: Scenario,
  processId: number
): { candidate: Scenario; safety: SafetyResult; alreadyFinished: boolean } {
  const p = getProcess(scenario, processId);
  const candidate = cloneScenario(scenario);
  const cp = candidate.processes.find((x) => x.id === processId)!;
  if (cp.status === "finished") {
    return { candidate, safety: checkSafety(candidate), alreadyFinished: true };
  }
  cp.status = "finished";
  cp.allocation = cp.allocation.map(() => 0);
  cp.max = cp.max; // 保留最大需求用于报告
  candidate.version = scenario.version + 1;
  candidate.updatedAt = new Date().toISOString();
  return { candidate, safety: checkSafety(candidate), alreadyFinished: false };
}

// 经典教学示例：3 类资源 (10,5,7)，5 个进程。
export function builtinScenarioInput(): ScenarioInput {
  return {
    total: [10, 5, 7],
    processes: [
      { name: "P0", max: [7, 5, 3], allocation: [0, 1, 0] },
      { name: "P1", max: [3, 2, 2], allocation: [2, 0, 0] },
      { name: "P2", max: [9, 0, 2], allocation: [3, 0, 2] },
      { name: "P3", max: [2, 2, 2], allocation: [2, 1, 1] },
      { name: "P4", max: [4, 3, 3], allocation: [0, 0, 2] },
    ],
  };
}
