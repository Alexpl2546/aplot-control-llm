import { describe, expect, it } from "vitest";
import { buildAgentNetwork, type AgentNetworkSource } from "../src/features/agent-network/model";
import { EMPTY_AGENT, type AgentThread } from "../src/features/agent/store";
import type { AgentProject, AgentTask } from "../src/features/agent/workspaceModel";

const project: AgentProject = { id: "p1", name: "Project One", path: "C:/work/project-one", skills: "", createdAt: 1 };
function task(id: string, runId?: string): AgentTask {
  return {
    id, projectId: project.id, title: `Task ${id}`, createdAt: 1, updatedAt: Number(id.slice(1)) || 1,
    archived: false, unread: false, runtime: id === "t2" ? "claude" : "codex",
    binding: runId ? { runId, generation: 1, name: runId, modelId: "model", engine: "llama_cpp", contextTokens: 8192 } : undefined,
  };
}
function source(tasks: AgentTask[], threads: Record<string, AgentThread>): AgentNetworkSource {
  return { projects: [project], tasks, presets: [], threads, events: [] };
}

describe("agent network projection", () => {
  it("creates a collaboration link only from participants recorded on the same task", () => {
    const thread = {
      ...EMPTY_AGENT,
      id: "session-one",
      children: [{ id: "reviewer", name: "Reviewer", activity: "Review", status: "running" }],
    } satisfies AgentThread;
    const snapshot = buildAgentNetwork(source([task("t1"), task("t2")], { t1: thread }));

    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.tasks.map(row => row.task.id)).toEqual(["t2", "t1"]);
    expect(snapshot.links).toHaveLength(1);
    expect(snapshot.links[0]?.taskIds).toEqual(["t1"]);
    expect(snapshot.links[0]?.agentIds.map(id => id.startsWith("child:") ? "child" : id.startsWith("role:codex") ? "codex" : id)).toEqual(["child", "codex"]);
  });

  it("keeps tasks in separate CH channels out of a scoped projection", () => {
    const snapshot = buildAgentNetwork(source([task("t1", "ch1"), task("t2", "ch2")], {}), { runId: "ch1" });

    expect(snapshot.tasks.map(row => row.task.id)).toEqual(["t1"]);
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.projects[0]?.taskIds).toEqual(["t1"]);
  });

  it("retains real projects in the all-channel view when they have no tasks", () => {
    const emptyProject = { ...project, id: "p2", name: "Empty project" };
    const snapshot = buildAgentNetwork({ ...source([], {}), projects: [project, emptyProject] });

    expect(snapshot.projects.map(entry => entry.project.id)).toEqual(["p2", "p1"]);
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.links).toEqual([]);
  });

  it("marks pending approvals and repeated failures as actionable states", () => {
    const waiting = { ...EMPTY_AGENT, requests: [{ id: "r1", method: "approval", params: {} }] } satisfies AgentThread;
    const blocked = {
      ...EMPTY_AGENT,
      error: "agent-error",
      entries: ["1", "2", "3"].map(id => ({ id, kind: "tool" as const, name: "write_file", text: "", status: "error" as const, details: "same path" })),
    } satisfies AgentThread;
    const snapshot = buildAgentNetwork(source([task("t1"), task("t2")], { t1: waiting, t2: blocked }));

    expect(snapshot.tasks.find(row => row.task.id === "t1")?.status).toBe("waiting");
    expect(snapshot.tasks.find(row => row.task.id === "t2")?.status).toBe("blocked");
  });

  it("only labels a restored transcript complete when a completion event confirms it", () => {
    const transcript = { ...EMPTY_AGENT, ended: true, restored: true, entries: [{ id: "a1", kind: "assistant" as const, text: "Finished" }] } satisfies AgentThread;
    const completedEvent = { id: "e1", time: 10, kind: "agent.completed" as const, level: "info" as const, name: "Task t1", taskId: "t1", data: { outcome: "success" } };
    const completed = buildAgentNetwork({ ...source([task("t1")], { t1: transcript }), events: [completedEvent] });
    const inactive = buildAgentNetwork(source([task("t1")], { t1: transcript }));

    expect(completed.tasks[0]?.status).toBe("completed");
    expect(inactive.tasks[0]?.status).toBe("inactive");
  });
});

it('removes a deleted employee and historical child nodes while retaining task history',()=>{
 const preset={id:'employee',name:'Reviewer',runtime:'codex' as const,instructions:'',accessMode:'manual' as const};
 const row={...task('t1'),presetId:preset.id,agentName:preset.name};
 const ended={...EMPTY_AGENT,ended:true,children:[{id:'child',name:'Old helper',activity:'',status:'completed'}]};
 const before=buildAgentNetwork({...source([row],{t1:ended}),presets:[preset]});
 expect(before.agents).toHaveLength(2);
 const after=buildAgentNetwork({...source([{...row,presetId:undefined}],{t1:ended}),presets:[]});
 expect(after.agents).toEqual([]);expect(after.links).toEqual([]);expect(after.tasks).toHaveLength(1);
});
