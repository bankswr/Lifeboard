package org.lifeboard.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Lifeboard's own native plugins; npm plugins are registered by Capacitor itself.
        registerPlugin(GoogleAuthorizationPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
