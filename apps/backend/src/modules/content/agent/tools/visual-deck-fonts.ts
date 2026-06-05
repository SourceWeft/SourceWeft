import { config } from "../../../../shared/config";

export type VisualDeckFontKey =
  | "inter"
  | "noto-sans-sc"
  | "noto-serif"
  | "noto-serif-sc";
export type VisualDeckFontRole = "body" | "heading";

export type VisualDeckFontConfig = {
  bytes: number;
  cssFamily: string;
  fallback: string;
  family: string;
  fileName: string;
  fontPath: string;
  key: VisualDeckFontKey;
  licensePath: string;
  roles: readonly VisualDeckFontRole[];
  sha256: string;
  weights: readonly number[];
};

const defaultFontAssetBaseUrl = "https://assets.sourceweft.com";

export const visualDeckFontRegistry = {
  inter: {
    key: "inter",
    family: "Inter",
    cssFamily: "Inter",
    weights: [400, 600, 700, 800, 900],
    roles: ["body", "heading"],
    fallback: "Arial, Helvetica, sans-serif",
    fileName: "Inter-29160a80ff49ddca.ttf",
    fontPath: "ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf",
    licensePath: "ofl/inter/OFL.txt",
    sha256:
      "29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031",
    bytes: 876576,
  },
  "noto-sans-sc": {
    key: "noto-sans-sc",
    family: "Noto Sans SC",
    cssFamily: "Noto Sans SC",
    weights: [400, 500, 700, 800, 900],
    roles: ["body", "heading"],
    fallback: '"Microsoft YaHei", "PingFang SC", sans-serif',
    fileName: "NotoSansSC-a3041811a78c361b.ttf",
    fontPath: "ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf",
    licensePath: "ofl/notosanssc/OFL.txt",
    sha256:
      "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da",
    bytes: 17772300,
  },
  "noto-serif": {
    key: "noto-serif",
    family: "Noto Serif",
    cssFamily: "Noto Serif",
    weights: [400, 600, 700, 800, 900],
    roles: ["heading"],
    fallback: "Georgia, serif",
    fileName: "NotoSerif-4d8e676142465686.ttf",
    fontPath: "ofl/notoserif/NotoSerif%5Bwdth%2Cwght%5D.ttf",
    licensePath: "ofl/notoserif/OFL.txt",
    sha256:
      "4d8e6761424656867019081a1a01336f3cb086982682698714054fc33f782713",
    bytes: 1887192,
  },
  "noto-serif-sc": {
    key: "noto-serif-sc",
    family: "Noto Serif SC",
    cssFamily: "Noto Serif SC",
    weights: [400, 600, 700, 800, 900],
    roles: ["heading"],
    fallback: '"Songti SC", SimSun, serif',
    fileName: "NotoSerifSC-050080d9255a8680.ttf",
    fontPath: "ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf",
    licensePath: "ofl/notoserifsc/OFL.txt",
    sha256:
      "050080d9255a86808f2945bffac582b31ef32bc36411ce29563b4961670c66f9",
    bytes: 25125512,
  },
} satisfies Record<VisualDeckFontKey, VisualDeckFontConfig>;

export function normalizeVisualDeckFontPrefix(prefix: string) {
  return prefix
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");
}

export function getVisualDeckFontPrefix() {
  return normalizeVisualDeckFontPrefix(process.env.FONT_ASSET_PREFIX || "fonts");
}

function encodeStoragePath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function joinStorageKey(parts: string[]) {
  return parts.filter(Boolean).join("/");
}

export function buildVisualDeckFontStorageKey(
  font: VisualDeckFontConfig,
  prefix = getVisualDeckFontPrefix(),
) {
  return joinStorageKey([prefix, font.key, font.fileName]);
}

export function buildVisualDeckLicenseStorageKey(
  font: VisualDeckFontConfig,
  prefix = getVisualDeckFontPrefix(),
) {
  return joinStorageKey([prefix, font.key, "OFL.txt"]);
}

export function buildVisualDeckFontRegistryStorageKey(
  prefix = getVisualDeckFontPrefix(),
) {
  return joinStorageKey([prefix, "font-registry.json"]);
}

export function buildVisualDeckPublicUrlForStorageKey(key: string) {
  const publicBaseUrl = (config.publicS3.baseUrl || defaultFontAssetBaseUrl).replace(
    /\/+$/g,
    "",
  );
  return `${publicBaseUrl}/${encodeStoragePath(key)}`;
}

export function getVisualDeckFontAssetBaseUrl() {
  const explicitBaseUrl = process.env.VISUAL_DECK_FONT_BASE_URL?.trim();
  if (explicitBaseUrl) {
    return explicitBaseUrl.replace(/\/+$/g, "");
  }

  const publicBaseUrl = (config.publicS3.baseUrl || defaultFontAssetBaseUrl).replace(
    /\/+$/g,
    "",
  );
  const prefix = getVisualDeckFontPrefix();
  return prefix ? `${publicBaseUrl}/${encodeStoragePath(prefix)}` : publicBaseUrl;
}

export function buildVisualDeckFontPublicUrl(font: VisualDeckFontConfig) {
  return `${getVisualDeckFontAssetBaseUrl()}/${encodeURIComponent(font.key)}/${encodeURIComponent(font.fileName)}`;
}

export function buildVisualDeckLicensePublicUrl(font: VisualDeckFontConfig) {
  return `${getVisualDeckFontAssetBaseUrl()}/${encodeURIComponent(font.key)}/OFL.txt`;
}
