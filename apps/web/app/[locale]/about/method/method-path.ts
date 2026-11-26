/** The "About & method" page, without a locale prefix. */
export const METHOD_PATH = "/about/method";

/** Section ids on the page, in page order; each has a `method.<id>.title`. */
export const METHOD_SECTIONS = [
  "sources",
  "overviews",
  "score",
  "scan",
  "publishers",
  "reports",
  "responsibility",
] as const;

export type MethodSection = (typeof METHOD_SECTIONS)[number];

export function methodSectionPath(section: MethodSection) {
  return `${METHOD_PATH}#${section}`;
}
