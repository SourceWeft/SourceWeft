declare module "@choochmeque/tauri-plugin-google-auth-api" {
  export type SignInOptions = {
    clientId: string;
    clientSecret?: string;
    flowType?: "native" | "web";
    hostedDomain?: string;
    loginHint?: string;
    redirectUri?: string;
    scopes?: string[];
    successHtmlResponse?: string;
  };

  export type SignOutOptions = {
    accessToken?: string;
    flowType?: "native" | "web";
  };

  export type RefreshTokenOptions = {
    clientId: string;
    clientSecret?: string;
    flowType?: "native" | "web";
    refreshToken?: string;
    scopes?: string[];
  };

  export type TokenResponse = {
    accessToken?: string;
    expiresAt?: number;
    idToken?: string;
    refreshToken?: string;
    scopes?: string[];
  };

  export function signIn(options: SignInOptions): Promise<TokenResponse>;
  export function signOut(options?: SignOutOptions): Promise<void>;
  export function refreshToken(
    options: RefreshTokenOptions,
  ): Promise<TokenResponse>;
}
