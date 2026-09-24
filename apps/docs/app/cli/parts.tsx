import type { ReactNode } from "react";

export function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-8 pt-12">
      <h2 className="mb-4 text-2xl font-semibold tracking-tight">{title}</h2>
      <div className="flex flex-col gap-4 leading-7">{children}</div>
    </section>
  );
}

export function SubSection({
  id,
  title,
  children,
}: {
  id?: string;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <div id={id} className="flex scroll-mt-8 flex-col gap-3 pt-4">
      <h3 className="text-lg font-semibold">{title}</h3>
      {children}
    </div>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-neutral-200/70 px-1.5 py-0.5 font-mono text-[0.875em] dark:bg-neutral-800">
      {children}
    </code>
  );
}

export function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-neutral-300 bg-neutral-100 p-4 font-mono text-sm leading-6 dark:border-neutral-800 dark:bg-neutral-900">
      <code>{children}</code>
    </pre>
  );
}

export function Note({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <aside className="rounded-lg border border-neutral-300 bg-neutral-100/70 px-4 py-3 text-sm leading-6 dark:border-neutral-800 dark:bg-neutral-900/60">
      <p className="mb-1 font-semibold">{title}</p>
      <div className="flex flex-col gap-2">{children}</div>
    </aside>
  );
}

export function BulletList({ children }: { children: ReactNode }) {
  return <ul className="flex list-disc flex-col gap-2 pl-6">{children}</ul>;
}

export function DataTable({
  head,
  rows,
}: {
  head: readonly string[];
  rows: readonly (readonly ReactNode[])[];
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-300 dark:border-neutral-800">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-neutral-100 dark:bg-neutral-900">
          <tr>
            {head.map((label) => (
              <th key={label} className="px-3 py-2 font-semibold">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={index}
              className="border-t border-neutral-300 align-top dark:border-neutral-800"
            >
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-3 py-2">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
