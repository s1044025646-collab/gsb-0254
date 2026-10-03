import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Service } from "../src/service";
import { Store } from "../src/store";
import { demoScenario } from "../src/demo";

test("重启后可读取先前决定与当时场景快照", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "banker-"));
  const dbFile = path.join(dir, "test.db");

  let svc = new Service(new Store(dbFile));
  const s = svc.importScenario(demoScenario);
  svc.request(s.id, { process: "P4", version: 0, request: [3, 3, 0] });
  const ok = svc.request(s.id, { process: "P4", version: 0, request: [1, 0, 0] });
  svc.complete(s.id, { process: "P1", version: ok.version });
  svc.store.close();

  svc = new Service(new Store(dbFile));
  const restored = svc.getScenario(s.id);
  assert.equal(restored.version, 2);
  assert.equal(restored.processes.find((p) => p.name === "P1")!.completed, true);
  assert.deepEqual(restored.processes.find((p) => p.name === "P4")!.alloc, [1, 0, 2]);

  const decisions = svc.store.decisions(s.id) as {
    kind: string;
    approved: number;
    snapshot: string;
    trace: string | null;
  }[];
  assert.equal(decisions.length, 3);
  assert.equal(decisions[0].approved, 0);
  assert.equal(decisions[1].approved, 1);
  const snap = JSON.parse(decisions[1].snapshot);
  assert.equal(snap.version, 1);
  assert.equal(snap.processes.length, 5);
  const trace = JSON.parse(decisions[0].trace!);
  assert.equal(trace.safe, false);
  svc.store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
