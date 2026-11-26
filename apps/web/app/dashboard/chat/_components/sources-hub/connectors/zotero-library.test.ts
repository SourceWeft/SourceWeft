import { describe, expect, test } from "vitest";

import {
  isAcceptableZoteroApiKey,
  isAcceptableZoteroLibraryId,
  zoteroLibraryRef,
} from "./zotero-library";

describe("isAcceptableZoteroLibraryId", () => {
  test.each(["1", "2205533", "123456789012"])("accepts %s", (value) => {
    expect(isAcceptableZoteroLibraryId(value)).toBe(true);
  });

  test.each(["", "0", "012", "12a", "-1", "1.5", " 12", "1234567890123", "١٢"])(
    "rejects %j",
    (value) => {
      expect(isAcceptableZoteroLibraryId(value)).toBe(false);
    },
  );
});

describe("isAcceptableZoteroApiKey", () => {
  test("accepts printable ASCII of any case", () => {
    expect(isAcceptableZoteroApiKey("AbC123xyz")).toBe(true);
    expect(isAcceptableZoteroApiKey("a".repeat(2000))).toBe(true);
  });

  test.each(["", "has space", "tab\there", "new\nline", "é", "a".repeat(2001)])(
    "rejects %j",
    (value) => {
      expect(isAcceptableZoteroApiKey(value)).toBe(false);
    },
  );
});

describe("zoteroLibraryRef", () => {
  test("derives the credential username from the connector config", () => {
    expect(zoteroLibraryRef({ libraryType: "user", libraryId: "42" })).toBe(
      "users/42",
    );
    expect(
      zoteroLibraryRef({ libraryType: "group", libraryId: "2205533" }),
    ).toBe("groups/2205533");
  });

  test("returns null for missing or malformed library details", () => {
    expect(zoteroLibraryRef({})).toBeNull();
    expect(
      zoteroLibraryRef({ libraryType: "team", libraryId: "1" }),
    ).toBeNull();
    expect(
      zoteroLibraryRef({ libraryType: "user", libraryId: "0" }),
    ).toBeNull();
    expect(zoteroLibraryRef({ libraryType: "user", libraryId: 5 })).toBeNull();
  });
});
