import * as Dialog from "@radix-ui/react-dialog";
import { ArrowDown, ArrowUp, Check, Copy, LoaderCircle, Maximize2, MessageSquare, Minimize2, RotateCcw, Sparkles, SquarePen, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { askCopilot, clearCopilotHistory, connectCopilot, fetchCopilotHistory } from "./api";
import { errorMessage, MaximumChatQuestionLength, type ChatMessage, type CopilotConnection, type ViewerStatus } from "./model";
import { SelectControl } from "./ui";

const MarkdownPlugins = [remarkGfm];
const HighlightPlugins = [[rehypeHighlight, { detect: false, ignoreMissing: true }]] as import("react-markdown").Options["rehypePlugins"];

export function CopilotChatPanel({ status, sessionId, hidden = false, onClose, returnFocus }: {
  status: ViewerStatus | null;
  sessionId: string;
  hidden?: boolean;
  onClose(): void;
  returnFocus(): void;
}) {
  const [connection, setConnection] = useState<CopilotConnection | null>(null);
  const [preparing, setPreparing] = useState(true);
  const [setupAttempt, setSetupAttempt] = useState(0);
  const setupRequest = useRef<Promise<CopilotConnection> | null>(null);
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const focusOnOpen = useRef(true);
  const [streamedAnswer, setStreamedAnswer] = useState("");
  const [following, setFollowing] = useState(true);
  const [copied, setCopied] = useState<number | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const questionInput = useRef<HTMLTextAreaElement>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const followMessages = useRef(true);
  const scrollPosition = useRef(0);
  const readingAnchor = useRef<{ index: number; fraction: number } | null>(null);
  const restoredScroll = useRef<{ log: HTMLDivElement; top: number } | null>(null);
  const restoreConversation = useCallback((log: HTMLDivElement, reflow = false) => {
    let top = followMessages.current ? log.scrollHeight : scrollPosition.current;
    const anchor = readingAnchor.current;
    const message = anchor && log.children.item(anchor.index);
    if (!followMessages.current && reflow && message) {
      const bounds = message.getBoundingClientRect();
      top = log.scrollTop + bounds.top - log.getBoundingClientRect().top + bounds.height * anchor.fraction;
    }
    log.scrollTop = top;
    scrollPosition.current = log.scrollTop;
    restoredScroll.current = { log, top: log.scrollTop };
  }, []);
  const attachConversation = useCallback((log: HTMLDivElement | null) => {
    conversation.current = log;
    if (log) restoreConversation(log, true);
  }, [restoreConversation]);
  const resizeQuestion = useCallback((input: HTMLTextAreaElement | null) => {
    questionInput.current = input;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(180, Math.max(60, input.scrollHeight))}px`;
  }, []);
  const entryCount = Math.max(0, (status?.lastId ?? 0) - (status?.clearedThroughId ?? 0));
  const selectedModel = connection?.models.find(candidate => candidate.id === model);

  useEffect(() => {
    const controller = new AbortController();
    setHistoryLoaded(false); setHistoryError(null);
    void fetchCopilotHistory(sessionId, controller.signal)
      .then(history => {
        if (!controller.signal.aborted) { setMessages(history); setHistoryLoaded(true); }
      })
      .catch(error => { if (!controller.signal.aborted) setHistoryError(errorMessage(error)); });
    return () => controller.abort();
  }, [sessionId, historyAttempt]);

  useEffect(() => {
    let active = true;
    setPreparing(true);
    const request = setupRequest.current ??= connectCopilot();
    void request.then(result => { if (active) { setConnection(result); setError(null); } })
      .catch(error => { if (active) setError(errorMessage(error)); })
      .finally(() => { if (active) setPreparing(false); });
    return () => { active = false; };
  }, [setupAttempt]);

  useEffect(() => {
    if (hidden || busy) return;
    const opening = focusOnOpen.current;
    focusOnOpen.current = false;
    if (!opening && document.activeElement !== document.body && !panel.current?.contains(document.activeElement)) return;
    questionInput.current?.focus();
  }, [busy, hidden]);

  useEffect(() => {
    const log = conversation.current;
    if (!hidden && log) restoreConversation(log);
  }, [messages, streamedAnswer, busy, hidden, restoreConversation]);

  useEffect(() => {
    resizeQuestion(questionInput.current);
  }, [question, hidden, resizeQuestion]);

  function close() {
    if (busy) return;
    onClose();
    if (!expanded) returnFocus();
  }

  async function copyAnswer(content: string, index: number) {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(index); setCopyError(null);
    } catch {
      setCopyError("Could not copy the answer. Select the text and copy it manually.");
    }
  }

  async function submit() {
    const text = question.trim();
    if (!text || !connection || !historyLoaded || inFlight.current || !entryCount) return;
    inFlight.current = true;
    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: text }];
    followMessages.current = true;
    setFollowing(true);
    setCopied(null);
    setStreamedAnswer("");
    setMessages(nextMessages);
    setQuestion("");
    setBusy(true); setError(null);
    try {
      const history = messages.slice(-6).map(message => ({ ...message, content: message.content.slice(0, MaximumChatQuestionLength) }));
      const response = await askCopilot(sessionId, text, history,
        { ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) }, setStreamedAnswer);
      setMessages([...nextMessages, { role: "assistant", content: response.answer }]);
    } catch (error) {
      setMessages(messages);
      setQuestion(question);
      setError(errorMessage(error));
    }
    finally { inFlight.current = false; setBusy(false); setStreamedAnswer(""); }
  }

  async function newChat() {
    if (inFlight.current || !historyLoaded) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await clearCopilotHistory(sessionId);
      setMessages([]); setQuestion(""); if (connection) setError(null);
      setCopied(null); setCopyError(null); followMessages.current = true; setFollowing(true);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      inFlight.current = false; setBusy(false);
      questionInput.current?.focus();
    }
  }

  const chatPanel = <aside ref={panel} className={`copilot-panel${expanded ? " copilot-fullscreen" : ""}`} hidden={hidden} aria-label="Ask Copilot about logs" onKeyDown={event => {
    if (event.key === "Escape" && !expanded && !busy && !event.defaultPrevented && panel.current?.contains(event.target as Node)) {
      event.stopPropagation(); close();
    }
  }}>
    <header className="copilot-header">
      <MessageSquare size={19} aria-hidden="true" />
      <div className="copilot-heading">
        <Dialog.Title>Ask Copilot about logs</Dialog.Title>
        <p title={status?.applicationName}>{status?.applicationName ?? "Selected session"}</p>
      </div>
      <button className="icon-button ghost-button" disabled={busy || !historyLoaded || (!messages.length && !question && !error)} aria-label="New chat" title="New chat"
        onClick={() => { void newChat(); }}>
        <SquarePen size={17} />
      </button>
      <button ref={expandButton} className="icon-button ghost-button" aria-label={expanded ? "Restore Copilot chat" : "Expand Copilot chat"}
        title={expanded ? "Restore chat" : "Expand chat"} onClick={() => setExpanded(value => !value)}>
        {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
      </button>
      <button className="icon-button ghost-button" disabled={busy} aria-label="Close Copilot chat" title="Close chat" onClick={close}><X size={17} /></button>
    </header>
    <div className="copilot-content">
      {!messages.length && <div className="copilot-empty">
        <Sparkles size={26} aria-hidden="true" />
        <h3>Find the story in your logs</h3>
        <div className="copilot-starters">
          {["What caused the errors?", "Summarize this session"].map(prompt => <button type="button" key={prompt} disabled={busy || !historyLoaded || !entryCount}
            onClick={() => { setQuestion(prompt); questionInput.current?.focus(); }}>{prompt}<ArrowUp size={13} aria-hidden="true" /></button>)}
        </div>
      </div>}
      <div ref={attachConversation} className="copilot-messages" role="log" aria-label="Copilot conversation" aria-live="polite"
        aria-busy={busy}
        onScroll={event => {
          const log = event.currentTarget;
          const restored = restoredScroll.current;
          restoredScroll.current = null;
          if (restored?.log === log && restored.top === log.scrollTop) return;
          scrollPosition.current = log.scrollTop;
          followMessages.current = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
          setFollowing(followMessages.current);
          const top = log.getBoundingClientRect().top;
          const index = Array.from(log.children).findIndex(message => message.getBoundingClientRect().bottom > top);
          const bounds = log.children.item(index)?.getBoundingClientRect();
          readingAnchor.current = bounds && bounds.height > 0 ? { index, fraction: Math.max(0, (top - bounds.top) / bounds.height) } : null;
        }}>
        {messages.map((message, index) => <div className={`copilot-message ${message.role}`} key={index}>
          <span className="copilot-message-author">{message.role === "user" ? "You" : "Copilot"}</span>
          {message.role === "user" ? <p>{message.content}</p> : <>
            <div className="copilot-markdown"><Markdown remarkPlugins={MarkdownPlugins} rehypePlugins={HighlightPlugins}
              components={{ img: ({ alt }) => <span>{alt || "Image omitted"}</span>, a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> }}>{message.content}</Markdown></div>
            <button className="ghost-button copilot-copy" type="button" aria-label={copied === index ? "Answer copied" : "Copy answer"}
              onClick={() => { void copyAnswer(message.content, index); }}>{copied === index ? <Check size={13} /> : <Copy size={13} />}{copied === index ? "Copied" : "Copy"}</button>
          </>}
        </div>)}
        {busy && <div className="copilot-message assistant">
          {streamedAnswer && <div className="copilot-markdown"><Markdown remarkPlugins={MarkdownPlugins}
            components={{ img: ({ alt }) => <span>{alt || "Image omitted"}</span>, a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> }}>{streamedAnswer}</Markdown></div>}
          <div className="copilot-thinking" role="status"><LoaderCircle size={14} aria-hidden="true" />{streamedAnswer ? "Writing…" : "Thinking…"}</div>
        </div>}
      </div>
      {!following && messages.length > 0 && <button type="button" className="copilot-jump" onClick={() => {
        followMessages.current = true; setFollowing(true);
        if (conversation.current) conversation.current.scrollTop = conversation.current.scrollHeight;
      }}><ArrowDown size={13} />Latest message</button>}
      {error && <div className="notice danger" role="alert"><span>{error}</span>{!connection && !preparing &&
        <button type="button" aria-label="Retry Copilot setup" onClick={() => { setupRequest.current = null; setSetupAttempt(value => value + 1); }}><RotateCcw size={14} />Retry</button>}</div>}
      {copyError && <p className="notice danger" role="alert">{copyError}</p>}
      {historyError && <div className="notice danger" role="alert"><span>{historyError}</span>
        <button type="button" aria-label="Retry chat history" onClick={() => setHistoryAttempt(value => value + 1)}><RotateCcw size={14} />Retry</button></div>}
      <form className="copilot-composer" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <label className="visually-hidden" htmlFor="copilotQuestion">Message Copilot</label>
        <textarea ref={resizeQuestion} id="copilotQuestion" value={question} maxLength={MaximumChatQuestionLength} disabled={busy}
          rows={2} placeholder="Ask about this session…" onChange={event => setQuestion(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
              event.preventDefault();
              void submit();
            }
          }} />
        <div className="copilot-composer-toolbar">
          <div className="copilot-options">
            {connection && <SelectControl label="AI model" value={model} disabled={busy}
              choices={[{ value: "", label: "CLI default" }, ...connection.models.map(model => ({ value: model.id, label: model.name }))]}
              onChange={value => { setModel(value); setReasoningEffort(""); }} />}
            {!!selectedModel?.reasoningEfforts.length && <SelectControl label="Reasoning effort" value={reasoningEffort} disabled={busy}
              choices={[{ value: "", label: "Default reasoning" }, ...selectedModel.reasoningEfforts.map(value => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) }))]}
              onChange={setReasoningEffort} />}
          </div>
          <button type="submit" className="icon-button primary" aria-label="Send message" title="Send message"
            disabled={busy || !historyLoaded || !connection || !question.trim() || !entryCount}><ArrowUp size={18} /></button>
        </div>
      </form>
      <div className="copilot-footer" aria-live="polite">{!historyLoaded ? historyError ? "Chat history is unavailable. Retry to continue." : "Loading chat history…" :
        preparing ? "Preparing Copilot…" : !entryCount ? "This session has no logs to analyze." :
        !connection ? "Copilot is unavailable. Your draft is preserved." : "Enter to send · Shift+Enter for a new line"}</div>
    </div>
  </aside>;

  return <Dialog.Root open={expanded && !hidden} onOpenChange={setExpanded}>
    {expanded && !hidden ? <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content asChild aria-modal="true" aria-describedby={undefined}
        onOpenAutoFocus={event => { event.preventDefault(); (busy ? expandButton.current : questionInput.current)?.focus(); }}
        onCloseAutoFocus={event => { event.preventDefault(); if (panel.current) expandButton.current?.focus(); else returnFocus(); }}>
        {chatPanel}
      </Dialog.Content>
    </Dialog.Portal> : chatPanel}
  </Dialog.Root>;
}
