import assert from "node:assert/strict";
import { test } from "node:test";
import { generateProxyEnvVars } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";

function onPlatform<T>(platform: string, run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", {
    ...descriptor,
    value: platform,
  });
  try {
    return run();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

function env(httpPort?: number, socksPort?: number, token?: string) {
  return Object.fromEntries(
    generateProxyEnvVars(
      httpPort,
      socksPort,
      undefined,
      token,
      true,
      "test-command",
    ).map((assignment) => {
      const at = assignment.indexOf("=");
      return [assignment.slice(0, at), assignment.slice(at + 1)];
    }),
  );
}

test("installed runtime advertises its macOS IPv4 mux without changing credentials or bypass policy", () => {
  onPlatform("darwin", () => {
    const values = env(7311, 7311, "test-proxy-token");
    for (const name of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "http_proxy",
      "https_proxy",
      "ALL_PROXY",
      "all_proxy",
      "GRPC_PROXY",
      "grpc_proxy",
      "FTP_PROXY",
      "ftp_proxy",
      "DOCKER_HTTP_PROXY",
      "DOCKER_HTTPS_PROXY",
    ]) {
      const url = new URL(values[name]!);
      assert.equal(url.hostname, "127.0.0.1", name);
      assert.equal(url.port, "7311", name);
      assert.equal(url.password, "test-proxy-token", name);
      assert.ok(url.username.length > 0, name);
    }
    assert.equal(values.RSYNC_PROXY, "127.0.0.1:7311");
    assert.equal(values.CLOUDSDK_PROXY_ADDRESS, "127.0.0.1");
    assert.equal(values.CLOUDSDK_PROXY_PASSWORD, "test-proxy-token");
    assert.equal(
      values.NO_PROXY,
      "localhost,127.0.0.1,::1,169.254.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16",
    );
    assert.equal(values.no_proxy, values.NO_PROXY);
  });
});

test("external and non-shared macOS proxy settings preserve their existing host semantics", () => {
  onPlatform("darwin", () => {
    for (const values of [env(7311, 7311), env(7311, 7312, "test-token")]) {
      assert.equal(new URL(values.HTTP_PROXY!).hostname, "localhost");
      assert.equal(new URL(values.FTP_PROXY!).hostname, "localhost");
    }
  });
});

test("Linux and Windows proxy endpoints are unchanged", () => {
  for (const platform of ["linux", "win32"]) {
    onPlatform(platform, () => {
      const values = env(7311, 7311, "test-token");
      assert.equal(new URL(values.HTTP_PROXY!).hostname, "localhost", platform);
      assert.equal(new URL(values.FTP_PROXY!).hostname, "localhost", platform);
      assert.equal(values.CLOUDSDK_PROXY_ADDRESS, "localhost", platform);
    });
  }
});

test("SOCKS-only and no-proxy configurations retain their original contracts", () => {
  onPlatform("darwin", () => {
    const socks = env(undefined, 7311, "test-token");
    assert.equal(socks.HTTP_PROXY, undefined);
    assert.equal(new URL(socks.ALL_PROXY!).protocol, "socks5h:");
    assert.equal(new URL(socks.ALL_PROXY!).hostname, "localhost");
    assert.equal(env().ALL_PROXY, undefined);
  });
});
