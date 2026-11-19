import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { APP_NAV, PORTAL_NAV, itemsOf, sectionFrom, locate } from "./nav";
import Sidebar from "./Sidebar";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("admin menu", () => {
  it("groups each site's pages into modules", () => {
    expect(APP_NAV.map((g) => `${g.label}: ${g.items.map((i) => i.label).join(", ")}`)).toEqual([
      "Customers: Borrowers, KYC reviews",
      "Product: Offers, App releases",
      "Setup: KYC settings, Team",
      "Monitoring: Services, API traffic, Audit",
    ]);
    expect(PORTAL_NAV.map((g) => g.label)).toEqual(["Banks", "Setup", "Monitoring"]);
  });

  it("keeps every page reachable exactly once, with the same URL keys as before", () => {
    const app = itemsOf(APP_NAV).map((i) => i.key), portal = itemsOf(PORTAL_NAV).map((i) => i.key);
    expect(new Set(app).size).toBe(app.length);
    expect(new Set(portal).size).toBe(portal.length);
    expect([...app].sort()).toEqual(["audit", "clients", "kyc", "offers", "releases", "reviews", "services", "team", "traffic"]);
    expect([...portal].sort()).toEqual(["applications", "audit", "commission", "compliance", "institutions", "roles", "services", "team", "traffic"]);
  });

  it("opens the page a bookmark names, and the first page for anything else, including another site's page", () => {
    expect(sectionFrom("#traffic", APP_NAV)).toBe("traffic");
    expect(sectionFrom("", APP_NAV)).toBe("clients");
    expect(sectionFrom("#institutions", APP_NAV)).toBe("clients");
    expect(sectionFrom("#nonsense", PORTAL_NAV)).toBe("applications");
    expect(locate("releases", APP_NAV)).toEqual({ group: "Product", label: "App releases" });
  });

  it("shows modules as main entries, with only the current page's module open", () => {
    const html = renderToStaticMarkup(<Sidebar nav={APP_NAV} current="services" />);
    expect(html).toContain('aria-label="Admin sections"');
    expect(html.match(/class="nav-module-btn"/g)).toHaveLength(4);
    expect(html).toMatch(/<button type="button" class="nav-module-btn" aria-expanded="true" aria-controls="nav-monitoring">/);
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(1);
    expect(html.match(/hidden=""/g)).toHaveLength(3);
    expect(html).toContain('<a href="#services" aria-current="page">Services</a>');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(text(html)).toContain("Customers ▸ Borrowers KYC reviews Product ▸ Offers App releases Setup ▸ KYC settings Team Monitoring ▾ Services API traffic Audit");
  });

  it("on a phone, the Menu button names where you are and starts closed", () => {
    const html = renderToStaticMarkup(<Sidebar nav={PORTAL_NAV} current="commission" />);
    expect(html).toContain('aria-expanded="false" aria-controls="sidebar-groups"');
    expect(text(html)).toMatch(/^Ficium (App|Portal) admin Menu Banks · Commission/);
    expect(renderToStaticMarkup(<Sidebar nav={PORTAL_NAV} current="commission" initiallyOpen />)).toContain('class="sidebar open"');
  });
});
