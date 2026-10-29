// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18n from '../src/lib/i18n';
import { KnowledgeView } from '../src/features/knowledge/KnowledgeView';
import { initializeWorkspace, useWorkspaceStore } from '../src/features/agent/workspace';
import { highlightParts, linkCandidates, queryTerms, wikiToMarkdown, NOTE_LINK } from '../src/features/knowledge/knowledgeModel';
import { knowledgeOpenObsidian, knowledgeRead, knowledgeSearch, knowledgeStatus, type KnowledgeNote, type KnowledgeStatus } from '../src/services/knowledge';

vi.mock('../src/services/knowledge', () => ({
  knowledgeStatus: vi.fn(), knowledgeSearch: vi.fn(), knowledgeRead: vi.fn(), knowledgeOpenObsidian: vi.fn(),
  knowledgeBind: vi.fn(), knowledgeUnbind: vi.fn(), knowledgeReindex: vi.fn(),
}));

const vault = { id: 'v1', name: 'Test vault', path: 'C:\\Temp\\Test vault', exclusions: [], addedAt: '' };
const status = (indexedAt: string): KnowledgeStatus => ({ available: true, vaults: [{ vault, documents: 2, chunks: 4, obsidian: true, state: 'ready', indexedAt, watching: true }] });
const note = (body: string): KnowledgeNote => ({
  vaultId: 'v1', vaultName: 'Test vault', path: 'Decisions/Поиск.md', absolutePath: 'C:\\Temp\\Test vault\\Decisions\\Поиск.md',
  obsidianUri: 'obsidian://open?path=C%3A%5CTemp%5CTest%20vault%5CDecisions%5C%D0%9F%D0%BE%D0%B8%D1%81%D0%BA.md',
  title: 'Решение по поиску', properties: { aplot_id: 'note-1', tags: ['search'] }, tags: ['search'], aliases: ['Search decision'],
  body, bodyLine: 5, outline: [], links: [], backlinks: [{ vaultId: 'v1', path: 'Overview.md', title: 'Overview' }], size: 100, modified: 0,
});

Object.defineProperty(window, 'matchMedia', { configurable: true, value: (media: string) => ({ matches: false, media, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }) });

