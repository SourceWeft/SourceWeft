import { describe, expect, it } from "vitest";
import { parentOfWirePath, shortenHomePath } from "./local-path";

describe("shortenHomePath", () => {
  it("abbreviates a macOS, Linux or Windows home directory", () => {
    expect(shortenHomePath("/Users/me/SourceWeft/2026-11-15")).toBe(
      "~/SourceWeft/2026-11-15",
    );
    expect(shortenHomePath("/home/me/work/proj")).toBe("~/work/proj");
    expect(shortenHomePath("C:/Users/me/work/proj")).toBe("~/work/proj");
    expect(shortenHomePath("d:/Users/me/work")).toBe("~/work");
  });

  it("shows the home directory itself as ~", () => {
    expect(shortenHomePath("/Users/me")).toBe("~");
    expect(shortenHomePath("/home/me/")).toBe("~");
    expect(shortenHomePath("C:/Users/me")).toBe("~");
  });

  it("leaves every other path unchanged", () => {
    for (const path of [
      "/Volumes/Work/proj",
      "/Users",
      "/home",
      "/opt/home/me/proj",
      "D:/work/proj",
      "C:/Users",
      "/var/Users/me/proj",
      "",
    ])
      expect(shortenHomePath(path)).toBe(path);
  });

  it("does not treat a longer first segment as the home prefix", () => {
    expect(shortenHomePath("/Usersx/me/proj")).toBe("/Usersx/me/proj");
    expect(shortenHomePath("/homes/me/proj")).toBe("/homes/me/proj");
  });
});

describe("parentOfWirePath", () => {
  it("returns the containing directory", () => {
    expect(parentOfWirePath("/Users/me/work/proj")).toBe("/Users/me/work");
    expect(parentOfWirePath("C:/Users/me/work/proj")).toBe("C:/Users/me/work");
    expect(parentOfWirePath("/Users/me/work/proj/")).toBe("/Users/me/work");
  });

  it("stops at the root", () => {
    expect(parentOfWirePath("/proj")).toBe("/");
    expect(parentOfWirePath("C:/proj")).toBe("C:/");
    expect(parentOfWirePath("/")).toBe("/");
    expect(parentOfWirePath("C:/")).toBe("C:/");
  });

  it("has no parent for a path without a separator", () => {
    expect(parentOfWirePath("proj")).toBe("");
    expect(parentOfWirePath("")).toBe("");
  });
});
