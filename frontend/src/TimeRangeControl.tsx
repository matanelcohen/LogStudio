import * as Oui from "@opensearch-project/oui";
import { CalendarRange } from "lucide-react";
import { useState } from "react";
import { validateTimeRange, type QueryState } from "./model";

function localTime(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 23);
}

export function TimeRangeControl({ query, onChange }: { query: QueryState; onChange(query: QueryState): void }) {
  const [open, setOpen] = useState(false);
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [error, setError] = useState<string | null>(null);
  const active = !!(query.since || query.until);
  return <Oui.Popover open={open} onOpenChange={open => {
    if (open) { setSince(localTime(query.since)); setUntil(localTime(query.until)); setError(null); }
    setOpen(open);
  }}>
    <Oui.PopoverTrigger asChild>
      <Oui.Button variant="outline" size="sm" aria-label="Set exact time range" aria-pressed={active}
        title={active ? `${query.since ? new Date(query.since).toLocaleString() : "Beginning"} – ${query.until ? new Date(query.until).toLocaleString() : "Latest"}` : undefined}>
        <CalendarRange size={14} />{active ? "Custom range" : "Date range"}
      </Oui.Button>
    </Oui.PopoverTrigger>
    <Oui.PopoverContent className="popover time-range-popover" align="start" sideOffset={8}>
      <form onSubmit={event => {
        event.preventDefault();
        const invalid = validateTimeRange(since, until);
        if (invalid) return setError(invalid);
        onChange({ ...query, timeWindow: 0, since: since ? new Date(since).toISOString() : "", until: until ? new Date(until).toISOString() : "" });
        setOpen(false);
      }}>
        <h3>Exact time range</h3>
        <p className="muted">Local time ({Intl.DateTimeFormat().resolvedOptions().timeZone}). Bounds are inclusive; leave either blank for an open-ended range.</p>
        <label>Start (local time)<Oui.Input type="datetime-local" step="0.001" value={since} onChange={event => { setSince(event.target.value); setError(null); }} /></label>
        <label>End (local time)<Oui.Input type="datetime-local" step="0.001" value={until} onChange={event => { setUntil(event.target.value); setError(null); }} /></label>
        {error && <Oui.Alert variant="destructive" className="notice danger" role="alert">{error}</Oui.Alert>}
        <div className="dialog-footer">
          <Oui.Button variant="ghost" size="sm" type="button" onClick={() => { onChange({ ...query, timeWindow: 0, since: "", until: "" }); setOpen(false); }}>Clear range</Oui.Button>
          <Oui.Button size="sm" type="submit">Apply range</Oui.Button>
        </div>
      </form>
    </Oui.PopoverContent>
  </Oui.Popover>;
}
