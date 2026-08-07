import { createRoot } from "react-dom/client";

import "./index.css";
import { App } from "./App.tsx";

// only the desktop shell has a title bar to stand in for; a browser tab ignores the drag regions
if (navigator.userAgent.includes("Electron")) document.documentElement.classList.add("electron");

createRoot(document.getElementById("root")!).render(<App />);
