"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

const components: Components = {
  table: ({ children }) => (
    <div className="overflow-x-auto my-3">
      <table className="w-full text-sm border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="border-b border-line-2 bg-surface-1">{children}</thead>
  ),
  tbody: ({ children }) => <tbody className="divide-y divide-line-1">{children}</tbody>,
  tr: ({ children }) => (
    <tr className="hover:bg-surface-3 transition-colors">{children}</tr>
  ),
  th: ({ children }) => (
    <th className="px-3 py-2 text-left text-xs font-semibold text-ink-2 uppercase tracking-wider">{children}</th>
  ),
  td: ({ children }) => (
    <td className="px-3 py-2 text-sm text-ink-2">{children}</td>
  ),
  h1: ({ children }) => <h1 className="text-xl font-semibold text-ink-1 mt-4 mb-2">{children}</h1>,
  h2: ({ children }) => <h2 className="text-lg font-semibold text-ink-1 mt-4 mb-2">{children}</h2>,
  h3: ({ children }) => <h3 className="text-base font-medium text-ink-1 mt-3 mb-1">{children}</h3>,
  h4: ({ children }) => <h4 className="text-sm font-medium text-ink-1 mt-2 mb-1">{children}</h4>,
  p: ({ children }) => <p className="text-sm text-ink-2 leading-relaxed my-1.5">{children}</p>,
  ul: ({ children }) => <ul className="list-disc list-inside space-y-0.5 my-2 text-sm text-ink-2">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal list-inside space-y-0.5 my-2 text-sm text-ink-2">{children}</ol>,
  li: ({ children }) => <li className="text-sm text-ink-2">{children}</li>,
  strong: ({ children }) => <strong className="text-ink-1 font-semibold">{children}</strong>,
  em: ({ children }) => <em className="text-ink-2 italic">{children}</em>,
  a: ({ href, children }) => (
    <a href={href} className="text-blue-400 hover:text-blue-300 underline underline-offset-2" target="_blank" rel="noopener noreferrer">{children}</a>
  ),
  hr: () => <hr className="border-line-1 my-4" />,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-line-2 pl-4 my-3 text-ink-2 italic">{children}</blockquote>
  ),
  code: ({ children, className }) => {
    const isBlock = className?.includes("language-");
    if (isBlock) {
      return <code className={`block bg-surface-1 rounded-lg p-3 text-xs font-mono text-ink-2 overflow-x-auto my-2 ${className || ""}`}>{children}</code>;
    }
    return <code className="bg-surface-3 rounded px-1.5 py-0.5 text-xs font-mono text-ink-2">{children}</code>;
  },
  pre: ({ children }) => <pre className="my-2">{children}</pre>,
};

export default function Md({ content, className = "" }: { content: string; className?: string }) {
  if (!content) return null;
  const clean = content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  if (!clean) return null;

  return (
    <div className={`max-w-none ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{clean}</ReactMarkdown>
    </div>
  );
}
