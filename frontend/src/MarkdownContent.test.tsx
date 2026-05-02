// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MarkdownContent } from './MarkdownContent';

beforeEach(() => {
  cleanup();
});

afterEach(() => {
  cleanup();
});

describe('MarkdownContent', () => {
  it('renders Markdown emphasis as a strong element', () => {
    render(<MarkdownContent markdown="Say **bold** phrase." />);
    expect(screen.getByRole('paragraph')).toBeTruthy();
    expect(document.querySelector('.markdown-body strong')?.textContent).toBe('bold');
  });

  it('renders ATX headings', () => {
    render(<MarkdownContent markdown="### Title line" />);
    expect(screen.getByRole('heading', { level: 3, name: 'Title line' })).toBeTruthy();
  });

  it('renders an empty chrome when markdown is whitespace only', () => {
    const { container } = render(<MarkdownContent markdown={'  \n  '} />);
    expect(container.querySelector('.markdown-body--empty')).toBeTruthy();
    expect(screen.queryByRole('paragraph')).toBeNull();
  });

  it('supports GFM tables', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 |';
    render(<MarkdownContent markdown={md} />);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'a' })).toBeTruthy();
  });
});
