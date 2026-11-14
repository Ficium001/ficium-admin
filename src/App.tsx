import { useEffect, useState } from "react";
import KycPage from "./kyc/KycPage";
import ReviewsPage from "./kyc-reviews/ReviewsPage";
import ClientsPage from "./clients/ClientsPage";
import OffersPage from "./offers/OffersPage";
import TeamPage from "./team/TeamPage";
import CompliancePage from "./compliance/CompliancePage";
import InstitutionsPage from "./institutions/InstitutionsPage";
import ApplicationsPage from "./applications/ApplicationsPage";
import RolesPage from "./roles/RolesPage";
import AuditPage from "./audit/AuditPage";
import CommissionPage from "./commission/CommissionPage";
import Gate from "./auth/Gate";
import ResetPassword from "./auth/ResetPassword";
import { SITE, SITE_NAME } from "./site";

// Each site only shows (and its API only serves) its own modules.
const SECTIONS = SITE === "portal"
  ? [{ key: "applications", label: "Applications" }, { key: "institutions", label: "Banks" }, { key: "roles", label: "Roles" }, { key: "compliance", label: "Compliance" }, { key: "commission", label: "Commission" }, { key: "audit", label: "Audit" }, { key: "team", label: "Team" }] as const
  : [{ key: "clients", label: "Borrowers" }, { key: "kyc", label: "KYC checks" }, { key: "reviews", label: "KYC reviews" }, { key: "offers", label: "Offers" }, { key: "audit", label: "Audit" }, { key: "team", label: "Team" }] as const;
type Section = (typeof SECTIONS)[number]["key"];
const fromHash = (): Section => {
  const k = window.location.hash.slice(1);
  return (SECTIONS.find((s) => s.key === k)?.key ?? SECTIONS[0].key) as Section;
};

export default function App() {
  useEffect(() => { document.title = SITE_NAME; }, []);
  if (window.location.pathname === "/reset-password") return <ResetPassword />;
  return <Admin />;
}

function Admin() {
  const [section, setSection] = useState<Section>(fromHash);
  useEffect(() => {
    const on = () => setSection(fromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return (
    <Gate>
      <nav className="sections" aria-label="Admin sections">
        {SECTIONS.map((s) => (
          <a key={s.key} href={`#${s.key}`} aria-current={section === s.key ? "page" : undefined}>{s.label}</a>
        ))}
      </nav>
      {section === "applications" ? <ApplicationsPage />
        : section === "institutions" ? <InstitutionsPage />
        : section === "roles" ? <RolesPage />
        : section === "audit" ? <AuditPage />
        : section === "compliance" ? <CompliancePage />
        : section === "commission" ? <CommissionPage />
        : section === "offers" ? <OffersPage />
        : section === "team" ? <TeamPage />
        : section === "reviews" ? <ReviewsPage />
        : section === "clients" ? <ClientsPage />
        : <KycPage />}
    </Gate>
  );
}
