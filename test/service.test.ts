import { test } from "node:test";
import assert from "node:assert/strict";
import { Service } from "../src/service";
import { Store } from "../src/store";
import { demoScenario } from "../src/demo";
import { ApiError } from "../src/types";

function makeSvc(): { svc: Service; id: number } {
  const svc = new Service(new Store(":memory:"));
  const s = svc.importScenario(demoScenario);
  return { svc, id: s.id };
}

function expectCode(code: string, fn: () => void) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ApiError, `expected ApiError, got ${e}`);
    assert.equal(e.code, code);
    return;
  }
  assert.fail(`expected ApiError ${code}`);
}

test("导入校验：维度错误 / 已分配超过最大 / 总量不足", () => {
  const svc = new Service(new Store(":memory:"));
  expectCode("DIMENSION_MISMATCH", () =>
    svc.importScenario({ name: "x", total: [1, 2], processes: [{ name: "A", max: [1], alloc: [0] }] })
  );
  expectCode("VALIDATION_ERROR", () =>
    svc.importScenario({ name: "x", total: [1], processes: [{ name: "A", max: [1], alloc: [2] }] })
  );
  expectCode("VALIDATION_ERROR", () =>
    svc.importScenario({
      name: "x",
      total: [1],
      processes: [
        { name: "A", max: [1], alloc: [1] },
        { name: "B", max: [1], alloc: [1] },
      ],
    })
  );
  expectCode("VALIDATION_ERROR", () =>
    svc.importScenario({ name: "x", total: [1], processes: [{ name: "A", max: [-1], alloc: [0] }] })
  );
});

test("零申请安全则批准并推进版本", () => {
  const { svc, id } = makeSvc();
  const r = svc.request(id, { process: "P0", version: 0, request: [0, 0, 0] });
  assert.equal(r.approved, true);
  assert.equal(r.version, 1);
});

test("申请超过剩余需求 / 超过可用量分别报错", () => {
  const { svc, id } = makeSvc();
  expectCode("REQUEST_EXCEEDS_NEED", () =>
    svc.request(id, { process: "P1", version: 0, request: [2, 2, 2] })
  );
  expectCode("REQUEST_EXCEEDS_AVAILABLE", () =>
    svc.request(id, { process: "P0", version: 0, request: [4, 0, 0] })
  );
});

test("资源足够但暂分配后不安全的请求被拒绝，且状态不变", () => {
  const { svc, id } = makeSvc();
  const before = svc.getScenario(id);
  const r = svc.request(id, { process: "P4", version: 0, request: [3, 3, 0] });
  assert.equal(r.approved, false);
  assert.equal(r.reason, "UNSAFE");
  const after = svc.getScenario(id);
  assert.equal(after.version, before.version);
  assert.deepEqual(
    after.processes.map((p) => p.alloc),
    before.processes.map((p) => p.alloc)
  );
  const decisions = svc.store.decisions(id) as { approved: number }[];
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].approved, 0);
});

test("陈旧版本被拒绝且不改变持久化状态", () => {
  const { svc, id } = makeSvc();
  const ok = svc.request(id, { process: "P4", version: 0, request: [1, 0, 0] });
  assert.equal(ok.approved, true);
  const before = svc.getScenario(id);
  expectCode("VERSION_CONFLICT", () =>
    svc.request(id, { process: "P4", version: 0, request: [1, 0, 0] })
  );
  expectCode("VERSION_CONFLICT", () => svc.complete(id, { process: "P1", version: 0 }));
  const after = svc.getScenario(id);
  assert.deepEqual(after, before);
});

test("重复完成不重复增发资源", () => {
  const { svc, id } = makeSvc();
  const c = svc.complete(id, { process: "P1", version: 0 });
  const afterFirst = svc.getScenario(id);
  expectCode("ALREADY_COMPLETED", () => svc.complete(id, { process: "P1", version: c.version }));
  const afterSecond = svc.getScenario(id);
  assert.deepEqual(afterSecond, afterFirst);
  const rep = svc.report(id) as { available: number[] };
  assert.deepEqual(rep.available, [5, 3, 2]);
});

test("释放校验与生效", () => {
  const { svc, id } = makeSvc();
  expectCode("VALIDATION_ERROR", () =>
    svc.release(id, { process: "P1", version: 0, release: [3, 0, 0] })
  );
  const r = svc.release(id, { process: "P1", version: 0, release: [1, 0, 0] });
  assert.equal(r.version, 1);
  const p = svc.getScenario(id).processes.find((x) => x.name === "P1")!;
  assert.deepEqual(p.alloc, [1, 0, 0]);
});

test("try 试算不持久化", () => {
  const { svc, id } = makeSvc();
  const r = svc.tryRequest(id, { process: "P4", request: [3, 3, 0] });
  assert.equal(r.approved, false);
  assert.equal(svc.getScenario(id).version, 0);
  assert.equal((svc.store.decisions(id) as unknown[]).length, 0);
});
