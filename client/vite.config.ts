import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Listen on all interfaces so phones etc. on the same network can open it.
    host: true,
    // Forward /api/* to the Node server so the client only ever talks to our own backend.
    // `ws: true` also forwards the live-vehicle WebSocket at /api/ws.
    proxy: { "/api": { target: "http://localhost:3001", ws: true } },
    // Allow Tailscale HTTPS names (`tailscale serve`): phones only allow GPS on HTTPS pages.
    allowedHosts: [".ts.net"],
  },
});
