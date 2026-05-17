type StreamingEventParserOptions<TEvent> = {
  parseEvent: (input: unknown) => TEvent;
};

export function createStreamingEventParser<TEvent>({
  parseEvent,
}: StreamingEventParserOptions<TEvent>) {
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    parseChunk(value: Uint8Array) {
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      return events.flatMap((event) => {
        const line = event.trim();
        if (!line.startsWith("data: ")) {
          return [];
        }

        try {
          return [parseEvent(JSON.parse(line.slice(6)))];
        } catch {
          return [];
        }
      });
    },
  };
}
