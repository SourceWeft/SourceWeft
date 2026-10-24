import { describe, expect, test } from "vitest";
import { robotsAllows } from "./robots";

describe("robotsAllows", () => {
  test("an empty or rule-less file allows everything", () => {
    expect(robotsAllows("", "/")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow:", "/anything")).toBe(true);
  });

  test("Disallow: / stops the wildcard group", () => {
    expect(robotsAllows("User-agent: *\nDisallow: /", "/")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /", "/favicon.ico")).toBe(false);
  });

  test("our own group wins over the wildcard group", () => {
    const text = `User-agent: *\nDisallow: /\n\nUser-agent: SourceWeftIconFetcher\nAllow: /\n`;
    expect(robotsAllows(text, "/")).toBe(true);
    const deny = `User-agent: *\nAllow: /\n\nUser-agent: sourcewefticonfetcher\nDisallow: /`;
    expect(robotsAllows(deny, "/")).toBe(false);
  });

  test("the longest matching rule wins and Allow wins a tie", () => {
    const text = `User-agent: *\nDisallow: /assets/\nAllow: /assets/icons/\n`;
    expect(robotsAllows(text, "/assets/app.js")).toBe(false);
    expect(robotsAllows(text, "/assets/icons/logo.png")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow: /x\nAllow: /x", "/x")).toBe(true);
  });

  test("wildcards and end anchors work, comments are ignored", () => {
    const text = `# comment\nUser-agent: *\nDisallow: /*.png$ # no pngs\n`;
    expect(robotsAllows(text, "/a/b.png")).toBe(false);
    expect(robotsAllows(text, "/a/b.png?x=1")).toBe(true);
    expect(robotsAllows(text, "/a/b.jpg")).toBe(true);
  });

  test("consecutive User-agent lines share one group", () => {
    const text = `User-agent: googlebot\nUser-agent: sourcewefticonfetcher\nDisallow: /private\n`;
    expect(robotsAllows(text, "/private/x")).toBe(false);
    expect(robotsAllows(text, "/public")).toBe(true);
  });
});
