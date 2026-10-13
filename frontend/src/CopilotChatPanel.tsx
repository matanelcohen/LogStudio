import { ArrowUp, MessageSquare, SquarePen, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { askCopilot, connectCopilot } from "./api";
import { errorMessage, MaximumChatQuestionLength, type ChatMessage, type ViewerStatus } from "./model";

export function CopilotChatPanel({ status, sessionId, hidden = false, onClose, returnFocus }: {
  status: ViewerStatus | null;
  sessionId: string;
  hidden?: boolean;
  onClose(): void;
  returnFocus(): void;
}) {
  const [version, setVersion] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const connectButton = useRef<HTMLButtonElement>(null);
  const questionInput = useRef<HTMLTextAreaElement>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const followMessages = useRef(true);
  const entryCount = Math.max(0, (status?.lastId ?? 0) - (status?.clearedThroughId ?? 0));

  useEffect(() => {
    if (hidden || busy) return;
    if (version) questionInput.current?.focus();
    else connectButton.current?.focus();
  }, [version, busy, hidden]);

  useEffect(() => {
    const log = conversation.current;
    if (!hidden && log && followMessages.current) log.scrollTop = log.scrollHeight;
  }, [messages, busy, hidden]);

  function close() {
    if (busy) return;
    onClose();
    returnFocus();
  }

  async function connect() {
    if (busy) return;
    setBusy(true); setError(null);
    try { setVersion(await connectCopilot()); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function submit() {
    const text = question.trim();
    if (!text || !version || busy || !entryCount) return;
    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: text }];
    followMessages.current = true;
    setMessages(nextMessages);
    setQuestion("");
    setBusy(true); setError(null);
    try {
      const history = messages.slice(-6).map(message => ({ ...message, content: message.content.slice(0, MaximumChatQuestionLength) }));
      const response = await askCopilot(sessionId, text, history);
      setMessages([...nextMessages, { role: "assistant", content: response.answer }]);
    } catch (error) {
      setMessages(messages);
      setQuestion(question);
      setError(errorMessage(error));
    }
    finally { setBusy(false); }
  }

  return <aside className="copilot-panel" hidden={hidden} aria-labelledby="copilotTitle" onKeyDown={event => {
    if (event.key === "Escape" && !busy) { event.stopPropagation(); close(); }
  }}>
    <header className="copilot-header">
      <MessageSquare size={19} aria-hidden="true" />
      <div className="copilot-heading">
        <h2 id="copilotTitle">Ask Copilot about logs</h2>
        <p title={status?.applicationName}>{status?.applicationName ?? "Selected session"}</p>
      </div>
      <button className="icon-button ghost-button" disabled={busy || !messages.length} aria-label="New chat" title="New chat"
        onClick={() => { setMessages([]); setQuestion(""); setError(null); followMessages.current = true; questionInput.current?.focus(); }}>
        <SquarePen size={17} />
      </button>
      <button className="icon-button ghost-button" disabled={busy} aria-label="Close Copilot chat" title="Close chat" onClick={close}><X size={17} /></button>
    </header>
    <div className="copilot-content">
      {!version && <div className="copilot-setup">
        <button ref={connectButton} className="primary" disabled={busy} onClick={connect}>{busy ? "Connecting…" : "Connect local Copilot"}</button>
      </div>}
      <div ref={conversation} className="copilot-messages" role="log" aria-label="Copilot conversation" aria-live="polite"
        onScroll={event => {
          const log = event.currentTarget;
          followMessages.current = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
        }}>
        {messages.map((message, index) => <div className={`copilot-message ${message.role}`} key={index}>
          <span className="visually-hidden">{message.role === "user" ? "You" : "Copilot"}</span><p>{message.content}</p>
        </div>)}
        {busy && version && <div className="copilot-thinking" role="status">Thinking…</div>}
      </div>
      {error && <p className="notice danger" role="alert">{error}</p>}
      <form className="copilot-composer" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <label className="visually-hidden" htmlFor="copilotQuestion">Message Copilot</label>
        <textarea ref={questionInput} id="copilotQuestion" value={question} maxLength={MaximumChatQuestionLength} disabled={busy || !version}
          rows={2} placeholder="Ask about this session…" onChange={event => setQuestion(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }} />
        <button type="submit" className="icon-button primary" aria-label="Send message" title="Send message"
          disabled={busy || !version || !question.trim() || !entryCount}><ArrowUp size={18} /></button>
      </form>
    </div>
  </aside>;
}
