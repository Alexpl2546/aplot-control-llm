// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RichContent } from '../src/features/chat/RichContent';
import type { ContentBlock } from '../src/features/chat/content';

const version = 1 as const;

describe('RichContent renderer', () => {
  it('renders clickable HTTP citations and leaves script URLs inert', () => {
    const blocks: ContentBlock[] = [
      { version, id: 'web', type: 'citation', source: 'web', title: 'Helpful source', url: 'https://example.com/article' },
      { version, id: 'unsafe', type: 'citation', source: 'web', title: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)' },
    ];
    const { container } = render(<RichContent blocks={blocks} />);
    const link = screen.getByRole('link', { name: 'Helpful source' });
    expect(link.getAttribute('href')).toBe('https://example.com/article');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
  });

  it('shows tool state and opaque file references without executing calls or creating download links', () => {
    const blocks: ContentBlock[] = [
      { version, id: 'function', type: 'tool', tool: 'function', status: 'completed', label: 'Function request: send_email' },
      { version, id: 'file', type: 'artifact', kind: 'file', name: 'report.csv', reference: { type: 'openai_file', fileId: 'file-secret-id' } },
    ];
    const { container } = render(<RichContent blocks={blocks} />);
    expect(screen.getByText(/not executed by the chat view/)).toBeTruthy();
    expect(screen.getByText('Provider file reference: file-secret-id')).toBeTruthy();
    expect(container.querySelector('a')).toBeNull();
  });

  it('renders versioned tables and charts as text and SVG', () => {
    const blocks: ContentBlock[] = [
      { version, id: 'table', type: 'table', title: 'Summary', columns: ['Name', 'Count'], rows: [['A', '2']] },
      { version, id: 'chart', type: 'chart', title: 'Trend', series: [{ name: 'Count', points: [{ x: 'A', y: 2 }, { x: 'B', y: 4 }] }] },
    ];
    const { container } = render(<RichContent blocks={blocks} />);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Trend' })).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
  });

  it('falls back to an inert explanation for unknown or unsupported block versions', () => {
    const blocks = [{ version: 99, id: 'future', type: 'remote_widget', html: '<script>alert(1)</script>' }] as unknown as ContentBlock[];
    const { container } = render(<RichContent blocks={blocks} />);
    expect(screen.getByText('Unsupported response content version')).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
  });
});
