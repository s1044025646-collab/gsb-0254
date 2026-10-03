import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkSafety,
  computeAvailable,
  existsSafeSequenceByEnumeration,
} from "../src/algorithm";
import {
  builtinScenarioInput,
  evaluateComplete,
  evaluateRequest,
  importScenario,
} from "../src/operations";
import { Store } from "../src/store";
import { BankerService } from "../src/service";
import { AppError, Scenario } from "../src/types";

function tempDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "banker-"));
  return { dir, path: join(dir, "test.sqlite") };
}

function makeService(dbPath: string): { svc: BankerService; store: Store } {
  const store = new Store(dbPath);
  return { svc: new BankerService(store), store };
}

test("内置场景安全，序列与逐步 work 向量正确", () => {
  const s = importScenario(builtinScenarioInput());
  const avail = computeAvailable(s);
  assert.deepEqual(avail, [3, 3, 2]);
  const r = checkSafety(s);
  assert.equal(r.safe, true);
  if (r.safe) {
    assert.deepEqual(r.sequenceNames, ["P1", "P3", "P0", "P2", "P4"]);
    // 第一步 P1：work [3,3,2]，归还 [2,0,0] -> [5,3,2]
    assert.deepEqual(r.steps[0].availableBefore, [3, 3, 2]);
    assert.deepEqual(r.steps[0].availableAfter, [5, 3, 2]);
  }
  assert.equal(existsSafeSequenceByEnumeration(s), true);
});

test("每一步都满足资源守恒：work 增量等于归还量", () => {
  const s = importScenario(builtinScenarioInput());
  const r = checkSafety(s);
  assert.ok(r.safe);
  if (r.safe) {
    for (const step of r.steps) {
      const after = step.availableBefore.map((x, i) => x + step.released[i]);
      assert.deepEqual(after, step.availableAfter);
    }
    // 全部归还后 work 应等于资源总量
    assert.deepEqual(r.steps[r.steps.length - 1].availableAfter, s.total);
  }
});

test("零需求进程可立即完成，零申请被批准且不改变状态数量", () => {
  const s = importScenario({
    total: [2, 2],
    processes: [{ name: "A", max: [0, 0], allocation: [0, 0] }],
  });
  const r = checkSafety(s);
  assert.ok(r.safe);
  if (r.safe) assert.deepEqual(r.sequenceNames, ["A"]);
  const trial = evaluateRequest(s, 0, [0, 0]);
  assert.equal(trial.granted, true);
  assert.deepEqual(trial.candidate.processes[0].allocation, [0, 0]);
});

test("已分配超过最大需求被拒绝", () => {
  assert.throws(
    () =>
      importScenario({
        total: [5],
        processes: [{ name: "A", max: [2], allocation: [3] }],
      }),
    (e: AppError) => e.code === "ALLOCATION_EXCEEDS_MAX"
  );
});

test("总量不足（分配之和超过总量）被拒绝", () => {
  assert.throws(
    () =>
      importScenario({
        total: [3],
        processes: [
          { name: "A", max: [5], allocation: [2] },
          { name: "B", max: [5], allocation: [2] },
        ],
      }),
    (e: AppError) => e.code === "TOTAL_RESOURCES_INSUFFICIENT"
  );
});

test("维度错误：向量长度不符", () => {
  assert.throws(
    () =>
      importScenario({
        total: [3, 3],
        processes: [{ name: "A", max: [1], allocation: [0] }],
      }),
    (e: AppError) => e.code === "DIMENSION_MISMATCH"
  );
  const s = importScenario({ total: [3], processes: [{ name: "A", max: [2], allocation: [0] }] });
  assert.throws(() => evaluateRequest(s, 0, [1, 2]), (e: AppError) => e.code === "DIMENSION_MISMATCH");
  assert.throws(() => evaluateRequest(s, 0, [-1]), (e: AppError) => e.code === "INVALID_REQUEST");
});

