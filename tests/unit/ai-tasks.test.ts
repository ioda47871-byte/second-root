import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// .ai/tasks.json is the source of truth for development tasks and is how a
// fresh Claude session recovers where work stands, so its shape is checked
// in CI rather than trusted.

type Task = Record<string, unknown> & { id: string; status: string; depends_on: string[] };

const doc = JSON.parse(readFileSync(join(process.cwd(), ".ai/tasks.json"), "utf8")) as {
  statuses: string[];
  tasks: Task[];
};

const REQUIRED_FIELDS = [
  "id",
  "title",
  "status",
  "priority",
  "depends_on",
  "purpose",
  "acceptance_criteria",
  "required_tests",
  "allowed_scope",
  "forbidden_scope",
  "human_approval_triggers",
  "attempts",
  "last_failure",
] as const;

const STATUSES = ["backlog", "ready", "in_progress", "review", "done", "blocked"];

describe(".ai/tasks.json", () => {
  it("declares exactly the allowed statuses", () => {
    expect(doc.statuses).toEqual(STATUSES);
  });

  it.each(doc.tasks.map((t) => [t.id, t] as const))("%s has every required field", (_id, task) => {
    for (const field of REQUIRED_FIELDS) {
      expect(task, `missing ${field}`).toHaveProperty(field);
    }
    expect(STATUSES).toContain(task.status);
    expect(typeof task.attempts).toBe("number");
    for (const list of ["depends_on", "acceptance_criteria", "required_tests", "allowed_scope", "forbidden_scope", "human_approval_triggers"]) {
      expect(Array.isArray(task[list]), `${list} must be an array`).toBe(true);
    }
  });

  it("has unique ids", () => {
    const ids = doc.tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only depends on known tasks, without cycles", () => {
    const byId = new Map(doc.tasks.map((t) => [t.id, t]));
    for (const task of doc.tasks) {
      for (const dep of task.depends_on) expect(byId.has(dep), `${task.id} -> ${dep}`).toBe(true);
    }
    const state = new Map<string, "visiting" | "done">();
    const visit = (id: string, path: string[]) => {
      if (state.get(id) === "done") return;
      if (state.get(id) === "visiting") throw new Error(`cycle: ${[...path, id].join(" -> ")}`);
      state.set(id, "visiting");
      for (const dep of byId.get(id)!.depends_on) visit(dep, [...path, id]);
      state.set(id, "done");
    };
    for (const task of doc.tasks) visit(task.id, []);
  });

  it("gives every blocked task a reason", () => {
    for (const task of doc.tasks.filter((t) => t.status === "blocked")) {
      expect(task.blocked_reason ?? task.last_failure, task.id).toBeTruthy();
    }
  });

  it("never marks a task in progress or later before its dependencies are done", () => {
    const byId = new Map(doc.tasks.map((t) => [t.id, t]));
    for (const task of doc.tasks.filter((t) => ["in_progress", "review", "done"].includes(t.status))) {
      for (const dep of task.depends_on) expect(byId.get(dep)!.status, `${task.id} needs ${dep}`).toBe("done");
    }
  });
});
