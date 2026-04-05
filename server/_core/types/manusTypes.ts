// Google OAuth TypeScript types

export interface GoogleTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  id_token: string;
}

export interface GoogleUserInfo {
  id: string;
  email: string;
  verified_email: boolean;
  name: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
}

// Normalized types used by the rest of the app
export interface OAuthUserInfo {
  openId: string;
  name: string;
  email?: string | null;
  loginMethod: string;
}
