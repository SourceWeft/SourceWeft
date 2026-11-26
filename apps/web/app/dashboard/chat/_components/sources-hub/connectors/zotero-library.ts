/**
 * Zotero library facts the web needs for the add and rotate dialogs. These
 * mirror the rules the connector enforces server-side so a member gets an
 * immediate answer; the server remains the authority.
 */

export type ZoteroLibraryType = "user" | "group";

export const ZOTERO_CONNECTOR_TYPE = "zotero";
export const ZOTERO_API_KEY_MAX_LENGTH = 2000;
export const ZOTERO_LIBRARY_ID_MAX_LENGTH = 12;

/** Digits only, 1 to 12 of them, never starting with 0. */
const LIBRARY_ID = /^[1-9][0-9]{0,11}$/;
/** Printable ASCII with no whitespace; letters and digits of any case. */
const API_KEY = /^[\x21-\x7e]+$/;

export function isAcceptableZoteroLibraryId(value: string): boolean {
  return LIBRARY_ID.test(value);
}

export function isAcceptableZoteroApiKey(value: string): boolean {
  return value.length <= ZOTERO_API_KEY_MAX_LENGTH && API_KEY.test(value);
}

/** The credential username for a library: `users/<id>` or `groups/<id>`. */
export function zoteroCredentialUsername(
  libraryType: ZoteroLibraryType,
  libraryId: string,
): string {
  return `${libraryType === "user" ? "users" : "groups"}/${libraryId}`;
}

/** The credential username derived from a stored connector config, or null
 * when the config lacks usable library details. */
export function zoteroLibraryRef(
  config: Record<string, unknown>,
): string | null {
  const { libraryType, libraryId } = config;
  if (libraryType !== "user" && libraryType !== "group") return null;
  if (
    typeof libraryId !== "string" ||
    !isAcceptableZoteroLibraryId(libraryId)
  ) {
    return null;
  }
  return zoteroCredentialUsername(libraryType, libraryId);
}
