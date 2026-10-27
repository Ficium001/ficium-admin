/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "app" (default) or "portal": which admin site this build is. */
  readonly VITE_ADMIN_SITE?: string;
}
