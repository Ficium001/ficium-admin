import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Local dev mirrors the production rewrite in vercel.json: /auth/* -> ficium-auth.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/auth": { target: process.env.FICIUM_AUTH_URL ?? "https://ficium-auth-production.up.railway.app", changeOrigin: true } } },
});
