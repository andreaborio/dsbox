import "./theme/bootstrap";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "framer-motion";
import App from "./App";
import "./design-system/design-system.css";
import "./styles.css";

if (new URLSearchParams(window.location.search).get("desktop") === "1") {
  document.documentElement.classList.add("desktop-app");
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </StrictMode>
);
