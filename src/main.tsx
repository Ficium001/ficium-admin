import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import Login from "./Login";
import { AUTH_ENABLED, getSession, isReady } from "./auth";
import "./styles.css";

function Gate() {
  const [ready, setReady] = useState(() => !AUTH_ENABLED || isReady(getSession()));
  return ready ? <App /> : <Login onDone={() => setReady(true)} />;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Gate /></StrictMode>);
