import assert from "node:assert/strict";
import test from "node:test";

import {
  ARTIFACT_AUDIO_MIME_TYPES,
  ARTIFACT_IMAGE_MIME_TYPES,
  ARTIFACT_LIMITS,
  ARTIFACT_MIME_TYPES,
  ARTIFACT_PREVIEW_IMAGE_MIME_TYPES,
  compactArtifactText,
  extensionForMimeType,
  extensionForPath,
  isArtifactAudioMimeType,
  isArtifactImageMimeType,
  isInlinePreviewableMimeType,
  mimeTypeForPath,
  normalizeMimeType,
  sanitizeArtifactFileBase,
  sanitizeArtifactStorageSegment,
} from "../src/artifact-files";

/* ========================================================================== */
/* 1.1 File name sanitizing: the six implementations that were collapsed      */
/* ========================================================================== */

/**
 * Verbatim copies of the six implementations this module replaced, kept only so
 * the tests below can state what each one *used* to answer. They are the
 * documentation of record for the naming divergence — do not "fix" them.
 *
 *  - `publish`     `sanitizeFileBase`                     (builtin-tool-publish-artifact/src/artifact-files.ts)
 *  - `slidesView`  `sanitizeSlidesFileBaseName`           (builtin-tool-publish-artifact/src/artifact-view.ts)
 *  - `image`       `sanitizeImageArtifactFileBase`        (builtin-tool-generate-image/src/image-tools.ts)
 *  - `storageSeg`  `safeStorageSegment`                   (builtin-tool-video-presentation/src/pipeline/util.ts)
 *  - `vpFile`      `sanitizeVideoPresentationFileBase`    (builtin-tool-video-presentation/src/video-presentation-files.ts)
 *  - `sourceKey`   inline storage-key pass                (apps/backend/src/modules/sources/storage.ts)
 */
