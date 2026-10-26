import { describe, expect, it } from 'vitest';
import { sidebarAgents } from '../src/features/agent/sidebarModel';
import { EMPTY_AGENT } from '../src/features/agent/store';
import type { AgentPreset, AgentTask } from '../src/features/agent/workspaceModel';

const preset: AgentPreset={id:'tester',name:'Junior tester',runtime:'codex',accessMode:'manual',instructions:'Check changes'};
const task: AgentTask={id:'task',projectId:'project',title:'Test app',presetId:preset.id,runtime:'codex',createdAt:1,updatedAt:2,archived:false,unread:false};
const live={...EMPTY_AGENT,id:'session'};

describe('sidebar saved agents and sessions',()=>{
  it('shows a saved agent immediately, before any task or session exists',()=>{
    expect(sidebarAgents([preset],[],{})).toMatchObject([{name:preset.name,preset,tasks:[]}]);
  });
  it('groups live tasks under their saved agent and prioritizes an approval over idle sessions',()=>{
    const waiting={...task,id:'approval',updatedAt:1};
    const collaborator={...task,id:'collaborator',presetId:undefined,collaboratorPresetIds:[preset.id],updatedAt:0};
    const rows=sidebarAgents([preset],[task,waiting,collaborator],{task:live,collaborator:live,approval:{...live,requests:[{id:'q',method:'approval',params:{}}]}});
    expect(rows).toHaveLength(1);
    expect(rows[0].tasks.map(t=>t.id)).toEqual(['approval','task','collaborator']);
  });
  it('keeps a saved agent visible after session end without showing deleted tasks',()=>{
    const rows=sidebarAgents([preset],[task,{...task,id:'deleted',deletedAt:3}],{task:{...live,ended:true},deleted:live});
    expect(rows).toHaveLength(1);expect(rows[0].tasks).toEqual([]);
  });
  it('preserves active sessions with no preset or with a removed preset',()=>{
    const rows=sidebarAgents([],[task,{...task,id:'custom',presetId:undefined}],{task:live,custom:live});
    expect(rows.map(r=>r.tasks[0].id).sort()).toEqual(['custom','task']);
  });
  it('shows a starting session before it receives its native session id',()=>{
    expect(sidebarAgents([preset],[task],{task:{...EMPTY_AGENT,starting:true}})[0].tasks).toEqual([task]);
    expect(sidebarAgents([preset],[task],{task:{...EMPTY_AGENT,pending:true}})[0].tasks).toEqual([task]);
    expect(sidebarAgents([preset],[task],{task:{...EMPTY_AGENT}})[0].tasks).toEqual([]);
  });
});
