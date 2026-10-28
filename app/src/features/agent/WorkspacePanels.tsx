import { AgentIcon,agentName } from './AgentIdentity';
import { Archive, BookOpen as BookOpenIcon, ChevronLeft, Plus, File, Folder, FolderOpen, MoreHorizontal, Search, Sparkles, Trash2, RotateCcw, Settings2, ChevronRight, ExternalLink, Eye, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode, type MouseEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ChoiceSelect } from '../../components/ui/ChoiceSelect';
import { Button } from '../../components/ui/Primitives';
import { pickDirectory } from '../../services/dialog';
import { isTauri } from '../../services/tauri';
import { workspaceFiles, workspaceOpen, workspaceOpenDocument, workspaceRead, workspaceSkills } from '../../services/agentWorkspace';
import { useAgentStore, type AgentEntry } from './store';
import { flushWorkspace, restoreTask, selectProject, selectTask, taskStatus, useWorkspaceStore } from './workspace';
import { toolPath, type AgentProject, type ProjectMemory, type WorkspaceFile, type WorkspaceSkill } from './workspaceModel';

import { FileActionsMenu, FileMenuButton, type FileMenuTarget } from './FileActionsMenu';
import { projectFileActions } from './fileActions';
import { TaskActionsMenu, type TaskMenuTarget } from './TaskActionsMenu';

