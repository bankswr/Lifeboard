package org.lifeboard.app;

import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.CommonStatusCodes;
import com.google.android.gms.common.api.Scope;
import java.util.ArrayList;
import java.util.List;

/**
 * Google access tokens from Android's own authorization (Google Play services), for the
 * phone's backup Google sign-in (docs/PLAN.md phase 7, src/core/google/token.ts).
 *
 * Written here rather than taken from a plugin: the available Capacitor plugins are built
 * around a one-time login with a single scope set and a Web client ID, while Lifeboard needs
 * a silent token per scope set at every update (the Google Health API refuses tokens that
 * also carry Calendar or Tasks scopes). Play services keeps the user's grant, so nothing
 * secret is stored by the app. Needs an Android OAuth client in Google Cloud for this
 * package and signing key.
 */
@CapacitorPlugin(name = "GoogleAuthorization")
public class GoogleAuthorizationPlugin extends Plugin {

    private ActivityResultLauncher<IntentSenderRequest> consentLauncher;
    /** The authorize() call waiting for the user to answer Google's consent screen. */
    private PluginCall waitingForConsent;

    @Override
    public void load() {
        consentLauncher = bridge.registerForActivityResult(
            new ActivityResultContracts.StartIntentSenderForResult(),
            this::onConsentResult
        );
    }

    /**
     * Options: scopes (string[]), interactive (boolean). Resolves { accessToken }. Without
     * interactive, never shows anything: rejects with code CONSENT_NEEDED instead.
     */
    @PluginMethod
    public void authorize(PluginCall call) {
        List<Scope> scopes = new ArrayList<>();
        JSArray requested = call.getArray("scopes", new JSArray());
        for (int i = 0; i < requested.length(); i++) {
            scopes.add(new Scope(requested.optString(i)));
        }
        boolean interactive = Boolean.TRUE.equals(call.getBoolean("interactive", false));
        AuthorizationRequest request = AuthorizationRequest.builder().setRequestedScopes(scopes).build();

        Identity.getAuthorizationClient(getActivity())
            .authorize(request)
            .addOnSuccessListener(result -> {
                if (!result.hasResolution()) {
                    resolveToken(call, result);
                } else if (!interactive) {
                    call.reject("Google needs you to agree before giving access.", "CONSENT_NEEDED");
                } else if (waitingForConsent != null) {
                    call.reject("A Google sign-in is already open.", "BUSY");
                } else {
                    waitingForConsent = call;
                    consentLauncher.launch(new IntentSenderRequest.Builder(result.getPendingIntent().getIntentSender()).build());
                }
            })
            .addOnFailureListener(error -> reject(call, error));
    }

    private void onConsentResult(ActivityResult activityResult) {
        PluginCall call = waitingForConsent;
        waitingForConsent = null;
        if (call == null) return;
        try {
            AuthorizationResult result = Identity.getAuthorizationClient(getActivity())
                .getAuthorizationResultFromIntent(activityResult.getData());
            resolveToken(call, result);
        } catch (ApiException error) {
            reject(call, error);
        }
    }

    private void resolveToken(PluginCall call, AuthorizationResult result) {
        String token = result.getAccessToken();
        if (token == null) {
            call.reject("Google gave no access token.", "NO_TOKEN");
            return;
        }
        JSObject answer = new JSObject();
        answer.put("accessToken", token);
        call.resolve(answer);
    }

    /** Readable messages for the failures a user can act on. */
    private void reject(PluginCall call, Exception error) {
        if (error instanceof ApiException) {
            int status = ((ApiException) error).getStatusCode();
            if (status == CommonStatusCodes.DEVELOPER_ERROR) {
                call.reject(
                    "Google doesn't recognize this app yet: its Android OAuth client (package name and signing SHA-1) is missing or doesn't match.",
                    "NOT_CONFIGURED"
                );
                return;
            }
            if (status == CommonStatusCodes.CANCELED) {
                call.reject("Google sign-in was cancelled.", "CANCELLED");
                return;
            }
        }
        call.reject("Google sign-in failed: " + error.getMessage(), "FAILED");
    }
}
