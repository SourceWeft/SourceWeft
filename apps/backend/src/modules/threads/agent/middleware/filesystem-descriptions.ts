import { createMiddleware } from "langchain";
import {
  buildFilesystemToolDescriptions,
  type AgentFilesystemMountCapability,
} from "../filesystem-capabilities";

export function createKnowledgeFilesystemToolDescriptionMiddleware(input: {
  mounts: AgentFilesystemMountCapability[];
}) {
  const descriptions = buildFilesystemToolDescriptions({
    mounts: input.mounts,
  });
  const setToolDescription = (
    tool: { description?: string },
    description: string,
  ) => {
    tool.description = description;
    return tool;
  };

  return createMiddleware({
    name: "SourceWeftKnowledgeFilesystemDescriptions",
    wrapModelCall: async (request, handler) => {
      const tools = request.tools.map((tool) => {
        const description =
          descriptions[tool.name as keyof typeof descriptions];
        return description ? setToolDescription(tool, description) : tool;
      });

      return handler({
        ...request,
        tools,
      });
    },
  });
}
