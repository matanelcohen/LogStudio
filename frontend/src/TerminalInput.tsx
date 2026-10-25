import * as Oui from "@opensearch-project/oui";
import { Send, Terminal } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { sendInput } from "./api";
import { errorMessage, MaximumInputLength } from "./model";

export function TerminalInput() {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setSending(true);
    setSent(false);
    setError(null);
    try {
      await sendInput(text);
      setText("");
      setSent(true);
      input.current?.focus();
    } catch (error) {
      setError(`Could not confirm input was sent: ${errorMessage(error)} Check the program output before retrying.`);
    } finally {
      pending.current = false;
      setSending(false);
    }
  }

  return <section className="terminal-input" aria-label="Program input">
    <form aria-label="Send terminal input" onSubmit={submit}>
      <label htmlFor="terminalInput"><Terminal size={15} aria-hidden="true" /> Terminal input</label>
      <Oui.Input id="terminalInput" ref={input} type="text" value={text} maxLength={MaximumInputLength}
        readOnly={sending} autoComplete="off" spellCheck={false} aria-describedby="terminalInputHelp"
        placeholder="Type input for the running program"
        onChange={event => { setText(event.target.value); setSent(false); setError(null); }} />
      <Oui.Button variant="outline" size="sm" type="submit" disabled={sending}><Send size={14} aria-hidden="true" /> {sending ? "Sending…" : "Send input"}</Oui.Button>
    </form>
    <p id="terminalInputHelp" className="muted">Enter sends one line, including an empty line. Submissions are not saved separately; the program may echo them into logs.</p>
    {sent && <p role="status">Input sent.</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
