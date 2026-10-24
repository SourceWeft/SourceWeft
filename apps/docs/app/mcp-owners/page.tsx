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
} from "../cli/parts";

export const metadata: Metadata = {
  title: "Claim your MCP server | SourceWeft Docs",
  description:
    "How the publisher of an MCP server claims its SourceWeft catalog page, corrects what it shows, and publishes its tool list without sharing credentials.",
};

const CONTENTS = [
  ["who", "Who can claim"],
  ["github", "Claim with GitHub"],
  ["domain", "Claim with your domain"],
  ["corrections", "What a claimed listing lets you change"],
  ["tools", "Publish your tool list"],
  ["trust", "What is and is not trusted"],
  ["revoke", "Giving a claim up"],
] as const;

export default function McpOwnersPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 pb-24 pt-10">
      <nav className="mb-10 text-sm opacity-70">
        <Link href="/" className="hover:underline">
          SourceWeft Docs
        </Link>{" "}
        / Claim your MCP server
      </nav>

      <header className="flex flex-col gap-4">
        <h1 className="text-4xl font-bold tracking-tight">
          Claim your MCP server
        </h1>
        <p className="text-lg leading-8 opacity-80">
          The SourceWeft MCP catalog is built from the public MCP registry. If
          you publish one of the servers in it, you can claim its page, correct
          what it shows and publish the list of tools your server offers, even
          when the server only answers signed-in callers.
        </p>
        <p className="leading-7">
          Claiming is self-service. You prove that you control the identity the
          server is published under: a GitHub account or organization, or a
          domain. SourceWeft never asks for your server&rsquo;s credentials.
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

      <Section id="who" title="Who can claim">
        <p>
          Every catalog entry carries the name it was registered under in the
          MCP registry. That name decides how it can be claimed:
        </p>
        <DataTable
          head={["Registry name", "Example", "Claim with"]}
          rows={[
            [
              <Code key="gh">io.github.&lt;owner&gt;/&lt;server&gt;</Code>,
              <Code key="gh-ex">io.github.acme/weather</Code>,
              "Your GitHub account, or the owner role in the organization",
            ],
            [
              "A reverse domain name",
              <Code key="dom-ex">com.notion/mcp</Code>,
              <>
                A DNS record or a file on <Code>notion.com</Code>
              </>,
            ],
            [
              "Any name whose declared repository is on github.com",
              <Code key="repo-ex">com.example/server</Code> ,
              "The repository owner's GitHub account or organization, or the domain",
            ],
          ]}
        />
        <p>
          Sign in to SourceWeft, open the server&rsquo;s catalog page and choose{" "}
          <strong>Claim this server</strong>. The page offers only the methods
          that apply to that entry. Several people may hold a verified claim on
          the same server (an organization&rsquo;s owners, for instance); each
          of them can edit the listing.
        </p>
      </Section>

      <Section id="github" title="Claim with GitHub">
        <p>
          Link your GitHub account to SourceWeft (Settings → Security) if you
          have not already. The claim is then decided at once:
        </p>
        <BulletList>
          <li>
            <strong>A personal account.</strong> Your linked GitHub account must
            be the account the server is published under. GitHub is asked who
            that account is; the two are compared by GitHub&rsquo;s own account
            id, so a rename does not matter.
          </li>
          <li>
            <strong>An organization.</strong> You must be an <em>owner</em> of
            the organization (GitHub&rsquo;s <Code>admin</Code> role). A plain
            member cannot claim. SourceWeft reads your membership through your
            own GitHub link; GitHub only shows it to a link that has the{" "}
            <Code>read:org</Code> permission, so you may be asked to grant that
            once. The permission is used for this one check.
          </li>
        </BulletList>
        <Note title="Why not a verification file in the repository?">
          <p>
            Anyone who can push to a repository could add a file to it, and
            pushing is not owning. SourceWeft asks GitHub who owns the account
            instead.
          </p>
        </Note>
      </Section>

      <Section id="domain" title="Claim with your domain">
        <p>
          For a server registered under a reverse domain name, SourceWeft issues
          you a one-time token when you start the claim. It looks like{" "}
          <Code>sourceweft-claim-&lt;32 hex characters&gt;</Code>, is bound to
          your account and to that server, and expires after seven days. Publish
          it in one of two places, then press <strong>Verify</strong>:
        </p>
        <SubSection title="DNS TXT record">
          <p>
            Create a TXT record whose name is <Code>_sourceweft-claim</Code>{" "}
            under your domain and whose value is the token, exactly:
          </p>
          <CodeBlock>{`_sourceweft-claim.notion.com.   TXT   "sourceweft-claim-0123456789abcdef0123456789abcdef"`}</CodeBlock>
          <p>
            DNS changes can take a while to spread; if verification does not
            find the record yet, wait and try again. Other TXT records at the
            same name are ignored.
          </p>
        </SubSection>
        <SubSection title="Well-known file">
          <p>
            Serve the token as the whole body of a plain-text file at this
            exact address over HTTPS:
          </p>
          <CodeBlock>{`https://notion.com/.well-known/sourceweft-claim`}</CodeBlock>
          <p>
            The file may end with a newline. Redirects are not followed, so the
            file must be served at that path on the namespace domain itself.
          </p>
        </SubSection>
        <p>
          Verification reads exactly that DNS record or that file and nothing
          else on your domain. Once verified, you can remove the record or the
          file. The token is shown once, when the claim starts; if you lose it,
          start the claim again for a new one.
        </p>
      </Section>

      <Section id="corrections" title="What a claimed listing lets you change">
        <p>
          A verified owner can set the following on the server&rsquo;s page.
          Each is shown on top of what the registry says, and marked as the
          owner&rsquo;s. The registry&rsquo;s own data stays stored underneath:
          clearing a field shows the registry&rsquo;s value again.
        </p>
        <BulletList>
          <li>Logo URL</li>
          <li>Short description (the one-line summary) and long description</li>
          <li>
            Documentation link, shown on the page. SourceWeft shows it as a
            link and uses it as a declared fact; it never reads your site.
          </li>
          <li>Homepage and source repository links</li>
          <li>
            A <strong>deprecated</strong> mark for a server you no longer
            maintain
          </li>
          <li>
            The tool list (see below)
          </li>
        </BulletList>
        <p>
          The registry keeps syncing the entry; a sync never overwrites what
          you set.
        </p>
      </Section>

      <Section id="tools" title="Publish your tool list">
        <p>
          A remote server that refuses anonymous callers shows no tools in the
          catalog, because nothing but a real credential can list them. As the
          owner you can produce that list on your own machine, with your own
          credentials, and upload only the list.
        </p>
        <p>
          Install the SourceWeft command line (
          <Link href="/cli" className="underline">
            see its documentation
          </Link>
          ) and point it at your server. The credentials you pass stay on your
          machine: they are sent to your server only, and the file the command
          writes contains the endpoint without its query string and no header.
        </p>
        <CodeBlock>{`# A remote server
sourceweft mcp inspect --url https://mcp.example.com/mcp \\
  --header "Authorization: Bearer <your token>"

# A server you run locally over stdio
sourceweft mcp inspect --stdio "npx -y @example/mcp-server"`}</CodeBlock>
        <p>
          The command connects, performs the MCP handshake and lists the tools
          (up to 200, descriptions cut at 2,000 characters), then writes{" "}
          <Code>mcp-tools.json</Code>. Read it over; then upload it with an API
          key of the SourceWeft account that holds the claim (Settings → API
          keys):
        </p>
        <CodeBlock>{`sourceweft mcp submit-tools com.example/server mcp-tools.json --api-key <key>`}</CodeBlock>
        <p>
          The page then shows your tool list. You can replace it any time by
          running the two commands again, or remove it from the listing
          settings.
        </p>
      </Section>

      <Section id="trust" title="What is and is not trusted">
        <BulletList>
          <li>
            Your corrections are shown as yours. Fields you set are listed in
            the server&rsquo;s manifest under <Code>owner</Code> with{" "}
            <Code>source: &quot;owner&quot;</Code>.
          </li>
          <li>
            Tools you submit are stored with{" "}
            <Code>source: &quot;owner-submitted&quot;</Code> and shown with an
            unknown risk level, like tools read from a server directly. When a
            member runs one of them through SourceWeft, it asks for confirmation
            first; a submitted list never lets a tool run unattended.
          </li>
          <li>
            A claim changes what the page shows. It does not change the{" "}
            <em>Verified</em> or <em>Official</em> marks, which come from the
            registry and from SourceWeft respectively.
          </li>
        </BulletList>
      </Section>

      <Section id="revoke" title="Giving a claim up">
        <p>
          You can give a claim up from the listing settings at any time. While
          no verified owner is left, your corrections stop showing and the
          registry&rsquo;s data is shown again; they are kept, so a later
          verified owner finds them. SourceWeft may also revoke a claim that
          turns out to be wrong; write to{" "}
          <a href="mailto:support@sourceweft.com" className="underline">
            support@sourceweft.com
          </a>{" "}
          if a server you publish was claimed by someone else.
        </p>
      </Section>
    </main>
  );
}
