import * as Dialog from "@radix-ui/react-dialog";
import { Settings2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "./model";
import { fetchTelemetrySettings, MaximumSourcePatternLength, saveTelemetrySettings, validateSourcePatterns, type TelemetrySettings, type TelemetrySourcePatterns } from "./telemetry-api";

export function TelemetrySourcesDialog() {
  const [open, setOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const [settings, setSettings] = useState<TelemetrySettings | null>(null);
  const [draft, setDraft] = useState<TelemetrySourcePatterns>({ meterSources: "", activitySources: "" });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [applied, setApplied] = useState(false);
  const request = useRef<AbortController | null>(null);
  const pendingSave = useRef(false);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    request.current = controller;
    setSettings(null); setError(null); setLoading(true); setSaving(false); setApplied(false);
    pendingSave.current = false;
    void fetchTelemetrySettings(controller.signal).then(next => {
      if (!controller.signal.aborted) { setSettings(next); setDraft(next); }
    }).catch(error => {
      if (!controller.signal.aborted) setError(errorMessage(error));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => { controller.abort(); request.current?.abort(); };
  }, [open, reload]);

  function changeOpen(next: boolean) {
    if (!next) request.current?.abort();
    setOpen(next);
  }

  async function apply() {
    if (!settings?.canConfigure || loading || pendingSave.current || validateSourcePatterns(draft)) return;
    const controller = new AbortController();
    request.current = controller;
    pendingSave.current = true;
    setSaving(true); setError(null); setApplied(false);
    try {
      const next = await saveTelemetrySettings(draft, controller.signal);
      if (!controller.signal.aborted) { setSettings(next); setDraft(next); setApplied(true); }
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) { pendingSave.current = false; setSaving(false); }
    }
  }

  const validation = settings ? validateSourcePatterns(draft) : null;
  const disabled = loading || saving || !settings?.canConfigure;
  return <Dialog.Root open={open} onOpenChange={changeOpen}>
    <Dialog.Trigger asChild><button><Settings2 size={15} />Configure sources</button></Dialog.Trigger>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="import-dialog telemetry-sources-dialog">
        <div className="dialog-titlebar"><div className="dialog-icon"><Settings2 size={21} /></div><div>
          <Dialog.Title>Configure telemetry sources</Dialog.Title>
          <Dialog.Description>Change native capture filters for new measurements and spans, not just displayed records.</Dialog.Description>
        </div><Dialog.Close asChild><button className="icon-button" aria-label="Close source configuration"><X size={17} /></button></Dialog.Close></div>
        <form className="import-content" onSubmit={event => { event.preventDefault(); void apply(); }}>
          <p id="telemetry-pattern-help">Case-sensitive, comma-separated source name patterns. * matches any characters; ? matches one character.
            Empty means capture none. Each field allows up to 4096 characters and 64 comma-delimited parts.</p>
          <p>Apply commits these filters immediately for new events, including existing meters. Closing afterward does not undo applied changes. Previously captured records are retained.
            Filters last for this current run only and are not saved in the browser or session.</p>
          {loading && <p role="status">Loading source configuration…</p>}
          {settings && <>
            {!settings.canConfigure && <p role="status">Source configuration is read-only because capture is disabled or the application has completed.
              Enable LOG_STUDIO_TELEMETRY=true at startup and restart the instrumented application. This dialog only changes live filters; it cannot enable telemetry.</p>}
            <label className="import-name">Meter source patterns
              <input value={draft.meterSources} maxLength={MaximumSourcePatternLength} disabled={disabled}
                aria-describedby="telemetry-pattern-help" aria-invalid={!!validation}
                onChange={event => { setDraft({ ...draft, meterSources: event.target.value }); setApplied(false); }} /></label>
            <label className="import-name">Activity source patterns
              <input value={draft.activitySources} maxLength={MaximumSourcePatternLength} disabled={disabled}
                aria-describedby="telemetry-pattern-help" aria-invalid={!!validation}
                onChange={event => { setDraft({ ...draft, activitySources: event.target.value }); setApplied(false); }} /></label>
          </>}
          {(error || validation) && <p className="notice danger" role="alert">{error || validation}</p>}
          {!loading && !settings && error && <button type="button" onClick={() => setReload(value => value + 1)}>Retry loading</button>}
          {saving && <p role="status">Applying source patterns…</p>}
          {applied && <p role="status">Source patterns applied to native capture. Retained records are unchanged.</p>}
          <div className="dialog-footer"><Dialog.Close asChild><button type="button">{applied ? "Done" : "Cancel"}</button></Dialog.Close>
            <button type="submit" className="primary" disabled={disabled || !!validation}>{saving ? "Applying…" : "Apply"}</button></div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
