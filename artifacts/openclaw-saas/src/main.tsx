import { createRoot } from "react-dom/client";
import { setBaseUrl } from "@workspace/api-client-react";
import App from "./App";
import "./index.css";

// Configure the API client base URL.
// In production (Render static site), VITE_API_URL points to the separate
// openclaw-api service (e.g. https://openclaw-api.onrender.com).
// In local dev, the Vite dev server proxies /api → localhost:3001, so no
// base URL is needed (relative paths work).
const apiUrl = import.meta.env.VITE_API_URL as string | undefined;
if (apiUrl) {
  setBaseUrl(apiUrl);
}

createRoot(document.getElementById("root")!).render(<App />);
