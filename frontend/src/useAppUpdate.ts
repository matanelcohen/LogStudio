import { useEffect, useRef, useState } from "react";
import { appUpdate, type AppUpdateState } from "./api";
import { errorMessage } from "./model";

export function useAppUpdate() {
  const [state, setState] = useState<AppUpdateState | null>(null);
  const [busy, setBusy] = useState<"checking" | "installing" | null>("checking");
  const [error, setError] = useState<string | null>(null);
  const setup = useRef<Promise<AppUpdateState> | null>(null);
  const pending = useRef(false);

  useEffect(() => {
    let active = true;
    setup.current ??= appUpdate();
    setup.current.then(async state => {
      if (!active) return;
      setState(state);
      if (state.automaticCheck && !state.release && !state.installedVersion) {
        const checked = await appUpdate("check-update");
        if (active) setState(checked);
      }
    })
      .catch(error => { if (active) setError(errorMessage(error)); })
      .finally(() => { if (active) setBusy(null); });
    return () => { active = false; };
  }, []);

  async function run(action: "check-update" | "install-update") {
    if (pending.current || busy) return;
    pending.current = true;
    setBusy(action === "check-update" ? "checking" : "installing");
    setError(null);
    try {
      setState(await appUpdate(action, action === "install-update" ? state?.release?.version : undefined));
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      pending.current = false;
      setBusy(null);
    }
  }

  return { state, busy, error, check: () => run("check-update"), install: () => run("install-update") };
}
