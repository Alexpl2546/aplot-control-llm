import { FileText, Folder } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { KnowledgeLinkedNote, KnowledgeVaultStatus } from '../../services/knowledge';

interface FolderContents {
  folders: Map<string, FolderContents>;
  notes: KnowledgeLinkedNote[];
}

function makeFolder(): FolderContents {
  return { folders: new Map(), notes: [] };
}

function makeTree(notes: KnowledgeLinkedNote[]) {
  const roots = new Map<string, FolderContents>();
  for (const note of notes) {
    let folder = roots.get(note.vaultId) ?? makeFolder();
    roots.set(note.vaultId, folder);
    for (const part of note.path.split('/').slice(0, -1)) {
      const child = folder.folders.get(part) ?? makeFolder();
      folder.folders.set(part, child);
      folder = child;
    }
    folder.notes.push(note);
  }
  return roots;
}

interface TreeProps {
  selected?: Pick<KnowledgeLinkedNote, 'vaultId' | 'path'>;
  onSelect: (note: KnowledgeLinkedNote) => void;
}

function Contents({ data, selected, onSelect }: TreeProps & { data: FolderContents }) {
  return <ul className="knTreeList">
    {[...data.folders].map(([name, contents]) => <TreeFolder key={name} name={name} data={contents} selected={selected} onSelect={onSelect}/>)}
    {data.notes.map(note => {
      const current = selected?.vaultId === note.vaultId && selected.path === note.path;
      return <li key={note.path}><button type="button" aria-current={current || undefined} title={note.path} onClick={() => onSelect(note)}>
        <FileText size={14} aria-hidden="true"/><span>{note.title}</span>
      </button></li>;
    })}
  </ul>;
}

function TreeFolder({ name, data, selected, onSelect, initiallyOpen = false }: TreeProps & {
  name: string; data: FolderContents; initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return <li><details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary title={name}><Folder size={14} aria-hidden="true"/><span>{name}</span></summary>
    {open && <Contents data={data} selected={selected} onSelect={onSelect}/>}
  </details></li>;
}

export function KnowledgeTree({ vaults, notes, selected, onSelect }: TreeProps & {
  vaults: KnowledgeVaultStatus[]; notes: KnowledgeLinkedNote[];
}) {
  const roots = useMemo(() => makeTree(notes), [notes]);
  return <ul className="knTreeList knTreeRoots">{vaults.map(({ vault }) => {
    const root = roots.get(vault.id);
    return root && <TreeFolder key={vault.id} name={vault.name} data={root} initiallyOpen
      selected={selected} onSelect={onSelect}/>;
  })}</ul>;
}
