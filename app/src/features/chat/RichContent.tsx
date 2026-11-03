import { useTranslation } from 'react-i18next';
import i18n from 'i18next';
import { normalizeContentBlock, type ContentBlock, type ChartBlock, type CitationBlock, type ToolBlock } from './content';
import './richContent.css';

const tr = (key: string, fallback: string) => i18n.isInitialized ? i18n.t(`chatRich.${key}`, { defaultValue: fallback }) : fallback;

const toolNames: Record<ToolBlock['tool'], string> = {
  web_search: 'Web search',
  file_search: 'File search',
  function: 'Function request',
  mcp: 'MCP tool',
  code_interpreter: 'Code interpreter',
  image_generation: 'Image generation',
  unknown: 'Response tool',
};

const statuses: Record<ToolBlock['status'], string> = {
  in_progress: 'In progress',
  completed: 'Completed',
  failed: 'Failed',
  incomplete: 'Interrupted',
};

function Citation({ block }: { block: CitationBlock }) {
  const label = block.source === 'web' ? tr('webSource', 'Web source') : tr('fileSource', 'File source');
  return <li className="chatRichCitation">
    <span className="chatRichKind">{label}</span>
    <div className="chatRichMain">
      {block.url
        ? <a href={block.url} target="_blank" rel="noopener noreferrer">{block.title}</a>
        : <span>{block.title}</span>}
      {block.excerpt && <small>{block.excerpt}</small>}
      {block.source === 'file' && block.fileId && <small>{tr('fileReference','File reference')}: {block.fileId}</small>}
    </div>
  </li>;
}

function Tool({ block }: { block: ToolBlock }) {
  return <article className={`chatRichCard chatRichTool is-${block.status}`} role={block.status === 'in_progress' ? 'status' : undefined}>
    <header><span className="chatRichKind">{tr(`tools.${block.tool}`, toolNames[block.tool])}</span><span className="chatRichStatus">{tr(`statuses.${block.status}`, statuses[block.status])}</span></header>
    <strong>{block.label}</strong>
    {block.query && <p className="chatRichQuery">{tr('query','Query')}: {block.query}</p>}
    {block.summary && <p>{block.summary}</p>}
    {block.tool === 'function' && <small>{tr('functionNotExecuted','This request is shown for context and was not executed by the chat view.')}</small>}
  </article>;
}

function Artifact({ block }: { block: Extract<ContentBlock, { type: 'artifact' }> }) {
  return <article className="chatRichCard chatRichArtifact">
    <span className="chatRichKind">{block.kind === 'image' ? tr('image', 'Image') : block.kind === 'code' ? tr('code', 'Code') : tr('file', 'File')}</span>
    <strong>{block.name}</strong>
    {block.reference.type === 'openai_file'
      ? <small>{tr('providerFileReference','Provider file reference')}: {block.reference.fileId}</small>
      : <small>{block.kind === 'image' ? tr('imageMissing', 'Image data is not included in this chat history.') : tr('fileMissing', 'No local file reference is available.')}</small>}
  </article>;
}

function Table({ block }: { block: Extract<ContentBlock, { type: 'table' }> }) {
  return <section className="chatRichCard chatRichTable">
    {block.title && <h4>{block.title}</h4>}
    <div className="chatRichTableScroll"><table>
      <thead><tr>{block.columns.map((column, i) => <th key={`${i}:${column}`}>{column}</th>)}</tr></thead>
      <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>
        {block.columns.map((_, columnIndex) => <td key={columnIndex}>{row[columnIndex] ?? ''}</td>)}
      </tr>)}</tbody>
    </table></div>
  </section>;
}

function Chart({ block }: { block: ChartBlock }) {
  const points = block.series.flatMap(series => series.points.map(point => point.y)).filter(Number.isFinite);
  if (!points.length) return <section className="chatRichCard chatRichChart">{block.title && <h4>{block.title}</h4>}<p>{tr('noChartData','No chart data was returned.')}</p></section>;
  const magnitude = Math.max(...points.map(Math.abs)) || 1;
  const minimum = Math.min(0, ...points.map(value => value / magnitude)), maximum = Math.max(0, ...points.map(value => value / magnitude)), span = maximum - minimum || 1;
  const maxPointCount = Math.max(1, ...block.series.map(series => series.points.length));
  const chartY = (value: number) => 188 - ((value / magnitude - minimum) / span) * 150;
  const xAt = (position: number) => 42 + (position / Math.max(1, maxPointCount - 1)) * 554;
  const zeroY = chartY(0);
  return <section className="chatRichCard chatRichChart">
    {block.title && <h4>{block.title}</h4>}
    <div className="chatRichChartScroll">
      <svg viewBox="0 0 620 230" role="img" aria-label={block.title ?? tr('chart', 'Chart')}>
        <line x1="42" x2="596" y1={zeroY} y2={zeroY} className="chatRichChartAxis" />
        {block.series.map((series, seriesIndex) => {
          const path = series.points.map((point, position) => `${position ? 'L' : 'M'} ${xAt(position)} ${chartY(point.y)}`).join(' ');
          return <g key={`${seriesIndex}:${series.name}`} className="chatRichChartSeries">
            {series.points.length > 1 && <path d={path} fill="none" />}
            {series.points.map((point, position) => <circle key={`${position}:${point.x}`} cx={xAt(position)} cy={chartY(point.y)} r="3.5">
              <title>{`${series.name} · ${point.x}: ${point.y}`}</title>
            </circle>)}
          </g>;
        })}
        {block.series[0]?.points.map((point, position) => <text key={`${position}:${point.x}`} x={xAt(position)} y="214" textAnchor="middle">{String(point.x).slice(0, 12)}</text>)}
      </svg>
    </div>
    <ul className="chatRichLegend">{block.series.map((series, i) => <li key={`${i}:${series.name}`}><span className="chatRichLegendSwatch" />{series.name}</li>)}</ul>
  </section>;
}

function RichBlock({ block }: { block: ContentBlock }) {
  if (block.type === 'citation') return <Citation block={block} />;
  if (block.type === 'tool') return <Tool block={block} />;
  if (block.type === 'artifact') return <Artifact block={block} />;
  if (block.type === 'table') return <Table block={block} />;
  if (block.type === 'chart') return <Chart block={block} />;
  return <article className="chatRichCard chatRichUnknown"><span className="chatRichKind">{tr('unsupported','Unsupported response content')}</span><strong>{block.label}</strong><small>{tr('type','Type')}: {block.sourceType}</small>{block.summary && <p>{block.summary}</p>}</article>;
}

/** Renders structured response data as inert React text and allowlisted links. */
export function RichContent({ blocks }: { blocks?: readonly ContentBlock[] }) {
  useTranslation();
  if (!blocks?.length) return null;
  const safe = blocks.map((block, index) => normalizeContentBlock(block, `block-${index}`)).filter((block): block is ContentBlock => !!block);
  if (!safe.length) return null;
  const citations = safe.filter((block): block is CitationBlock => block.type === 'citation');
  const others = safe.filter(block => block.type !== 'citation');
  return <div className="chatRichContent" aria-label={tr('content','Structured response content')}>
    {!!citations.length && <section className="chatRichSources"><h4>{tr('sources','Sources')}</h4><ul>{citations.map(block => <Citation key={block.id} block={block} />)}</ul></section>}
    {others.map(block => <RichBlock key={block.id} block={block} />)}
  </div>;
}
