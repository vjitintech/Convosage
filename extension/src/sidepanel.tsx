import { createRoot } from "react-dom/client";
import "./ui/styles.css";
import { App } from "./ui/App";
import { ToastProvider } from "./ui/common";
createRoot(document.getElementById("root")!).render(<ToastProvider><App /></ToastProvider>);
