import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { initializeWorkspace, useWorkspaceStore } from '../agent/workspace';
import { cloudSelection, useOpenAi } from '../openai/store';
import { chatCapability } from '../openai/capabilities';
import { useChatStore } from './store';
import { loadChatPreferences, saveChatPreferences, useChatPreferences } from './preferences';
import { ProjectFilesPanel } from '../files/ProjectFilesPanel';
import type { ChatAttachment } from './media';
import './chatOptions.css';

export function ChatOptions({ conversationId, disabled, onAttach, onLibraryBusy }: { conversationId: string; disabled: boolean; onAttach?: (attachment: ChatAttachment) => void; onLibraryBusy?: (busy: boolean) => void }) {
  const { t } = useTranslation();
  const conversation = useChatStore(state => state.conversations[conversationId]);
  const workspace = useWorkspaceStore(), cloud = useOpenAi(), preferences = useChatPreferences();
  const [globalDraft, setGlobalDraft] = useState(''), [saving, setSaving] = useState(false), [saveError, setSaveError] = useState(false);
  useEffect(() => { void initializeWorkspace(); void loadChatPreferences(); }, []);
  useEffect(() => { if (preferences.ready) setGlobalDraft(preferences.globalInstructions); }, [preferences.ready, preferences.globalInstructions]);
  if (!conversation) return null;
  const target = conversation.target;
  const profile = target.provider === 'chatgpt' ? cloudSelection(cloud, 'openai', target.connectionId, target.profileId, 'chat').profile : undefined;
  const search = chatCapability({ provider: target.provider, authMode: profile?.authMode }, 'webSearch');
  const project = workspace.projects.find(project => project.id === conversation.projectId);
  const configure = (patch: { projectId?: string; instructions?: string; webSearch?: boolean }) => {
    if (disabled) return;
    useChatStore.setState(state => state.conversations[conversationId] ? { conversations: { ...state.conversations, [conversationId]: { ...state.conversations[conversationId], ...patch, updatedAt: Date.now() } } } : {});
  };
  return <details className="chatOptions">
    <summary>{t('chatTools.context', { defaultValue: 'Context and tools' })}{conversation.webSearch ? ` · ${t('chatTools.webSearch', { defaultValue: 'Web search' })}` : ''}{project ? ` · ${project.name}` : ''}</summary>
    <div className="chatOptionsBody">
      {conversation.temporary && <p className="oaHelp">{t('chatTools.temporaryScope', { defaultValue: 'This chat is excluded from Aplot history and exports. Project memory is off. The selected runtime or provider may keep its own records.' })}</p>}
      <label>{t('chatTools.project', { defaultValue: 'Project' })}<select value={conversation.projectId ?? ''} disabled={disabled || !workspace.ready || !!conversation.temporary} onChange={event => configure({ projectId: event.target.value || undefined })}>
        <option value="">{t('chatTools.noProject', { defaultValue: 'No project' })}</option>
        {conversation.projectId && !project && <option value={conversation.projectId}>{t('chatTools.projectMissing', { defaultValue: 'Project unavailable' })}</option>}
        {workspace.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select></label>
      <label className="chatOptionCheck"><input type="checkbox" checked={!!conversation.webSearch} disabled={disabled || search.state === 'unavailable'} onChange={event => configure({ webSearch: event.target.checked })}/>{t('chatTools.webSearch', { defaultValue: 'Web search' })}</label>
      {project && !conversation.temporary && <ProjectFilesPanel key={conversationId} projectId={project.id} disabled={disabled} onAttach={onAttach} onBusy={onLibraryBusy}/>}
      <p className="oaHelp">{t(search.state === 'unavailable' ? 'chatTools.searchUnavailable' : 'chatTools.searchConditional', { defaultValue: search.state === 'unavailable' ? 'Web search is available through an OpenAI chat connection.' : 'Search availability depends on the selected model and account. API tools may incur additional charges.' })}</p>
      <label>{t('chatTools.conversationInstructions', { defaultValue: 'Instructions for this chat' })}<textarea rows={2} maxLength={8000} value={conversation.instructions ?? ''} disabled={disabled} onChange={event => configure({ instructions: event.target.value })}/></label>
      {project && <label>{t('chatTools.projectInstructions', { defaultValue: 'Shared project instructions' })}<textarea rows={2} maxLength={8000} value={project.instructions ?? ''} disabled={disabled || !!workspace.saveError} onChange={event => {
        const instructions = event.target.value;
        useWorkspaceStore.setState(state => ({ projects: state.projects.map(item => item.id === project.id ? { ...item, instructions } : item) }));
      }}/><small>{t('chatTools.projectMemory', { defaultValue: 'Confirmed project memory is included. Project instructions also apply to new agent sessions.' })}</small></label>}
      <label>{t('chatTools.globalInstructions', { defaultValue: 'Global chat instructions' })}<textarea rows={2} maxLength={8000} value={globalDraft} disabled={!preferences.ready || saving} onChange={event => setGlobalDraft(event.target.value)}/></label>
      <button type="button" disabled={!preferences.ready || saving || globalDraft === preferences.globalInstructions} onClick={() => {
        setSaving(true); setSaveError(false);
        void saveChatPreferences(globalDraft).catch(() => setSaveError(true)).finally(() => setSaving(false));
      }}>{t('aw.save')}</button>
      {(preferences.error || saveError || workspace.saveError) && <p className="awError" role="alert">{t('chatTools.contextError', { defaultValue: 'Context settings could not be loaded or saved. Retry before continuing.' })}<button type="button" onClick={() => { void loadChatPreferences(); void initializeWorkspace(); }}>{t('chat.retry')}</button></p>}
      <p className="oaHelp">{t('chatTools.contextOrder', { defaultValue: 'Global instructions → project instructions → chat instructions. Attachments remain quoted data. Context is sent only to this chat’s selected connection.' })}</p>
    </div>
  </details>;
}