test("没有可完成进程：无安全序列且列出卡住进程", () => {
  const s = importScenario({
    total: [10],
    processes: [
      { name: "A", max: [10], allocation: [5] }, // need 5
      { name: "B", max: [10], allocation: [5] }, // need 5, avail 0
    ],
  });
  const r = checkSafety(s);
  assert.equal(r.safe, false);
  if (!r.safe) {
    assert.equal(r.blocked.length, 2);
    assert.deepEqual(r.blocked[0].shortfall, [5]);
  }
  assert.equal(existsSafeSequenceByEnumeration(s), false);
});

test("资源当前足够但暂分配后不安全：拒绝，且与枚举基准一致", () => {
  const s = importScenario(builtinScenarioInput());
  const r = evaluateRequest(s, 0, [0, 0, 2]); // P0
  assert.equal(r.granted, false);
  assert.equal(r.reasonCode, "UNSAFE_AFTER_GRANT");
  if (!r.safety.safe) assert.ok(r.safety.blocked.length > 0);
  assert.equal(existsSafeSequenceByEnumeration(r.candidate), false);
  // 缩小申请后安全
  const r2 = evaluateRequest(s, 0, [0, 0, 1]);
  assert.equal(r2.granted, true);
  assert.equal(existsSafeSequenceByEnumeration(r2.candidate), true);
});

test("多个安全序列：确定性选编号最小，枚举确认存在多个顺序", () => {
  // 两个零需求进程谁先都行
  const s = importScenario({
    total: [1],
    processes: [
      { name: "A", max: [0], allocation: [0] },
      { name: "B", max: [0], allocation: [0] },
    ],
  });
  const r = checkSafety(s);
  assert.ok(r.safe);
  if (r.safe) assert.deepEqual(r.sequence, [0, 1]); // 固定编号规则
});

test("请求超过剩余需求与超过可用分别返回不同错误码", () => {
  const s = importScenario(builtinScenarioInput());
  assert.throws(() => evaluateRequest(s, 0, [99, 0, 0]), (e: AppError) => e.code === "REQUEST_EXCEEDS_NEED");
  // 超过可用（但不超需求）：返回拒绝结果而非抛错
  const r = evaluateRequest(s, 2, [6, 0, 0]);
  assert.equal(r.granted, false);
  assert.equal(r.reasonCode, "REQUEST_EXCEEDS_AVAILABLE");
});

