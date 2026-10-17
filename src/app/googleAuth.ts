// The phone's backup Google sign-in: Android's own Google authorization through Lifeboard's
// native plugin (android/.../GoogleAuthorizationPlugin.java). core/google/token.ts decides
// when the phone uses Google; this file only reaches the plugin.
import { registerPlugin } from "@capacitor/core";
import { NativeGoogleConsentNeeded, type NativeGoogleAuthorizer } from "../core/google/token.ts";

interface GoogleAuthorizationPlugin {
  authorize(options: { scopes: string[]; interactive: boolean }): Promise<{ accessToken: string }>;
}

const GoogleAuthorization = registerPlugin<GoogleAuthorizationPlugin>("GoogleAuthorization");

export const nativeGoogleAuthorizer: NativeGoogleAuthorizer = async (scopes, interactive) => {
  try {
    return (await GoogleAuthorization.authorize({ scopes, interactive })).accessToken;
  } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    if (code === "CONSENT_NEEDED") throw new NativeGoogleConsentNeeded(message);
    throw new Error(message);
  }
};
