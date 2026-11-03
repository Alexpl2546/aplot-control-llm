import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { LoaderCircle, Pencil, Plus, RefreshCw, Save, Server, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Button } from '../../components/ui/Primitives';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { isTauri } from '../../services/tauri';
import { listMcpConnections, removeMcpConnection, saveMcpConnection, type McpConnectionInput, type McpConnectionSummary, type McpTransport } from '../../services/mcpConnections';
import './mcpConnectionsPanel.css';

interface Draft {
  id: string;
  enabled: boolean;
  transport: McpTransport;
  command: string;
  argsText: string;
  url: string;
  bearerToken: string;
  clearBearerToken: boolean;
}

const emptyDraft = (): Draft => ({ id: '', enabled: true, transport: 'stdio', command: '', argsText: '', url: '', bearerToken: '', clearBearerToken: false });

function errorText(value: unknown, t: TFunction) {
  const code = String(value).replace(/^Error:\s*/, '').toLowerCase();
  const known: Record<string, string> = {
    'mcp-id-invalid': 'agent.mcp.errors.id',
    'mcp-command-required': 'agent.mcp.errors.commandRequired',
    'mcp-command-invalid': 'agent.mcp.errors.commandInvalid',
    'mcp-args-invalid': 'agent.mcp.errors.args',
    'mcp-url-required': 'agent.mcp.errors.urlRequired',
    'mcp-url-invalid': 'agent.mcp.errors.urlInvalid',
    'mcp-http-requires-https': 'agent.mcp.errors.https',
    'mcp-secret-invalid': 'agent.mcp.errors.tokenInvalid',
    'mcp-secret-http-only': 'agent.mcp.errors.tokenHttpOnly',
    'mcp-project-limit': 'agent.mcp.errors.limit',
    'project-missing': 'agent.mcp.errors.project',
  };
  const defaults: Record<string, string> = {
    'mcp-id-invalid': 'Use a lowercase resource ID. The “aplot” name is reserved.',
    'mcp-command-required': 'Enter an executable command.',
    'mcp-command-invalid': 'The executable command is invalid.',
    'mcp-args-invalid': 'Arguments contain invalid text or an authentication value. Keep credentials out of command arguments.',
    'mcp-url-required': 'Enter an HTTP server URL.',
    'mcp-url-invalid': 'Enter an HTTP or HTTPS URL without credentials, query parameters, or a fragment.',
    'mcp-http-requires-https': 'Remote HTTP servers must use HTTPS. Plain HTTP is allowed only for localhost.',
    'mcp-secret-invalid': 'Enter a valid API token without spaces or control characters.',
    'mcp-secret-http-only': 'API tokens are supported for HTTP servers only.',
    'mcp-project-limit': 'This project already has the maximum number of MCP configurations.',
    'project-missing': 'This project is no longer available.',
  };
  const key = known[code];
  return key ? t(key, { defaultValue: defaults[code] }) : t('agent.mcp.errors.generic', { defaultValue: 'The MCP configuration could not be saved.' });
}

