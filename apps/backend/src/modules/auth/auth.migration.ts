import { createSourceweftAuth } from "./auth-config";

export const auth: any = createSourceweftAuth({ mode: "migration" });

export default auth;
