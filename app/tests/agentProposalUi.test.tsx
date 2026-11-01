// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/features/agent/generation',()=>({sendAgent:vi.fn()}));
import i18n from '../src/lib/i18n';
import { AgentProposalDialog } from '../src/features/agent/AgentProposalDialog';
import { handleAppTool, useAgentProposals, cancelAgentProposal } from '../src/features/agent/appTools';
import { useWorkspaceStore } from '../src/features/agent/workspace';
import { EMPTY_AGENT, useAgentStore } from '../src/features/agent/store';
beforeEach(async()=>{
 await i18n.changeLanguage('en');
 HTMLDialogElement.prototype.showModal=vi.fn(function(this:HTMLDialogElement){this.open=true;});HTMLDialogElement.prototype.close=vi.fn(function(this:HTMLDialogElement){this.open=false;});
 useWorkspaceStore.setState({ready:false,saveError:'',presets:[],tasks:[{id:'parent',projectId:'project',title:'Request',runtime:'codex',cloudModel:'caller-model',accessMode:'manual',archived:false,unread:false,createdAt:1,updatedAt:1}]});
 useAgentStore.setState({threads:{parent:{...EMPTY_AGENT,pending:true}}});
});
afterEach(()=>{cleanup();useAgentProposals.getState().items.forEach(item=>cancelAgentProposal(item.requestId));});
it('shows the proposed job and instructions, then creates the reviewed specialist on the explicit button click',async()=>{
 const pending=handleAppTool({requestId:'proposal',taskId:'parent',name:'aplot_propose_agent',arguments:{name:'DB expert',title:'Database specialist',instructions:'Check migrations and rollback steps.'}});
 render(<AgentProposalDialog/>);
 expect(screen.getByRole('dialog',{name:i18n.t('orchestrator.proposalTitle')})).toBeTruthy();
 expect(screen.getByText('Database specialist')).toBeTruthy();
 expect(screen.getByText('Check migrations and rollback steps.')).toBeTruthy();
 expect(useWorkspaceStore.getState().presets).toHaveLength(0);
 fireEvent.click(screen.getByRole('button',{name:i18n.t('presets.create')}));
 expect(await pending).toMatchObject({created:true,name:'DB expert'});
 await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
 expect(useWorkspaceStore.getState().presets).toHaveLength(1);
});