beforeEach(async () => {
  await i18n.changeLanguage('ru');
  localStorage.clear();
  useWorkspaceStore.setState({ projects: [] });
  vi.mocked(knowledgeStatus).mockResolvedValue(status('2026-10-29T10:00:00Z'));
  vi.mocked(knowledgeSearch).mockResolvedValue([{ vaultId: 'v1', path: 'Decisions/Поиск.md', title: 'Решение по поиску', heading: 'Решение по поиску › Причины', line: 8, snippet: 'Триграммы находят решения по части слова.', matched: 'prefix', tags: ['search'] }]);
  vi.mocked(knowledgeRead).mockResolvedValue(note('# Решение по поиску\nСм. [[Overview|обзор]].\n'));
  vi.mocked(knowledgeOpenObsidian).mockResolvedValue();
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

describe('knowledge view', () => {
  it('finds a note by part of a word, shows it and opens it in Obsidian', async () => {
    render(<KnowledgeView/>);
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Поиск по заметкам' }), { target: { value: 'решен' } });
    const hit = await screen.findByRole('button', { name: /Решение по поиску/ });
    expect(knowledgeSearch).toHaveBeenLastCalledWith('решен', undefined);
    expect(within(hit).getAllByText('Решен', { selector: 'mark' }).length).toBeGreaterThan(0);
    expect(within(hit).getByText('решен', { selector: 'mark' })).toBeTruthy();
    fireEvent.click(hit);
    const article = await screen.findByRole('article', { name: 'Решение по поиску' });
    expect(knowledgeRead).toHaveBeenCalledWith('v1', 'Decisions/Поиск.md');
    const open = within(article).getByRole('link', { name: 'Открыть в Obsidian' });
    expect(open.getAttribute('href')).toMatch(/^obsidian:\/\/open\?path=C%3A%5C/);
    fireEvent.click(open);
    expect(knowledgeOpenObsidian).toHaveBeenCalledWith('v1', 'Decisions/Поиск.md');
    expect(within(article).getByText('#search')).toBeTruthy();
    expect(within(article).getByText('note-1')).toBeTruthy();
    expect(within(article).getByRole('button', { name: 'Overview' })).toBeTruthy();
  });

  it('follows wiki links inside the vault', async () => {
    render(<KnowledgeView/>);
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'поиск' } });
    fireEvent.click(await screen.findByRole('button', { name: /Решение по поиску/ }));
    const link = await screen.findByRole('link', { name: 'обзор' });
    vi.mocked(knowledgeRead).mockRejectedValueOnce(new Error('knowledge-missing'));
    fireEvent.click(link);
    await waitFor(() => expect(knowledgeRead).toHaveBeenCalledWith('v1', 'Overview.md'));
    expect(knowledgeRead).toHaveBeenCalledWith('v1', 'Decisions/Overview.md');
  });

  it('shows the edited note after the index picks up an external change', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<KnowledgeView/>);
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'поиск' } });
    fireEvent.click(await screen.findByRole('button', { name: /Решение по поиску/ }));
    await screen.findByText(/См\./);
    vi.mocked(knowledgeStatus).mockResolvedValue(status('2026-10-29T10:05:00Z'));
    vi.mocked(knowledgeRead).mockResolvedValue(note('# Решение по поиску\nВторая редакция из Obsidian.\n'));
    await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
    expect(await screen.findByText('Вторая редакция из Obsidian.')).toBeTruthy();
  });

  it('limits search to the vaults bound to a project', async () => {
    await initializeWorkspace();
    useWorkspaceStore.setState({ projects: [{ id: 'p1', name: 'Aplot', path: 'C:\\Temp\\Aplot', skills: '', createdAt: 1, knowledge: ['v1'] }] });
    render(<KnowledgeView/>);
    const scope = await screen.findByRole('combobox', { name: 'Где искать' });
    fireEvent.click(scope);
    fireEvent.click(await screen.findByRole('option', { name: /Aplot/ }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'search' } });
    await waitFor(() => expect(knowledgeSearch).toHaveBeenLastCalledWith('search', ['v1']));
  });

  it('offers to connect a folder when nothing is bound', async () => {
    vi.mocked(knowledgeStatus).mockResolvedValue({ available: true, vaults: [] });
    render(<KnowledgeView/>);
    // The welcome screen explains the three steps, as in the agent workspace, with one connect button.
    expect(await screen.findByText('Подключите папку')).toBeTruthy();
    expect(screen.getByText('Привяжите к проекту')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Подключить папку' })).toHaveLength(1);
  });
});

describe('knowledge model', () => {
  it('turns wiki links into in-app links outside code only', () => {
    const md = wikiToMarkdown('See [[Plan#Risks|risks]] and ![[img.png]]\n`[[raw]]`\n```\n[[code]]\n```');
    expect(md).toContain(`[risks](${NOTE_LINK}${encodeURIComponent('Plan#Risks')})`);
    expect(md).toContain('`img.png`');
    expect(md).toContain('`[[raw]]`');
    expect(md).toContain('\n[[code]]\n');
  });

  it('highlights words with ё folded to е', () => {
    expect(highlightParts('Ёлка и ель', 'елка').filter(p => p.match).map(p => p.text)).toEqual(['Ёлка']);
    expect(queryTerms('  knowledge_bind, "Поиск"  ')).toEqual(['knowledge_bind', 'поиск']);
  });

  it('resolves link targets relative to the note and the vault root', () => {
    expect(linkCandidates('Overview', 'Projects/Aplot/Plan.md')).toEqual(['Overview.md', 'Projects/Aplot/Overview.md']);
    expect(linkCandidates('../Shared/Glossary.md#x', 'Projects/Plan.md')).toEqual(['../Shared/Glossary.md', 'Shared/Glossary.md']);
  });
});
