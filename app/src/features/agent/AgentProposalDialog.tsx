import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Primitives';
import { WorkspaceDialog } from './WorkspacePanels';
import { resolveAgentProposal, useAgentProposals } from './appTools';
import './appTools.css';

export function AgentProposalDialog(){
  const {t}=useTranslation();
  const proposal=useAgentProposals(state=>state.items[0]);
  if(!proposal)return null;
  const {agent,requestId}=proposal;
  return <WorkspaceDialog key={requestId} title={t('orchestrator.proposalTitle')} onClose={()=>void resolveAgentProposal(requestId,false)}>
    <div className="agentProposalBody">
      <p>{t('orchestrator.proposalHelp')}</p>
      <h3>{agent.name}</h3><p>{agent.title}</p>
      <p>{agent.runtime} · {agent.model||agent.binding?.modelId||t('orchestrator.callerModel')}</p>
      <p>{t(`aw.io.access.${agent.accessMode}`)}</p>
      <pre>{agent.instructions}</pre>
      <div className="agentProposalActions">
        <Button onClick={()=>void resolveAgentProposal(requestId,false)}>{t('actions.cancel')}</Button>
        <Button className="primary" onClick={()=>void resolveAgentProposal(requestId,true)}>{t('presets.create')}</Button>
      </div>
    </div>
  </WorkspaceDialog>;
}
