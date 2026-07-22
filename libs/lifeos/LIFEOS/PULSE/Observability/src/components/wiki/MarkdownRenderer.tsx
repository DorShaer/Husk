"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeHighlight from "rehype-highlight";
import Link from "next/link";
import type { Components } from "react-markdown";

interface MarkdownRendererProps {
  content: string;
  onWikiLinkClick?: (slug: string) => void;
}

// Transform [[wikilinks]] into <a> tags before rendering
function preprocessWikilinks(content: string): string {
  return content.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_, slug, label) => {
      const displayText = label || slug;
      const href = slug.trim().toLowerCase().replace(/\s+/g, "-");
      return `<a href="/system?doc=${href}" class="wikilink" data-slug="${href}">${displayText}</a>`;
    }
  );
}

// Strip YAML frontmatter from content
function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n?/);
  return match ? content.slice(match[0].length) : content;
}

const components: Components = {
  h1: ({ children }) => (
    <h1
      className="text-2xl font-bold tracking-wide text-ink-1 mb-6 pb-3 border-b border-line-2"
      style={{ fontFamily: "'advocate-c14', sans-serif" }}
    >
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2
      className="text-xl font-semibold tracking-wide text-ink-1 mt-8 mb-4"
      style={{ fontFamily: "'advocate-c14', sans-serif" }}
    >
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3
      className="text-lg font-semibold text-ink-1 mt-6 mb-3"
      style={{ fontFamily: "'concourse-t3', sans-serif" }}
    >
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4
      className="text-base font-semibold text-ink-2 mt-5 mb-2"
      style={{ fontFamily: "'concourse-t3', sans-serif" }}
    >
      {children}
    </h4>
  ),
  p: ({ children }) => (
    <p
      className="text-sm text-ink-2 leading-relaxed mb-4"
      style={{ fontFamily: "'concourse-t3', sans-serif" }}
    >
      {children}
    </p>
  ),
  a: ({ href, children, className, ...props }) => {
    // Wikilink (preprocessed)
    if (className === "wikilink" || href?.startsWith("/system?doc=")) {
      const slug = (props as Record<string, string>)["data-slug"] || href?.replace("/system?doc=", "") || "";
      return (
        <Link
          href={`/system?doc=${slug}`}
          className="inline-flex items-center px-1.5 py-0.5 text-xs rounded bg-sky-500/10 border border-sky-500/20 text-sky-400 hover:bg-sky-500/20 hover:text-sky-300 transition-colors"
          style={{ fontFamily: "'concourse-t3', sans-serif" }}
        >
          {children}
        </Link>
      );
    }
    // External link
    if (href?.startsWith("http")) {
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sky-400 hover:text-sky-300 underline underline-offset-2 transition-colors"
        >
          {children}
        </a>
      );
    }
    // Internal link
    return (
      <Link href={href || "#"} className="text-sky-400 hover:text-sky-300 underline underline-offset-2 transition-colors">
        {children}
      </Link>
    );
  },
  code: ({ className, children, ...props }) => {
    const isBlock = className?.startsWith("language-");
    if (isBlock) {
      return (
        <code className={`${className} text-xs`} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className="px-1.5 py-0.5 text-xs rounded bg-surface-3 text-sky-300 border border-line-2">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="rounded-lg bg-surface-1 border border-line-2 p-4 mb-4 overflow-x-auto text-xs leading-relaxed">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto mb-4">
      <table className="w-full text-xs border-collapse rounded-lg overflow-hidden bg-surface-2 border border-line-2">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-surface-1">
      {children}
    </thead>
  ),
  th: ({ children }) => (
    <th
      className="px-3 py-2 text-left text-sky-400 font-medium tracking-wide border-b border-line-2"
      style={{ fontFamily: "'concourse-t3', sans-serif" }}
    >
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td
      className="px-3 py-2 text-ink-2 border-b border-line-1"
      style={{ fontFamily: "'concourse-t3', sans-serif" }}
    >
      {children}
    </td>
  ),
  tr: ({ children }) => (
    <tr className="hover:bg-surface-3 transition-colors">
      {children}
    </tr>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-purple-500/50 pl-4 py-1 my-4 bg-purple-500/5 rounded-r italic text-ink-2">
      {children}
    </blockquote>
  ),
  ul: ({ children }) => (
    <ul className="list-none space-y-1 mb-4 pl-4">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal space-y-1 mb-4 pl-6 text-sm text-ink-2 marker:text-sky-500">
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li className="text-sm text-ink-2 leading-relaxed relative pl-3 before:content-['▸'] before:absolute before:left-0 before:text-sky-500/60 before:text-[13px] before:top-[3px]"
      style={{ fontFamily: "'concourse-t3', sans-serif" }}
    >
      {children}
    </li>
  ),
  hr: () => (
    <hr className="border-line-2 my-6" />
  ),
  img: ({ src, alt }) => (
    <img src={src} alt={alt || ""} className="rounded-lg border border-line-2 max-w-full my-4" />
  ),
  strong: ({ children }) => (
    <strong className="text-ink-1 font-semibold">{children}</strong>
  ),
  em: ({ children }) => (
    <em className="text-ink-2 italic">{children}</em>
  ),
};

export default function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const processed = preprocessWikilinks(stripFrontmatter(content));

  return (
    <div className="wiki-content max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeHighlight]}
        components={components}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
}
