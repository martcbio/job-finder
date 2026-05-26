import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 32002,
    strictPort: true,
    allowedHosts: [
      "job-finder.test",
      ".job-finder.test",
      "job-finder.auto.test",
    ],
    hmr: {
      host: "job-finder.test",
      clientPort: 8443,
      protocol: "wss",
    },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3737",
        changeOrigin: true,
      },
    },
  },
});
