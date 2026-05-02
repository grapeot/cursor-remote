import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export interface MarkdownContentProps {
  markdown: string;
}

export function MarkdownContent({ markdown }: MarkdownContentProps) {
  const trimmed = markdown.trim();
  if (trimmed.length === 0) {
    return <div className="markdown-body markdown-body--empty" aria-hidden />;
  }
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </div>
  );
}
