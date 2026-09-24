import type { Metadata } from "next";
import Link from "next/link";
import {
  BulletList,
  Code,
  CodeBlock,
  DataTable,
  Note,
  Section,
  SubSection,
} from "./parts";

export const metadata: Metadata = {
  title: "Command line | SourceWeft Docs",
  description:
    "Install skills from the SourceWeft marketplace onto your coding agent with the sourceweft command line.",
};

/** Mirrors `cli/src/install/agents.ts`; `sourceweft skills agents` prints the same table. */
const AGENTS: readonly (readonly [
  id: string,
  name: string,
  user: string,
  project: string,
  sharedDir: string,
])[] = [
  ["claude-code", "Claude Code", "~/.claude/skills", ".claude/skills", ""],
  [
    "universal",
    "Shared .agents directory",
    "~/.agents/skills",
    ".agents/skills",
    "the shared directory itself",
  ],
  ["codex", "OpenAI Codex CLI", "~/.agents/skills", ".agents/skills", "yes"],
  ["gemini-cli", "Gemini CLI", "~/.gemini/skills", ".gemini/skills", "yes"],
  ["qwen-code", "Qwen Code", "~/.qwen/skills", ".qwen/skills", ""],
  ["amp", "Amp", "~/.config/agents/skills", ".agents/skills", "yes"],
  ["cursor", "Cursor", "~/.cursor/skills", ".cursor/skills", "yes"],
  [
    "windsurf",
    "Windsurf",
    "~/.codeium/windsurf/skills",
    ".windsurf/skills",
    "yes",
  ],
  ["cline", "Cline", "~/.cline/skills", ".cline/skills", ""],
  ["roo", "Roo Code", "~/.roo/skills", ".roo/skills", "yes"],
  [
    "github-copilot",
    "GitHub Copilot",
    "~/.copilot/skills",
    ".github/skills",
    "yes",
  ],
  [
    "opencode",
    "OpenCode",
    "~/.config/opencode/skills",
    ".opencode/skills",
    "yes",
  ],
  ["goose", "Goose", "~/.agents/skills", ".agents/skills", "yes"],
  ["kiro", "Kiro", "~/.kiro/skills", ".kiro/skills", ""],
];

const CONTENTS = [
  ["what-it-is", "What it is"],
  ["trust", "How installs are kept trustworthy"],
  ["quick-start", "Quick start"],
  ["commands", "Commands"],
  ["options", "Options"],
  ["agents", "Supported agents and directories"],
  ["on-disk", "What is written to disk"],
  ["protections", "What it does to protect you"],
  ["exit-codes", "Exit codes"],
  ["troubleshooting", "Troubleshooting"],
] as const;

