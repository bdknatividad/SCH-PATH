
  // Must be first: fills in browser features the PDF viewer needs.
  import "./polyfills";
  import { createRoot } from "react-dom/client";
  import App from "./app/App";
  import "./styles/index.css";

  createRoot(document.getElementById("root")!).render(<App />);
  