import { AppError, ProcessRecord, SafetyResult, Scenario } from "./types";

export function isNonNegIntVec(v: unknown, dim?: number): v is number[] {
  return (
    Array.isArray(v) &&
    (dim === undefined || v.length === dim) &&
    v.every((x) => Number.isInteger(x) && x >= 0)
  );
}

export function vecAdd(a: number[], b: number[]): number[] {
  return a.map((x, i) => x + b[i]);
}

export function vecSub(a: number[], b: number[]): number[] {
  return a.map((x, i) => x - b[i]);
}

export function vecLE(a: number[], b: number[]): boolean {
  return a.every((x, i) => x <= b[i]);
}

// 需求 = 最大需求 - 已分配
export function needOf(p: ProcessRecord): number[] {
  return vecSub(p.max, p.allocation);
}

// 可用资源 = 总量 - 所有进程已分配之和。finished 进程分配量应为 0。
export function computeAvailable(s: Pick<Scenario, "total" | "processes">): number[] {
  const used = s.total.map(() => 0);
  for (const p of s.processes) {
    for (let i = 0; i < s.total.length; i++) used[i] += p.allocation[i] ?? 0;
  }
  return vecSub(s.total, used);
}

// 资源守恒校验：所有分配量之和不得超过总量；单进程分配不得超过最大需求。
export function validateInvariant(s: Pick<Scenario, "total" | "processes">): void {
  const dim = s.total.length;
  const used = s.total.map(() => 0);
  for (const p of s.processes) {
    if (p.max.length !== dim || p.allocation.length !== dim) {
      throw new AppError("DIMENSION_MISMATCH", `进程 ${p.name} 的向量维度与资源总数不一致`);
    }
    if (!vecLE(p.allocation, p.max)) {
      throw new AppError(
        "ALLOCATION_EXCEEDS_MAX",
        `进程 ${p.name} 已分配 ${JSON.stringify(p.allocation)} 超过最大需求 ${JSON.stringify(p.max)}`
      );
    }
    for (let i = 0; i < dim; i++) used[i] += p.allocation[i];
  }
  if (!vecLE(used, s.total)) {
    throw new AppError(
      "TOTAL_RESOURCES_INSUFFICIENT",
      `已分配总量 ${JSON.stringify(used)} 超过资源总量 ${JSON.stringify(s.total)}`
    );
  }
}

// 银行家安全性检查。
// 选择规则（固定、可复现）：在可运行的未完成进程中，选择编号最小者。
// finished 进程视为已经完成，不参与调度。
export function checkSafety(scenario: Scenario): SafetyResult {
  validateInvariant(scenario);
  const work = computeAvailable(scenario);
  const pending = scenario.processes.filter((p) => p.status === "active");
  const done = new Set<number>();
  const sequence: number[] = [];
  const sequenceNames: string[] = [];
  const workTrace: number[][] = [];
  const steps = [];

  while (done.size < pending.length) {
    // 按编号升序，保证确定性
    const candidates = pending
      .filter((p) => !done.has(p.id))
      .sort((a, b) => a.id - b.id);
    const chosen = candidates.find((p) => vecLE(needOf(p), work));
    if (!chosen) {
      const blocked = candidates.map((p) => {
        const need = needOf(p);
        return {
          processId: p.id,
          processName: p.name,
          need,
          available: [...work],
          shortfall: need.map((x, i) => Math.max(0, x - work[i])),
        };
      });
      return {
        safe: false,
        sequence,
        sequenceNames,
        workTrace,
        steps,
        blocked,
        available: work,
      };
    }
    const availableBefore = [...work];
    const released = [...chosen.allocation];
    for (let i = 0; i < work.length; i++) work[i] += chosen.allocation[i];
    done.add(chosen.id);
    sequence.push(chosen.id);
    sequenceNames.push(chosen.name);
    workTrace.push(availableBefore);
    steps.push({
      order: sequence.length,
      processId: chosen.id,
      processName: chosen.name,
      needBefore: needOf(chosen),
      availableBefore,
      availableAfter: [...work],
      released,
    });
  }

  return {
    safe: true,
    sequence,
    sequenceNames,
    workTrace,
    steps,
    available: computeAvailable(scenario),
  };
}

// 枚举基准：小规模下穷举全部完成顺序，返回是否存在至少一条安全序列。
// 用于与 checkSafety 的结论交叉核对。
export function existsSafeSequenceByEnumeration(scenario: Scenario): boolean {
  validateInvariant(scenario);
  const pending = scenario.processes.filter((p) => p.status === "active");
  const initial = computeAvailable(scenario);

  const search = (remaining: ProcessRecord[], work: number[]): boolean => {
    if (remaining.length === 0) return true;
    for (let i = 0; i < remaining.length; i++) {
      const p = remaining[i];
      if (vecLE(needOf(p), work)) {
        const nextWork = vecAdd(work, p.allocation);
        const rest = remaining.filter((_, idx) => idx !== i);
        if (search(rest, nextWork)) return true;
      }
    }
    return false;
  };

  return search(pending, initial);
}

// 深拷贝场景并分配新的编号
export function cloneScenario(s: Scenario): Scenario {
  return JSON.parse(JSON.stringify(s)) as Scenario;
}
