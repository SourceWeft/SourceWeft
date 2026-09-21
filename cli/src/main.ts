import { parseArgs } from "node:util";
import {
  installCommand,
  infoCommand,
  searchCommand,
  type CommandContext,
} from "./commands/skills";
import {
  doctorCommand,
  listCommand,
  removeCommand,
  updateCommand,
  type ManageContext,
} from "./commands/manage";
import { agentsCommand } from "./commands/agents";
import { findAgent } from "./install/agents";
import { EXIT, toFailure, UsageError } from "./errors";
import { createRegistryClient, normalizeRegistry } from "./registry/client";

import pkg from "../package.json" with { type: "json" };

const VERSION = pkg.version;

const HELP = `sourceweft ${VERSION}

Usage: sourceweft skills <command> [options]

Commands:
  skills search [query]     Search the marketplace
  skills info <slug>        Show a skill and where it comes from
  skills install <slug>     Install a skill for a coding agent
  skills agents             List supported agents and where they keep skills
  skills list               List skills installed by sourceweft
  skills update [slug]      Update installed skills to the registry's version
  skills remove <slug>      Remove an installed skill
  skills doctor             Check installed skills for problems

Options:
  --registry <url>   Marketplace API address
  --agent <ids>      Comma-separated agents to install for (default: claude-code)
  --scope <scope>    user or project (install default: user; other commands: both)
  --dir <path>       Use this skills directory instead of the agents' own
  --force            Overwrite or remove a skill whose files were edited
  --dry-run          Show what update would do without doing it
  -y, --yes          Do not ask for confirmation
  --category <slug>  Filter search by category
  --sort <sort>      recommended, popular, new or name
  --limit <n>        Number of search results
  --json             Machine-readable output
  -v, --version      Print the version
  -h, --help         Print this help
`;

async function run(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        registry: { type: "string" },
        agent: { type: "string" },
        scope: { type: "string" },
        dir: { type: "string" },
        force: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        yes: { type: "boolean", short: "y", default: false },
        category: { type: "string" },
        sort: { type: "string" },
        limit: { type: "string" },
        json: { type: "boolean", default: false },
        version: { type: "boolean", short: "v", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const { values, positionals } = parsed;

  if (values.version) {
    console.log(VERSION);
    return EXIT.ok;
  }
  const [group, command, ...args] = positionals;
  if (values.help || !group) {
    console.log(HELP);
    return group || values.help ? EXIT.ok : EXIT.usage;
  }
  if (group !== "skills" || !command) {
    throw new UsageError(
      `Unknown command '${positionals.join(" ")}'. Run with --help.`,
    );
  }

  const out = (line: string) => console.log(line);
  const registryContext = (): CommandContext => {
    const registry = normalizeRegistry(values.registry);
    return {
      client: createRegistryClient(registry),
      registry,
      json: values.json,
      out,
    };
  };
  const rawScope = values.scope;
  if (
    rawScope !== undefined &&
    rawScope !== "user" &&
    rawScope !== "project" &&
    rawScope !== "all"
  ) {
    throw new UsageError("--scope must be 'user', 'project' or 'all'");
  }
  const scope: "user" | "project" | "all" | undefined = rawScope;
  // Commands over what is already installed look in every agent's directory
  // unless told otherwise, and need no registry until an update asks for one.
  const selection = {
    ...(values.agent
      ? {
          agents: values.agent.split(",").map((id) => {
            const agent = findAgent(id.trim());
            if (!agent) {
              throw new UsageError(`Unknown agent '${id.trim()}'`);
            }
            return agent;
          }),
        }
      : {}),
    ...(scope ? { scope } : {}),
    ...(values.dir ? { dir: values.dir } : {}),
  };
  const manageContext = (): ManageContext => ({
    json: values.json,
    out,
    clientFor: (registry) => createRegistryClient(normalizeRegistry(registry)),
  });

  switch (command) {
    case "agents":
      agentsCommand({ json: values.json, out });
      return EXIT.ok;
    case "list":
      await listCommand(manageContext(), selection);
      return EXIT.ok;
    case "doctor":
      return doctorCommand(manageContext(), selection);
    case "update": {
      const [slug] = args;
      if (args.length > 1) {
        throw new UsageError("Usage: sourceweft skills update [slug]");
      }
      await updateCommand(
        manageContext(),
        { ...selection, ...(slug ? { slug } : {}) },
        {
          dryRun: values["dry-run"],
          force: values.force,
          yes: values.yes,
        },
      );
      return EXIT.ok;
    }
    case "remove": {
      const [slug] = args;
      if (!slug || args.length > 1) {
        throw new UsageError("Usage: sourceweft skills remove <slug>");
      }
      await removeCommand(
        manageContext(),
        { ...selection, slug },
        { force: values.force, yes: values.yes },
      );
      return EXIT.ok;
    }
    case "search": {
      const ctx = registryContext();
      const limit =
        values.limit === undefined ? undefined : Number(values.limit);
      if (
        limit !== undefined &&
        (!Number.isInteger(limit) || limit < 1 || limit > 100)
      ) {
        throw new UsageError("--limit must be a whole number from 1 to 100");
      }
      await searchCommand(ctx, {
        query: args.join(" "),
        ...(values.category ? { category: values.category } : {}),
        ...(values.sort ? { sort: values.sort } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return EXIT.ok;
    }
    case "info": {
      const ctx = registryContext();
      const [slug] = args;
      if (!slug || args.length > 1) {
        throw new UsageError("Usage: sourceweft skills info <slug>");
      }
      await infoCommand(ctx, { slug });
      return EXIT.ok;
    }
    case "install": {
      const ctx = registryContext();
      const [slug] = args;
      if (!slug || args.length > 1) {
        throw new UsageError("Usage: sourceweft skills install <slug>");
      }
      if (scope === "all") {
        throw new UsageError("--scope must be 'user' or 'project' for install");
      }
      await installCommand(ctx, {
        slug,
        agents: (values.agent ?? "claude-code")
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean),
        scope: scope ?? "user",
        ...(values.dir ? { dir: values.dir } : {}),
        force: values.force,
        yes: values.yes,
      });
      return EXIT.ok;
    }
    default:
      throw new UsageError(
        `Unknown command 'skills ${command}'. Run with --help.`,
      );
  }
}

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const failure = toFailure(error);
    console.error(`Error: ${failure.message}`);
    for (const detail of failure.details ?? []) {
      console.error(`  - ${detail}`);
    }
    process.exitCode = failure.exitCode;
  },
);