export type InspectorTab = 'results' | 'files' | 'memory' | 'skills';
export function WorkspaceDialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const { t } = useTranslation(); const dialog = useRef<HTMLDialogElement>(null);
  const [closing,setClosing]=useState(false);const closeTimer=useRef<ReturnType<typeof setTimeout>>(undefined);
  const requestClose=()=>{if(closing)return;if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){onClose();return;}setClosing(true);closeTimer.current=setTimeout(onClose,140);};
  useEffect(()=>()=>clearTimeout(closeTimer.current),[]);
  useEffect(() => { const el = dialog.current, focused = document.activeElement as HTMLElement | null; el?.showModal(); return () => { el?.close(); focused?.focus(); }; }, []);
  return <dialog className={`awDialog${wide ? ' isWide' : ''}${closing?' isClosing':''}`} ref={dialog} aria-label={title} onCancel={e => { if(e.target!==e.currentTarget)return;e.preventDefault(); requestClose(); }}><header><h3>{title}</h3><button className="kIconBtn" type="button" aria-label={t('aw.close')} onClick={requestClose}><X size={17}/></button></header>{children}</dialog>;
}
export function WorkspaceSidebar({ onOpen, onProject, onRename, onTrash, onClose, onNewTask, onSelect, mobile }: { onOpen: () => void; onProject: () => void; onRename: (id: string) => void; onTrash: (id:string)=>void; onClose: () => void; onNewTask?: () => void; onSelect?: () => void; mobile: boolean }) {
  const { t } = useTranslation();
  const { projects, tasks, presets, selectedProjectId, selectedTaskId } = useWorkspaceStore();
  const threads = useAgentStore(s => s.threads), [search,setSearch] = useState(''), [list,setList] = useState<'active'|'archive'|'trash'>('active');
  const [menu,setMenu]=useState<TaskMenuTarget>();
  const closeMenu=useCallback(()=>setMenu(undefined),[]);
  const project = projects.find(p => p.id === selectedProjectId);
  const selectedTask=tasks.find(task=>task.id===selectedTaskId);
  useEffect(()=>{if(selectedTask)setList(selectedTask.deletedAt?'trash':selectedTask.archived?'archive':'active');},[selectedTaskId,selectedTask?.deletedAt,selectedTask?.archived]);
  const filtered = tasks.filter(task => task.projectId === selectedProjectId && (list==='trash'?!!task.deletedAt:!task.deletedAt&&task.archived===(list==='archive')) && task.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())).sort((a,b)=>b.updatedAt-a.updatedAt);
  // Active tasks are grouped by what they need from the person: a decision, patience, or nothing.
  const groupOf=(id:string)=>{const status=taskStatus(threads[id]);return ['waiting','attention'].includes(status)?'needs':['running','recording'].includes(status)?'running':'rest';};
  const groups:[string,typeof filtered][]=list==='active'?([['needs',filtered.filter(task=>groupOf(task.id)==='needs')],['running',filtered.filter(task=>groupOf(task.id)==='running')],['rest',filtered.filter(task=>groupOf(task.id)==='rest')]] as [string,typeof filtered][]).filter(([,items])=>items.length):[['rest',filtered]];
  const counts={archive:tasks.filter(task=>task.projectId===selectedProjectId&&!task.deletedAt&&task.archived).length,trash:tasks.filter(task=>task.projectId===selectedProjectId&&!!task.deletedAt).length};
  const showMenu=(task:typeof tasks[number],event:MouseEvent|KeyboardEvent)=>{
    event.preventDefault();event.stopPropagation();
    const box=event.currentTarget.getBoundingClientRect();
    setMenu({task,x:'clientX' in event?event.clientX:box.right,y:'clientY' in event?event.clientY:box.bottom});
  };
  const row=(task:typeof tasks[number])=>{
    const status=task.deletedAt?'disconnected':taskStatus(threads[task.id]),color=presets.find(p=>p.id===task.presetId)?.color;
    return <div key={task.id} className={`awTask${task.id === selectedTaskId ? ' isOn' : ''}`} onContextMenu={e=>showMenu(task,e)} onKeyDown={e=>{if(e.key==='ContextMenu'||e.key==='F10'&&e.shiftKey)showMenu(task,e);}}>
      <button onClick={() => { selectTask(task.id); onSelect?.(); onClose(); }}>
        <span className="awTaskTop">{color?<i className="presetDot" style={{['--c' as string]:color}} aria-hidden="true"/>:<AgentIcon runtime={task.runtime} size={13}/>}<b className="awTaskName" title={task.title}>{task.title}</b>{task.unread && <span className="awUnread" aria-label={t('aw.unread')}/>}</span>
        <span className={`awTaskState is-${status}`}><i/><span className="awTaskWho" title={agentName(task.runtime)}>{task.agentName??agentName(task.runtime)}</span><span>· {t(task.deletedAt?'aw.inTrash':`aw.status.${status}`)}</span></span>
      </button>
      <button type="button" className="kIconBtn awTaskMenuTrigger" onClick={e=>{const rect=e.currentTarget.getBoundingClientRect();setMenu({task,x:rect.right,y:rect.bottom});}} aria-label={t('aw.taskMenuFor',{name:task.title})} title={t('aw.taskMenu')} aria-haspopup="menu" aria-expanded={menu?.task.id===task.id}><MoreHorizontal size={15}/></button>
    </div>;
  };
  return <aside className="awSidebar" role={mobile ? 'dialog' : undefined} aria-modal={mobile || undefined} aria-label={t('aw.projects')}>
    <div className="awSideHeading"><span>{t('aw.projects')}</span><button type="button" className="kIconBtn" onClick={onOpen} title={t('aw.addProject')} aria-label={t('aw.addProject')}><Folder size={15}/></button>{mobile && <button className="kIconBtn" onClick={onClose} aria-label={t('aw.close')}><X size={16}/></button>}</div>
    {projects.length?<div className="awProjectCard"><span className="awProjectIcon"><FolderOpen size={16}/></span><ChoiceSelect label={t('aw.project')} value={selectedProjectId} options={projects.map(p => ({ value:p.id,label:p.name,description:p.path }))} onChange={id => { selectProject(id); setList('active'); setSearch(''); }}/><button type="button" className="kIconBtn" disabled={!project} aria-label={t('aw.projectSettings')} title={t('aw.projectSettings')} onClick={onProject}><Settings2 size={15}/></button>{project&&<button type="button" className="awProjectPath" onClick={onProject} title={project.path}>{project.path}</button>}</div>
      :<Button className="awOpenFolder" onClick={onOpen}><FolderOpen size={15}/>{t('aw.addProject')}</Button>}
    {project&&onNewTask&&<Button className="primary awSideNew" onClick={onNewTask}><Plus size={15}/>{t('aw.newTask')}</Button>}
    {project&&<label className="awSearch"><Search size={14}/><input aria-label={t('aw.search')} placeholder={t('aw.search')} value={search} onChange={e => setSearch(e.target.value)}/></label>}
    <div className="awTaskList">
      {list!=='active'&&<div className="awTasksLabel"><span>{t(list==='trash'?'aw.trash':'aw.archive')}</span><span className="awCount">{filtered.length}</span><button type="button" className="awTextAction" onClick={()=>setList('active')}><ChevronLeft size={13}/>{t('aw.activeTasks')}</button></div>}
      {groups.map(([key,items])=><div key={key} className={`awTaskGroup is-${key}`}>{list==='active'&&(groups.length>1||key!=='rest')&&<div className="awTaskGroupLabel"><span>{t(`aw.group.${key}`)}</span><span className="awCount">{items.length}</span></div>}{items.map(row)}</div>)}
      {!filtered.length && project && <p className="awMuted awTaskEmpty">{t(search ? 'aw.noMatches' : list==='trash'?'aw.trashEmpty':list==='archive'?'aw.archiveEmpty':'aw.noTasks')}</p>}
    </div>
    {project&&<div className="awTaskCollections" role="group" aria-label={t('aw.collections')}><button className="awArchive" aria-pressed={list==='archive'} onClick={()=>setList(v=>v==='archive'?'active':'archive')}><Archive size={14}/>{t('aw.archive')}{counts.archive>0&&<span className="awCount">{counts.archive}</span>}</button><button className="awArchive" aria-pressed={list==='trash'} onClick={()=>setList(v=>v==='trash'?'active':'trash')}><Trash2 size={14}/>{t('aw.trash')}{counts.trash>0&&<span className="awCount">{counts.trash}</span>}</button></div>}
    <TaskActionsMenu target={menu} onClose={closeMenu} onRename={onRename} onTrash={onTrash} onRestore={id=>{restoreTask(id);selectTask(id);setList('active');}}/>
  </aside>;
}

