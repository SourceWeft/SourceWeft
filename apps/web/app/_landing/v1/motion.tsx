"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import styles from "./motion.module.css";

/** Content stays visible without JavaScript or when reduced motion is enabled. */
export function Reveal({
  children,
  className = "",
  delay = 0,
  demo = false,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  demo?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          element.dataset.visible = "true";
          observer.disconnect();
        }
      },
      { threshold: 0.12 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`${styles.reveal} ${demo ? styles.demo : ""} ${className}`}
      style={{ "--reveal-delay": `${delay}ms` } as CSSProperties}
    >
      {children}
    </div>
  );
}
