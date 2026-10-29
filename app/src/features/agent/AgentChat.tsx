import { openSettingsSection } from '../../services/settingsWindow';
import { ActivityOrb,activityState } from '../../components/ui/ActivityOrb';
import { AgentTaskBoard } from './AgentTaskBoard';
import { AgentTransfer } from './AgentTransfer';
import { CloudProfileSelect } from '../openai/CloudProfileSelect';
import { agentOptions } from './AgentIdentity';
import { openAgentPresets } from './AgentPresets';
import { cloudSelection, useOpenAi } from '../openai/store';
import { ArrowDown, BookOpen, Bot, Files, FolderOpen, KanbanSquare, Menu, PanelRight, Plus, Send, Sparkles, Settings2, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Primitives';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { ChoiceSelect } from '../../components/ui/ChoiceSelect';
import { useControlStore } from '../../store/control';
import { pickProjectDirectory } from '../../services/dialog';
import { workspaceOpen } from '../../services/agentWorkspace';
import { isTauri } from '../../services/tauri';
import { ENGINE_NAMES } from '../../lib/engineModels';
import { EMPTY_AGENT, useAgentStore } from './store';
import { sendAgent, interruptAgent, resetAgentSession } from './generation';
import { bindRun, confirmedMemorySnapshot, repeatedFailures, type AgentBinding, type AgentProject, type ProjectMemory } from './workspaceModel';
import { assignAgentPreset,createTask, deleteMemory, editTask, flushWorkspace, initializeWorkspace, openProject, projectHasActiveSessions, removeProject, updateProjectSettings, restoreTask, saveMemory, taskStatus, trashTask, useWorkspaceStore } from './workspace';
import { MemoryEditor, WorkspaceDialog, WorkspaceInspector, WorkspaceSidebar, type InspectorTab } from './WorkspacePanels';
import { WorkspaceMessage, WorkspaceRequest } from './WorkspaceMessages';
import { AgentComposer } from './AgentComposer';
import { useLaunchUi } from '../launches/ui';
import { boundTaskProfile } from './connection';
import { TaskStarter, WorkspaceWelcome } from './TaskStarter';
import { AgentIcon } from './AgentIdentity';
import { ProjectKnowledge } from '../knowledge/ProjectKnowledge';

export function AgentChat() {
  const { t, i18n } = useTranslation();
  const ws = useWorkspaceStore(), threads = useAgentStore(s => s.threads);
  const runs = useControlStore(s => s.runs), globalId = useControlStore(s => s.selectedRunId), setView = useControlStore(s => s.setView), notify = useControlStore(s => s.notify);
  const profiles = useControlStore(s => s.profiles);
  const project = ws.projects.find(p => p.id === ws.selectedProjectId), task = ws.tasks.find(task => task.id === ws.selectedTaskId && task.projectId === project?.id);
  const thread = task ? threads[task.id] ?? EMPTY_AGENT : EMPTY_AGENT;
  const cloud=useOpenAi(),isCodex=task?.runtime==='codex',isClaude=task?.runtime==='claude',isCloud=isCodex||isClaude;
  const selection=cloudSelection(cloud,isClaude?'claude':'openai',task?.connectionId,task?.connectionProfileId);
  const cloudStatus=selection.status;
  const cloudInstalled=isClaude?cloud.claude.installed:cloud.installed;
  const taskModel=task?.cloudModel??task?.codexModel;
  const modelsFor=(runtime:string,profileId?:string)=>cloudSelection(cloud,runtime==='claude'?'claude':'openai',undefined,profileId).models;
  const [newRuntime,setNewRuntime]=useState<'hermes'|'codex'|'claude'>('hermes');
  const [newCodexModel,setNewCodexModel]=useState(''),[newProfileId,setNewProfileId]=useState(''),[newPresetId,setNewPresetId]=useState(''),[newInstructions,setNewInstructions]=useState('');
  const newSelection=cloudSelection(cloud,newRuntime==='claude'?'claude':'openai',undefined,newProfileId);
  const newPreset=ws.presets.find(p=>p.id===newPresetId);
  const taskProfile = boundTaskProfile(task?.binding, profiles);
  const launchTaskModel = () => { setModal(undefined); useLaunchUi.getState().setQuickAdd(true, taskProfile?.id); };
  const run = runs.find(r => r.info.runId === task?.binding?.runId), fallback = runs.find(r => r.info.runId === globalId) ?? runs.find(r => ['ready','busy'].includes(r.info.state));
  const [inspector,setInspector] = useState<InspectorTab>(), [mobileTasks,setMobileTasks] = useState(false), [modal,setModal] = useState<'new'|'rename'|'resume'|'agent'|'profile'|'project'|'trash'|'connection'|'transfer'|'board'>(), [name,setName] = useState(''), [renameId,setRenameId] = useState('');
  const [newBinding,setNewBinding] = useState<AgentBinding>(), [handoff,setHandoff] = useState(''), [busy,setBusy] = useState(false), [localError,setLocalError] = useState('');
  const [projectToRemove,setProjectToRemove]=useState<{project:AgentProject;tasks:number;memory:number}>();
  const [projectPath,setProjectPath]=useState('');
  const [deleteId,setDeleteId]=useState(''), [actionError,setActionError]=useState('');
  const [memoryEdit,setMemoryEdit] = useState<{record?: ProjectMemory}>(), [preview,setPreview] = useState<{title:string;text:string;diff?:boolean}>();
  const [starter,setStarter] = useState(false), autoSend = useRef('');
  const [atBottom,setAtBottom] = useState(true), scroll = useRef<HTMLDivElement>(null), textarea = useRef<HTMLTextAreaElement>(null), nearBottom = useRef(true);
  useEffect(() => { void initializeWorkspace(); }, []);
  useEffect(() => {
    useWorkspaceStore.setState({ visibleTaskId: task?.id ?? '' });
    if (task?.unread) useWorkspaceStore.setState(s => ({ tasks:s.tasks.map(x => x.id === task.id ? {...x,unread:false} : x) }));
    nearBottom.current = true; setAtBottom(true);
    return () => { useWorkspaceStore.setState({visibleTaskId:''}); };
  }, [task?.id]);
  useEffect(() => { if (nearBottom.current) scroll.current?.scrollTo({top:thread.entries.length||thread.requests.length?scroll.current.scrollHeight:0,behavior:'instant'}); }, [thread.entries,thread.requests,task?.id]);
  useEffect(() => { const media = window.matchMedia('(max-width: 1550px)'); const adapt = () => { if (media.matches) setInspector(undefined); }; media.addEventListener('change',adapt); return () => media.removeEventListener('change',adapt); }, []);
  useEffect(() => {
    if (!mobileTasks) return;
    const focused = document.activeElement as HTMLElement | null;
    const panel = document.querySelector<HTMLElement>('.awSidebar');
    panel?.querySelector<HTMLElement>('button:not(:disabled),input')?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || document.querySelector('dialog[open]')) return;
      const items = Array.from(panel?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)') ?? []).filter(el => el.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown',trap);
    return () => { window.removeEventListener('keydown',trap); focused?.focus(); };
  }, [mobileTasks]);
  useEffect(() => {
    if (!mobileTasks && !inspector) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
      setMobileTasks(false); setInspector(undefined);
      textarea.current?.focus();
    };
    window.addEventListener('keydown',close);
    return () => window.removeEventListener('keydown',close);
  }, [mobileTasks,inspector]);
  const sameGeneration = isCloud || !!run && (run.info.generation === task?.binding?.generation||!!task?.autoStartServer&&!thread.id);
  const ready = !task?.deletedAt && (isCloud ? cloudInstalled&&cloudStatus.connected&&(!task.connectionId||task.connectionId===cloudStatus.connectionId)&&!!taskModel : !!task?.binding && sameGeneration && !!run && (['ready','busy'].includes(run.info.state)||!!task.autoStartServer) && run.info.contextTokens >= 64000);
  const projectMemory = ws.memory.filter(m => m.projectId === project?.id);
  const memorySnapshot = () => confirmedMemorySnapshot(projectMemory);
  const openFolder = async () => {
    if (!isTauri()) {setLocalError(t('aw.desktopOnly'));return;}
    try { const path = await pickProjectDirectory(); if (path) { await openProject(path); setMobileTasks(false); } } catch {setLocalError(t('aw.ioError'));}
  };
  const newTask = () => {setStarter(true);setMobileTasks(false);};
  const inspect = (tab:InspectorTab) => {setInspector(v=>v===tab?undefined:tab);setMobileTasks(false);};
  const projectSettings=()=>{setActionError('');setName(project?.name??'');setProjectPath(project?.path??'');setModal('project');};
  const projectPathError=(error:unknown)=>t(String(error).includes('project-busy')?'aw.projectDeleteBusy':String(error).includes('project-folder-used')?'aw.projectFolderUsed':String(error).includes('project-save-failed')?'aw.error.save':String(error).includes('desktop-only')?'aw.desktopOnly':'aw.projectFolderUnavailable');
  const saveProject=async(reveal=false)=>{
    if(!project||busy)return;setBusy(true);setActionError('');
    try{await updateProjectSettings(project.id,name,projectPath);if(reveal)await workspaceOpen(project.id,'');else setModal(undefined);}
    catch(error){setActionError(projectPathError(error));}finally{setBusy(false);}
  };
  const chooseProjectFolder=async()=>{
    if(!isTauri()){setActionError(t('aw.desktopOnly'));return;}
    try{const path=await pickProjectDirectory();if(path){setProjectPath(path);setActionError('');}}catch(error){setActionError(projectPathError(error));}
  };
  const projectBusy=!!project&&projectHasActiveSessions(project.id);
  const requestTrash=(id:string)=>{setDeleteId(id);setActionError('');setModal('trash');};
  const removeTask=async()=>{
    if(busy)return;setBusy(true);setActionError('');
    try {await trashTask(deleteId,id=>interruptAgent(id,true));setModal(undefined);}
    catch {setActionError(t('aw.trashFailed'));}finally{setBusy(false);}
  };
  const askSession = (binding = task?.binding) => {
    if (!task || task.archived || task.deletedAt || thread.pending) return;
    const active = runs.find(r => r.info.runId === binding?.runId && ['ready','busy'].includes(r.info.state));
    setNewBinding(active ? bindRun(active.info,active.config?.profileName) : fallback ? bindRun(fallback.info,fallback.config?.profileName) : undefined);
    const summary = thread.entries.filter(e => ['user','assistant'].includes(e.kind) && e.text).slice(-6).map(e => `${e.kind === 'user' ? t('chat.you') : (isClaude?'Claude':isCodex?'Codex':'Hermes')}: ${e.text}`).join('\n\n').slice(-12000);
    setHandoff(summary ? `${t('aw.handoffHeading')}\n\n${summary}\n\n${t('aw.handoffInstruction')}${thread.draft ? `\n\n${thread.draft}` : ''}` : thread.draft);
    setModal('resume');
  };
  const chooseRun = (id:string) => {
    const selected = runs.find(r => r.info.runId === id); if (!selected || !task) return;
    if (thread.id || thread.entries.length) { askSession(bindRun(selected.info,selected.config?.profileName)); return; }
    editTask(task.id,{binding:bindRun(selected.info,selected.config?.profileName)});
  };
  const prepareInput = () => { if(task&&!thread.id) useAgentStore.getState().update(task.id,s=>({...s,skills:project?.skills??'',appliedMemory:memorySnapshot(),accessMode:task.accessMode??'manual'})); };
  const send = () => {
    if (!task || task.deletedAt || !ready || thread.pending || thread.ended || ws.saveError) return;
    if(isCloud&&!task.connectionId)editTask(task.id,{connectionId:cloudStatus.connectionId});
    prepareInput();
    void sendAgent(task.id,{runId:task.binding?.runId??'',generation:task.binding?.generation??0,language:i18n.language.startsWith('ru') ? 'ru' : 'en'});
  };
  const resume = async () => {
    if (!task || !project || (!newBinding&&!isCloud) || busy) return;
    if(isCloud){editTask(task.id,{connectionId:cloudStatus.connectionId});setBusy(true);try{if(!await resetAgentSession(task.id))return;useAgentStore.getState().update(task.id,s=>({...s,id:undefined,ended:false,restored:false,pending:false,starting:false,stopped:false,error:'',requests:[],cursor:undefined,context:undefined,nativeSessionId:undefined,nativeRuntime:undefined,nativeConnectionId:undefined,accessMode:task.accessMode??'manual',skills:project.skills,appliedMemory:memorySnapshot(),draft:handoff}));setModal(undefined);if(handoff.trim())await sendAgent(task.id,{runId:'',generation:0,language:i18n.language.startsWith('ru')?'ru':'en'});}finally{setBusy(false);}return;}
    const live = runs.find(r => r.info.runId === newBinding!.runId);
    if (!live || !['ready','busy'].includes(live.info.state) || live.info.contextTokens < 64000) return;
    setBusy(true);
    try {
      if (!await resetAgentSession(task.id)) return;
      editTask(task.id,{binding:bindRun(live.info,live.config?.profileName)});
      useAgentStore.getState().update(task.id,s => ({...s,id:undefined,hermesSessionId:undefined,actualModelId:undefined,actualContextTokens:undefined,context:undefined,voiceStatus:'idle',accessMode:task.accessMode??'manual',ended:false,restored:false,pending:false,starting:false,stopped:false,error:'',requests:[],cursor:undefined,skills:project.skills,appliedMemory:memorySnapshot(),draft:handoff,entries:[...s.entries,{id:crypto.randomUUID(),kind:'notice',text:t('aw.newSessionNotice'),time:Date.now()}]}));
      setModal(undefined);
      if (handoff.trim()) await sendAgent(task.id,{runId:live.info.runId,generation:live.info.generation,language:i18n.language.startsWith('ru')?'ru':'en'});
    } finally {setBusy(false);}
  };
  const addFromMessage = (entryId:string,text:string) => { if (project && task) setMemoryEdit({record:{id:crypto.randomUUID(),projectId:project.id,taskId:task.id,sourceEntryId:entryId,text:text.slice(0,12000),category:'result',confirmed:true,updatedAt:Date.now()}}); };
  const connection = isCloud ? `${task?.agentName??(isClaude?'Claude':'Codex')} · ${taskModel??''} · ${cloudStatus.email??''}` : task?.binding ? ['Hermes',run ? t('k.serverNumber',{number:runs.indexOf(run)+1}) : t('aw.savedConnection'),thread.actualModelId || task.binding.name,ENGINE_NAMES[task.binding.engine]].join(' · ') : t('aw.noConnection');
  const reason = !task ? '' : isCloud ? thread.ended?t('aw.restoreHint'):!cloudStatus.connected?t('openai.connectFirst'):!cloudInstalled?t(isClaude?'profiles.claudeMissing':'openai.cliMissing'):task.connectionId&&task.connectionId!==cloudStatus.connectionId?t('connections.accountChanged'):!taskModel?t('openai.chooseModel'):'' : thread.ended ? t('aw.restoreHint') : !task.binding ? t('aw.chooseConnection') : !run || !sameGeneration ? t('aw.connectionChanged') : !['ready','busy'].includes(run.info.state) ? t(task.autoStartServer?'presets.serverOnTask':'aw.serverStopped') : run.info.contextTokens < 64000 ? t('agent.errors.context') : '';
  if (!ws.ready) return <div className="awLoading" role="status">{t(ws.error ? `aw.error.${ws.error}` : 'aw.loading')}{ws.error && <Button onClick={() => void initializeWorkspace()}>{t('aw.retry')}</Button>}</div>;
  // A task made from the starter sends its first message as soon as the agent can take it.
  useEffect(() => {
    if (!autoSend.current || task?.id !== autoSend.current) return;
    autoSend.current = '';
    if (ready) send(); else textarea.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, ready]);
  const showStarter = !!project && (starter || !task);
  const headerPreset = ws.presets.find(p=>p.id===task?.presetId);
  return <section className={`agentWorkspaceV2 awV3${inspector ? ' hasInspector' : ''}`}>
    <div className="awContent"><div className={`awSidebarContainer${mobileTasks?' isOpen':''}`}>{mobileTasks && <button className="awScrim" aria-label={t('aw.close')} onClick={()=>setMobileTasks(false)}/>}<WorkspaceSidebar onOpen={()=>void openFolder()} onNewTask={project?newTask:undefined} onProject={projectSettings} onTrash={requestTrash} onRename={id=>{setRenameId(id);setName(ws.tasks.find(x=>x.id===id)?.title??'');setModal('rename');}} onSelect={()=>setStarter(false)} mobile={mobileTasks} onClose={()=>setMobileTasks(false)}/></div>
    <div className="awMain">
    <header className="awHeader"><button className="kIconBtn awTaskToggle" aria-label={t('aw.showTasks')} onClick={() => setMobileTasks(v=>!v)}><Menu size={18}/></button>
      <div className="awHeading">{showStarter||!task?<h2>{t(project?'aw.newTask':'aw.workspace')}</h2>:<><div className="awHeadingLine"><h2 title={task.title}>{task.title}</h2><span className={`awTaskState is-${taskStatus(thread)}`}><i/>{t(`aw.status.${taskStatus(thread)}`)}</span></div>
        <button type="button" className="awAgentChip" style={headerPreset?.color?{['--c' as string]:headerPreset.color}:undefined} title={connection} disabled={thread.pending||!!task.deletedAt} onClick={()=>setModal('connection')}>{headerPreset?<i className="presetDot" aria-hidden="true"/>:<AgentIcon runtime={task.runtime} size={13}/>}<b>{task.agentName??(isClaude?'Claude':isCodex?'Codex':'Hermes')}</b><span>{(isCloud?taskModel:thread.actualModelId||task.binding?.name)||t('aw.noConnection')}</span>{run&&!isCloud&&<i className={`kLed is-${run.info.state}`} aria-hidden="true"/>}{task.binding&&<small>{t('aw.pinned')}</small>}</button></>}</div>
      <div className="awHeaderActions">
        {task&&!showStarter&&<button type="button" className="kIconBtn" title={t('connections.transfer')} aria-label={t('connections.transfer')} disabled={thread.pending||!!task.deletedAt||!thread.entries.length} onClick={()=>setModal('transfer')}><Send size={16}/></button>}
        <button type="button" className="kIconBtn" title={t('connections.board')} aria-label={t('connections.board')} disabled={!project} onClick={()=>setModal('board')}><KanbanSquare size={16}/></button>
        <nav className="awSegment" aria-label={t('aw.projectSections')}>{([{id:'files',Icon:Files},{id:'memory',Icon:BookOpen},{id:'skills',Icon:Sparkles},{id:'results',Icon:PanelRight}] as const).map(({id,Icon})=><button type="button" key={id} disabled={!project} aria-pressed={inspector===id} title={t(`aw.${id}`)} onClick={()=>inspect(id)}><Icon size={15}/><span>{t(`aw.${id}`)}</span></button>)}</nav>
        {project&&!showStarter&&<Button className="primary awNewTaskBtn" onClick={newTask}><Plus size={15}/><span>{t('aw.newTask')}</span></Button>}
      </div>
    </header>
    {(localError || ws.saveError) && <div className="awBanner" role="alert"><span>{localError || t(`aw.error.${ws.saveError}`)}</span>{ws.saveError && <Button onClick={() => void flushWorkspace()}>{t('aw.retry')}</Button>}{localError && <button className="kIconBtn" aria-label={t('aw.close')} onClick={()=>setLocalError('')}><X size={14}/></button>}</div>}
      <div className="awChat">{showStarter&&project?<TaskStarter key={project.id} project={project} onCancel={task?()=>setStarter(false):undefined} onCreated={id=>{autoSend.current=id;setStarter(false);}}/>:!project?<WorkspaceWelcome onOpen={()=>void openFolder()}/>:<><div ref={scroll} className="awTranscript" role="log" aria-label={t('chat.messages')} aria-live="off" onScroll={e=>{const el=e.currentTarget;nearBottom.current=el.scrollHeight-el.scrollTop-el.clientHeight<100;setAtBottom(nearBottom.current);}}>
        {task && !thread.entries.length && <div className="awWelcome"><MessageSquareIcon/><h2>{task.title}</h2><p>{t('aw.emptyTask')}</p><div className="awSuggestions">{['review','fix','document'].map(v=><button key={v} onClick={()=>{useAgentStore.getState().update(task.id,s=>({...s,draft:t(`aw.example.${v}`)}));textarea.current?.focus();}}>{t(`aw.example.${v}`)}</button>)}</div></div>}
        <div className="awTranscriptInner">{thread.entries.map(entry=><WorkspaceMessage key={entry.id} entry={entry} assistantName={task?.agentName||(isClaude?'Claude':isCodex?'Codex':undefined)} onMemory={()=>addFromMessage(entry.id,entry.text)} onCopied={ok=>notify(ok?'success':'error',t(ok?'chat.copied':'chat.copyFailed'))}/>)}
          {task && thread.requests.map(question=><WorkspaceRequest key={question.id} question={question} taskId={task.id}/>)}
          {!!thread.children?.length&&<div className="awAgentChildren" aria-label={t('connections.subagents')}>{thread.children.map(child=><details key={child.id}><summary><Bot size={14}/><b>{child.name}</b><span>{t(`connections.child.${['running','completed','failed','stopped'].includes(child.status)?child.status:'unknown'}`)}</span></summary><p>{child.activity}</p></details>)}</div>}
          {thread.pending && <p className="awProgress" role="status"><ActivityOrb state={activityState(thread)}/>{t(!isCloud&&task?.autoStartServer&&thread.starting&&run&&!['ready','busy'].includes(run.info.state)?'presets.serverStarting':isCloud?thread.starting?'openai.starting':'openai.running':thread.starting?'agent.starting':'agent.running')}</p>}
          {thread.error && <p className="awError" role="alert">{t(isCloud?'openai.agentError':`agent.errors.${thread.error}`)}</p>}
          {thread.stopped && <p className="awNotice">{t('chat.stopped')}</p>}
          {repeatedFailures(thread.entries) && <div className="awBanner"><span>{t('aw.repeatedFailures')}</span>{thread.pending && task && <Button onClick={()=>void interruptAgent(task.id)}>{t('aw.stopTask')}</Button>}</div>}
        </div>
      </div>
      {!atBottom && <button className="awLatest" onClick={()=>{nearBottom.current=true;setAtBottom(true);scroll.current?.scrollTo({top:scroll.current.scrollHeight,behavior:'instant'});}}><ArrowDown size={14}/>{t(thread.requests.length?'aw.goQuestion':'aw.latest')}</button>}
      {task?.deletedAt&&<div className="awDeletedBanner"><Trash2 size={17}/><span>{t('aw.deletedTaskHint')}</span><Button onClick={()=>restoreTask(task.id)}>{t('aw.restoreTask')}</Button></div>}
      {task && !task.deletedAt && <AgentComposer key={task.id} task={task} thread={thread} ready={ready} saveError={!!ws.saveError} inputRef={textarea} modelLabel={(isCloud?taskModel:task.binding?.name)||t('aw.composer.chooseModel')} onSend={send} onStop={()=>void interruptAgent(task.id)} onPrepare={prepareInput} onNewSession={()=>askSession()} onConnection={()=>setModal('connection')} notice={reason && <div className="awComposerReason"><span>{reason}</span>{(thread.ended || !!task.binding&&!sameGeneration) && !thread.pending && !task.archived && (isCloud||runs.some(r=>['ready','busy'].includes(r.info.state)&&r.info.contextTokens>=64000)) && <Button type="button" onClick={()=>askSession()}>{t('aw.newSession')}</Button>}{!isCloud&&(!run || ['stopped','crashed'].includes(run.info.state))&&!thread.pending&&!task.archived&&<Button type="button" onClick={launchTaskModel}>{t(taskProfile?'aw.launchTaskModel':'desk.server.new')}</Button>}{!isCloud&&run && run.info.contextTokens<64000 && <Button type="button" onClick={()=>setView('configuration')}>{t('nav.configuration')}</Button>}</div>}/>}
      </>}</div>
      </div>
      {inspector && <WorkspaceInspector tab={inspector} onClose={()=>setInspector(undefined)} project={project} entries={thread.entries} memory={projectMemory} appliedIds={(thread.appliedMemory??[]).filter(s=>projectMemory.some(m=>m.id===s.id&&m.updatedAt===s.updatedAt)).map(m=>m.id)} onMemory={record=>setMemoryEdit({record})} onDelete={deleteMemory} onPreview={(title,text,diff)=>setPreview({title,text,diff})}/>}
    </div>
    {modal==='board'&&<AgentTaskBoard onClose={()=>setModal(undefined)}/>}
    {modal==='transfer'&&task&&<AgentTransfer task={task} onClose={()=>setModal(undefined)}/>}
    <ConfirmDialog open={!!projectToRemove} title={t('aw.deleteProject')} text={projectToRemove?t('aw.projectDeleteConfirm',{name:projectToRemove.project.name,tasks:projectToRemove.tasks,memory:projectToRemove.memory}):''} confirmLabel={t('aw.deleteProject')} dangerous busy={busy} onCancel={()=>setProjectToRemove(undefined)} onConfirm={async()=>{
      if(!projectToRemove||busy)return;
      setBusy(true);
      try{await removeProject(projectToRemove.project.id);setProjectToRemove(undefined);setModal(undefined);setInspector(undefined);setMobileTasks(false);setActionError('');}
      catch(error){throw new Error(t(String(error).includes('project-busy')?'aw.projectDeleteBusy':'aw.projectDeleteFailed'));}
      finally{setBusy(false);}
    }}/>
    {modal==='project'&&project&&<WorkspaceDialog title={t('aw.projectSettings')} onClose={()=>{if(!busy)setModal(undefined);}}>
      <form onSubmit={event=>{event.preventDefault();void saveProject();}}>
        <label>{t('aw.projectName')}<input autoFocus value={name} maxLength={120} disabled={busy} onChange={event=>setName(event.target.value)}/></label>
        <label>{t('aw.projectFolder')}<input value={projectPath} disabled={busy||projectBusy} onChange={event=>{setProjectPath(event.target.value);setActionError('');}} spellCheck={false}/></label>
        <Button type="button" disabled={busy||projectBusy} onClick={()=>{void chooseProjectFolder();}}><FolderOpen size={15}/>{t('aw.chooseProjectFolder')}</Button>
        <p className="awMuted">{t('aw.projectFolderHelp')}</p>
        <ProjectKnowledge projectId={project.id} disabled={busy}/>
        {projectBusy&&<p className="awMuted">{t('aw.projectDeleteBusy')}</p>}
        <div className="awDialogActions">
          <Button type="button" className="awDangerButton awProjectRemove" disabled={busy||projectBusy} title={projectBusy?t('aw.projectDeleteBusy'):undefined} onClick={()=>setProjectToRemove({project:{...project},tasks:ws.tasks.filter(task=>task.projectId===project.id).length,memory:ws.memory.filter(record=>record.projectId===project.id).length})}><Trash2 size={15}/>{t('aw.deleteProject')}</Button>
          <Button type="button" disabled={busy||!name.trim()||!projectPath.trim()} onClick={()=>{void saveProject(true);}}><FolderOpen size={15}/>{t('aw.reveal')}</Button>
          <Button type="button" disabled={busy} onClick={()=>setModal(undefined)}>{t('aw.cancel')}</Button>
          <Button type="submit" className="primary" disabled={busy||!name.trim()||!projectPath.trim()}>{t('aw.save')}</Button>
        </div>
        {actionError&&<p className="awError" role="alert">{actionError}</p>}
      </form>
    </WorkspaceDialog>}
    {modal==='trash'&&<WorkspaceDialog title={t('aw.trashTask')} onClose={()=>{if(!busy)setModal(undefined);}}><p>{t('aw.trashConfirm',{name:ws.tasks.find(x=>x.id===deleteId)?.title})}</p><p className="awMuted">{t('aw.trashExplanation')}</p>{threads[deleteId]?.id&&<p className="awNotice">{t('aw.trashRunning')}</p>}{actionError&&<p className="awError" role="alert">{actionError}</p>}<div className="awDialogActions"><Button disabled={busy} onClick={()=>setModal(undefined)}>{t('aw.cancel')}</Button><Button className="awDangerButton" disabled={busy} onClick={()=>void removeTask()}><Trash2 size={15}/>{t('aw.trashTask')}</Button></div></WorkspaceDialog>}
    {(modal==='new'||modal==='rename') && <WorkspaceDialog title={t(modal==='new'?'aw.newTask':'aw.rename')} onClose={()=>setModal(undefined)}><form onSubmit={e=>{e.preventDefault();if(!name.trim())return;if(modal==='new'&&project){const id=createTask(project.id,name,newRuntime==='hermes'&&fallback?bindRun(fallback.info,fallback.config?.profileName):undefined);editTask(id,{runtime:newRuntime,cloudModel:newRuntime!=='hermes'?(newCodexModel||newSelection.models[0]?.model):undefined,connectionId:newRuntime==='hermes'?undefined:newSelection.status.connectionId,connectionProfileId:newRuntime==='hermes'?undefined:newSelection.profile?.id,presetId:newPresetId||undefined,accessMode:newPreset?.accessMode??'manual',agentName:newPreset?.name,instructions:newInstructions,autoStartServer:newPreset?.autoStartServer,binding:newRuntime==='hermes'?(newPreset?.binding??(fallback?bindRun(fallback.info,fallback.config?.profileName):undefined)):undefined});}else editTask(renameId,{title:name});setModal(undefined);setMobileTasks(false);}}>{modal==='new'&&<><ChoiceSelect label={t('presets.assignment')} value={newPresetId} options={[{value:'',label:t('presets.custom')},...ws.presets.map(p=>({value:p.id,label:p.name}))]} onChange={id=>{setNewPresetId(id);const p=ws.presets.find(p=>p.id===id);if(p){setNewRuntime(p.runtime);setNewProfileId(p.connectionProfileId??'');setNewCodexModel(p.model??'');setNewInstructions(p.instructions);}else setNewInstructions('');}}/><Button type="button" onClick={openAgentPresets}>{t('presets.manage')}</Button><ChoiceSelect label={t('aw.composer.agent')} value={newRuntime} options={agentOptions()} onChange={v=>{setNewRuntime(v as 'hermes'|'codex'|'claude');setNewPresetId('');setNewProfileId('');setNewCodexModel(modelsFor(v)[0]?.model??'');}}/>{newRuntime!=='hermes'&&<><CloudProfileSelect provider={newRuntime==='claude'?'claude':'openai'} profileId={newProfileId} onChange={id=>{setNewProfileId(id);setNewPresetId('');setNewCodexModel(modelsFor(newRuntime,id)[0]?.model??'');}}/><ChoiceSelect variant="model" label={t('openai.model')} value={newCodexModel} options={newSelection.models.map(m=>({value:m.model,label:m.displayName,description:m.model,keywords:m.defaultReasoningEffort}))} onChange={setNewCodexModel}/><Button type="button" onClick={()=>openSettingsSection('connections')}>{t('openai.connections')}</Button></>}<label>{t('presets.instructions')}<textarea rows={3} maxLength={16000} value={newInstructions} onChange={e=>setNewInstructions(e.target.value)}/></label></>}<label>{t('aw.taskName')}<input autoFocus value={name} maxLength={120} onChange={e=>setName(e.target.value)}/></label><div className="awDialogActions"><Button type="button" onClick={()=>setModal(undefined)}>{t('aw.cancel')}</Button><Button className="primary" type="submit" disabled={!name.trim()}>{t(modal==='new'?'aw.create':'aw.save')}</Button></div></form></WorkspaceDialog>}
    {modal==='resume'&&<WorkspaceDialog title={t('aw.newSession')} onClose={()=>{if(!busy)setModal(undefined);}}><p>{t('aw.resumeExplanation')}</p>{!isCloud&&!runs.some(r=>['ready','busy'].includes(r.info.state)&&r.info.contextTokens>=64000)&&<div className="awNotice"><p>{t('aw.startModelFirst')}</p><Button type="button" onClick={launchTaskModel}>{t(taskProfile?'aw.launchTaskModel':'desk.server.new')}</Button></div>}{!isCloud&&<ChoiceSelect label={t('aw.modelServer')} value={newBinding?.runId??''} options={runs.filter(r=>['ready','busy'].includes(r.info.state)&&r.info.contextTokens>=64000).map(r=>({value:r.info.runId,label:r.info.name}))} onChange={id=>{const r=runs.find(r=>r.info.runId===id);if(r)setNewBinding(bindRun(r.info,r.config?.profileName));}}/>}<label>{t('aw.handoff')}<textarea rows={9} value={handoff} maxLength={16000} onChange={e=>setHandoff(e.target.value)}/></label><p className="awMuted">{t('aw.memoryNextSession')}</p><div className="awDialogActions"><Button disabled={busy} onClick={()=>setModal(undefined)}>{t('aw.keepSession')}</Button><Button disabled={busy||(!isCloud&&(!newBinding||!runs.some(r=>r.info.runId===newBinding!.runId&&['ready','busy'].includes(r.info.state)&&r.info.contextTokens>=64000)))} className="primary" onClick={()=>void resume()}>{t('aw.startSession')}</Button></div></WorkspaceDialog>}
    {modal==='connection'&&<WorkspaceDialog title={t('aw.composer.modelPicker')} onClose={()=>setModal(undefined)}><div className="awConnectionPicker"><ChoiceSelect label={t('presets.assignment')} value={task?.presetId??''} disabled={thread.pending||!!thread.id||!!thread.entries.length} options={[{value:'',label:t('presets.custom')},...ws.presets.map(p=>({value:p.id,label:p.name}))]} onChange={id=>{if(task)assignAgentPreset(task.id,id);}}/><Button type="button" onClick={openAgentPresets}>{t('presets.manage')}</Button>
      <ChoiceSelect label={t('aw.composer.agent')} value={task?.runtime??'hermes'} disabled={thread.pending||!!thread.id||!!thread.entries.length} options={agentOptions()} onChange={value=>{if(task)editTask(task.id,{runtime:value as 'hermes'|'codex'|'claude',cloudModel:modelsFor(value)[0]?.model,connectionId:value==='hermes'?undefined:cloudSelection(cloud,value==='claude'?'claude':'openai').status.connectionId,connectionProfileId:value==='hermes'?undefined:cloudSelection(cloud,value==='claude'?'claude':'openai').profile?.id});}}/>
      {(thread.id||thread.entries.length>0)&&<p className="awMuted">{t('openai.agentPinned')}</p>}
      {isCloud?<><CloudProfileSelect provider={isClaude?'claude':'openai'} profileId={task?.connectionProfileId} connectionId={task?.connectionId} disabled={thread.pending||!!thread.id||!!thread.entries.length} onChange={id=>{if(task){const selected=cloudSelection(cloud,isClaude?'claude':'openai',undefined,id);editTask(task.id,{connectionProfileId:id,connectionId:selected.status.connectionId,cloudModel:selected.models[0]?.model});}}}/><ChoiceSelect variant="model" label={t('openai.model')} value={taskModel??''} disabled={thread.pending||!!thread.id||!!thread.entries.length} options={selection.models.map(m=>({value:m.model,label:m.displayName,description:m.model,keywords:m.defaultReasoningEffort}))} onChange={model=>{if(task)editTask(task.id,{cloudModel:model,connectionId:cloudStatus.connectionId});}}/><Button onClick={()=>openSettingsSection('connections')}>{t('openai.connections')}</Button></>:<><ChoiceSelect label={t('aw.modelServer')} disabled={thread.pending||task?.archived} value={task?.binding?.runId??''} options={runs.map((item,index)=>({value:item.info.runId,label:`${t('k.serverNumber',{number:index+1})} · ${item.info.name}`}))} onChange={chooseRun}/><Button onClick={launchTaskModel}><Plus size={15}/>{t('desk.server.new')}</Button></>}
    </div></WorkspaceDialog>}
    {modal==='agent'&&<WorkspaceDialog title={t('agent.title')} onClose={()=>setModal(undefined)}><p>{t('aw.toolsList')}</p><p>{t('agent.scope')}</p><p className="awMuted">{t('agent.toolsDescription')}</p><Button onClick={()=>{setModal(undefined);inspect('skills');}}>{t('aw.skills')}</Button></WorkspaceDialog>}
    {modal==='profile'&&<WorkspaceDialog title={t('aw.profile')} onClose={()=>setModal(undefined)}><p>{task?.binding?.profileName || t('aw.noProfile')}</p><p>{t('aw.profileExplanation')}</p>{taskProfile?<Button onClick={()=>{void useControlStore.getState().selectProfile(taskProfile.id).then(()=>{setModal(undefined);setView('configuration');}).catch(e=>setLocalError(String(e)));}}>{t('nav.configuration')}</Button>:<><p className="awNotice">{t('aw.savedProfileUnavailable')}</p><Button onClick={launchTaskModel}>{t('desk.server.new')}</Button></>}</WorkspaceDialog>}
    {memoryEdit&&project&&<MemoryEditor projectId={project.id} record={memoryEdit.record} onSave={saveMemory} onClose={()=>setMemoryEdit(undefined)}/>}
    {preview&&<WorkspaceDialog title={preview.title} wide onClose={()=>setPreview(undefined)}>{preview.diff&&<p className="awMuted">{t('aw.recordedDiff')}</p>}<pre className={preview.diff?'awDiff':'awFilePreview'}>{preview.text}</pre></WorkspaceDialog>}
  </section>;
}
function MessageSquareIcon(){return <Bot size={28}/>;}