const legacy = {
  publish: (value: string) => {
    const normalized = value
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "-")
      .replace(/\s+/g, " ")
      .replace(/\s*-\s*/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[\s.-]+|[\s.-]+$/g, "")
      .slice(0, 120);
    return normalized.length > 0 ? normalized : "artifact";
  },
  image: (value: string) => {
    const normalized = value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return normalized.length > 0 ? normalized : "generated-image";
  },
  storageSeg: (value: string) =>
    value
      .normalize("NFKC")
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "video-presentation",
  vpFile: (value: string) => {
    const sanitized = value
      .trim()
      .replace(/[/\\?%*:|"<>]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80);
    return sanitized || "video-presentation";
  },
  sourceKey: (value: string) => value.replace(/[^a-zA-Z0-9._-]+/g, "-"),
} as const;

type LegacyName = keyof typeof legacy;

type NamingCase = {
  /** What is being demonstrated. */
  readonly what: string;
  readonly input: string;
  /** What `sanitizeArtifactFileBase` now answers for every caller. */
  readonly unified: string;
  /** What each old implementation answered. Only listed where they disagreed. */
  readonly legacy?: Partial<Record<LegacyName, string>>;
};

/**
 * Every row where the old implementations disagreed with each other, plus the
 * rows where they already agreed (so a future change that breaks the agreement
 * is caught too).
 */
const NAMING_CASES: readonly NamingCase[] = [
  {
    what: "accented latin: three different names shipped for one title",
    input: "Résumé Q3",
    unified: "Résumé-Q3",
    legacy: {
      publish: "Résumé Q3",
      image: "r-sum-q3",
      storageSeg: "R-sum-Q3",
      vpFile: "Résumé-Q3",
      sourceKey: "R-sum-Q3",
    },
  },
  {
    what: "CJK titles survived in two implementations and were erased in two",
    input: "日本語タイトル",
    unified: "日本語タイトル",
    legacy: {
      publish: "日本語タイトル",
      image: "generated-image",
      storageSeg: "video-presentation",
      vpFile: "日本語タイトル",
      sourceKey: "-",
    },
  },
  {
    what: "case is preserved; only the image path used to lowercase",
    input: "CAPS Title",
    unified: "CAPS-Title",
    legacy: {
      publish: "CAPS Title",
      image: "caps-title",
      storageSeg: "CAPS-Title",
      vpFile: "CAPS-Title",
      sourceKey: "CAPS-Title",
    },
  },
  {
    what: "spaces always become dashes; publish used to keep literal spaces",
    input: "Q3 Report",
    unified: "Q3-Report",
    legacy: { publish: "Q3 Report" },
  },
  {
    what: "runs of whitespace collapse to a single dash",
    input: "Naïve  multi  spaces",
    unified: "Naïve-multi-spaces",
    legacy: {
      publish: "Naïve multi spaces",
      image: "na-ve-multi-spaces",
      storageSeg: "Na-ve-multi-spaces",
    },
  },
  {
    what: "emoji are preserved like any other non-ASCII glyph",
    input: "emoji 🎉 title",
    unified: "emoji-🎉-title",
    legacy: {
      publish: "emoji 🎉 title",
      image: "emoji-title",
      storageSeg: "emoji-title",
      sourceKey: "emoji-title",
    },
  },
  {
    what: "NFKC folds compatibility glyphs before sanitizing",
    input: "ﬁ ligature",
    unified: "fi-ligature",
    legacy: {
      publish: "fi ligature",
      image: "ligature",
      vpFile: "ﬁ-ligature",
      sourceKey: "-ligature",
    },
  },
  {
    what: "leading/trailing dots and spaces are stripped",
    input: "  ...spaced...  ",
    unified: "spaced",
    legacy: {
      image: "...spaced...",
      storageSeg: "...spaced...",
      vpFile: "...spaced...",
      sourceKey: "-...spaced...-",
    },
  },
  {
    what: "percent is hostile: it survived publish but not the video path",
    input: "50% growth",
    unified: "50-growth",
    legacy: { publish: "50% growth", image: "50-growth" },
  },
  {
    what: "path separators and shell metacharacters collapse to dashes",
    input: "a/b:c*d",
    unified: "a-b-c-d",
  },
  {
    what: "control characters never reach the name",
    input: "tab\tsep\u0000nul",
    unified: "tab-sep-nul",
  },
  {
    what: "interior dots are kept, so versioned names stay readable",
    input: "file.name.v2",
    unified: "file.name.v2",
  },
  {
    what: "a title made only of separators falls back",
    input: "---",
    unified: "artifact",
    legacy: {
      image: "generated-image",
      storageSeg: "video-presentation",
      vpFile: "video-presentation",
      sourceKey: "---",
    },
  },
  {
    what: "empty input falls back",
    input: "",
    unified: "artifact",
    legacy: {
      image: "generated-image",
      storageSeg: "video-presentation",
      vpFile: "video-presentation",
      sourceKey: "",
    },
  },
];

test("sanitizeArtifactFileBase resolves every documented naming divergence", () => {
  for (const namingCase of NAMING_CASES) {
    assert.equal(
      sanitizeArtifactFileBase(namingCase.input),
      namingCase.unified,
      namingCase.what,
    );
  }
});

test("the recorded legacy answers really are what the old code produced", () => {
  // Guards the table above from rotting into fiction: if someone edits a
  // `legacy` expectation to make a test pass, this fails instead.
  for (const namingCase of NAMING_CASES) {
    for (const [name, expected] of Object.entries(namingCase.legacy ?? {})) {
      assert.equal(
        legacy[name as LegacyName](namingCase.input),
        expected,
        `${name} on ${JSON.stringify(namingCase.input)}`,
      );
    }
  }
});

test("at least one old implementation disagreed on every divergence row", () => {
  for (const namingCase of NAMING_CASES) {
    const entries = Object.entries(namingCase.legacy ?? {});
    if (entries.length === 0) {
      continue;
    }
    assert.ok(
      entries.some(([, answer]) => answer !== namingCase.unified),
      `${namingCase.what}: recorded legacy answers all match the unified one, so this row documents nothing`,
    );
  }
});

test("fallback and maxLength are per-caller, not baked in", () => {
  assert.equal(
    sanitizeArtifactFileBase("", { fallback: "generated-image" }),
    "generated-image",
  );
  assert.equal(
    sanitizeArtifactFileBase("   ", { fallback: "video-presentation" }),
    "video-presentation",
  );
  assert.equal(
    sanitizeArtifactFileBase("x".repeat(150), { maxLength: 80 }).length,
    80,
  );
  assert.equal(sanitizeArtifactFileBase("x".repeat(150)).length, 120);
});

test("truncation never leaves a trailing separator", () => {
  // `slice` used to be the last step in all six implementations, so a cut that
  // landed on a dash shipped a name ending in `-`.
  assert.equal(
    sanitizeArtifactFileBase("abcdefgh ijkl", { maxLength: 9 }),
    "abcdefgh",
  );
  assert.equal(legacy.vpFile("abcdefgh ijkl").slice(0, 9), "abcdefgh-");
});

test("sanitizeArtifactStorageSegment keeps shell and key contexts ASCII", () => {
  // Storage segments, sandbox directory names and job ids are the callers that
  // genuinely cannot take unicode, so they get their own primitive.
  assert.equal(sanitizeArtifactStorageSegment("Résumé Q3"), "R-sum-Q3");
  assert.equal(
    sanitizeArtifactStorageSegment("日本語", { fallback: "video-presentation" }),
    "video-presentation",
  );
  assert.equal(sanitizeArtifactStorageSegment("a/b:c*d"), "a-b-c-d");
  assert.equal(sanitizeArtifactStorageSegment("x".repeat(150)).length, 80);
  for (const value of ["Résumé Q3", "日本語 🎉", "emoji 🎉 title"]) {
    assert.match(sanitizeArtifactStorageSegment(value), /^[A-Za-z0-9._-]+$/);
  }
});

test("unicode file bases stay ASCII once they reach a storage key", () => {
  // The second reason unicode is safe in file names: the backend's storage-key
  // builder re-sanitizes. Modelled here with its exact expression.
  const fileName = `${sanitizeArtifactFileBase("Résumé Q3")}.pdf`;
  assert.equal(fileName, "Résumé-Q3.pdf");
  assert.match(legacy.sourceKey(fileName), /^[A-Za-z0-9._-]+$/);
});

/* ========================================================================== */
/* 1.2 MIME and extension resolution                                          */
/* ========================================================================== */

test("mimeTypeForPath infers common artifact file types", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["/workspace/deck.pptx", ARTIFACT_MIME_TYPES.pptx],
    ["/workspace/report.pdf", ARTIFACT_MIME_TYPES.pdf],
    ["/workspace/report.xlsx", ARTIFACT_MIME_TYPES.xlsx],
    ["/workspace/table.csv", ARTIFACT_MIME_TYPES.csv],
    ["/workspace/archive.zip", ARTIFACT_MIME_TYPES.zip],
    ["/workspace/image.png", ARTIFACT_MIME_TYPES.png],
    ["/workspace/image.JPG", ARTIFACT_MIME_TYPES.jpeg],
    ["/workspace/image.webp", ARTIFACT_MIME_TYPES.webp],
    ["/workspace/page.html", ARTIFACT_MIME_TYPES.html],
    ["/workspace/unknown.bin", ARTIFACT_MIME_TYPES.binary],
    ["/workspace/no-extension", ARTIFACT_MIME_TYPES.binary],
  ];
  for (const [path, expected] of cases) {
    assert.equal(mimeTypeForPath(path), expected, path);
  }
});

