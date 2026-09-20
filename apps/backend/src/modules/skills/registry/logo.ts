import path from "node:path";
import sharp from "sharp";
import { parseDocument } from "yaml";
import type { SkillDiagnostic, SkillLogo } from "@sourceweft/contracts";
import { skillLogoSchema } from "@sourceweft/contracts";
import { parseSkillFrontmatter } from "../frontmatter";
import type { DiscoveredSkill } from "./read";

export const MAX_LOGO_BYTES = 512 * 1024;
export const LOGO_FILE_PATTERN = /\.(?:png|jpe?g|webp|gif|svg)$/i;
const CONVENTIONAL_LOGO =
  /^(?:assets\/|images\/)?(?:logo|icon)(?:[-_](?:small|large|light|dark))?\.(?:svg|png|webp|jpe?g|gif)$/i;

/** Optional presentation metadata; logo failures are reported without changing skill files. */
export async function extractRegistryLogo(
  discovered: DiscoveredSkill,
): Promise<{ logo?: SkillLogo; diagnostics: SkillDiagnostic[] }> {
  let selected: string | undefined;
  try {
    const skill = discovered.files.find(
      (file) => file.bundlePath === "SKILL.md",
    );
    const metadata = skill?.isText
      ? parseSkillFrontmatter(skill.contentText)
      : null;
    const nested = metadata?.metadata as Record<string, unknown> | undefined;
    const declaration =
      metadata?.logo ??
      metadata?.icon ??
      metadata?.logo_url ??
      metadata?.icon_url ??
      nested?.logo ??
      nested?.icon;
    if (typeof declaration === "string" && declaration.trim())
      selected = declaration.trim();
    const agentFile = discovered.files.find(
      (file) => file.bundlePath === "agents/openai.yaml",
    );
    if (!selected && agentFile?.isText) {
      const document = parseDocument(agentFile.contentText, {
        uniqueKeys: true,
      });
      if (document.errors.length || document.warnings.length)
        throw new Error("Invalid icon metadata");
      const data = document.toJS({ maxAliasCount: 20 });
      const value = data?.interface?.icon_large ?? data?.interface?.icon_small;
      if (typeof value === "string" && value.trim()) selected = value.trim();
    }
    // Raster logos and SVGs alike: every bundle file carries its raw bytes.
    const images = new Map<string, Uint8Array>();
    for (const file of discovered.files) {
      if (LOGO_FILE_PATTERN.test(file.bundlePath))
        images.set(file.bundlePath, file.bytes);
    }
    if (!selected) {
      selected = [...images.keys()]
        .filter((name) => CONVENTIONAL_LOGO.test(name))
        .sort((a, b) => {
          const rank = (name: string) =>
            (name.includes("/") ? 2 : 0) + (/logo/i.test(name) ? 0 : 1);
          return rank(a) - rank(b) || a.localeCompare(b, "en");
        })[0];
    }
    if (!selected) return { diagnostics: [] };
    if (/^https:\/\//i.test(selected)) {
      return {
        logo: skillLogoSchema.parse({ url: selected, source: "skill" }),
        diagnostics: [],
      };
    }
    const normalized = path.posix.normalize(selected);
    if (
      selected.includes("\\") ||
      normalized.startsWith("/") ||
      normalized.startsWith("../") ||
      !LOGO_FILE_PATTERN.test(normalized)
    )
      throw new Error("Invalid logo path");
    const raw = images.get(normalized);
    if (!raw || raw.byteLength > MAX_LOGO_BYTES)
      throw new Error("Logo unavailable or too large");
    const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    const svg = bytes.toString("utf8");
    if (/<svg[\s>]|<!DOCTYPE|<!ENTITY/i.test(svg)) {
      // Only self-contained SVGs enter the rasterizer; no scripts or external resources.
      if (
        /<!DOCTYPE|<!ENTITY|<script|<foreignObject|@import|(?:href|src)\s*=\s*["'](?!#)|url\(\s*(?!["']?#)/i.test(
          svg,
        )
      )
        throw new Error("SVG uses unsupported resources");
    }
    const png = await sharp(bytes, {
      limitInputPixels: 4_000_000,
      failOn: "error",
    })
      .rotate()
      .resize(128, 128, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    if (png.length > 64 * 1024) throw new Error("Logo output too large");
    return {
      logo: {
        url: `data:image/png;base64,${png.toString("base64")}`,
        source: "skill",
        path: normalized,
      },
      diagnostics: [],
    };
  } catch {
    return {
      diagnostics: [
        {
          code: "SKILL_LOGO_UNAVAILABLE",
          severity: "warning",
          message:
            "The skill logo could not be loaded. Use a self-contained SVG or PNG/JPEG/WebP/GIF image up to 512 KiB, or an HTTPS image URL. The publisher avatar is used when available.",
          ...(selected && !/^[a-z][a-z0-9+.-]*:/i.test(selected)
            ? { file: selected }
            : {}),
        },
      ],
    };
  }
}
