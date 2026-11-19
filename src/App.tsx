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
import ReleasesPage from "./releases/ReleasesPage";
import ApiTrafficPage from "./traffic/ApiTrafficPage";
import ServicesPage from "./services/ServicesPage";
import CasesPage from "./cases/CasesPage";
import MarketplacePage from "./marketplace/MarketplacePage";
import IncidentsPage from "./incidents/IncidentsPage";
import DataProtectionPage from "./data-protection/DataProtectionPage";
import CredentialsPage from "./credentials/CredentialsPage";
import Gate from "./auth/Gate";
import ResetPassword from "./auth/ResetPassword";
import { SITE, SITE_NAME } from "./site";
import { navFor, sectionFrom } from "./nav";
import Sidebar from "./Sidebar";

// Each site only shows (and its API only serves) its own modules, grouped in src/nav.ts.
const NAV = navFor(SITE);
const fromHash = () => sectionFrom(window.location.hash, NAV);

export default function App() {
  useEffect(() => { document.title = SITE_NAME; }, []);
  if (window.location.pathname === "/reset-password") return <ResetPassword />;
  return <Admin />;
}

function Admin() {
  const [section, setSection] = useState<string>(fromHash);
  useEffect(() => {
    const on = () => setSection(fromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return (
    <Gate>
      <div className="layout">
      <Sidebar nav={NAV} current={section} />
      <div className="layout-main">
      {section === "applications" ? <ApplicationsPage />
        : section === "institutions" ? <InstitutionsPage />
        : section === "roles" ? <RolesPage />
        : section === "audit" ? <AuditPage />
        : section === "compliance" ? <CompliancePage />
        : section === "commission" ? <CommissionPage />
        : section === "offers" ? <OffersPage />
        : section === "releases" ? <ReleasesPage />
        : section === "services" ? <ServicesPage />
        : section === "cases" ? <CasesPage />
        : section === "marketplace" ? <MarketplacePage />
        : section === "incidents" ? <IncidentsPage />
        : section === "privacy" ? <DataProtectionPage />
        : section === "credentials" ? <CredentialsPage />
        : section === "traffic" ? <ApiTrafficPage />
        : section === "team" ? <TeamPage />
        : section === "reviews" ? <ReviewsPage />
        : section === "clients" ? <ClientsPage />
        : <KycPage />}
      </div>
      </div>
    </Gate>
  );
}