test("extensionForPath lowercases and tolerates both separators", () => {
  assert.equal(extensionForPath("C:\\tmp\\Deck.PPTX"), ".pptx");
  assert.equal(extensionForPath("/tmp/deck"), "");
  assert.equal(extensionForPath("/tmp/archive.tar.gz"), ".gz");
});

test("normalizeMimeType strips parameters and casing", () => {
  assert.equal(normalizeMimeType("IMAGE/PNG"), "image/png");
  assert.equal(normalizeMimeType("text/html; charset=utf-8"), "text/html");
  assert.equal(normalizeMimeType("  audio/mpeg  "), "audio/mpeg");
  assert.equal(normalizeMimeType(undefined), "");
  assert.equal(normalizeMimeType(null), "");
});

/**
 * `imageExtensionForMimeType` (video pipeline) and `extensionForMimeType`
 * (video audio) both used `String.includes`, so any MIME type that merely
 * *contained* a format name was classified as that format.
 */
const SUBSTRING_MATCH_CASES: ReadonlyArray<{
  readonly what: string;
  readonly mimeType: string;
  readonly fallback: string;
  readonly unified: string;
  readonly legacySubstring: string;
}> = [
  {
    what: "a non-image type containing 'gif' was classified as a GIF",
    mimeType: "application/x-gif-thing",
    fallback: ".jpg",
    unified: ".jpg",
    legacySubstring: ".gif",
  },
  {
    what: "a container type containing 'wav' was classified as WAV audio",
    mimeType: "application/x-wav-container",
    fallback: ".mp3",
    unified: ".mp3",
    legacySubstring: ".wav",
  },
  {
    what: "'image/png' matched correctly by both, and still does",
    mimeType: "image/png",
    fallback: ".jpg",
    unified: ".png",
    legacySubstring: ".png",
  },
  {
    what: "parameters are stripped before matching",
    mimeType: "image/jpeg; charset=binary",
    fallback: ".png",
    unified: ".jpg",
    legacySubstring: ".jpg",
  },
  {
    what: "octet-stream carries no format information, so the fallback wins",
    mimeType: "application/octet-stream",
    fallback: ".png",
    unified: ".png",
    legacySubstring: ".jpg",
  },
];

