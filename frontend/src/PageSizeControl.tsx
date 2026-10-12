import { useEffect, useState } from "react";
import { MaximumPageSize } from "./model";

export function PageSizeControl({ value, onChange }: { value: number; onChange(size: number): void }) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDraft(String(value)); setError(null); }, [value]);

  function apply() {
    const size = Number(draft);
    if (!draft.trim() || !Number.isInteger(size) || size < 1 || size > MaximumPageSize) {
      setError(`Enter 1–${MaximumPageSize} rows.`);
      return;
    }
    setError(null);
    if (size !== value) onChange(size);
  }

  return <div className="page-size-control">
    <label htmlFor="pageSize">Rows/page</label>
    <input id="pageSize" type="number" aria-label="Rows per page" min={1} max={MaximumPageSize} step={1}
      value={draft} aria-invalid={!!error} aria-describedby={error ? "pageSizeError" : undefined}
      onChange={event => { setDraft(event.target.value); setError(null); }} onBlur={apply}
      onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); apply(); }
        if (event.key === "Escape") { setDraft(String(value)); setError(null); }
      }} />
    {error && <span id="pageSizeError" role="alert">{error}</span>}
  </div>;
}
