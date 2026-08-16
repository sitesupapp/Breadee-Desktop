import React from "react";
import ReactDOM from "react-dom/client";
import App from "@/App";
import { bootTheme } from "@/lib/theme/apply";
import "@/index.css";

// BEFORE the first render, deliberately. Applying the stored theme from a React
// effect would paint one frame of Classic Green on every launch, which on a
// dark theme is a white flash in a dim restaurant.
bootTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
