import * as Oui from "@opensearch-project/oui";

import { Settings2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "./model";
import { TelemetrySourceSuggestions } from "./TelemetrySourceSuggestions";
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
  return <Oui.Dialog open={open} onOpenChange={changeOpen}>
    <Oui.DialogTrigger asChild><Oui.Button variant="outline" size="sm"><Settings2 size={15} />Configure sources</Oui.Button></Oui.DialogTrigger>

      <Oui.DialogContent showCloseButton={false} className="import-dialog telemetry-sources-dialog">
        <div className="dialog-titlebar"><div className="dialog-icon"><Settings2 size={21} /></div><div>
          <Oui.DialogTitle>Configure telemetry sources</Oui.DialogTitle>
          <Oui.DialogDescription>Change native capture filters for new measurements and spans, not just displayed records.</Oui.DialogDescription>
        </div><Oui.DialogClose asChild><Oui.Button variant="ghost" size="icon" className="icon-button" aria-label="Close source configuration"><X size={17} /></Oui.Button></Oui.DialogClose></div>
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
              <Oui.Input value={draft.meterSources} maxLength={MaximumSourcePatternLength} disabled={disabled}
                aria-describedby="telemetry-pattern-help" aria-invalid={!!validation}
                onChange={event => { setDraft({ ...draft, meterSources: event.target.value }); setApplied(false); }} /></label>
            <label className="import-name">Activity source patterns
              <Oui.Input value={draft.activitySources} maxLength={MaximumSourcePatternLength} disabled={disabled}
                aria-describedby="telemetry-pattern-help" aria-invalid={!!validation}
                onChange={event => { setDraft({ ...draft, activitySources: event.target.value }); setApplied(false); }} /></label>
          </>}
          {(error || validation) && <Oui.Alert variant="destructive" className="notice danger" role="alert">{error || validation}</Oui.Alert>}
          {!loading && !settings && error && <Oui.Button variant="outline" size="sm" type="button" onClick={() => setReload(value => value + 1)}>Retry loading</Oui.Button>}
          {saving && <p role="status">Applying source patterns…</p>}
          {applied && <p role="status">Source patterns applied to native capture. Retained records are unchanged.</p>}
          {open && <TelemetrySourceSuggestions disabled={disabled} onUse={patterns => { setDraft(patterns); setApplied(false); }} />}
          <div className="dialog-footer"><Oui.DialogClose asChild><Oui.Button variant="outline" size="sm" type="button">{applied ? "Done" : "Cancel"}</Oui.Button></Oui.DialogClose>
            <Oui.Button variant="default" size="sm" type="submit" className="primary" disabled={disabled || !!validation}>{saving ? "Applying…" : "Apply"}</Oui.Button></div>
        </form>
      </Oui.DialogContent>

  </Oui.Dialog>;
}
