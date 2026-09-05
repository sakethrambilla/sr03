// The browser entry point: the stylesheet, and the app mounted into index.html's #root.
import { createRoot } from "react-dom/client";

import "./index.css";
import { App } from "./App.tsx";

// only the desktop shell has a title bar to stand in for; a browser tab ignores the drag regions.
// and only the macOS shell hides its frame, so only there do the headers make room for controls
if (navigator.userAgent.includes("Electron")) {
  document.documentElement.classList.add("electron");
  if (navigator.userAgent.includes("Macintosh")) document.documentElement.classList.add("mac");
}

createRoot(document.getElementById("root")!).render(<App />);
