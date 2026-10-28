import { useEffect, useState } from "react";
import { apiFetch } from "../auth/client";

type Group = { id: string; slug: string; label: string; description: string | null; user_type: string;
  is_system: boolean; active_members: number; modules: { key: string; label: string }[] };

export default function RolesPage() {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    apiFetch("/api/institutions?view=groups")
      .then(async (r) => { const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(b.error ?? `Request failed (${r.status})`); setGroups(b.groups); })
      .catch((e) => setError(e.message));
  }, []);
  if (error) return <main className="shell"><p className="fatal" role="alert">{error}</p></main>;
  if (!groups) return <main className="shell"><p className="muted">Loading roles…</p></main>;
  return (
    <main className="shell">
      <header className="top"><h1>Roles</h1></header>
      <p className="lead muted">The role templates bank users are given, and what each one can open. These are system roles: they
        apply to every bank, so they change only through a reviewed release, not from here.</p>
      <ul className="board">
        {groups.map((g) => (
          <li key={g.id} className="breaker on">
            <div className="text">
              <h2>{g.label}<span className="tag">{g.user_type === "admin" ? "Ficium staff" : "Bank"}</span></h2>
              <p>{g.description || g.slug} · {g.active_members} active user{g.active_members === 1 ? "" : "s"}</p>
              <p>{g.modules.length === 0 ? "No modules" : g.modules.map((m) => m.key === "*" ? "Everything" : m.label).join(", ")}</p>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
