import * as Dialog from "@radix-ui/react-dialog";
import { MessageSquare, X } from "lucide-react";
import { useState } from "react";
import { askCopilot, connectCopilot } from "./api";
import { errorMessage, MaximumChatEntries, MaximumChatQuestionLength, type ChatMessage, type LogPage } from "./model";

export function CopilotChatDialog({ page, sessionId, onClose, returnFocus }: {
  page: LogPage;
  sessionId: string;
  onClose(): void;
  returnFocus(): void;
}) {
  const [snapshot] = useState(() => ({
    ids: page.entries.slice(-MaximumChatEntries).map(entry => entry.id),
    name: page.status.applicationName,
    pageCount: page.entries.length
  }));
  const [version, setVersion] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [contextNote, setContextNote] = useState<string | null>(null);

  async function connect() {
    if (busy) return;
    setBusy(true); setError(null);
    try { setVersion(await connectCopilot()); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function submit() {
    const text = question.trim();
    if (!text || !version || !consent || busy || !snapshot.ids.length) return;
    setBusy(true); setError(null);
    try {
      const history = messages.slice(-6).map(message => ({ ...message, content: message.content.slice(0, MaximumChatQuestionLength) }));
      const response = await askCopilot(sessionId, snapshot.ids, text, history);
      setMessages([...messages.slice(-6), { role: "user", content: text }, { role: "assistant", content: response.answer }]);
      setQuestion("");
      setContextNote(`${response.contextEntryCount} log records used.${response.contextTruncated ? " Context was truncated; narrow the visible page for more detail." : ""}`);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="copilot-dialog" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}
        onPointerDownOutside={event => { if (busy) event.preventDefault(); }}
        onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}>
        <div className="dialog-titlebar"><div className="dialog-icon"><MessageSquare size={21} /></div><div>
          <Dialog.Title>Ask Copilot about logs</Dialog.Title>
          <Dialog.Description>Read-only chat through the GitHub Copilot CLI installed on the machine running Log Studio.</Dialog.Description>
        </div><button className="icon-button" disabled={busy} aria-label="Close Copilot chat" onClick={onClose}><X size={17} /></button></div>
        <div className="copilot-content">
          <p><strong>{snapshot.name}</strong> · Snapshot of {snapshot.ids.length} {snapshot.pageCount > MaximumChatEntries ? "newest " : ""}visible entries
            {snapshot.ids.length > 0 && ` (#${snapshot.ids[0]}–#${snapshot.ids.at(-1)})`}. Not the full session.</p>
          <p className="muted">Filter or page the logs before opening chat. Reopen to use a new snapshot. Long records and context may be truncated.</p>
          <p>The CLI runs locally, but questions, log text, and recent conversation are sent to GitHub Copilot's service.
            Logs are not automatically redacted. Do not share secrets or sensitive data. Copilot's service may retain submitted data.</p>
          {!version ? <div className="copilot-setup">
            <p>Install the current GitHub Copilot CLI and run <code>copilot login</code> in a terminal first. A Copilot entitlement and internet connection are required.</p>
            <button className="primary" disabled={busy} onClick={connect}>{busy ? "Connecting…" : "Connect local Copilot"}</button>
          </div> : <>
            <p className="muted">Connected CLI: {version}. Log analysis cannot run tools or commands.</p>
            <label className="copilot-consent"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />
              I agree to send this log snapshot and my questions to Copilot.</label>
            <div className="copilot-messages" role="log" aria-label="Copilot conversation" aria-live="polite">
              {messages.map((message, index) => <div className={`copilot-message ${message.role}`} key={index}>
                <strong>{message.role === "user" ? "You" : "Copilot"}</strong><p>{message.content}</p>
              </div>)}
            </div>
            <form onSubmit={event => { event.preventDefault(); void submit(); }}>
              <label htmlFor="copilotQuestion">Question about these logs</label>
              <textarea id="copilotQuestion" value={question} maxLength={MaximumChatQuestionLength} disabled={busy || !consent}
                rows={3} placeholder="What caused the errors? Cite the log IDs." onChange={event => setQuestion(event.target.value)} />
              <div className="dialog-footer">
                <button type="button" disabled={busy || !messages.length} onClick={() => { setMessages([]); setContextNote(null); setError(null); }}>Clear chat</button>
                <button type="submit" className="primary" disabled={busy || !consent || !question.trim() || !snapshot.ids.length}>{busy ? "Asking Copilot…" : "Ask Copilot"}</button>
              </div>
            </form>
          </>}
          {busy && <p role="status">{version ? "Waiting for Copilot (up to two minutes)…" : "Checking the local CLI…"}</p>}
          {contextNote && <p className="muted" role="status">{contextNote} AI answers can be wrong; verify against the logs.</p>}
          {error && <p className="notice danger" role="alert">{error}</p>}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
