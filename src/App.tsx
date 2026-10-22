import { useEffect, useState } from "react";
import KycPage from "./kyc/KycPage";
import OffersPage from "./offers/OffersPage";

const SECTIONS = [
  { key: "kyc", label: "KYC checks" },
  { key: "offers", label: "Offers" },
] as const;
type Section = (typeof SECTIONS)[number]["key"];
const fromHash = (): Section => (window.location.hash === "#offers" ? "offers" : "kyc");

export default function App() {
  const [section, setSection] = useState<Section>(fromHash);
  useEffect(() => {
    const on = () => setSection(fromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return (
    <>
      <nav className="sections" aria-label="Admin sections">
        {SECTIONS.map((s) => (
          <a key={s.key} href={`#${s.key}`} aria-current={section === s.key ? "page" : undefined}>{s.label}</a>
        ))}
      </nav>
      {section === "offers" ? <OffersPage /> : <KycPage />}
    </>
  );
}
