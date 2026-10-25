import { describe, expect, test } from "vitest";
import {
  robotsAllows,
  robotsPatternMatches,
  ROBOTS_MAX_PATTERN_LENGTH,
  ROBOTS_MAX_RULES,
  ROBOTS_MAX_WILDCARDS,
} from "./robots";

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

  test("wildcard semantics: prefix by default, whole path when anchored", () => {
    expect(robotsPatternMatches("/a*c", "/abbbc/zzz")).toBe(true);
    expect(robotsPatternMatches("/a*c$", "/abbbc/zzz")).toBe(false);
    expect(robotsPatternMatches("/a*c$", "/abbbc")).toBe(true);
    expect(robotsPatternMatches("/*.png$", "/x/y.png")).toBe(true);
    expect(robotsPatternMatches("/a*b*c", "/a-b-c")).toBe(true);
    expect(robotsPatternMatches("/a*b*c", "/a-c-b")).toBe(false);
    expect(robotsPatternMatches("*", "/anything")).toBe(true);
    expect(robotsPatternMatches("/x$", "/x")).toBe(true);
    expect(robotsPatternMatches("/x$", "/xy")).toBe(false);
    // The tail may not overlap the head part.
    expect(robotsPatternMatches("/ab*b$", "/ab")).toBe(false);
  });
});

describe("hostile robots.txt", () => {
  const path = "/" + "a".repeat(200);

  test("a catastrophic wildcard rule finishes at once", () => {
    const started = Date.now();
    const text = `User-agent: *\nDisallow: /*a*a*a*a*a*b\n`;
    expect(robotsAllows(text, path)).toBe(true);
    expect(Date.now() - started).toBeLessThan(200);
    const wild = `User-agent: *\nDisallow: /${"*a".repeat(ROBOTS_MAX_WILDCARDS)}b\n`;
    expect(robotsAllows(wild, path)).toBe(true);
    expect(Date.now() - started).toBeLessThan(400);
  });

  test("too many wildcards, too long a pattern or too many rules mean do not fetch", () => {
    const manyStars = `User-agent: *\nDisallow: /${"*a".repeat(ROBOTS_MAX_WILDCARDS + 1)}\n`;
    expect(robotsAllows(manyStars, "/")).toBe(false);
    const long = `User-agent: *\nAllow: /${"x".repeat(ROBOTS_MAX_PATTERN_LENGTH)}\n`;
    expect(robotsAllows(long, "/")).toBe(false);
    const rules = Array.from({ length: ROBOTS_MAX_RULES + 1 }, (_, i) => `Disallow: /p${i}`).join("\n");
    expect(robotsAllows(`User-agent: *\n${rules}`, "/")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /x", "/" + "y".repeat(3000))).toBe(false);
  });
});
