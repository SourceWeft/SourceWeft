import {
  cloneElement,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { FileText } from "lucide-react";
import { MessageResponse } from "@sourceweft/ui-web/components/ai-elements/message";
import { LoadingDots } from "@sourceweft/ui-web/components/ui/loading-dots";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { resolveMessageAssetUrl } from "./message-assets";
import { shouldShowPossibleEvidence } from "./message-evidence";
import type { CitationRecord } from "./types";

const CITATION_PATTERN =
  /[[【]\u200B?citation:\s*([\w:-]+(?:\s*,\s*[\w:-]+)*)\s*\u200B?[\]】]/g;
const WORKFILE_PATH_PATTERN = /\/workfiles\/[^\s`"'<>()[\]{}，。！？；：、]+/g;
const WORKFILE_TRAILING_PUNCTUATION_PATTERN = /[.,!?;:]+$/;

function splitCitationIds(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function resolveCitationFromId(input: {
  citationByChunkId: Map<string, CitationRecord>;
  citationByKey: Map<string, CitationRecord>;
  id: string;
}) {
  return (
    input.citationByKey.get(input.id) ?? input.citationByChunkId.get(input.id)
  );
}

function getCitationLabel(
  citation: CitationRecord | undefined,
  fallback: string,
) {
  return (
    citation?.sourceTitle?.trim() ||
    (citation ? "Source" : fallback || "Source")
  );
}

function CitationBadge({
  citation,
  label,
  onCitationClick,
}: {
  citation?: CitationRecord;
  label: string;
  onCitationClick?: (citation: CitationRecord) => void;
}) {
  return (
    <button
      className={cn(
        "mx-0.5 inline-flex max-w-[14rem] cursor-pointer items-center justify-center rounded-full bg-primary/10 px-1.5 py-0.5 align-baseline text-[11px] font-medium leading-none text-primary transition-colors hover:bg-primary/15",
        !citation &&
          "cursor-default bg-muted text-muted-foreground hover:bg-muted",
      )}
      disabled={!citation}
      onClick={() => {
        if (citation) {
          onCitationClick?.(citation);
        }
      }}
      title={citation?.excerpt ?? `Citation ${label}`}
      type="button"
    >
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

function makeCitationNode(input: {
  citationByChunkId: Map<string, CitationRecord>;
  citationByKey: Map<string, CitationRecord>;
  id: string;
  instanceIndex: number;
  onCitationClick?: (citation: CitationRecord) => void;
}) {
  const citation = resolveCitationFromId(input);
  const label = getCitationLabel(citation, input.id);

  return (
    <CitationBadge
      citation={citation}
      key={`citation-${input.id}-${input.instanceIndex}`}
      label={label}
      onCitationClick={input.onCitationClick}
    />
  );
}

function WorkfilePathLink({
  onWorkfileClick,
  path,
}: {
  onWorkfileClick?: (path: string) => void;
  path: string;
}) {
  return (
    <button
      className="inline cursor-pointer bg-transparent p-0 align-baseline font-medium text-primary underline decoration-primary/35 underline-offset-2 transition-colors hover:decoration-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => onWorkfileClick?.(path)}
      title={`Open preview: ${path}`}
      type="button"
    >
      {path}
    </button>
  );
}

function parseCitationText(input: {
  citationByChunkId: Map<string, CitationRecord>;
  citationByKey: Map<string, CitationRecord>;
  onCitationClick?: (citation: CitationRecord) => void;
  onWorkfileClick?: (path: string) => void;
  text: string;
}) {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let instanceIndex = 0;

  CITATION_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CITATION_PATTERN.exec(input.text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(input.text.slice(lastIndex, match.index));
    }

    for (const id of splitCitationIds(match[1] ?? "")) {
      parts.push(
        makeCitationNode({
          citationByChunkId: input.citationByChunkId,
          citationByKey: input.citationByKey,
          id,
          instanceIndex: instanceIndex++,
          onCitationClick: input.onCitationClick,
        }),
      );
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < input.text.length) {
    parts.push(input.text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : [input.text];
}

function parseWorkfilePaths(input: {
  children: ReactNode[];
  onWorkfileClick?: (path: string) => void;
}) {
  if (!input.onWorkfileClick) {
    return input.children;
  }

  return input.children.flatMap((child, childIndex) => {
    if (typeof child !== "string") {
      return [child];
    }

    const parts: ReactNode[] = [];
    let lastIndex = 0;
    WORKFILE_PATH_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = WORKFILE_PATH_PATTERN.exec(child)) !== null) {
      const rawPath = match[0];
      const path = rawPath.replace(WORKFILE_TRAILING_PUNCTUATION_PATTERN, "");
      if (!path || path === "/workfiles/") {
        continue;
      }

      if (match.index > lastIndex) {
        parts.push(child.slice(lastIndex, match.index));
      }

      parts.push(
        <WorkfilePathLink
          key={`workfile-${childIndex}-${match.index}`}
          onWorkfileClick={input.onWorkfileClick}
          path={path}
        />,
      );

      const consumedIndex = match.index + path.length;
      if (consumedIndex < match.index + rawPath.length) {
        parts.push(child.slice(consumedIndex, match.index + rawPath.length));
      }
      lastIndex = match.index + rawPath.length;
    }

    if (lastIndex < child.length) {
      parts.push(child.slice(lastIndex));
    }

    return parts.length > 0 ? parts : [child];
  });
}

function processMessageChildren(input: {
  children: ReactNode;
  citationByChunkId: Map<string, CitationRecord>;
  citationByKey: Map<string, CitationRecord>;
  onCitationClick?: (citation: CitationRecord) => void;
  onWorkfileClick?: (path: string) => void;
}): ReactNode {
  if (typeof input.children === "string") {
    return parseWorkfilePaths({
      children: parseCitationText({
        citationByChunkId: input.citationByChunkId,
        citationByKey: input.citationByKey,
        onCitationClick: input.onCitationClick,
        onWorkfileClick: input.onWorkfileClick,
        text: input.children,
      }),
      onWorkfileClick: input.onWorkfileClick,
    });
  }

  if (Array.isArray(input.children)) {
    return input.children.map((child, index) => (
      <span key={index}>
        {processMessageChildren({
          ...input,
          children: child,
        })}
      </span>
    ));
  }

  if (isValidElement(input.children)) {
    const child = input.children as ReactElement<{ children?: ReactNode }>;
    if (child.type === "code" || child.type === "pre" || child.type === "a") {
      return child;
    }
    return cloneElement(child, {
      children: processMessageChildren({
        ...input,
        children: child.props.children,
      }),
    });
  }

  return input.children;
}

export function CitationAwareMessageResponse({
  availableCitations,
  citations,
  className,
  children,
  onCitationClick,
  onWorkfileClick,
  showLoading = false,
}: {
  availableCitations?: CitationRecord[];
  citations: CitationRecord[] | undefined;
  className?: string;
  children: string;
  onCitationClick?: (citation: CitationRecord) => void;
  onWorkfileClick?: (path: string) => void;
  showLoading?: boolean;
}) {
  const citationByKey = new Map(
    (citations ?? []).map((citation) => [citation.citation, citation]),
  );
  const citationByChunkId = new Map(
    (citations ?? []).map((citation) => [citation.chunkId, citation]),
  );
  const hasInlineCitationMarkers = (() => {
    CITATION_PATTERN.lastIndex = 0;
    return CITATION_PATTERN.test(children);
  })();
  const possibleEvidence = shouldShowPossibleEvidence({
    availableCitations,
    citations,
    hasInlineCitationMarkers,
    showLoading,
  })
    ? (availableCitations ?? [])
    : [];
  const textComponent = ({
    children: nodeChildren,
  }: {
    children?: ReactNode;
  }) => (
    <>
      {processMessageChildren({
        children: nodeChildren,
        citationByChunkId,
        citationByKey,
        onCitationClick,
        onWorkfileClick,
      })}
    </>
  );

  const paragraphComponent = ({
    children: nodeChildren,
  }: {
    children?: ReactNode;
  }) => createElement("p", null, textComponent({ children: nodeChildren }));
  const listItemComponent = ({
    children: nodeChildren,
  }: {
    children?: ReactNode;
  }) => createElement("li", null, textComponent({ children: nodeChildren }));
  const strongComponent = ({
    children: nodeChildren,
  }: {
    children?: ReactNode;
  }) =>
    createElement("strong", null, textComponent({ children: nodeChildren }));
  const emphasisComponent = ({
    children: nodeChildren,
  }: {
    children?: ReactNode;
  }) => createElement("em", null, textComponent({ children: nodeChildren }));
  const blockquoteComponent = ({
    children: nodeChildren,
  }: {
    children?: ReactNode;
  }) =>
    createElement(
      "blockquote",
      null,
      textComponent({ children: nodeChildren }),
    );
  const h1Component = ({ children: nodeChildren }: { children?: ReactNode }) =>
    createElement("h1", null, textComponent({ children: nodeChildren }));
  const h2Component = ({ children: nodeChildren }: { children?: ReactNode }) =>
    createElement("h2", null, textComponent({ children: nodeChildren }));
  const h3Component = ({ children: nodeChildren }: { children?: ReactNode }) =>
    createElement("h3", null, textComponent({ children: nodeChildren }));
  const h4Component = ({ children: nodeChildren }: { children?: ReactNode }) =>
    createElement("h4", null, textComponent({ children: nodeChildren }));
  const h5Component = ({ children: nodeChildren }: { children?: ReactNode }) =>
    createElement("h5", null, textComponent({ children: nodeChildren }));
  const h6Component = ({ children: nodeChildren }: { children?: ReactNode }) =>
    createElement("h6", null, textComponent({ children: nodeChildren }));
  const tableCellComponent = ({
    children: nodeChildren,
  }: {
    children?: ReactNode;
  }) =>
    createElement(
      "td",
      { className: "border border-border px-3 py-2 align-top" },
      textComponent({ children: nodeChildren }),
    );
  const tableHeaderComponent = ({
    children: nodeChildren,
  }: {
    children?: ReactNode;
  }) =>
    createElement(
      "th",
      {
        className:
          "border border-border bg-muted/40 px-3 py-2 text-left align-top font-semibold text-foreground",
      },
      textComponent({ children: nodeChildren }),
    );
  const imageComponent = ({
    alt,
    className,
    src,
    ...props
  }: {
    alt?: string;
    className?: string;
    src?: string;
  }) => {
    return createElement("img", {
      ...props,
      alt: alt ?? "",
      className: cn(
        "my-3 max-h-[520px] max-w-full rounded-lg border border-border bg-muted/20 object-contain shadow-sm",
        className,
      ),
      loading: "lazy",
      src: resolveMessageAssetUrl(src),
    });
  };

  return (
    <div className={className}>
      <MessageResponse
        components={{
          a: ({ children: nodeChildren, href, ...props }) => (
            <a
              {...props}
              href={resolveMessageAssetUrl(href) as string | undefined}
            >
              {nodeChildren}
            </a>
          ),
          blockquote: blockquoteComponent as never,
          em: emphasisComponent as never,
          h1: h1Component as never,
          h2: h2Component as never,
          h3: h3Component as never,
          h4: h4Component as never,
          h5: h5Component as never,
          h6: h6Component as never,
          img: imageComponent as never,
          li: listItemComponent as never,
          p: paragraphComponent as never,
          strong: strongComponent as never,
          td: tableCellComponent as never,
          th: tableHeaderComponent as never,
        }}
      >
        {children}
      </MessageResponse>
      {showLoading ? <LoadingDots /> : null}
      <PossibleEvidenceStrip
        evidence={possibleEvidence}
        onCitationClick={onCitationClick}
      />
    </div>
  );
}

function PossibleEvidenceStrip({
  evidence,
  onCitationClick,
}: {
  evidence: CitationRecord[];
  onCitationClick?: (citation: CitationRecord) => void;
}) {
  if (evidence.length === 0) {
    return null;
  }

  const visibleEvidence = evidence.slice(0, 4);
  const hiddenCount = evidence.length - visibleEvidence.length;

  return (
    <div className="mt-3 rounded-2xl border border-dashed bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
      <div className="mb-2 flex items-center gap-1.5 font-medium text-foreground/80">
        <FileText className="size-3.5" />
        <span>Possible evidence</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {visibleEvidence.map((citation, index) => (
          <button
            className="inline-flex max-w-[240px] items-center gap-1.5 rounded-full border border-input bg-background/80 px-2 py-1 text-left text-xs text-foreground shadow-xs transition-colors hover:border-primary/35 hover:bg-primary/5"
            key={`${citation.citation}-${citation.chunkId}`}
            onClick={() => onCitationClick?.(citation)}
            title={citation.excerpt}
            type="button"
          >
            <span className="text-[10px] font-semibold text-primary">
              {index + 1}
            </span>
            <span className="truncate">
              {citation.sourceTitle?.trim() || "Untitled source"}
            </span>
          </button>
        ))}
        {hiddenCount > 0 ? (
          <span className="inline-flex items-center rounded-full border border-input bg-background/80 px-2 py-1 text-xs shadow-xs">
            +{hiddenCount} more
          </span>
        ) : null}
      </div>
      <p className="mt-2 leading-5">
        The answer did not include inline citation markers; these sources were
        read or retrieved during generation.
      </p>
    </div>
  );
}