test("extensionForMimeType matches exactly instead of by substring", () => {
  for (const matchCase of SUBSTRING_MATCH_CASES) {
    assert.equal(
      extensionForMimeType(matchCase.mimeType, matchCase.fallback),
      matchCase.unified,
      matchCase.what,
    );
  }
});

test("extensionForMimeType honours each caller's fallback", () => {
  // The three callers disagreed on what an unrecognized type should become,
  // and each of them was right for its own context.
  assert.equal(extensionForMimeType("application/x-weird", ".png"), ".png");
  assert.equal(extensionForMimeType("application/x-weird", ".jpg"), ".jpg");
  assert.equal(extensionForMimeType("application/x-weird", ".mp3"), ".mp3");
  assert.equal(extensionForMimeType(undefined, ".png"), ".png");
  assert.equal(extensionForMimeType(null, ".mp3"), ".mp3");
});

test("provider MIME aliases resolve to the canonical extension", () => {
  assert.equal(extensionForMimeType("image/jpg", ".png"), ".jpg");
  assert.equal(extensionForMimeType("audio/mp3", ".mp3"), ".mp3");
  assert.equal(extensionForMimeType("audio/x-wav", ".mp3"), ".wav");
});

test("the extension and MIME tables agree in both directions", () => {
  for (const mimeType of Object.values(ARTIFACT_MIME_TYPES)) {
    if (mimeType === ARTIFACT_MIME_TYPES.binary) {
      // "no information" — intentionally has no canonical extension.
      assert.equal(extensionForMimeType(mimeType, ".png"), ".png");
      continue;
    }
    const extension = extensionForMimeType(mimeType, "");
    assert.notEqual(extension, "", `${mimeType} has no canonical extension`);
    assert.equal(
      mimeTypeForPath(`file${extension}`),
      mimeType,
      `${mimeType} -> ${extension} does not round-trip`,
    );
  }
});

