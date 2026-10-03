import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { ProcessState, ScenarioState } from "./types";

export function dataDir(): string {
  return process.env.BANKER_DATA_DIR || path.join(process.cwd(), "data");
}

export class Store {
  db: DatabaseSync;

  constructor(dbPath?: string) {
    const file = dbPath ?? path.join(dataDir(), "banker.db");
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS scenarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        total TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS processes (
        scenario_id INTEGER NOT NULL,
        idx INTEGER NOT NULL,
        name TEXT NOT NULL,
        max TEXT NOT NULL,
        alloc TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (scenario_id, idx)
      );
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scenario_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        process TEXT,
        request TEXT,
        approved INTEGER NOT NULL,
        reason TEXT,
        version_before INTEGER NOT NULL,
        version_after INTEGER NOT NULL,
        snapshot TEXT NOT NULL,
        trace TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scenario_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        safe INTEGER NOT NULL,
        report TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  close() {
    this.db.close();
  }

  createScenario(name: string, total: number[], processes: ProcessState[]): number {
    this.db.exec("BEGIN");
    try {
      const r = this.db
        .prepare("INSERT INTO scenarios (name, total, version) VALUES (?, ?, 0)")
        .run(name, JSON.stringify(total));
      const id = Number(r.lastInsertRowid);
      const ins = this.db.prepare(
        "INSERT INTO processes (scenario_id, idx, name, max, alloc, completed) VALUES (?,?,?,?,?,?)"
      );
      processes.forEach((p, i) =>
        ins.run(id, i, p.name, JSON.stringify(p.max), JSON.stringify(p.alloc), p.completed ? 1 : 0)
      );
      this.db.exec("COMMIT");
      return id;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  loadScenario(id: number): ScenarioState | null {
    const row = this.db.prepare("SELECT * FROM scenarios WHERE id = ?").get(id) as
      | { id: number; name: string; total: string; version: number }
      | undefined;
    if (!row) return null;
    const procs = this.db
      .prepare("SELECT * FROM processes WHERE scenario_id = ? ORDER BY idx")
      .all(id) as unknown as { idx: number; name: string; max: string; alloc: string; completed: number }[];
    return {
      id: row.id,
      name: row.name,
      total: JSON.parse(row.total),
      version: row.version,
      processes: procs.map((p) => ({
        index: p.idx,
        name: p.name,
        max: JSON.parse(p.max),
        alloc: JSON.parse(p.alloc),
        completed: !!p.completed,
      })),
    };
  }

  listScenarios(): { id: number; name: string; version: number }[] {
    return this.db
      .prepare("SELECT id, name, version FROM scenarios ORDER BY id")
      .all() as unknown as { id: number; name: string; version: number }[];
  }

  saveMutation(
    state: ScenarioState,
    decision: Omit<DecisionRecord, "snapshot"> & { snapshot?: unknown }
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const upd = this.db.prepare(
        "UPDATE processes SET alloc = ?, completed = ? WHERE scenario_id = ? AND idx = ?"
      );
      for (const p of state.processes) {
        upd.run(JSON.stringify(p.alloc), p.completed ? 1 : 0, state.id, p.index);
      }
      this.db
        .prepare("UPDATE scenarios SET version = ? WHERE id = ?")
        .run(state.version, state.id);
      this.insertDecision(state.id, { ...decision, snapshot: decision.snapshot ?? state });
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  insertDecision(
    scenarioId: number,
    d: Omit<DecisionRecord, "snapshot"> & { snapshot: unknown }
  ): void {
    this.db
      .prepare(
        `INSERT INTO decisions (scenario_id, kind, process, request, approved, reason, version_before, version_after, snapshot, trace)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        scenarioId,
        d.kind,
        d.process ?? null,
        d.request ? JSON.stringify(d.request) : null,
        d.approved ? 1 : 0,
        d.reason ?? null,
        d.versionBefore,
        d.versionAfter,
        JSON.stringify(d.snapshot),
        d.trace ? JSON.stringify(d.trace) : null
      );
  }

  insertCheck(scenarioId: number, version: number, report: unknown, safe: boolean): void {
    this.db
      .prepare("INSERT INTO checks (scenario_id, version, safe, report) VALUES (?,?,?,?)")
      .run(scenarioId, version, safe ? 1 : 0, JSON.stringify(report));
  }

  decisions(scenarioId: number): unknown[] {
    return this.db
      .prepare("SELECT * FROM decisions WHERE scenario_id = ? ORDER BY id")
      .all(scenarioId) as unknown as unknown[];
  }

  checks(scenarioId: number): unknown[] {
    return this.db
      .prepare("SELECT * FROM checks WHERE scenario_id = ? ORDER BY id")
      .all(scenarioId) as unknown as unknown[];
  }
}

export interface DecisionRecord {
  kind: string;
  process?: string;
  request?: number[];
  approved: boolean;
  reason?: string;
  versionBefore: number;
  versionAfter: number;
  snapshot: unknown;
  trace?: unknown;
}
