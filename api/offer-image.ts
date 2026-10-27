/**
 * POST /api/offer-image  (raw image body, Content-Type image/jpeg|png|webp, max 2 MB)
 *   -> { url }
 * Stores the image in Vercel Blob under offers/. The URL is unguessable but
 * public; it only appears to borrowers once an offer using it is approved and
 * published. Auth is Vercel OIDC + BLOB_STORE_ID (no long-lived blob token);
 * this app holds no Supabase keys; its only DB logins are single-purpose roles.
 */
import { randomUUID } from "node:crypto";
import { requireStaff, AuthError } from "./_lib/access.js";
import { onlyOn } from "./_lib/site.js";

type Req = AsyncIterable<Buffer | string> & { method?: string; headers: Record<string, string | string[] | undefined> };
type Res = { status(code: number): Res; json(body: unknown): void; setHeader(k: string, v: string): void };

export const MAX_BYTES = 2 * 1024 * 1024;
const TYPES: Record<string, { ext: string; magic: (b: Buffer) => boolean }> = {
  "image/jpeg": { ext: "jpg", magic: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/png": { ext: "png", magic: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/webp": { ext: "webp", magic: (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
};

export type Deps = {
  requireStaff: typeof requireStaff;
  put: (path: string, body: Buffer, contentType: string) => Promise<{ url: string }>;
};

const live: Deps = {
  requireStaff,
  put: async (path, body, contentType) => {
    const { put } = await import("@vercel/blob");
    return put(path, body, { access: "public", contentType, addRandomSuffix: true, cacheControlMaxAge: 31_536_000 });
  },
};

async function readBody(req: Req, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) {
    const b = typeof c === "string" ? Buffer.from(c) : c;
    size += b.length;
    if (size > limit) return null;
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

export function makeHandler(deps: Deps) {
  return async function handler(req: Req, res: Res) {
    res.setHeader("Cache-Control", "no-store");
    let actor: string;
    try {
      actor = await deps.requireStaff(req.headers);
    } catch (e) {
      const status = e instanceof AuthError ? e.status : 401;
      return res.status(status).json({ error: e instanceof Error ? e.message : "Not signed in" });
    }
    if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }

    const ct = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    const type = TYPES[ct];
    if (!type) return res.status(415).json({ error: "Use a JPEG, PNG or WebP image" });
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_BYTES) return res.status(413).json({ error: "Image must be 2 MB or smaller" });

    try {
      const body = await readBody(req, MAX_BYTES);
      if (!body) return res.status(413).json({ error: "Image must be 2 MB or smaller" });
      if (!type.magic(body)) return res.status(415).json({ error: "The file isn't a valid image of that type" });
      const { url } = await deps.put(`offers/${randomUUID()}.${type.ext}`, body, ct);
      console.info("offer image uploaded", actor, url);
      return res.status(200).json({ url });
    } catch (e: any) {
      console.error("offer image error", e?.message);
      return res.status(500).json({ error: "Upload failed. Nothing was stored" });
    }
  };
}

export default onlyOn("app", makeHandler(live));
