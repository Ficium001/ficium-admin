/** Which admin site this build is: set per Vercel project (VITE_ADMIN_SITE). */
export type Site = "app" | "portal";
export const SITE: Site = import.meta.env.VITE_ADMIN_SITE === "portal" ? "portal" : "app";
export const SITE_NAME = SITE === "portal" ? "Ficium Portal Admin" : "Ficium App Admin";
