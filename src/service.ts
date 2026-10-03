import { safetyCheck, available, vecSub, vecLeq } from "./banker";
import { Store } from "./store";
import { ApiError, ProcessState, SafetyReport, ScenarioSpec, ScenarioState } from "./types";

function isNonNegIntVec(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((x) => Number.isInteger(x) && x >= 0)
  );
}

function checkVec(v: unknown, dim: number, what: string): number[] {
  if (!isNonNegIntVec(v)) {
    throw new ApiError("VALIDATION_ERROR", `${what} 必须为非空非负整数向量`);
  }
  if (v.length !== dim) {
    throw new ApiError("DIMENSION_MISMATCH", `${what} 维度必须为 ${dim}，实际为 ${v.length}`);
  }
  return v;
}

export function validateScenarioSpec(spec: unknown): ScenarioSpec {
  const s = spec as ScenarioSpec;
  if (!s || typeof s.name !== "string" || !s.name) {
    throw new ApiError("VALIDATION_ERROR", "场景缺少 name 字段");
  }
  if (!isNonNegIntVec(s.total)) {
    throw new ApiError("VALIDATION_ERROR", "total 必须为非空非负整数向量");
  }
  const dim = s.total.length;
  if (!Array.isArray(s.processes) || s.processes.length === 0) {
    throw new ApiError("VALIDATION_ERROR", "processes 必须为非空数组");
  }
  const names = new Set<string>();
  for (const [i, p] of s.processes.entries()) {
    if (!p || typeof p.name !== "string" || !p.name) {
      throw new ApiError("VALIDATION_ERROR", `进程 #${i} 缺少 name`);
    }
    if (names.has(p.name)) {
      throw new ApiError("VALIDATION_ERROR", `进程名重复: ${p.name}`);
    }
    names.add(p.name);
    checkVec(p.max, dim, `进程 ${p.name} 的 max`);
    checkVec(p.alloc, dim, `进程 ${p.name} 的 alloc`);
    if (!vecLeq(p.alloc, p.max)) {
      throw new ApiError("VALIDATION_ERROR", `进程 ${p.name} 的已分配量超过其最大需求`);
    }
  }
  const sum = new Array(dim).fill(0);
  for (const p of s.processes) for (let i = 0; i < dim; i++) sum[i] += p.alloc[i];
  for (let i = 0; i < dim; i++) {
    if (sum[i] > s.total[i]) {
      throw new ApiError(
        "VALIDATION_ERROR",
        `资源 ${i} 的已分配总量 ${sum[i]} 超过资源总量 ${s.total[i]}`
      );
    }
  }
  return s;
}

export class Service {
  constructor(public store: Store) {}

  importScenario(spec: unknown): ScenarioState {
    const s = validateScenarioSpec(spec);
    const processes: ProcessState[] = s.processes.map((p, i) => ({
      index: i,
      name: p.name,
      max: p.max,
      alloc: p.alloc,
      completed: false,
    }));
    const id = this.store.createScenario(s.name, s.total, processes);
    return this.store.loadScenario(id)!;
  }

  getScenario(id: number): ScenarioState {
    const s = this.store.loadScenario(id);
    if (!s) throw new ApiError("NOT_FOUND", `场景 ${id} 不存在`);
    return s;
  }

  check(id: number): SafetyReport {
    const s = this.getScenario(id);
    const report = safetyCheck(s.total, s.processes.filter((p) => !p.completed));
    this.store.insertCheck(id, s.version, report, report.safe);
    return report;
  }

  private findProcess(s: ScenarioState, name: unknown): ProcessState {
    if (typeof name !== "string") throw new ApiError("VALIDATION_ERROR", "缺少 process 字段");
    const p = s.processes.find((x) => x.name === name);
    if (!p) throw new ApiError("NOT_FOUND", `进程 ${name} 不存在`);
    return p;
  }

  private checkVersion(s: ScenarioState, version: unknown): void {
    if (version === undefined || version === null) {
      throw new ApiError("VALIDATION_ERROR", "缺少状态版本 version 字段");
    }
    if (version !== s.version) {
      throw new ApiError(
        "VERSION_CONFLICT",
        `陈旧操作：期望版本 ${version}，当前版本 ${s.version}`,
        { expected: version, current: s.version }
      );
    }
  }

  /** 试算：校验 + 暂分配安全性检查，不修改任何持久化状态。 */
  tryRequest(id: number, body: { process?: unknown; request?: unknown }): {
    approved: boolean;
    report?: SafetyReport;
    reason?: string;
  } {
    const s = this.getScenario(id);
    const { p, req } = this.validateRequest(s, body);
    const trial = s.processes.map((x) => ({ ...x, alloc: x.alloc.slice() }));
    const tp = trial.find((x) => x.name === p.name)!;
    for (let i = 0; i < req.length; i++) tp.alloc[i] += req[i];
    const report = safetyCheck(s.total, trial.filter((x) => !x.completed));
    return { approved: report.safe, report, reason: report.safe ? undefined : "暂分配后状态不安全" };
  }

