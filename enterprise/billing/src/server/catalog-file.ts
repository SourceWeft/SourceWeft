import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  parseBillingCatalog,
  type BillingCatalog,
} from "../catalog/billing-catalog";

export type LoadedBillingCatalog = {
  catalog: BillingCatalog;
  /** First 12 hex characters of the sha256 of the file text. */
  fingerprint: string;
  filePath: string;
};

export function readBillingCatalogFile(filePath: string): LoadedBillingCatalog {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    throw new Error(`Unable to read billing catalog file: ${filePath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Do not include parser excerpts: an operator may paste a credential.
    throw new Error(`Billing catalog file is not valid JSON: ${filePath}`);
  }
  let catalog: BillingCatalog;
  try {
    catalog = parseBillingCatalog(raw);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} (${filePath})`,
    );
  }
  const fingerprint = createHash("sha256")
    .update(text)
    .digest("hex")
    .slice(0, 12);
  return { catalog, fingerprint, filePath };
}
