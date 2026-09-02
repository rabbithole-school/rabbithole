"use client";

import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MathText } from "@/components/MathText";
import { remarkInlineMath, RH_MATH_CLASS } from "@/lib/remarkInlineMath";

const chatMarkdownComponents: Components = {
  em: ({ children, ...props }) => {
    const text = typeof children === "string" ? children : "";
    if (text.startsWith("[") && text.endsWith("]")) {
      return <em style={{ color: "var(--chakra-colors-charcoal-300, #999)" }}>{text}</em>;
    }
    return <em {...props}>{children}</em>;
  },
  a: ({ href, children, ...props }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  ),
  span: ({ className, children, node: _node, ...props }) => {
    const classes = typeof className === "string" ? className.split(/\s+/) : [];
    if (classes.includes(RH_MATH_CLASS)) {
      const latex = Array.isArray(children) ? children.join("") : String(children ?? "");
      const display = (props as Record<string, unknown>)["data-display"] === "1";
      return <MathText latex={latex} display={display} fontSize={19} color="inherit" />;
    }
    return <span className={className} {...props}>{children}</span>;
  },
};

const chatMarkdownRemarkPlugins = [remarkGfm, remarkInlineMath];

export function splitStreamingMarkdown(content: string): { stableSegments: string[]; tail: string } {
  const stableSegments: string[] = [];
  let segmentStart = 0;
  let offset = 0;
  let inFence = false;

  while (offset < content.length) {
    const newline = content.indexOf("\n", offset);
    const lineEnd = newline === -1 ? content.length : newline;
    const nextOffset = newline === -1 ? content.length : newline + 1;
    const trimmed = content.slice(offset, lineEnd).trim();

    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
    } else if (!inFence && trimmed === "") {
      const segment = content.slice(segmentStart, nextOffset);
      if (segment.trim()) stableSegments.push(segment);
      segmentStart = nextOffset;
    }

    offset = nextOffset;
  }

  return {
    stableSegments,
    tail: content.slice(segmentStart),
  };
}

export const MarkdownBlock = memo(function MarkdownBlock({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={chatMarkdownRemarkPlugins} components={chatMarkdownComponents}>
      {content}
    </ReactMarkdown>
  );
});

export function StreamingMarkdown({ content }: { content: string }) {
  const { stableSegments, tail } = useMemo(
    () => splitStreamingMarkdown(content),
    [content],
  );

  return (
    <>
      {stableSegments.map((segment, index) => (
        <MarkdownBlock key={index} content={segment} />
      ))}
      {tail && (
        <ReactMarkdown remarkPlugins={chatMarkdownRemarkPlugins} components={chatMarkdownComponents}>
          {tail}
        </ReactMarkdown>
      )}
    </>
  );
}