  private validateRequest(
    s: ScenarioState,
    body: { process?: unknown; request?: unknown }
  ): { p: ProcessState; req: number[] } {
    const p = this.findProcess(s, body.process);
    if (p.completed) throw new ApiError("ALREADY_COMPLETED", `进程 ${p.name} 已完成`);
    const req = checkVec(body.request, s.total.length, "request");
    const need = vecSub(p.max, p.alloc);
    if (!vecLeq(req, need)) {
      throw new ApiError("REQUEST_EXCEEDS_NEED", `申请量超过进程 ${p.name} 的剩余最大需求`, {
        request: req,
        need,
      });
    }
    const avail = available(s.total, s.processes);
    if (!vecLeq(req, avail)) {
      throw new ApiError("REQUEST_EXCEEDS_AVAILABLE", "申请量超过当前可用资源", {
        request: req,
        available: avail,
      });
    }
    return { p, req };
  }

  /** 申请：校验 -> 暂分配 -> 安全检查 -> 仅安全时原子保存。 */
  request(id: number, body: { process?: unknown; request?: unknown; version?: unknown }): {
    approved: boolean;
    version: number;
    report?: SafetyReport;
    reason?: string;
  } {
    const s = this.getScenario(id);
    this.checkVersion(s, body.version);
    const { p, req } = this.validateRequest(s, body);

    const trial = s.processes.map((x) => ({ ...x, alloc: x.alloc.slice() }));
    const tp = trial.find((x) => x.name === p.name)!;
    for (let i = 0; i < req.length; i++) tp.alloc[i] += req[i];
    const report = safetyCheck(s.total, trial.filter((x) => !x.completed));

    if (!report.safe) {
      // 拒绝：仅记录决定，状态不变，版本不变。
      this.store.insertDecision(id, {
        kind: "request",
        process: p.name,
        request: req,
        approved: false,
        reason: "UNSAFE: 暂分配后不存在安全序列",
        versionBefore: s.version,
        versionAfter: s.version,
        snapshot: s,
        trace: report,
      });
      return { approved: false, version: s.version, report, reason: "UNSAFE" };
    }

    const before = s.version;
    p.alloc = p.alloc.map((v, i) => v + req[i]);
    s.version += 1;
    this.store.saveMutation(s, {
      kind: "request",
      process: p.name,
      request: req,
      approved: true,
      versionBefore: before,
      versionAfter: s.version,
      trace: report,
    });
    return { approved: true, version: s.version, report };
  }

  /** 主动释放：从已分配中减去向量。 */
  release(id: number, body: { process?: unknown; release?: unknown; version?: unknown }): {
    version: number;
  } {
    const s = this.getScenario(id);
    this.checkVersion(s, body.version);
    const p = this.findProcess(s, body.process);
    if (p.completed) throw new ApiError("ALREADY_COMPLETED", `进程 ${p.name} 已完成`);
    const rel = checkVec(body.release, s.total.length, "release");
    if (!vecLeq(rel, p.alloc)) {
      throw new ApiError("VALIDATION_ERROR", "释放量超过当前已分配量", {
        release: rel,
        alloc: p.alloc,
      });
    }
    const before = s.version;
    p.alloc = p.alloc.map((v, i) => v - rel[i]);
    s.version += 1;
    this.store.saveMutation(s, {
      kind: "release",
      process: p.name,
      request: rel,
      approved: true,
      versionBefore: before,
      versionAfter: s.version,
    });
    return { version: s.version };
  }

  /** 完成进程：返还全部分配；重复完成返回 ALREADY_COMPLETED，不重复增发资源。 */
  complete(id: number, body: { process?: unknown; version?: unknown }): { version: number } {
    const s = this.getScenario(id);
    this.checkVersion(s, body.version);
    const p = this.findProcess(s, body.process);
    if (p.completed) {
      throw new ApiError("ALREADY_COMPLETED", `进程 ${p.name} 已完成，不能重复完成`);
    }
    const before = s.version;
    p.completed = true;
    const released = p.alloc.slice();
    p.alloc = p.alloc.map(() => 0);
    s.version += 1;
    this.store.saveMutation(s, {
      kind: "complete",
      process: p.name,
      request: released,
      approved: true,
      versionBefore: before,
      versionAfter: s.version,
    });
    return { version: s.version };
  }

  report(id: number): unknown {
    const s = this.getScenario(id);
    return {
      scenario: s,
      available: available(s.total, s.processes),
      decisions: this.store.decisions(id),
      checks: this.store.checks(id),
    };
  }
}
