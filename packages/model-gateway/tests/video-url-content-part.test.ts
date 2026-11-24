import assert from "node:assert/strict";
import test from "node:test";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { toLangChainMessages } from "../src/bridge/utils";
import { createGenerationObservation } from "../src/observe/generation";
import type { GatewayMessage } from "../src/types";
import { makeResolvedTarget } from "./helpers";

test("toLangChainMessages passes a video_url content part through to the HumanMessage unchanged", () => {
  const messages: GatewayMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "Summarize this video" },
        {
          type: "video_url",
          video_url: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
        },
      ],
    },
  ];

  const [langChainMessage] = toLangChainMessages(messages);

  assert.ok(langChainMessage instanceof HumanMessage);
  assert.deepEqual(langChainMessage?.content, messages[0]!.content);
});

test("gatewayContentToText (via a non-user role) renders a video_url part as [video]", () => {
  const messages: GatewayMessage[] = [
    {
      role: "system",
      content: [
        { type: "text", text: "Caption" },
        {
          type: "video_url",
          video_url: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
        },
      ],
    },
  ];

  const [langChainMessage] = toLangChainMessages(messages);

  assert.ok(langChainMessage instanceof SystemMessage);
  assert.equal(langChainMessage?.content, "Caption\n[video]");
});

test("chat generation preview renders a video_url content part as [video]", () => {
  const generation = createGenerationObservation({
    operation: "chat.complete",
    payload: {
      model: "network-test",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Summarize this video" },
            {
              type: "video_url",
              video_url: {
                url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
              },
            },
          ],
        },
      ],
    },
    target: makeResolvedTarget(),
  });

  const messagePreview = (
    generation.start.input as {
      messages?: Array<{
        content?: { preview?: string; contentPartCount?: number };
      }>;
    }
  ).messages?.[0]?.content;

  assert.equal(messagePreview?.preview, "Summarize this video\n[video]");
  assert.equal(messagePreview?.contentPartCount, 2);
});