export function MemoryEditor({ projectId, record, onSave, onClose }: { projectId: string; record?: ProjectMemory; onSave: (record: ProjectMemory) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [value,setValue] = useState(record?.text ?? ''), [category,setCategory] = useState(record?.category ?? 'fact'), [confirmed,setConfirmed] = useState(record?.confirmed ?? true);
  return <WorkspaceDialog title={t(record ? 'aw.editMemory' : 'aw.addMemory')} onClose={onClose}><form onSubmit={e => { e.preventDefault(); if (!value.trim()) return; onSave({ ...record,id:record?.id ?? crypto.randomUUID(),projectId,text:value,category,confirmed,updatedAt:Date.now() }); onClose(); }}>
    <label>{t('aw.category')}<ChoiceSelect label={t('aw.category')} value={category} onChange={v => setCategory(v as ProjectMemory['category'])} options={['requirement','decision','fact','result'].map(v => ({ value:v,label:t(`aw.category.${v}`) }))}/></label>
    <label>{t('aw.memoryText')}<textarea autoFocus rows={8} value={value} maxLength={12000} onChange={e => setValue(e.target.value)}/></label>
    <label className="awCheck"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>{t('aw.confirmMemory')}</label><p className="awMuted">{t('aw.memoryNextSession')}</p>
    <div className="awDialogActions"><Button type="button" onClick={onClose}>{t('aw.cancel')}</Button><Button className="primary" disabled={!value.trim()} type="submit">{t('aw.save')}</Button></div>
  </form></WorkspaceDialog>;
}

export function WorkspaceInspector({ tab, onClose, project, entries, memory, appliedIds, onMemory, onDelete, onPreview }: {
  tab: InspectorTab; onClose: () => void; project?: AgentProject; entries: AgentEntry[]; memory: ProjectMemory[]; appliedIds: string[]; onMemory: (record?: ProjectMemory) => void; onDelete: (id: string) => void; onPreview: (title: string,text: string,diff?: boolean) => void;
}) {
  const [fileMenu,setFileMenu]=useState<FileMenuTarget>();
  const closeFileMenu=useCallback(()=>setFileMenu(undefined),[]);
  const { t, i18n } = useTranslation(); const [directory,setDirectory] = useState(''), [files,setFiles] = useState<WorkspaceFile[]>([]), [skills,setSkills] = useState<WorkspaceSkill[]>([]), [error,setError] = useState(''), [loading,setLoading] = useState(false), [existingResults,setExistingResults] = useState<string[]>([]), [refresh,setRefresh]=useState(0);
  const resultSignature = entries.filter(e => e.kind === 'tool').map(e => `${e.id}:${e.status}:${toolPath(e.args,e.result)}`).join('|');
  useEffect(() => { setDirectory(''); }, [project?.id]);
  useEffect(() => {
    let current = true; setError(''); setLoading(true); setExistingResults([]);
    const load = async () => {
      try {
        await flushWorkspace();
        if (tab === 'files' || tab === 'results') { const rows = project ? await workspaceFiles(project.id, tab === 'files' ? directory : '') : []; if (current) setFiles(rows.sort((a,b) => Number(b.directory)-Number(a.directory) || a.name.localeCompare(b.name))); }
        if (tab === 'results' && project) {
          const candidates = [...new Set(entries.filter(e => e.kind === 'tool' && e.status === 'success' && ['write_file','patch','edit_file','apply_patch'].includes(e.name ?? '')).map(e => toolPath(e.args,e.result)).filter(Boolean))].slice(-100);
          const checks = await Promise.all(candidates.map(async path => { try { const rows=await workspaceFiles(project.id,path); return rows.length===1 && !rows[0].directory ? path : ''; } catch { return ''; } }));
          if (current) setExistingResults(checks.filter(Boolean));
        }
        if (tab === 'skills') { const rows = project?.skills ? await workspaceSkills(project.skills) : []; if (current) setSkills(rows); }
      } catch { if (current) setError(t('aw.ioError')); } finally { if (current) setLoading(false); }
    };
    void load(); return () => { current = false; };
  }, [project?.id,project?.skills,tab,directory,entries.length,resultSignature,t,refresh]);
  const read = async (path: string) => { if (!project) return; try { onPreview(path,await workspaceRead(project.id,path)); } catch { setError(t('aw.readError')); } };
  const reveal = async (path: string) => { if (!project) return; try { await workspaceOpen(project.id,path); } catch { setError(t('aw.ioError')); } };
  const openFile=async(path:string)=>{if(!project)return;try{await workspaceOpenDocument(project.id,path);}catch{setError(t('aw.file.openFailed'));}};
  const showFileMenu=(file:WorkspaceFile,event:MouseEvent|KeyboardEvent)=>{event.preventDefault();event.stopPropagation();const bounds=event.currentTarget.getBoundingClientRect();setFileMenu({file,x:'clientX' in event?event.clientX:bounds.right,y:'clientY' in event?event.clientY:bounds.bottom});};
  const known = entries.filter(e => e.kind === 'tool' && e.status === 'success' && toolPath(e.args,e.result));
  const writes = known.filter(e => ['write_file','patch','edit_file','apply_patch'].includes(e.name ?? '') && (tab !== 'results' || existingResults.includes(toolPath(e.args,e.result))));
  const sourceTask = (id?: string) => useWorkspaceStore.getState().tasks.find(task => task.id === id)?.title;
  const chooseSkills = async () => {
    if (!isTauri() || !project) { setError(t('aw.desktopOnly')); return; }
    try {
      const path = await pickDirectory();
      if (path) useWorkspaceStore.setState(s => ({ projects:s.projects.map(p => p.id === project.id ? {...p,skills:path} : p) }));
    } catch { setError(t('aw.ioError')); }
  };
  const filename=(path:string)=>path.split(/[\\/]/).filter(Boolean).at(-1)??path;
  const rows=[...new Map(writes.map(e=>[toolPath(e.args,e.result),e])).values()];
  const Icon=tab==='skills'?Sparkles:tab==='files'?FolderOpen:tab==='results'?File:BookOpenIcon;
  return <aside className="awInspector" aria-label={t(`aw.${tab}`)}><header><div><h3><Icon size={18}/>{t(`aw.${tab}`)}</h3><span className="awPanelScope">{tab==='results'?t('aw.currentTask'):project?.name}</span></div><button type="button" className="kIconBtn" aria-label={t('aw.close')} onClick={onClose}><X size={17}/></button></header>
    <div className="awInspectorBody">{error && <p role="alert" className="awError">{error}</p>}{loading && <p className="awMuted" role="status">{t('aw.loading')}</p>}
      {tab === 'results' && <><p className="awPanelIntro">{t('aw.resultsSummary')}</p>{!rows.length&&!loading&&<p className="awEmptyPanel">{t('aw.noResults')}</p>}{rows.map(e=><article className="awResultCard" key={e.id}><div className="awResultName"><File size={18}/><b>{filename(toolPath(e.args,e.result))}</b><span className="awTag">{t('aw.written')}</span></div><code className="awItemPath" title={toolPath(e.args,e.result)}>{toolPath(e.args,e.result)}</code><div className="awInlineActions">{projectFileActions(toolPath(e.args,e.result)).mode!=='reveal'&&<Button onClick={()=>void openFile(toolPath(e.args,e.result))}><ExternalLink size={14}/>{t('aw.file.open')}</Button>}{projectFileActions(toolPath(e.args,e.result)).canPreview&&<Button onClick={()=>void read(toolPath(e.args,e.result))}><Eye size={14}/>{t('aw.file.source')}</Button>}<Button onClick={()=>void reveal(toolPath(e.args,e.result))}><FolderOpen size={14}/>{t('aw.file.reveal')}</Button>{e.diff&&<Button onClick={()=>onPreview(filename(toolPath(e.args,e.result)),e.diff!,true)}>{t('aw.diff')}</Button>}</div></article>)}</>}
      {tab === 'files' && <><div className="awFileToolbar">{directory?<Button onClick={()=>setDirectory(directory.split(/[\\/]/).slice(0,-1).join('/'))}><ChevronLeft size={14}/>{t('aw.parentFolder')}</Button>:<span>{t('aw.projectRoot')}</span>}<button type="button" className="kIconBtn" aria-label={t('aw.refreshFiles')} title={t('aw.refreshFiles')} onClick={()=>setRefresh(v=>v+1)}><RotateCcw size={15}/></button></div><div className="awDirectoryPath" title={directory||project?.path}>{directory||project?.name}</div><div className="awFileList">{files.map(file=>{const policy=projectFileActions(file.path);return <div className="awFileEntry" key={file.path} onContextMenu={event=>showFileMenu(file,event)} onKeyDown={event=>{if(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey)showFileMenu(file,event);}}><button type="button" className="awFileRow" onClick={()=>file.directory?setDirectory(file.path):policy.mode==='reveal'?void reveal(file.path):void openFile(file.path)} title={t(file.directory?'aw.openDirectory':policy.browser?'aw.file.browser':policy.mode==='editor'?'aw.file.editor':policy.mode==='reveal'?'aw.file.reveal':'aw.file.defaultApp',{name:file.name})}>{file.directory?<Folder size={18}/>:<File size={18}/>}<span><b>{file.name}</b><small>{file.directory?t('aw.folder'):new Intl.NumberFormat(i18n.language,{maximumFractionDigits:1}).format(file.size/1024)+' KB'}</small></span><ChevronRight size={14}/></button><FileMenuButton name={file.name} onClick={event=>{const box=event.currentTarget.getBoundingClientRect();setFileMenu({file,x:box.right,y:box.bottom});}}/></div>;})}</div>{!files.length&&!loading&&<p className="awEmptyPanel">{t('aw.noFiles')}</p>}</>}
      {tab === 'memory' && <><div className="awPanelLead"><p className="awPanelIntro">{t('aw.memorySummary')}</p><Button disabled={!project} onClick={()=>onMemory()}>{t('aw.add')}</Button></div>{!memory.length&&<p className="awEmptyPanel">{t('aw.noMemory')}</p>}{memory.map(m=><article className="awMemoryItem" key={m.id}><div className="awTags"><span className="awTag">{t(`aw.category.${m.category}`)}</span><span className={`awTag${appliedIds.includes(m.id)?' isApplied':''}`}>{t(appliedIds.includes(m.id)?'aw.inSession':m.confirmed?'aw.confirmed':'aw.unconfirmed')}</span></div><p>{m.text}</p><small>{sourceTask(m.taskId)??t('aw.manualMemory')} · {new Date(m.updatedAt).toLocaleDateString(i18n.language)}</small><div className="awInlineActions"><Button onClick={()=>onMemory(m)}>{t('aw.edit')}</Button><Button onClick={()=>onDelete(m.id)}>{t('aw.delete')}</Button></div></article>)}</>}
      {tab === 'skills' && <><p className="awPanelIntro">{t('aw.skillsSummary')}</p><div className="awSkillFolder"><FolderOpen size={17}/><span title={project?.skills}>{project?.skills?filename(project.skills):t('aw.noSkillsFolder')}</span></div><div className="awInlineActions"><Button onClick={()=>void chooseSkills()}>{t('aw.chooseSkills')}</Button>{project?.skills&&<Button onClick={()=>useWorkspaceStore.setState(s=>({projects:s.projects.map(p=>p.id===project.id?{...p,skills:''}:p)}))}>{t('aw.clear')}</Button>}</div><div className="awSkillList">{skills.map(skill=><article className="awMemoryItem" key={skill.path}><h4><Sparkles size={16}/>{skill.name}</h4><p>{skill.description||t('aw.noDescription')}</p><code className="awItemPath" title={skill.path}>{skill.path}</code></article>)}</div>{!skills.length&&!loading&&<p className="awEmptyPanel">{t('aw.noSkills')}</p>}<details className="awPanelHelp"><summary>{t('aw.tools')}</summary><p>{t('aw.toolsList')}</p><p>{t('aw.skillsNote')}</p></details></>}
    </div>
    <FileActionsMenu target={fileMenu} onClose={closeFileMenu} onOpen={path=>void openFile(path)} onRead={path=>void read(path)} onReveal={path=>void reveal(path)}/>
  </aside>;
}
