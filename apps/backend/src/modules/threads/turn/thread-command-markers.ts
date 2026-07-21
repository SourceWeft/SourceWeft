export type ParsedPromptMarker =
  | {
      readonly kind: "skill" | "tool";
      readonly label: string;
      readonly value: string;
      readonly type: "command";
    }
  | {
      readonly sourceId: string | null;
      readonly title: string;
      readonly type: "source";
    };

function decodePromptMarkerValue(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function unescapePromptMarkerLabel(value: string) {
  return value.replace(/\\([\\)\]])/g, "$1");
}

export function parsePromptMarkers(content: string) {
  const markers: ParsedPromptMarker[] = [];
  const pattern =
    /\[(skills|skill-command|tool|source):([^\]]+)\]\(((?:\\.|[^)])*)\)/g;
  let cleanContent = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    cleanContent += content.slice(lastIndex, match.index);
    const rawKind = match[1];
    const rawValue = match[2] ?? "";
    const label = unescapePromptMarkerLabel(match[3] ?? "");
    const decodedValue = decodePromptMarkerValue(rawValue);

    if (rawKind === "source") {
      const title = label || decodedValue;
      markers.push({
        sourceId: decodedValue.trim() || null,
        title,
        type: "source",
      });
      cleanContent += `@${title}`;
    } else if (rawKind !== "skill-command") {
      markers.push({
        kind: rawKind === "tool" ? "tool" : "skill",
        label,
        value: `/${decodedValue.replace(/^\//, "")}`,
        type: "command",
      });
    }

    lastIndex = pattern.lastIndex;
  }

  cleanContent += content.slice(lastIndex);

  return {
    cleanContent: cleanContent
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim(),
    markers,
  };
}

function commandMarkers(markers: readonly ParsedPromptMarker[]) {
  return markers.filter(
    (marker): marker is Extract<ParsedPromptMarker, { type: "command" }> =>
      marker.type === "command",
  );
}

function sourceMarkers(markers: readonly ParsedPromptMarker[]) {
  return markers.filter(
    (marker): marker is Extract<ParsedPromptMarker, { type: "source" }> =>
      marker.type === "source",
  );
}

export function markerSourceIds(markers: readonly ParsedPromptMarker[]) {
  return sourceMarkers(markers)
    .filter((marker) => Boolean(marker.sourceId))
    .map((marker) => marker.sourceId as string);
}

export function markerSourceTitles(markers: readonly ParsedPromptMarker[]) {
  return sourceMarkers(markers).map((marker) => marker.title);
}

export function lastToolCommandMarker(markers: readonly ParsedPromptMarker[]) {
  return [...commandMarkers(markers)]
    .reverse()
    .find((marker) => marker.kind === "tool");
}
