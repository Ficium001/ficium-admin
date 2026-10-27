import { useEffect, useState } from "react";
import KycPage from "./kyc/KycPage";
import OffersPage from "./offers/OffersPage";
import TeamPage from "./team/TeamPage";
import Gate from "./auth/Gate";
import ResetPassword from "./auth/ResetPassword";

const SECTIONS = [
  { key: "kyc", label: "KYC checks" },
  { key: "offers", label: "Offers" },
  { key: "team", label: "Team" },
] as const;
type Section = (typeof SECTIONS)[number]["key"];
const fromHash = (): Section => (window.location.hash === "#offers" ? "offers" : window.location.hash === "#team" ? "team" : "kyc");

export default function App() {
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
      {section === "offers" ? <OffersPage /> : section === "team" ? <TeamPage /> : <KycPage />}
    </Gate>
  );
}
