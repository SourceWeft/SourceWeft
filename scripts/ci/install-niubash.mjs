// Prepare the identical private runtime for tests and the Windows installer.
// Do not set PATH or a niubash override: CI must exercise the shipped default.
import { prepareNiubash } from "./prepare-niubash.mjs";
await prepareNiubash();
