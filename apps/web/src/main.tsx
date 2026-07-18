import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import serviceWorkerUrl from "./sw.ts?worker&url";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () =>
    navigator.serviceWorker.register(serviceWorkerUrl, { type: "module", scope: "/" }),
  );
}
