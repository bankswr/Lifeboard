import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "org.lifeboard.app",
  appName: "Lifeboard",
  webDir: "dist",
  // Behind the web content and any padding Capacitor adds around it (matches --bg in style.css).
  backgroundColor: "#0f172a",
  plugins: {
    SystemBars: {
      // The app is drawn edge-to-edge; style.css pads by --safe-area-inset-* (see --inset-top).
      insetsHandling: "css",
      initialViewportFitValueHint: "cover",
      // Light status-bar icons over the app's dark background.
      style: "DARK",
    },
  },
};

export default config;
