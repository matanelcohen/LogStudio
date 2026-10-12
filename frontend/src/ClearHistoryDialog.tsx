import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, LoaderCircle, Trash2, X } from "lucide-react";
import { NumberFormatter } from "./model";

export function ClearHistoryDialog({ open, entryCount, deleting, error, onClose, onConfirm, returnFocus }: {
  open: boolean;
  entryCount: number;
  deleting: boolean;
  error: string | null;
  onClose(): void;
  onConfirm(): void;
  returnFocus(): void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={open => { if (!open && !deleting) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="clear-dialog" onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}
          onEscapeKeyDown={event => { if (deleting) event.preventDefault(); }}
          onPointerDownOutside={event => { if (deleting) event.preventDefault(); }}>
          <div className="dialog-titlebar">
            <div className="dialog-icon danger"><AlertTriangle size={21} /></div>
            <div><Dialog.Title>Delete session logs?</Dialog.Title>
              <Dialog.Description>This removes captured history from disk for every tab connected to this session.</Dialog.Description></div>
            <button className="icon-button" disabled={deleting} onClick={onClose} aria-label="Cancel clearing session logs"><X size={17} /></button>
          </div>
          <div className="clear-dialog-body">
            <p><strong>{NumberFormatter.format(entryCount)}</strong> entries have been captured since the last clear.</p>
            <p>All entries through the moment you confirm are deleted, including filtered, hidden, and retention-expired logs. This cannot be undone.</p>
            <p className="muted">The command keeps running. Output captured after the deletion point appears normally. Previously downloaded files are not affected.</p>
            {error && <p className="notice danger" role="alert">{error}</p>}
            <div className="dialog-footer">
              <button disabled={deleting} onClick={onClose}>Cancel</button>
              <button id="confirmClear" className="danger-button" disabled={deleting} onClick={onConfirm}>
                {deleting ? <LoaderCircle size={15} /> : <Trash2 size={15} />}{deleting ? "Deleting…" : "Delete session logs"}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
