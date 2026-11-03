import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DevelopmentShell } from "./DevelopmentShell";
import "./style.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root.");
createRoot(root).render(
  <StrictMode>
    <DevelopmentShell />
  </StrictMode>,
);
