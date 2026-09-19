export type ChangelogEntry = {
  tag: string;
  releasedAt: string;
  title: string;
  commit: string;
  category: "Release";
  summary: string;
  items: string[];
};

export function formatReleaseDate(releasedAt: string) {
  return new Date(`${releasedAt}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
