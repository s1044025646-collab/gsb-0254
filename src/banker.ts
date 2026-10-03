import { ProcessState, SafetyReport, SafetyStep, StuckProcess } from "./types";

export function vecAdd(a: number[], b: number[]): number[] {
  return a.map((v, i) => v + b[i]);
}

export function vecSub(a: number[], b: number[]): number[] {
  return a.map((v, i) => v - b[i]);
}

export function vecLeq(a: number[], b: number[]): boolean {
  return a.every((v, i) => v <= b[i]);
}

export function available(total: number[], processes: ProcessState[]): number[] {
  const work = total.slice();
  for (const p of processes) {
    for (let i = 0; i < work.length; i++) work[i] -= p.alloc[i];
  }
  return work;
}

/**
 * 银行家安全性检查。
 * 每轮在未完成进程中按进程编号升序选择第一个剩余需求 <= 当前可用量的进程，
 * 假设其完成并归还全部分配，直到全部完成或无法继续。
 */
export function safetyCheck(total: number[], processes: ProcessState[]): SafetyReport {
  const initialAvailable = available(total, processes);
  const work = initialAvailable.slice();
  const done = new Array(processes.length).fill(false);
  const steps: SafetyStep[] = [];
  const sequence: string[] = [];

  for (;;) {
    let picked = -1;
    for (let i = 0; i < processes.length; i++) {
      if (done[i]) continue;
      const p = processes[i];
      const need = vecSub(p.max, p.alloc);
      if (vecLeq(need, work)) {
        picked = i;
        break;
      }
    }
    if (picked === -1) break;
    const p = processes[picked];
    const workBefore = work.slice();
    for (let i = 0; i < work.length; i++) work[i] += p.alloc[i];
    steps.push({
      process: p.name,
      index: p.index,
      workBefore,
      allocation: p.alloc.slice(),
      workAfter: work.slice(),
    });
    sequence.push(p.name);
    done[picked] = true;
  }

  const safe = done.every(Boolean);
  const stuck: StuckProcess[] = [];
  if (!safe) {
    for (let i = 0; i < processes.length; i++) {
      if (done[i]) continue;
      const p = processes[i];
      const need = vecSub(p.max, p.alloc);
      const deficient = need
        .map((n, r) => ({ resource: r, needed: n, available: work[r] }))
        .filter((d) => d.needed > d.available);
      stuck.push({ process: p.name, index: p.index, need, work: work.slice(), deficient });
    }
  }

  return {
    safe,
    sequence,
    steps,
    stuck,
    initialAvailable,
    total: total.slice(),
    note: safe
      ? undefined
      : "不安全状态仅表示不存在保证全部完成的序列，并不等于此刻已发生真实死锁。",
  };
}

/** 独立基准：枚举全部进程完成顺序判断安全性（仅用于小规模测试核对）。 */
export function safetyByEnumeration(total: number[], processes: ProcessState[]): boolean {
  const init = available(total, processes);
  const n = processes.length;
  const used = new Array(n).fill(false);
  const dfs = (work: number[]): boolean => {
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const need = vecSub(processes[i].max, processes[i].alloc);
      if (vecLeq(need, work)) {
        used[i] = true;
        if (dfs(vecAdd(work, processes[i].alloc))) return true;
        used[i] = false;
      }
    }
    return used.every(Boolean);
  };
  return dfs(init);
}
