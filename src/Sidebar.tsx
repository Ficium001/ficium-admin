import { useState } from "react";
import { locate, type Group } from "./nav";

/**
 * Vertical, grouped menu. On a wide screen it sits on the left and is always open. On a phone it
 * folds into a "Menu" button that names the current page, and closes when a page is picked.
 */
export default function Sidebar({ nav, current, initiallyOpen = false }: { nav: Group[]; current: string; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const here = locate(current, nav);
  return (
    <nav className={`sidebar${open ? " open" : ""}`} aria-label="Admin sections">
      <button type="button" className="sidebar-toggle" aria-expanded={open} aria-controls="sidebar-groups" onClick={() => setOpen(!open)}>
        <span>Menu</span>
        {here && <span className="muted">{here.group} · {here.label}</span>}
      </button>
      <div id="sidebar-groups" className="sidebar-groups">
        {nav.map((g) => {
          const id = `nav-${g.label.toLowerCase().replace(/\W+/g, "-")}`;
          return (
            <div key={g.label} className="nav-group">
              <p className="nav-heading" id={id}>{g.label}</p>
              <ul aria-labelledby={id}>
                {g.items.map((i) => (
                  <li key={i.key}>
                    <a href={`#${i.key}`} aria-current={current === i.key ? "page" : undefined} onClick={() => setOpen(false)}>{i.label}</a>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