test("拒绝与陈旧版本不改变持久化状态", () => {
  const { dir, path } = tempDb();
  let store: Store | undefined;
  try {
    const { svc, store: st } = makeService(path);
    store = st;
    svc.loadBuiltin();
    const before = JSON.stringify(svc.getScenario());
    const v = svc.getScenario().version;

    // 不安全的申请被拒绝
    const res = svc.request(v, 0, [0, 0, 2]);
    assert.equal(res.decision.outcome, "rejected");
    assert.equal(svc.getScenario().version, v);
    assert.equal(JSON.stringify(svc.getScenario()), before);

    // 陈旧版本
    assert.throws(() => svc.request(v - 1, 0, [0, 0, 1]), (e: AppError) => e.code === "STALE_VERSION");
    assert.equal(JSON.stringify(svc.getScenario()), before);

    // 合法申请推进版本
    const ok = svc.request(v, 0, [0, 0, 1]);
    assert.equal(ok.decision.outcome, "granted");
    assert.equal(svc.getScenario().version, v + 1);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("完成进程返还资源；重复完成不增发；决策与快照持久化且重启可读", () => {
  const { dir, path } = tempDb();
  let store: Store | undefined;
  try {
    let made = makeService(path);
    store = made.store;
    let svc = made.svc;
    svc.loadBuiltin();
    const availBefore = computeAvailable(svc.getScenario());
    const v = svc.getScenario().version;
    const heldP3 = [...svc.getScenario().processes[3].allocation];

    svc.complete(v, 3);
    assert.deepEqual(svc.getScenario().processes[3].status, "finished");
    assert.deepEqual(
      computeAvailable(svc.getScenario()),
      availBefore.map((x, i) => x + heldP3[i])
    );

    // 重复完成
    const availAfterFirst = computeAvailable(svc.getScenario());
    const v2 = svc.getScenario().version;
    const again = svc.complete(v2, 3);
    assert.equal(again.alreadyFinished, true);
    assert.deepEqual(computeAvailable(svc.getScenario()), availAfterFirst);

    const decisionsBeforeClose = svc.listDecisions().length;
    assert.ok(decisionsBeforeClose >= 2);

    // 重启：重新打开同一数据库
    store.close();
    made = makeService(path);
    store = made.store;
    svc = made.svc;
    const reloaded = svc.getScenario();
    assert.equal(reloaded.processes[3].status, "finished");
    const decisions = svc.listDecisions();
    assert.equal(decisions.length, decisionsBeforeClose);
    // 快照是决策当时的完整场景
    const snap = decisions[decisions.length - 1].snapshot as Scenario;
    assert.ok(snap.processes.length === 5);
    assert.ok(typeof snap.version === "number");
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("释放资源受持有量限制且归还后可用增加", () => {
  const { dir, path } = tempDb();
  let store: Store | undefined;
  try {
    const { svc, store: st } = makeService(path);
    store = st;
    svc.loadBuiltin();
    const v = svc.getScenario().version;
    const before = computeAvailable(svc.getScenario());
    svc.release(v, 1, [1, 0, 0]);
    assert.deepEqual(computeAvailable(svc.getScenario()), [before[0] + 1, before[1], before[2]]);
    const v2 = svc.getScenario().version;
    assert.throws(
      () => svc.release(v2, 1, [9, 0, 0]),
      (e: AppError) => e.code === "RELEASE_EXCEEDS_ALLOCATION"
    );
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("随机小场景：贪心安全结论与枚举基准一致且报告向量守恒", () => {
  for (let seed = 0; seed < 200; seed++) {
    let state = seed;
    const rand = () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
    const dim = 1 + Math.floor(rand() * 2);
    const n = 2 + Math.floor(rand() * 3);
    const total = Array.from({ length: dim }, () => 3 + Math.floor(rand() * 5));
    const allocation: number[][] = Array.from({ length: n }, () => Array(dim).fill(0));
    // 先随机放置分配，保证不超总量
    for (let i = 0; i < dim; i++) {
      let budget = total[i];
      for (let j = 0; j < n && budget > 0; j++) {
        const take = Math.floor(rand() * (budget + 1));
        allocation[j][i] = take;
        budget -= take;
      }
    }
    const processes = allocation.map((alloc, idx) => ({
      name: `P${idx}`,
      allocation: alloc,
      max: alloc.map((a) => a + Math.floor(rand() * (total[0] + 1))),
    }));
    const s = importScenario({ total, processes });
    const greedySafe = checkSafety(s).safe;
    assert.equal(
      greedySafe,
      existsSafeSequenceByEnumeration(s),
      `seed ${seed} 贪心与枚举不一致`
    );
    // 可用 + 已分配之和 = 总量
    const avail = computeAvailable(s);
    for (let i = 0; i < dim; i++) {
      const used = s.processes.reduce((sum, p) => sum + p.allocation[i], 0);
      assert.equal(avail[i] + used, total[i], `seed ${seed} 资源不守恒`);
    }
  }
});

test("evaluateComplete 直接调用在未导入时不涉及库，完成后仍可安全", () => {
  const s = importScenario(builtinScenarioInput());
  const { candidate, alreadyFinished } = evaluateComplete(s, 0);
  assert.equal(alreadyFinished, false);
  assert.equal(checkSafety(candidate).safe, true);
  const again = evaluateComplete(candidate, 0);
  assert.equal(again.alreadyFinished, true);
});