export default function CliPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 pb-24 pt-10">
      <nav className="mb-10 text-sm opacity-70">
        <Link href="/" className="hover:underline">
          SourceWeft Docs
        </Link>{" "}
        / Command line
      </nav>

      <header className="flex flex-col gap-4">
        <h1 className="text-4xl font-bold tracking-tight">
          The SourceWeft command line
        </h1>
        <p className="text-lg leading-8 opacity-80">
          <Code>sourceweft</Code> installs skills from the SourceWeft
          marketplace onto the coding agent you already use, and keeps them up
          to date. It is published on npm as <Code>@sourceweft/cli</Code> and
          needs Node 20 or newer.
        </p>
        <p className="leading-7">
          Installing public marketplace skills needs no account and no token.
          There is nothing to sign in to.
        </p>
      </header>

      <nav
        aria-label="On this page"
        className="mt-8 rounded-lg border border-neutral-300 p-4 text-sm dark:border-neutral-800"
      >
        <p className="mb-2 font-semibold">On this page</p>
        <ul className="grid gap-1 sm:grid-cols-2">
          {CONTENTS.map(([id, label]) => (
            <li key={id}>
              <a href={`#${id}`} className="hover:underline">
                {label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <Section id="what-it-is" title="What it is">
        <p>
          The marketplace only <strong>indexes</strong> skills. For each one it
          records where the skill lives (a GitHub repository, pinned to a single
          commit) and what every file in it hashes to. It does not host or serve
          the files themselves.
        </p>
        <p>
          The command line is the part that puts a skill on your machine. It
          looks the skill up in the registry, downloads its files from that
          pinned GitHub commit, and installs them only if every file matches the
          hashes the registry recorded.
        </p>
        <p>
          The result: what lands on your machine is the content that was indexed
          and scanned, not whatever the upstream branch holds today.
        </p>
      </Section>

      <Section id="trust" title="How installs are kept trustworthy">
        <BulletList>
          <li>
            <strong>The registry says what to install.</strong> It names the
            repository, the commit and the list of files, with a hash for each.
            Because you rely on it for that, the registry address must be{" "}
            <Code>https://</Code> (plain <Code>http://</Code> is accepted only
            for a server on your own machine).
          </li>
          <li>
            <strong>GitHub supplies the bytes.</strong> The download comes from
            the pinned commit, a full 40-character commit hash, never from a
            branch or tag. The same commit always gives the same archive.
          </li>
          <li>
            <strong>Your machine checks them.</strong> Each listed file must be
            present, have the recorded size and hash to the recorded value. Any
            mismatch, missing file or oversize entry stops the install with exit
            code 3, and nothing is written to disk. Files in the repository that
            the registry did not list are never installed.
          </li>
        </BulletList>
        <p>
          Only skills pinned to a commit of a <Code>github.com</Code> repository
          can be installed with the command line.
        </p>
      </Section>

      <Section id="quick-start" title="Quick start">
        <p>
          Run it without installing anything, using <Code>npx</Code>:
        </p>
        <CodeBlock>{`npx @sourceweft/cli skills search pdf
npx @sourceweft/cli skills info <slug>
npx @sourceweft/cli skills install <slug>`}</CodeBlock>
        <p>
          <Code>install</Code> shows the skill&rsquo;s source, license and
          whether it ships scripts, then asks you to confirm. By default it
          installs for Claude Code in your user directory (
          <Code>~/.claude/skills</Code>).
        </p>
        <p>To install it globally so the command is always available:</p>
        <CodeBlock>{`npm install -g @sourceweft/cli
sourceweft skills install <slug>`}</CodeBlock>
        <p>
          To install for another agent, or into the current project instead of
          your home directory:
        </p>
        <CodeBlock>{`sourceweft skills install <slug> --agent codex
sourceweft skills install <slug> --agent cursor --scope project`}</CodeBlock>
        <Note title="Which registry?">
          <p>
            The CLI asks the registry at <Code>https://api.sourceweft.com</Code>{" "}
            by default. Pass <Code>--registry &lt;url&gt;</Code> to use another
            one. Every command that talks to a registry needs one that serves
            the skill marketplace API; see{" "}
            <a href="#troubleshooting" className="underline">
              Troubleshooting
            </a>{" "}
            if you get an error about that.
          </p>
        </Note>
      </Section>

      <Section id="commands" title="Commands">
        <p>
          Every command has the form{" "}
          <Code>sourceweft skills &lt;command&gt;</Code>. Add{" "}
          <Code>--json</Code> to any of them for machine-readable output.
        </p>
        <DataTable
          head={["Command", "What it does", "Needs the registry"]}
          rows={[
            [
              <Code key="c">search [query]</Code>,
              "Search the marketplace",
              "Yes",
            ],
            [
              <Code key="c">info &lt;slug&gt;</Code>,
              "Show a skill and where it comes from",
              "Yes",
            ],
            [
              <Code key="c">install &lt;slug&gt;</Code>,
              "Install a skill for a coding agent",
              "Yes",
            ],
            [
              <Code key="c">agents</Code>,
              "List supported agents and where they keep skills",
              "No",
            ],
            [
              <Code key="c">list</Code>,
              "List skills installed by sourceweft",
              "No",
            ],
            [
              <Code key="c">update [slug]</Code>,
              "Update installed skills to the registry’s version",
              "Yes, the one each skill was installed from",
            ],
            [
              <Code key="c">remove &lt;slug&gt;</Code>,
              "Remove an installed skill",
              "No",
            ],
            [
              <Code key="c">doctor</Code>,
              "Check installed skills for problems",
              "No",
            ],
          ]}
        />

        <SubSection id="search" title={<Code>search</Code>}>
          <p>
            Searches the marketplace. Everything after <Code>search</Code> is
            the query; leave it out to list skills. Each result shows the slug,
            a <Code>verified</Code> mark if a SourceWeft admin has verified the
            skill, a <Code>scripts</Code> mark if it ships executable files, and
            a short description.
          </p>
          <DataTable
            head={["Option", "Meaning"]}
            rows={[
              [
                <Code key="o">--category &lt;slug&gt;</Code>,
                "Only this category",
              ],
              [
                <Code key="o">--sort &lt;sort&gt;</Code>,
                <>
                  <Code>recommended</Code>, <Code>popular</Code>,{" "}
                  <Code>new</Code> or <Code>name</Code>
                </>,
              ],
              [
                <Code key="o">--limit &lt;n&gt;</Code>,
                "Number of results, a whole number from 1 to 100 (default 20)",
              ],
            ]}
          />
          <CodeBlock>{`sourceweft skills search pdf --sort popular --limit 10`}</CodeBlock>
        </SubSection>

        <SubSection id="info" title={<Code>info</Code>}>
          <p>
            Shows one skill without installing it: its version, license, source
            repository, whether it is verified, how many files it has, whether
            it includes scripts, and any scan flags. Use it to look before you
            install.
          </p>
          <CodeBlock>{`sourceweft skills info <slug>`}</CodeBlock>
        </SubSection>

        <SubSection id="install" title={<Code>install</Code>}>
          <p>
            Looks the skill up, prints the same summary as <Code>info</Code>,
            asks for confirmation, downloads the files, verifies them and writes
            them. If the same commit is already installed and you have not
            edited it, it says so and downloads nothing.
          </p>
          <DataTable
            head={["Option", "Meaning"]}
            rows={[
              [
                <Code key="o">--agent &lt;ids&gt;</Code>,
                <>
                  Comma-separated agents to install for (default{" "}
                  <Code>claude-code</Code>). See{" "}
                  <a href="#agents" className="underline">
                    the agents table
                  </a>
                  .
                </>,
              ],
              [
                <Code key="o">--scope user|project</Code>,
                <>
                  <Code>user</Code> (default) installs under your home
                  directory; <Code>project</Code> installs under the directory
                  you ran the command from
                </>,
              ],
              [
                <Code key="o">--dir &lt;path&gt;</Code>,
                "Install into this skills directory instead of the agent’s own. Use it with a single agent",
              ],
              [
                <Code key="o">--force</Code>,
                "Replace an earlier install of this skill whose files you have edited",
              ],
              [<Code key="o">-y, --yes</Code>, "Do not ask for confirmation"],
            ]}
          />
          <p>
            If you name several agents that read the same directory (for example{" "}
            <Code>codex</Code> and <Code>goose</Code>), the skill is installed
            once for all of them. Agents with different directories each get
            their own copy.
          </p>
          <CodeBlock>{`sourceweft skills install <slug>
sourceweft skills install <slug> --agent claude-code,cursor --scope project
sourceweft skills install <slug> --dir ./my-skills`}</CodeBlock>
        </SubSection>

        <SubSection id="agents-command" title={<Code>agents</Code>}>
          <p>
            Prints the table of supported agents and the directories they use,
            the same one shown below.
          </p>
          <CodeBlock>{`sourceweft skills agents`}</CodeBlock>
        </SubSection>

        <SubSection id="list" title={<Code>list</Code>}>
          <p>
            Lists the skills sourceweft has installed, found by scanning each
            agent&rsquo;s skills directories for the{" "}
            <Code>.sourceweft.json</Code> file it leaves behind. It keeps no
            list of its own, so deleting a directory by hand never leaves it out
            of step. It shows the slug, version, agent and scope, a status (
            <Code>files missing</Code>, <Code>modified</Code> or{" "}
            <Code>extra files</Code>, blank when the skill is untouched) and the
            directory. It needs no network access.
          </p>
          <p>
            By default it looks at every supported agent in both scopes. Narrow
            it with <Code>--agent</Code>, <Code>--scope user|project|all</Code>{" "}
            or <Code>--dir</Code>.
          </p>
          <CodeBlock>{`sourceweft skills list
sourceweft skills list --scope project`}</CodeBlock>
        </SubSection>

        <SubSection id="update" title={<Code>update</Code>}>
          <p>
            Checks each installed skill against the registry it was installed
            from and updates the ones whose pinned commit has changed. Give a
            slug to update just that skill. It prints what would change (
            <Code>abc1234 → def5678</Code>), asks once for the whole run, then
            downloads and verifies the new files exactly as <Code>install</Code>{" "}
            does.
          </p>
          <DataTable
            head={["Option", "Meaning"]}
            rows={[
              [
                <Code key="o">--dry-run</Code>,
                "Report which updates are available without changing anything",
              ],
              [
                <Code key="o">--force</Code>,
                "Replace a skill whose files you have edited",
              ],
              [<Code key="o">-y, --yes</Code>, "Do not ask for confirmation"],
              [
                <Code key="o">--agent</Code>,
                "Limit which agents’ directories are checked (also --scope, --dir)",
              ],
            ]}
          />
          <p>Each skill ends up in one of these states:</p>
          <BulletList>
            <li>
              <em>up to date</em>: the registry is at the commit you have.
            </li>
            <li>
              <em>updated</em> or <em>update available</em> (with{" "}
              <Code>--dry-run</Code>, or if you declined).
            </li>
            <li>
              <em>no longer in the registry</em>: the skill is left installed as
              it is.
            </li>
            <li>
              <em>now named &lsquo;x&rsquo;</em>: the skill was renamed
              upstream; <Code>remove</Code> it and install it again.
            </li>
          </BulletList>
          <CodeBlock>{`sourceweft skills update --dry-run
sourceweft skills update <slug>`}</CodeBlock>
        </SubSection>

        <SubSection id="remove" title={<Code>remove</Code>}>
          <p>
            Removes an installed skill from every agent directory where
            sourceweft installed it, after listing them and asking you to
            confirm. It only deletes directories that carry sourceweft&rsquo;s
            own metadata, never one it did not create. If you edited, deleted or
            added files inside the skill it refuses unless you pass{" "}
            <Code>--force</Code>, because removing the directory would lose
            those changes. <Code>--agent</Code>, <Code>--scope</Code>,{" "}
            <Code>--dir</Code> and <Code>-y</Code> work as above.
          </p>
          <CodeBlock>{`sourceweft skills remove <slug>
sourceweft skills remove <slug> --agent cursor --scope project`}</CodeBlock>
        </SubSection>

        <SubSection id="doctor" title={<Code>doctor</Code>}>
          <p>
            Checks installed skills without touching them and needs no network.
            It reports two kinds of finding:
          </p>
          <BulletList>
            <li>
              <strong>Problems</strong> (exit code 1): a{" "}
              <Code>.sourceweft.json</Code> that cannot be read; a leftover
              temporary directory from an interrupted install, which is safe to
              delete; a file the record lists that is missing; the same skill
              installed at different versions in different places (for example,
              one agent&rsquo;s copy was not updated).
            </li>
            <li>
              <strong>Notes</strong> (do not affect the exit code): a file you
              edited, or extra files you added.
            </li>
          </BulletList>
          <CodeBlock>{`sourceweft skills doctor`}</CodeBlock>
        </SubSection>
      </Section>

      <Section id="options" title="Options">
        <p>
          These options are accepted by all commands. Not every command uses
          every option.
        </p>
        <DataTable
          head={["Option", "Meaning"]}
          rows={[
            [
              <Code key="o">--registry &lt;url&gt;</Code>,
              "Marketplace API address to use instead of the default. Must be https:// (http:// only for localhost)",
            ],
            [
              <Code key="o">--agent &lt;ids&gt;</Code>,
              "Comma-separated agents. install: which to install for (default claude-code). Other commands: which to look at (default all)",
            ],
            [
              <Code key="o">--scope &lt;scope&gt;</Code>,
              "user or project. install defaults to user. list, update, remove and doctor also accept all and default to both",
            ],
            [
              <Code key="o">--dir &lt;path&gt;</Code>,
              "Use this skills directory instead of the agents’ own",
            ],
            [
              <Code key="o">--force</Code>,
              "Overwrite or remove a skill whose files were edited",
            ],
            [
              <Code key="o">--dry-run</Code>,
              "Show what update would do without doing it",
            ],
            [<Code key="o">-y, --yes</Code>, "Do not ask for confirmation"],
            [
              <Code key="o">--category &lt;slug&gt;</Code>,
              "Filter search by category",
            ],
            [
              <Code key="o">--sort &lt;sort&gt;</Code>,
              "recommended, popular, new or name",
            ],
            [
              <Code key="o">--limit &lt;n&gt;</Code>,
              "Number of search results",
            ],
            [<Code key="o">--json</Code>, "Machine-readable output"],
            [<Code key="o">-v, --version</Code>, "Print the version"],
            [<Code key="o">-h, --help</Code>, "Print the help text"],
          ]}
        />
      </Section>

      <Section id="agents" title="Supported agents and directories">
        <p>
          Each skill is installed into the skills directory of the agent you
          choose. The directories below are each agent&rsquo;s own documented
          location, checked against its official documentation on 2026-09-21.
          The <em>user</em> directory is under your home directory; the{" "}
          <em>project</em> directory is under the directory you run the command
          from.
        </p>
        <DataTable
          head={[
            "--agent",
            "Agent",
            "--scope user",
            "--scope project",
            "Also reads .agents/skills",
          ]}
          rows={AGENTS.map(([id, name, user, project, shared]) => [
            <Code key="id">{id}</Code>,
            name,
            <Code key="user">{user}</Code>,
            <Code key="project">{project}</Code>,
            shared,
          ])}
        />
        <Note title="One install for many agents">
          <p>
            Many agents also read the shared <Code>.agents/skills</Code>{" "}
            directory: Codex, Goose, Gemini CLI, Cursor, Windsurf, Roo Code,
            GitHub Copilot, OpenCode and Amp. Installing with{" "}
            <Code>--agent universal</Code> puts the skill in that shared
            directory once, and all of those agents can use it.
          </p>
          <p>
            Claude Code, Qwen Code, Cline and Kiro do not document that
            directory, so install for them by their own name.
          </p>
        </Note>
        <p>
          If your agent keeps skills somewhere else, use{" "}
          <Code>--dir &lt;path&gt;</Code> to install into that directory.
        </p>
      </Section>

      <Section id="on-disk" title="What is written to disk">
        <p>
          Each skill becomes a directory named after the skill,{" "}
          <Code>&lt;skills dir&gt;/&lt;name&gt;/</Code>, holding its files plus
          a <Code>.sourceweft.json</Code>. That file records the registry the
          skill came from, the commit, and the hash of every file. It is how
          sourceweft recognises a directory as its own, and how it notices later
          that you have edited something. A directory without it is never
          touched.
        </p>
      </Section>

      <Section id="protections" title="What it does to protect you">
        <BulletList>
          <li>
            <strong>Verifies before writing.</strong> The download is checked
            file by file against the registry&rsquo;s record. If anything does
            not match, nothing is written.
          </li>
          <li>
            <strong>Installs atomically.</strong> Files go into a temporary
            directory beside the target first and are moved into place only when
            every file is down, so a failed install leaves nothing half-written.
          </li>
          <li>
            <strong>Never overwrites what it did not create.</strong> If a
            directory with the skill&rsquo;s name already exists and has no{" "}
            <Code>.sourceweft.json</Code>, the install stops and asks you to
            move it away yourself; <Code>--force</Code> does not override this.
            It also refuses if the directory holds a different skill or one from
            a different registry, and it never follows a symbolic link at a
            skill&rsquo;s location.
          </li>
          <li>
            <strong>Protects your local edits.</strong> If you edited, deleted
            or added files inside an installed skill, <Code>update</Code> and{" "}
            <Code>remove</Code> (and re-installing over it) refuse unless you
            pass <Code>--force</Code>.
          </li>
          <li>
            <strong>Asks before installing someone else&rsquo;s code.</strong>{" "}
            <Code>install</Code> and <Code>update</Code> show the source,
            license and whether the skill ships scripts, and ask you to confirm.
            With no terminal to ask on, they exit with code 4 unless you pass{" "}
            <Code>--yes</Code>.
          </li>
          <li>
            <strong>No telemetry.</strong> The CLI sends nothing about you or
            your installs anywhere. Its only network traffic is to the registry
            and to GitHub for the download.
          </li>
        </BulletList>
      </Section>

      <Section id="exit-codes" title="Exit codes">
        <DataTable
          head={["Code", "Meaning"]}
          rows={[
            ["0", "Success"],
            [
              "1",
              <>
                Error. Also returned by <Code>doctor</Code> when it finds a
                problem
              </>,
            ],
            ["2", "Usage error: a bad option or argument"],
            ["3", "The download did not match the registry’s record"],
            [
              "4",
              <>
                Confirmation needed but there is no terminal; re-run with{" "}
                <Code>--yes</Code>
              </>,
            ],
          ]}
        />
      </Section>

      <Section id="troubleshooting" title="Troubleshooting">
        <SubSection
          title={
            <>&ldquo;&hellip; does not serve the skill marketplace API&rdquo;</>
          }
        >
          <p>
            The full message reads{" "}
            <Code>
              &lt;registry&gt; does not serve the skill marketplace API (GET
              /v1/skills returned 404). It may not be deployed there yet.
            </Code>{" "}
            and the exit code is 1. It means the server you reached answers, but
            it has no skill marketplace API. Check the address, or pass{" "}
            <Code>--registry &lt;url&gt;</Code> with a registry that does.
          </p>
          <p>
            You see this message from <Code>search</Code>. From{" "}
            <Code>info</Code> and <Code>install</Code>, the same situation shows
            as <Code>Skill not found in the registry.</Code>, which is also what
            you get for a slug that does not exist. Run a <Code>search</Code> to
            tell the two apart.
          </p>
        </SubSection>

        <SubSection title="Exit code 3: the download did not match">
          <p>
            The message is &ldquo;The downloaded skill does not match what the
            registry indexed, so nothing was installed,&rdquo; followed by one
            line per problem (a file missing from the download, the wrong size,
            the wrong hash, an unsafe path). Nothing was written to disk. This
            is the safety check working, and there is no option to skip it. Do
            not try to work around it; report the skill and the lines shown to
            the registry&rsquo;s operator.
          </p>
        </SubSection>

        <SubSection title="Exit code 4: confirmation needed">
          <p>
            <Code>install</Code>, <Code>update</Code> and <Code>remove</Code>{" "}
            ask before they change anything. When the command is not running in
            an interactive terminal (a script, CI, a pipe), it cannot ask and
            exits with code 4 instead of guessing. Add <Code>--yes</Code> once
            you are sure of what it will do;{" "}
            <Code>sourceweft skills info &lt;slug&gt;</Code> shows you what you
            would be installing.
          </p>
        </SubSection>

        <SubSection title="GitHub rate limits">
          <p>
            <Code>
              GitHub refused the download (rate limit). Try again later.
            </Code>{" "}
            means GitHub answered with HTTP 403 or 429. The CLI downloads
            anonymously and has no option for a GitHub token, so wait and run
            the command again.
          </p>
          <p>
            If instead GitHub says the repository was not found, it may have
            been deleted or made private since it was indexed.
          </p>
        </SubSection>

        <SubSection title="Other messages">
          <BulletList>
            <li>
              <Code>already exists and was not installed by sourceweft</Code>: a
              directory with that name is already there. Move or remove it
              yourself. <Code>--force</Code> will not touch it.
            </li>
            <li>
              <Code>
                has local changes. Re-run with --force to overwrite them
              </Code>
              : you edited the installed skill. Keep your copy of the changes if
              you want them, then use <Code>--force</Code>.
            </li>
            <li>
              <Code>Could not reach the registry</Code>: check your network and
              the <Code>--registry</Code> address.
            </li>
            <li>
              <Code>Unknown agent</Code>: the message lists the valid ids; they
              match the table above.
            </li>
            <li>
              <Code>--dir installs into one place</Code>: with{" "}
              <Code>--dir</Code>, name a single agent.
            </li>
            <li>
              <Code>is not pinned to a GitHub commit</Code>: the registry has no
              GitHub commit for that skill, so the CLI cannot install it.
            </li>
          </BulletList>
        </SubSection>
      </Section>
    </main>
  );
}