test("allowlists are explicit and narrower than the extension table", () => {
  // The old `imageExtensionForMimeType` accepted gif and svg while
  // `SUPPORTED_IMAGE_MIME_TYPES` rejected them: knowing an extension for a type
  // is not the same as accepting it as an artifact.
  assert.equal(isArtifactImageMimeType("image/gif"), false);
  assert.equal(isArtifactImageMimeType("image/svg+xml"), false);
  assert.equal(extensionForMimeType("image/gif", ".jpg"), ".gif");
  assert.equal(extensionForMimeType("image/svg+xml", ".jpg"), ".svg");

  assert.equal(isArtifactImageMimeType("image/png"), true);
  assert.equal(isArtifactImageMimeType("IMAGE/PNG; charset=binary"), true);
  assert.equal(isArtifactAudioMimeType("audio/mpeg"), true);
  assert.equal(isArtifactAudioMimeType("image/png"), false);

  assert.deepEqual(
    [...ARTIFACT_IMAGE_MIME_TYPES].sort(),
    [...ARTIFACT_PREVIEW_IMAGE_MIME_TYPES].sort(),
  );
  for (const mimeType of [
    ...ARTIFACT_IMAGE_MIME_TYPES,
    ...ARTIFACT_AUDIO_MIME_TYPES,
  ]) {
    assert.notEqual(
      extensionForMimeType(mimeType, ""),
      "",
      `${mimeType} is allowed but has no extension`,
    );
  }
});

test("isInlinePreviewableMimeType keeps inline preview policy centralized", () => {
  assert.equal(isInlinePreviewableMimeType("image/png"), true);
  assert.equal(isInlinePreviewableMimeType("text/html; charset=utf-8"), true);
  assert.equal(isInlinePreviewableMimeType("application/pdf"), true);
  assert.equal(isInlinePreviewableMimeType("application/json"), true);
  assert.equal(isInlinePreviewableMimeType("application/zip"), false);
  assert.equal(isInlinePreviewableMimeType(ARTIFACT_MIME_TYPES.xlsx), false);
});

/* ========================================================================== */
/* 1.3 Size limits                                                            */
/* ========================================================================== */

test("ARTIFACT_LIMITS keeps the values the scattered constants had", () => {
  assert.equal(ARTIFACT_LIMITS.fileBytes, 100 * 1024 * 1024);
  assert.equal(ARTIFACT_LIMITS.pptxBytes, 100 * 1024 * 1024);
  assert.equal(ARTIFACT_LIMITS.imageBytes, 50 * 1024 * 1024);
  assert.equal(ARTIFACT_LIMITS.previewImageBytes, 5 * 1024 * 1024);
});

test("limit ordering encodes the intended policy", () => {
  // An image artifact is decoded and thumbnailed, so it is capped below a plain
  // file; a thumbnail is an enhancement, so it is capped far below both.
  assert.ok(ARTIFACT_LIMITS.imageBytes < ARTIFACT_LIMITS.fileBytes);
  assert.ok(ARTIFACT_LIMITS.previewImageBytes < ARTIFACT_LIMITS.imageBytes);
  assert.equal(ARTIFACT_LIMITS.pptxBytes, ARTIFACT_LIMITS.fileBytes);
});

/* ========================================================================== */
/* 1.6 compactArtifactText                                                    */
/* ========================================================================== */

test("compactArtifactText collapses whitespace and ellipsizes", () => {
  assert.equal(compactArtifactText("  a   b \n c  "), "a b c");
  assert.equal(compactArtifactText("abcdefghij", 10), "abcdefghij");
  assert.equal(compactArtifactText("abcdefghijk", 10), "abcdefg...");
  assert.equal(compactArtifactText("abcdef ghijk", 10), "abcdef...");
  assert.equal(compactArtifactText("x".repeat(200)).length, 120);
});
