import assert from "node:assert/strict";
import { test } from "vitest";
import {
  firstHttpsIconSrc,
  githubAvatarUrl,
  githubOwner,
  iconBeforeFavicon,
  isGithubNamespace,
  namespaceDomain,
  resolveIcon,
} from "./chain";

test("namespace domain: reverse-DNS labels reversed, never for io.github, never the endpoint", () => {
  assert.equal(namespaceDomain("com.notion"), "notion.com");
  assert.equal(namespaceDomain("ai.smithery"), "smithery.ai");
  assert.equal(namespaceDomain("com.example.sub"), "sub.example.com");
  assert.equal(namespaceDomain("Com.Notion"), "notion.com");
  assert.equal(namespaceDomain("io.github.acme"), undefined);
  assert.equal(namespaceDomain("io.github"), undefined);
  // Not reverse-DNS at all: a bare word, an empty label, a bad character.
  assert.equal(namespaceDomain("notion"), undefined);
  assert.equal(namespaceDomain("com..notion"), undefined);
  assert.equal(namespaceDomain("com.not ion"), undefined);
  assert.equal(namespaceDomain("com.-notion"), undefined);
  assert.equal(isGithubNamespace("io.github.acme"), true);
  assert.equal(isGithubNamespace("com.github"), false);
});

test("github owner: the io.github namespace owner, else the declared github.com repository's owner", () => {
  assert.equal(githubOwner({ namespace: "io.github.Acme-Labs" }), "Acme-Labs");
  // The namespace owner wins over the declared repository.
  assert.equal(
    githubOwner({
      namespace: "io.github.acme",
      repositoryUrl: "https://github.com/other/repo",
    }),
    "acme",
  );
  assert.equal(
    githubOwner({
      namespace: "com.notion",
      repositoryUrl: "https://github.com/makenotion/notion-next",
    }),
    "makenotion",
  );
  // Not on github.com, not https, not a valid login, no repository.
  assert.equal(
    githubOwner({
      namespace: "com.acme",
      repositoryUrl: "https://gitlab.com/acme/repo",
    }),
    undefined,
  );
  assert.equal(
    githubOwner({
      namespace: "com.acme",
      repositoryUrl: "http://github.com/acme/repo",
    }),
    undefined,
  );
  assert.equal(
    githubOwner({
      namespace: "com.acme",
      repositoryUrl: "https://github.com/-bad-/repo",
    }),
    undefined,
  );
  assert.equal(githubOwner({ namespace: "com.acme" }), undefined);
  assert.equal(githubOwner({ namespace: "io.github.-x" }), undefined);
  assert.equal(githubAvatarUrl("acme"), "https://github.com/acme.png?size=128");
});

test("icons arrays: the first absolute https src without credentials", () => {
  assert.equal(
    firstHttpsIconSrc([
      { src: "http://insecure.test/a.png" },
      { src: "https://user:pw@cdn.test/b.png" },
      "not-an-object",
      { src: 42 },
      { src: "https://cdn.test/c.png", mimeType: "image/png" },
    ]),
    "https://cdn.test/c.png",
  );
  assert.equal(firstHttpsIconSrc(undefined), undefined);
  assert.equal(firstHttpsIconSrc({ src: "https://cdn.test/c.png" }), undefined);
  assert.equal(firstHttpsIconSrc([{ src: "nope" }]), undefined);
});

test("chain order: registry, server-info, github-avatar, github-registry, favicon, placeholder", () => {
  const everything = {
    namespace: "com.notion",
    registryIconUrl: "https://registry.test/icon.png",
    serverInfoIcons: [{ src: "https://notion.test/server.png" }],
    repositoryUrl: "https://github.com/makenotion/notion-next",
    githubRegistryAvatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
  };
  assert.deepEqual(resolveIcon(everything, "https://assets.test/f.png"), {
    iconUrl: "https://registry.test/icon.png",
    iconSource: "registry",
  });
  const { registryIconUrl: _r, ...noRegistry } = everything;
  assert.deepEqual(resolveIcon(noRegistry, "https://assets.test/f.png"), {
    iconUrl: "https://notion.test/server.png",
    iconSource: "server-info",
  });
  const { serverInfoIcons: _s, ...noServerInfo } = noRegistry;
  assert.deepEqual(resolveIcon(noServerInfo, "https://assets.test/f.png"), {
    iconUrl: "https://github.com/makenotion.png?size=128",
    iconSource: "github-avatar",
  });
  const { repositoryUrl: _p, ...noRepository } = noServerInfo;
  assert.deepEqual(resolveIcon(noRepository, "https://assets.test/f.png"), {
    iconUrl: "https://avatars.githubusercontent.com/u/1?v=4",
    iconSource: "github-registry",
  });
  const { githubRegistryAvatarUrl: _g, ...nothingStatic } = noRepository;
  assert.equal(iconBeforeFavicon(nothingStatic), undefined);
  assert.deepEqual(resolveIcon(nothingStatic, "https://assets.test/f.png"), {
    iconUrl: "https://assets.test/f.png",
    iconSource: "favicon",
  });
  assert.deepEqual(resolveIcon(nothingStatic), { iconSource: "placeholder" });
});

test("an io.github entry is a github-avatar before any favicon", () => {
  assert.deepEqual(
    resolveIcon({ namespace: "io.github.acme" }, "https://assets.test/f.png"),
    {
      iconUrl: "https://github.com/acme.png?size=128",
      iconSource: "github-avatar",
    },
  );
});

test("a github-registry avatar is taken only from GitHub's hosts over https", () => {
  for (const bad of [
    "https://evil.test/avatar.png",
    "http://github.com/acme.png",
    "https://user:pw@github.com/acme.png",
    42,
    null,
  ]) {
    assert.deepEqual(
      resolveIcon({ namespace: "com.acme", githubRegistryAvatarUrl: bad }),
      { iconSource: "placeholder" },
    );
  }
  assert.equal(
    resolveIcon({
      namespace: "com.acme",
      githubRegistryAvatarUrl: "https://github.com/acme.png",
    }).iconSource,
    "github-registry",
  );
});