export function McpConnectionsPanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<McpConnectionSummary[]>([]);
  const [loadedProjectId, setLoadedProjectId] = useState('');
  const [draft, setDraft] = useState<Draft>(() => emptyDraft());
  const [editingId, setEditingId] = useState('');
  const [draftProjectId, setDraftProjectId] = useState(projectId);
  const [removeTarget, setRemoveTarget] = useState<McpConnectionSummary>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const request = useRef(0);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const projectItems = loadedProjectId === projectId ? items : [];
  const projectEditingId = draftProjectId === projectId ? editingId : '';
  const projectDraft = draftProjectId === projectId ? draft : emptyDraft();

  const refresh = useCallback(async () => {
    const token = ++request.current;
    setLoading(true);
    setError('');
    try {
      const next = await listMcpConnections(projectId);
      if (token === request.current && projectIdRef.current === projectId) { setItems(next); setLoadedProjectId(projectId); }
    } catch {
      if (token === request.current && projectIdRef.current === projectId) setError(t('agent.mcp.loadFailed', { defaultValue: 'Could not load this project’s MCP configurations.' }));
    } finally {
      if (token === request.current && projectIdRef.current === projectId) setLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => {
    setLoadedProjectId('');
    setEditingId('');
    setDraft(emptyDraft());
    setDraftProjectId(projectId);
    setRemoveTarget(undefined);
    void refresh();
    return () => { request.current++; };
  }, [refresh]);

  const cancelEdit = () => { setEditingId(''); setDraft(emptyDraft()); setDraftProjectId(projectId); setError(''); };

  const edit = (item: McpConnectionSummary) => {
    setEditingId(item.id);
    setDraftProjectId(projectId);
    setError('');
    setDraft({
      id: item.id,
      enabled: item.enabled,
      transport: item.transport,
      command: item.command ?? '',
      argsText: item.args.join('\n'),
      url: item.url ?? '',
      bearerToken: '',
      clearBearerToken: false,
    });
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectId || draftProjectId !== projectId || saving) return;
    setSaving(true);
    setError('');
    const args = projectDraft.argsText.split(/\r?\n/).filter(argument => argument.length > 0);
    const config: McpConnectionInput = {
      id: projectDraft.id.trim(),
      enabled: projectDraft.enabled,
      transport: projectDraft.transport,
      ...(projectDraft.transport === 'stdio'
        ? { command: projectDraft.command, args }
        : { url: projectDraft.url.trim(), ...(projectDraft.bearerToken ? { bearerToken: projectDraft.bearerToken } : {}), clearBearerToken: projectDraft.clearBearerToken }),
    };
    try {
      await saveMcpConnection(projectId, config);
      if (projectIdRef.current !== projectId) return;
      cancelEdit();
      await refresh();
    } catch (cause) {
      if (projectIdRef.current === projectId) setError(errorText(cause, t));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!removeTarget || busyId) return;
    setBusyId(removeTarget.id);
    setError('');
    try {
      await removeMcpConnection(projectId, removeTarget.id);
      if (projectIdRef.current !== projectId) return;
      if (editingId === removeTarget.id) cancelEdit();
      setRemoveTarget(undefined);
      await refresh();
    } catch (cause) {
      if (projectIdRef.current === projectId) setError(errorText(cause, t));
      throw new Error(errorText(cause, t));
    } finally {
      setBusyId('');
    }
  };

  const title = t('agent.mcp.title', { defaultValue: 'External MCP servers' });
  return <section className="agentMcp" aria-label={title}>
    <header className="agentMcpHeader">
      <div><h3><Server size={17} aria-hidden="true"/>{title}</h3>
        <p>{t('agent.mcp.description', { defaultValue: 'Configure project-specific MCP servers for supported new sessions. Saved settings do not show connection health.' })}</p>
      </div>
      <button type="button" className="kIconBtn" aria-label={t('agent.mcp.refresh', { defaultValue: 'Refresh MCP configurations' })} title={t('agent.mcp.refresh', { defaultValue: 'Refresh MCP configurations' })} disabled={loading || saving} onClick={() => void refresh()}><RefreshCw size={14} className={loading ? 'isSpinning' : ''}/></button>
    </header>
    <p className="agentMcpNotice">{t('agent.mcp.newSessions', { defaultValue: 'Changes apply to new sessions. Removing a configuration does not stop servers already used by an existing session.' })}</p>
    {!isTauri() && <p className="agentMcpEmpty" role="status">{t('agent.mcp.desktopOnly', { defaultValue: 'MCP configuration is available in the desktop app.' })}</p>}
    {error && <p className="agentMcpError" role="alert">{error}</p>}
    {loading && <p className="agentMcpStatus" role="status">{t('agent.mcp.loading', { defaultValue: 'Loading MCP configurations…' })}</p>}
    {!loading && !projectItems.length && <p className="agentMcpEmpty">{t('agent.mcp.empty', { defaultValue: 'No MCP servers are configured for this project.' })}</p>}
    <div className="agentMcpList">{projectItems.map(item => <article className="agentMcpCard" key={item.id}>
      <div className="agentMcpCardHeading"><div><strong>{item.id}</strong><small>{item.transport === 'stdio' ? t('agent.mcp.stdio', { defaultValue: 'Standard input/output' }) : t('agent.mcp.http', { defaultValue: 'HTTP' })}</small></div>
        <span className={item.enabled ? 'isEnabled' : 'isDisabled'}>{item.enabled ? t('agent.mcp.enabled', { defaultValue: 'Enabled' }) : t('agent.mcp.disabled', { defaultValue: 'Disabled' })}</span>
      </div>
      {item.transport === 'stdio' ? <div className="agentMcpCommand"><code>{item.command}</code>{item.args.map((arg, index) => <code key={`${index}:${arg}`}>{arg}</code>)}</div> : <code className="agentMcpUrl">{item.url}</code>}
      {item.hasBearerToken && <small className="agentMcpSecret">{t('agent.mcp.tokenStored', { defaultValue: 'API token stored securely' })}</small>}
      <div className="agentMcpActions"><Button type="button" disabled={!!busyId || saving || !isTauri()} onClick={() => edit(item)}><Pencil size={13}/>{t('agent.mcp.edit', { defaultValue: 'Edit' })}</Button>
        <Button type="button" className="danger" disabled={!!busyId || saving || !isTauri()} onClick={() => setRemoveTarget(item)}><Trash2 size={13}/>{t('agent.mcp.remove', { defaultValue: 'Remove configuration' })}</Button></div>
    </article>)}</div>
    <form className="agentMcpForm" onSubmit={event => void save(event)}>
      <h4>{projectEditingId ? t('agent.mcp.editTitle', { defaultValue: 'Edit MCP server' }) : t('agent.mcp.addTitle', { defaultValue: 'Add MCP server' })}</h4>
      <label>{t('agent.mcp.resourceId', { defaultValue: 'Resource ID' })}<input required maxLength={64} value={projectDraft.id} disabled={saving || !!projectEditingId || !isTauri()} placeholder="docs-server" autoComplete="off" onChange={event => setDraft(current => ({ ...current, id: event.target.value }))}/></label>
      <label>{t('agent.mcp.transport', { defaultValue: 'Transport' })}<select value={projectDraft.transport} disabled={saving || !!projectEditingId || !isTauri()} onChange={event => setDraft(current => ({ ...current, transport: event.target.value as McpTransport, bearerToken: '', clearBearerToken: false }))}>
        <option value="stdio">{t('agent.mcp.stdio', { defaultValue: 'Standard input/output' })}</option><option value="http">HTTP</option>
      </select></label>
      {projectDraft.transport === 'stdio' ? <>
        <label>{t('agent.mcp.command', { defaultValue: 'Executable command' })}<input required maxLength={1024} value={projectDraft.command} disabled={saving || !isTauri()} placeholder="npx" autoComplete="off" spellCheck={false} onChange={event => setDraft(current => ({ ...current, command: event.target.value }))}/></label>
        <label>{t('agent.mcp.args', { defaultValue: 'Arguments (one per line)' })}<textarea value={projectDraft.argsText} disabled={saving || !isTauri()} rows={4} spellCheck={false} placeholder={'-y\n@example/mcp-server'} onChange={event => setDraft(current => ({ ...current, argsText: event.target.value }))}/></label>
        <small>{t('agent.mcp.argsHint', { defaultValue: 'Each line is passed as one argument. No shell command parsing is used. Keep credentials out of arguments.' })}</small>
      </> : <>
        <label>{t('agent.mcp.serverUrl', { defaultValue: 'Server URL' })}<input required maxLength={2048} type="url" value={projectDraft.url} disabled={saving || !isTauri()} placeholder="https://mcp.example.com/mcp" autoComplete="off" spellCheck={false} onChange={event => setDraft(current => ({ ...current, url: event.target.value }))}/></label>
        <small>{t('agent.mcp.urlHint', { defaultValue: 'Remote servers require HTTPS. HTTP is allowed only for localhost. URLs cannot include credentials, query parameters, or fragments.' })}</small>
        <label>{t('agent.mcp.apiToken', { defaultValue: 'API token (optional)' })}<input type="password" value={projectDraft.bearerToken} disabled={saving || !isTauri()} autoComplete="new-password" placeholder={t('agent.mcp.tokenPlaceholder', { defaultValue: 'Blank keeps any saved token' })} onChange={event => setDraft(current => ({ ...current, bearerToken: event.target.value, clearBearerToken: false }))}/></label>
        <small>{t('agent.mcp.tokenHint', { defaultValue: 'Manual bearer/API token support only. Aplot stores the token with Windows DPAPI and passes it to Codex as an Authorization header for the session. OAuth sign-in is not available.' })}</small>
        {projectEditingId && projectItems.find(item => item.id === projectEditingId)?.hasBearerToken && <label className="agentMcpCheckbox"><input type="checkbox" checked={projectDraft.clearBearerToken} disabled={saving || !!projectDraft.bearerToken || !isTauri()} onChange={event => setDraft(current => ({ ...current, clearBearerToken: event.target.checked }))}/><span>{t('agent.mcp.clearToken', { defaultValue: 'Remove the stored API token' })}</span></label>}
      </>}
      <label className="agentMcpCheckbox"><input type="checkbox" checked={projectDraft.enabled} disabled={saving || !isTauri()} onChange={event => setDraft(current => ({ ...current, enabled: event.target.checked }))}/><span>{t('agent.mcp.enable', { defaultValue: 'Enable for new sessions' })}</span></label>
      <div className="agentMcpFormActions"><Button type="submit" className="primary" disabled={saving || !isTauri() || !projectDraft.id.trim() || (projectDraft.transport === 'stdio' ? !projectDraft.command.trim() : !projectDraft.url.trim())}>{saving ? <LoaderCircle size={14} className="isSpinning"/> : projectEditingId ? <Save size={14}/> : <Plus size={14}/>}<span>{saving ? t('agent.mcp.saving', { defaultValue: 'Saving…' }) : t('agent.mcp.save', { defaultValue: 'Save configuration' })}</span></Button>
        {projectEditingId && <Button type="button" disabled={saving} onClick={cancelEdit}><X size={14}/>{t('actions.cancel', { defaultValue: 'Cancel' })}</Button>}</div>
    </form>
    <ConfirmDialog open={!!removeTarget} title={t('agent.mcp.removeTitle', { defaultValue: 'Remove MCP configuration?' })} text={t('agent.mcp.removeText', { defaultValue: 'This deletes the saved project configuration only. It does not stop a server used by an existing session.' })} confirmLabel={t('agent.mcp.remove', { defaultValue: 'Remove configuration' })} dangerous busy={!!busyId} onCancel={() => setRemoveTarget(undefined)} onConfirm={remove}/>
  </section>;
}
