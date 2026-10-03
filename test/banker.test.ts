import { test } from "node:test";
import assert from "node:assert/strict";
import { safetyCheck, safetyByEnumeration, available } from "../src/banker";
import { ProcessState } from "../src/types";

function procs(list: [string, number[], number[]][]): ProcessState[] {
  return list.map(([name, max, alloc], i) => ({ index: i, name, max, alloc, completed: false }));
}

const classicTotal = [10, 5, 7];
const classicProcs = () =>
  procs([
    ["P0", [7, 5, 3], [0, 1, 0]],
    ["P1", [3, 2, 2], [2, 0, 0]],
    ["P2", [9, 0, 2], [3, 0, 2]],
    ["P3", [2, 2, 2], [2, 1, 1]],
    ["P4", [4, 3, 3], [0, 0, 2]],
  ]);

test("经典场景安全，序列按进程编号升序贪心", () => {
  const r = safetyCheck(classicTotal, classicProcs());
  assert.equal(r.safe, true);
  assert.deepEqual(r.sequence, ["P1", "P3", "P0", "P2", "P4"]);
  assert.deepEqual(r.initialAvailable, [3, 3, 2]);
});

test("报告每一步向量变化且资源守恒", () => {
  const r = safetyCheck(classicTotal, classicProcs());
  let prev = r.initialAvailable;
  for (const s of r.steps) {
    assert.deepEqual(s.workBefore, prev);
    assert.deepEqual(s.workAfter, s.workBefore.map((v, i) => v + s.allocation[i]));
    prev = s.workAfter;
  }
  assert.deepEqual(prev, classicTotal);
});

test("零需求进程可立即完成", () => {
  const r = safetyCheck([1], procs([["Z", [0], [0]]]));
  assert.equal(r.safe, true);
  assert.deepEqual(r.sequence, ["Z"]);
});

test("多个安全序列时返回确定性的编号升序序列", () => {
  const p = procs([
    ["A", [1], [0]],
    ["B", [1], [0]],
  ]);
  const r = safetyCheck([2], p);
  assert.equal(r.safe, true);
  assert.deepEqual(r.sequence, ["A", "B"]);
  assert.equal(safetyByEnumeration([2], p), true);
});

test("没有可完成进程时不安全并列出卡住进程与不足资源", () => {
  const p = procs([
    ["A", [2, 0], [0, 0]],
    ["B", [0, 2], [0, 0]],
  ]);
  const r = safetyCheck([1, 1], p);
  assert.equal(r.safe, false);
  assert.equal(r.stuck.length, 2);
  assert.deepEqual(r.stuck[0].deficient, [{ resource: 0, needed: 2, available: 1 }]);
  assert.match(r.note!, /并不等于/);
});

test("总量不足导致不安全", () => {
  const p = procs([["A", [5], [1]]]);
  const r = safetyCheck([3], p);
  assert.equal(r.safe, false);
});

test("随机小规模场景与枚举基准一致", () => {
  let seed = 42;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let t = 0; t < 300; t++) {
    const dim = 1 + rnd(3);
    const n = 1 + rnd(5);
    const total = Array.from({ length: dim }, () => rnd(8));
    const list: [string, number[], number[]][] = [];
    const sum = new Array(dim).fill(0);
    for (let i = 0; i < n; i++) {
      const max = Array.from({ length: dim }, () => rnd(6));
      const alloc = max.map((m, r) => Math.min(m, rnd(Math.max(1, total[r] - sum[r] + 1))));
      for (let r = 0; r < dim; r++) sum[r] += alloc[r];
      list.push([`P${i}`, max, alloc]);
    }
    const p = procs(list);
    const greedy = safetyCheck(total, p).safe;
    const brute = safetyByEnumeration(total, p);
    assert.equal(greedy, brute, `case ${t}: total=${total} ${JSON.stringify(list)}`);
    const rep = safetyCheck(total, p);
    let work = rep.initialAvailable;
    assert.deepEqual(work, available(total, p));
    for (const s of rep.steps) {
      assert.deepEqual(s.workAfter, work.map((v, i) => v + s.allocation[i]));
      work = s.workAfter;
    }
  }
});
