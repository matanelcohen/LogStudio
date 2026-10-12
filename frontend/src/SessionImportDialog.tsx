import * as Dialog from "@radix-ui/react-dialog";
import { FileUp, FolderOpen, LoaderCircle, ShieldCheck, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { importSessionFile } from "./api";
import { errorMessage, importFormat, MaximumSessionNameLength, NumberFormatter, validateImportFile, type SessionInfo } from "./model";

export function SessionImportDialog({ open, onClose, onImported, returnFocus }: {
  open: boolean;
  onClose(): void;
  onImported(session: SessionInfo): void;
  returnFocus(): void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setFile(null); setName(""); setError(null); setProgress(0); } }, [open]);

  function select(file: File) {
    const error = validateImportFile(file);
    setError(error);
    setFile(error ? null : file);
    setName("");
  }

  async function submit() {
    if (!file || busy) return;
    setBusy(true);
    setProgress(0);
    setError(null);
    try {
      const session = await importSessionFile(file, name, setProgress);
      onImported(session);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return <Dialog.Root open={open} onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay session-action-overlay" />
      <Dialog.Content className="import-dialog" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}
        onPointerDownOutside={event => { if (busy) event.preventDefault(); }}
        onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}>
        <div className="dialog-titlebar"><div className="dialog-icon"><FileUp size={21} /></div><div>
          <Dialog.Title>Import a session</Dialog.Title><Dialog.Description>Bring a portable session bundle or exported JSONL history into this workspace.</Dialog.Description>
        </div><button className="icon-button" disabled={busy} aria-label="Close import" onClick={onClose}><X size={17} /></button></div>
        <div className="import-content">
          <input ref={input} id="sessionImportFile" aria-label="Session file" type="file" accept=".zip,.jsonl,.ndjson" disabled={busy}
            onChange={event => { const file = event.target.files?.[0]; if (file) select(file); event.target.value = ""; }} />
          <button type="button" className={`import-dropzone ${dragging ? "drag-over" : ""}`} disabled={busy} onClick={() => input.current?.click()}
            onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={event => { event.preventDefault(); setDragging(false); if (!busy && event.dataTransfer.files[0]) select(event.dataTransfer.files[0]); }}>
            <Upload size={28} /><strong>{file ? file.name : "Drop a file here or choose one"}</strong>
            <span>{file ? `${NumberFormatter.format(file.size)} bytes · ${importFormat(file.name) === "bundle" ? "Portable session bundle" : "Log Studio JSONL"}` : ".logstudio.zip / .zip / .jsonl / .ndjson · up to 256 MiB"}</span>
          </button>
          <label className="import-name">Session name <span className="muted">(optional)</span>
            <input aria-label="Imported session name" maxLength={MaximumSessionNameLength} value={name} disabled={busy}
              placeholder="Use the bundle name, or a unique random name for JSONL" onChange={event => setName(event.target.value)} /></label>
          <p className="import-assurance"><ShieldCheck size={16} />A fresh session ID is created. Existing histories are never overwritten. The disk index is rebuilt from validated records.</p>
          {busy && <div className="import-progress" role="status"><progress max={100} value={progress} /><span>{progress < 100 ? `Uploading ${progress}%` : "Validating records and rebuilding the disk index…"}</span></div>}
          {error && <p className="notice danger" role="alert">{error}</p>}
          <div className="dialog-footer"><button disabled={busy} onClick={onClose}>Cancel</button>
            <button id="confirmImport" className="primary" disabled={!file || busy} onClick={submit}>
              {busy ? <LoaderCircle size={15} /> : <FolderOpen size={15} />}{busy ? "Importing…" : "Import and open"}
            </button></div>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
