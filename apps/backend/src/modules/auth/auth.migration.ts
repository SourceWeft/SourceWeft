import { createSourceweftAuth } from "./auth-config";

export const auth = createSourceweftAuth({ mode: "migration" });

export default auth;
