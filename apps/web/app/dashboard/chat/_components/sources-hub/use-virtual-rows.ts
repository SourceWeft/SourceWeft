import { useEffect, useRef, useState } from "react";

export function useVirtualRows(input: {
  enabled: boolean;
  overscanRows: number;
  rowCount: number;
  rowHeight: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    if (!input.enabled) {
      setScrollTop(0);
      return;
    }

    const element = containerRef.current;
    if (!element) {
      return;
    }

    const updateViewportHeight = () => {
      setViewportHeight(element.clientHeight);
    };

    updateViewportHeight();
    const observer = new ResizeObserver(updateViewportHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, [input.enabled]);

  const startIndex = input.enabled
    ? Math.max(0, Math.floor(scrollTop / input.rowHeight) - input.overscanRows)
    : 0;
  const visibleCount = input.enabled
    ? Math.ceil(viewportHeight / input.rowHeight) + input.overscanRows * 2
    : input.rowCount;
  const endIndex = input.enabled
    ? Math.min(input.rowCount, startIndex + visibleCount)
    : input.rowCount;

  return {
    containerRef,
    endIndex,
    onScroll: input.enabled
      ? () => {
          const element = containerRef.current;
          if (element) {
            setScrollTop(element.scrollTop);
          }
        }
      : undefined,
    startIndex,
    topPadding: input.enabled ? startIndex * input.rowHeight : 0,
    totalHeight: input.rowCount * input.rowHeight,
  };
}
