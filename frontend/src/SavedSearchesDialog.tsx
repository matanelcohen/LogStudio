import * as Oui from "@opensearch-project/oui";
import { Bookmark, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { sessionFilters, type QueryState, type SessionFilters } from "./model";
import { MaximumSavedSearches, type SavedSearch } from "./preferences";

export function SavedSearchesDialog({ open, query, searches, saved, saveError, onChange, onApply, onRetry, onClose, returnFocus }: {
  open: boolean;
  query: QueryState;
  searches: SavedSearch[];
  saved: boolean;
  saveError: string | null;
  onChange(searches: SavedSearch[]): void;
  onApply(filters: SessionFilters): void;
  onRetry(): void;
  onClose(): void;
  returnFocus(): void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setName(""); setError(null); } }, [open]);
  return <Oui.Dialog open={open} onOpenChange={open => { if (!open) onClose(); }}>
    <Oui.DialogContent showCloseButton={false} className="condition-dialog saved-searches-dialog" onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}>
      <div className="dialog-titlebar">
        <div className="dialog-icon"><Bookmark size={20} /></div>
        <div><Oui.DialogTitle>Saved searches</Oui.DialogTitle>
          <Oui.DialogDescription>Reuse filters in any session. Searches stay on this device with your app settings.</Oui.DialogDescription></div>
        <Oui.DialogClose asChild><Oui.Button variant="ghost" size="icon" aria-label="Close saved searches"><X size={18} /></Oui.Button></Oui.DialogClose>
      </div>
      <form onSubmit={event => {
        event.preventDefault();
        const trimmed = name.trim();
        if (!trimmed || trimmed.length > 64 || /[\u0000-\u001f\u007f-\u009f]/u.test(trimmed)) return setError("Enter a name containing 1-64 characters without control characters.");
        if (searches.some(search => search.name.toLowerCase() === trimmed.toLowerCase())) return setError("A search with that name already exists.");
        if (searches.length >= MaximumSavedSearches) return setError("Remove a search before saving another.");
        onChange([...searches, { name: trimmed, filters: structuredClone(sessionFilters(query)) }]);
        setName(""); setError(null);
      }}>
        <label>Search name<Oui.Input aria-label="Search name" value={name} maxLength={64} onChange={event => { setName(event.target.value); setError(null); }} /></label>
        <Oui.Button type="submit" size="sm" disabled={searches.length >= MaximumSavedSearches}>Save current filters</Oui.Button>
        <p className="muted">Includes search text, levels, category, stream, time range and conditions, but not session, page or Clear view. Filter values may contain sensitive text.</p>
        {error && <Oui.Alert variant="destructive" className="notice danger" role="alert">{error}</Oui.Alert>}
      </form>
      <div className="saved-search-list">
        {searches.length === 0 ? <p className="muted">No saved searches yet.</p> : searches.map(search => <div className="saved-search-row" key={search.name}>
          <Oui.Button variant="outline" size="sm" onClick={() => { onApply(structuredClone(search.filters)); onClose(); }}>{search.name}</Oui.Button>
          <Oui.Button variant="ghost" size="icon" aria-label={`Delete saved search ${search.name}`} onClick={() => { onChange(searches.filter(current => current.name !== search.name)); setError(null); }}><Trash2 size={14} /></Oui.Button>
        </div>)}
      </div>
      {saveError && <Oui.Alert variant="destructive" className="notice danger" role="alert"><span>{saveError}</span><Oui.Button variant="outline" size="sm" onClick={onRetry}>Retry settings</Oui.Button></Oui.Alert>}
      <div className="dialog-footer"><span className="muted" role="status">{saveError ? "Not saved to disk" : saved ? "Saved on this device" : "Saving settings..."}</span>
        <Oui.Button variant="outline" size="sm" onClick={onClose}>Done</Oui.Button></div>
    </Oui.DialogContent>
  </Oui.Dialog>;
}
