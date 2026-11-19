import { useEffect, useState } from "react";
import { locate, type Group } from "./nav";

/**
 * Left menu: each module is a main entry that opens to show its pages. The module holding the
 * current page is open; others start closed, and any can be opened or closed by hand.
 * On a phone the whole menu folds into a "Menu" button that names the current page.
 */
export default function Sidebar({ nav, current, initiallyOpen = false }: { nav: Group[]; current: string; initiallyOpen?: boolean }) {
  const here = locate(current, nav);
  const [menuOpen, setMenuOpen] = useState(initiallyOpen);
  const [open, setOpen] = useState<Set<string>>(() => new Set(here ? [here.group] : []));

  // Arriving on a page (link, bookmark, back button) opens its module.
  useEffect(() => {
    if (here) setOpen((s) => (s.has(here.group) ? s : new Set(s).add(here.group)));
  }, [here?.group]);

  const toggle = (g: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(g)) n.delete(g); else n.add(g);
    return n;
  });

  return (
    <nav className={`sidebar${menuOpen ? " open" : ""}`} aria-label="Admin sections">
      <button type="button" className="sidebar-toggle" aria-expanded={menuOpen} aria-controls="sidebar-groups" onClick={() => setMenuOpen(!menuOpen)}>
        <span>Menu</span>
        {here && <span className="muted">{here.group} · {here.label}</span>}
      </button>
      <ul id="sidebar-groups" className="sidebar-groups">
        {nav.map((g) => {
          const id = `nav-${g.label.toLowerCase().replace(/\W+/g, "-")}`;
          const isOpen = open.has(g.label);
          const holdsCurrent = here?.group === g.label;
          return (
            <li key={g.label} className={`nav-module${holdsCurrent ? " current" : ""}`}>
              <button type="button" className="nav-module-btn" aria-expanded={isOpen} aria-controls={id} onClick={() => toggle(g.label)}>
                <span>{g.label}</span>
                <span className="chevron" aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
              </button>
              <ul id={id} className="nav-pages" hidden={!isOpen}>
                {g.items.map((i) => (
                  <li key={i.key}>
                    <a href={`#${i.key}`} aria-current={current === i.key ? "page" : undefined} onClick={() => setMenuOpen(false)}>{i.label}</a>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
