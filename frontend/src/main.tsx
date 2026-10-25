import * as Oui from "@opensearch-project/oui";
import { setNonce } from "get-nonce";
import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "@opensearch-project/oui/style.css";
import "./styles.css";

const nonceScript = document.querySelector("script[nonce]");
if (nonceScript instanceof HTMLScriptElement && nonceScript.nonce) setNonce(nonceScript.nonce);

class FrontendErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Log Studio frontend failed", error, info.componentStack);
  }
  render() {
    if (this.state.error) return <div className="fatal-error" role="alert"><h1>Log Studio couldn’t render</h1><p>{this.state.error}</p><Oui.Button variant="outline" size="sm" onClick={() => location.reload()}>Reload viewer</Oui.Button></div>;
    return this.props.children;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("The Log Studio application root is missing.");
createRoot(root).render(<StrictMode><FrontendErrorBoundary><App /></FrontendErrorBoundary></StrictMode>);
