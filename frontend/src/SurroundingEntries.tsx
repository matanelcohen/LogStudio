import * as Oui from "@opensearch-project/oui";
import { useEffect, useRef, useState } from "react";
import { fetchContext } from "./api";
import { errorMessage, SeverityLabels, type ContextPage, type EntryLocation, type PageCursor } from "./model";

export function SurroundingEntries({ location, unavailable, onClose, returnFocus }: {
  location: EntryLocation;
  unavailable: string | null;
  onClose(): void;
  returnFocus(): void;
}) {
  const [cursor, setCursor] = useState<PageCursor>({ before: null, after: null });
  const [page, setPage] = useState<ContextPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [selectedId, setSelectedId] = useState(location.entryId);
  const scroll = useRef<HTMLDivElement>(null);
  const positionPage = useRef(true);

  useEffect(() => {
    if (!page || !positionPage.current) return;
    positionPage.current = false;
    const pane = scroll.current;
    const anchor = pane?.querySelector<HTMLElement>(`[data-context-id="${location.entryId}"]`);
    if (pane) pane.scrollTop = anchor ? Math.max(0, anchor.offsetTop - pane.clientHeight / 2) : 0;
  }, [page, location.entryId]);

  useEffect(() => {
    setPage(null);
    if (unavailable) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    async function load() {
      try {
        const result = await fetchContext({ sessionId: location.sessionId, entryId: location.entryId }, cursor, controller.signal);
        if (!active) return;
        setPage(result);
        setError(null);
      } catch (error) {
        if (!active) return;
        setPage(null);
        setError(`Surrounding entries unavailable: ${errorMessage(error)}`);
      } finally {
        if (active) {
          setLoading(false);
          timer = setTimeout(load, 2000);
        }
      }
    }
    void load();
    return () => { active = false; controller.abort(); if (timer !== null) clearTimeout(timer); };
  }, [location.sessionId, location.entryId, cursor.before, cursor.after, retry, unavailable]);

  function navigate(next: PageCursor) {
    positionPage.current = true;
    setPage(null);
    setLoading(true);
    setCursor(next);
  }

  return <Oui.Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <Oui.DialogContent showCloseButton={false} className="surrounding-dialog"
      onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}>
      <Oui.DialogTitle>Surrounding entries · anchor #{location.entryId}</Oui.DialogTitle>
      <Oui.DialogDescription>
        Active filters are bypassed. Showing up to 25 retained entries before and after the anchor in the same session.
        Older and newer pages replace this page; your original results and follow/pause state are preserved.
      </Oui.DialogDescription>
      <div className="surrounding-toolbar">
        <Oui.Button variant="outline" size="sm" onClick={onClose}>Return to results</Oui.Button>
        <Oui.Button variant="outline" size="sm" disabled={loading || !!unavailable}
          onClick={() => { setSelectedId(location.entryId); navigate({ before: null, after: null }); setRetry(value => value + 1); }}>Back to anchor</Oui.Button>
        <span className="muted">Session {location.sessionId}</span>
      </div>
      {(unavailable || error) && <Oui.Alert variant="destructive" className="notice danger" role="alert">
        {unavailable ?? error}
        {!unavailable && <Oui.Button variant="outline" size="sm" onClick={() => setRetry(value => value + 1)}>Retry context</Oui.Button>}
      </Oui.Alert>}
      {loading && !unavailable && <p role="status">Loading surrounding entries…</p>}
      {page && !unavailable && <div ref={scroll} className="logs-scroll surrounding-scroll" aria-label="Surrounding log entries">
        <Oui.Table aria-label="Surrounding logs">
          <Oui.TableHeader><Oui.TableRow><Oui.TableHead>Entry</Oui.TableHead><Oui.TableHead>Captured (UTC)</Oui.TableHead>
            <Oui.TableHead>Level / Category</Oui.TableHead><Oui.TableHead>Message</Oui.TableHead></Oui.TableRow></Oui.TableHeader>
          <Oui.TableBody data-loaded-entries={page.entries.length}>
            {page.entries.map(entry => <Oui.TableRow key={entry.id} data-context-id={entry.id}
              data-anchor={entry.id === location.entryId} aria-selected={entry.id === selectedId}
              tabIndex={0} className={entry.id === location.entryId ? "context-anchor" : ""}
              onClick={() => setSelectedId(entry.id)} onFocus={() => setSelectedId(entry.id)}
              onKeyDown={event => {
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                event.preventDefault();
                const target = event.key === "ArrowDown" ? event.currentTarget.nextElementSibling : event.currentTarget.previousElementSibling;
                if (target instanceof HTMLElement) target.focus();
              }}>
              <Oui.TableCell>#{entry.id}{entry.id === location.entryId && <strong className="context-anchor-label">Anchor</strong>}</Oui.TableCell>
              <Oui.TableCell>{entry.timestamp}</Oui.TableCell>
              <Oui.TableCell>{SeverityLabels[entry.severity]}<br />{entry.category ?? "Uncategorized"}</Oui.TableCell>
              <Oui.TableCell><pre className="context-message">{entry.message}</pre></Oui.TableCell>
            </Oui.TableRow>)}
          </Oui.TableBody>
        </Oui.Table>
        {!page.entries.length && <p role="status">No more retained entries in this direction.</p>}
      </div>}
      <div className="surrounding-toolbar">
        <Oui.Button variant="outline" size="sm" disabled={loading || !page?.before || !!unavailable}
          onClick={() => navigate({ before: page!.before, after: null })}>Load 25 older entries</Oui.Button>
        <Oui.Button variant="outline" size="sm" disabled={loading || !page?.after || !!unavailable}
          onClick={() => navigate({ before: null, after: page!.after })}>Load 25 newer entries</Oui.Button>
        <span role="status">{page && !unavailable ? `${page.entries.length} entries on this page` : ""}</span>
      </div>
    </Oui.DialogContent>
  </Oui.Dialog>;
}
