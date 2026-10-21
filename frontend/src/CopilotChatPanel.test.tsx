import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { CopilotChatPanel } from "./CopilotChatPanel";
import type { ChatMessage, ChatResponse } from "./model";
import { Status } from "./test-fixtures";

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.spyOn(api, "fetchCopilotHistory").mockResolvedValue([]);
  vi.spyOn(api, "clearCopilotHistory").mockResolvedValue();
});

async function connectCli() {
  await screen.findByRole("combobox", { name: "AI model" });
}

const Setup = { version: "test CLI", models: [
  { id: "reasoner", name: "Reasoning model", reasoningEfforts: ["low", "medium", "high"] },
  { id: "fast", name: "Fast model", reasoningEfforts: [] }
] };

function ask(question = "Why did this fail?") {
  fireEvent.change(screen.getByLabelText("Message Copilot"), { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
}

describe("full-session log chat panel", () => {
  it("dismisses the model menu with Escape without closing chat", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue(Setup);
    const close = vi.fn();
    render(<CopilotChatPanel status={Status} sessionId="" onClose={close} returnFocus={vi.fn()} />);
    await connectCli();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "AI model" }), { key: "Enter" });
    fireEvent.keyDown(await screen.findByRole("option", { name: "Reasoning model" }), { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText("Message Copilot"), { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("shows only discovered reasoning levels and clears the effort when changing models", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue(Setup);
    const chat = vi.spyOn(api, "askCopilot").mockResolvedValue({ answer: "Selected model answer", contextEntryCount: 1, contextTruncated: false });
    render(<CopilotChatPanel status={Status} sessionId="" onClose={vi.fn()} returnFocus={vi.fn()} />);
    await connectCli();
    async function choose(label: string, option: string) {
      fireEvent.keyDown(screen.getByRole("combobox", { name: label }), { key: "Enter" });
      fireEvent.keyDown(await screen.findByRole("option", { name: option }), { key: "Enter" });
    }
    expect(screen.queryByRole("combobox", { name: "Reasoning effort" })).toBeNull();
    await choose("AI model", "Reasoning model");
    await choose("Reasoning effort", "High");
    ask("Think carefully");
    await screen.findByText("Selected model answer");
    expect(chat.mock.calls[0]?.[3]).toEqual({ model: "reasoner", reasoningEffort: "high" });
    await choose("AI model", "Fast model");
    expect(screen.queryByRole("combobox", { name: "Reasoning effort" })).toBeNull();
    ask("A quick follow-up");
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[1]?.[3]).toEqual({ model: "fast" });
    await waitFor(() => expect(screen.getByRole("button", { name: "New chat" }).hasAttribute("disabled")).toBe(false));
    await choose("AI model", "Reasoning model");
    expect(screen.getByRole("combobox", { name: "Reasoning effort" }).textContent).toContain("Default reasoning");
  });

  it("renders safe Markdown, highlighted code and tables without fetching generated images", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue(Setup);
    vi.spyOn(api, "askCopilot").mockResolvedValue({
      answer: "## Diagnosis\n\n**Timeout** in `Worker`.\n\n```js\nconst retries = 3;\n```\n\n| Key | Value |\n| --- | --- |\n| Retries | 3 |\n\n![tracking](https://example.com/pixel)\n\n[unsafe](javascript:alert%281%29)\n\n<script>alert('x')</script>",
      contextEntryCount: 1, contextTruncated: false
    });
    const { container } = render(<CopilotChatPanel status={Status} sessionId="" onClose={vi.fn()} returnFocus={vi.fn()} />);
    await connectCli();
    ask();
    await screen.findByRole("heading", { name: "Diagnosis" });
    expect(container.querySelector("strong")?.textContent).toBe("Timeout");
    expect(container.querySelector("pre code .hljs-keyword")?.textContent).toBe("const");
    expect(screen.getByRole("table")).toBeDefined();
    expect(container.querySelector("img, script")).toBeNull();
    expect(screen.getByText("unsafe").closest("a")?.getAttribute("href") ?? "").not.toContain("javascript:");
  });

  it("renders partial responses while writing and restores the draft after a stream failure", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue(Setup);
    let reject!: (error: Error) => void;
    vi.spyOn(api, "askCopilot").mockImplementation((_session, _question, _messages, _options, update) => {
      update?.("Partial diagnosis\n\n```js\nconst");
      return new Promise((_resolve, fail) => { reject = fail; });
    });
    render(<CopilotChatPanel status={Status} sessionId="" onClose={vi.fn()} returnFocus={vi.fn()} />);
    await connectCli();
    ask("Preserve my question");
    expect(screen.getByRole("log").textContent).toContain("Partial diagnosis");
    expect(screen.getByRole("status").textContent).toBe("Writing…");
    await act(async () => reject(new Error("Stream interrupted")));
    expect(screen.getByRole("alert").textContent).toBe("Stream interrupted");
    expect(screen.getByRole("log").textContent).toBe("");
    expect((screen.getByLabelText("Message Copilot") as HTMLTextAreaElement).value).toBe("Preserve my question");
  });

  it("prepares the CLI automatically without sending logs until an explicit question", async () => {
    const connect = vi.spyOn(api, "connectCopilot").mockResolvedValue(Setup);
    const chat = vi.spyOn(api, "askCopilot").mockResolvedValue({ answer: "Check #1", contextEntryCount: 1, contextTruncated: false });
    render(<CopilotChatPanel status={Status} sessionId="saved" onClose={vi.fn()} returnFocus={vi.fn()} />);
    expect(connect).toHaveBeenCalledOnce();
    expect(chat).not.toHaveBeenCalled();
    expect(screen.getByRole("log").textContent).toBe("");
    expect(screen.queryByText(/sent to GitHub Copilot's service|Every question provides|Read-only chat|Install the current/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
    await connectCli();
    expect(chat).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send message" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("complementary", { name: "Ask Copilot about logs" })).toBeDefined();
    ask();
    await screen.findByText("Check #1");
    expect(chat).toHaveBeenCalledWith("saved", "Why did this fail?", [], {}, expect.any(Function));
    expect(screen.getByLabelText("Message Copilot").getAttribute("maxlength")).toBe("2000");
    expect(screen.queryByText(/Full session file available|Connected CLI|AI answers can be wrong/)).toBeNull();
  });

  it("uses the selected session and preserves recent conversation as new logs arrive", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue(Setup);
    const chat = vi.spyOn(api, "askCopilot").mockResolvedValue({ answer: "Answer #101", contextEntryCount: 151, contextTruncated: false });
    const props = { sessionId: "", onClose: vi.fn(), returnFocus: vi.fn() };
    const { rerender } = render(<CopilotChatPanel {...props} status={{ ...Status, lastId: 150 }} />);
    await connectCli();
    rerender(<CopilotChatPanel {...props} status={{ ...Status, lastId: 151 }} />);
    ask("First question");
    await screen.findByText("Answer #101");
    expect(chat.mock.calls[0]).toEqual(["", "First question", [], {}, expect.any(Function)]);
    expect(screen.getByText(Status.applicationName)).toBeDefined();
    expect(screen.queryByText(/Full session/)).toBeNull();
    ask("Follow-up");
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[1]?.[2]).toEqual([
      { role: "user", content: "First question" }, { role: "assistant", content: "Answer #101" }
    ]);
    await waitFor(() => expect(screen.getByRole("button", { name: "New chat" }).hasAttribute("disabled")).toBe(false));
    fireEvent.change(screen.getByLabelText("Message Copilot"), { target: { value: "Discard this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(screen.getByRole("log").textContent).toBe(""));
    expect(api.clearCopilotHistory).toHaveBeenCalledWith("");
    expect((screen.getByLabelText("Message Copilot") as HTMLTextAreaElement).value).toBe("");
    expect(document.activeElement).toBe(screen.getByLabelText("Message Copilot"));
    ask("Fresh question");
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(3));
    expect(chat.mock.calls[2]).toEqual(["", "Fresh question", [], {}, expect.any(Function)]);
  });

  it("shows setup and chat errors without discarding the question", async () => {
    const connect = vi.spyOn(api, "connectCopilot").mockRejectedValue(new Error("Install Copilot CLI"));
    const chat = vi.spyOn(api, "askCopilot").mockRejectedValue(new Error("Run copilot login"));
    render(<CopilotChatPanel status={Status} sessionId="" onClose={vi.fn()} returnFocus={vi.fn()} />);
    await screen.findByText("Install Copilot CLI");
    fireEvent.change(screen.getByLabelText("Message Copilot"), { target: { value: "An unsent draft" } });
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(screen.getByRole("alert").textContent).toContain("Install Copilot CLI");
    expect(screen.getByRole("button", { name: "Retry Copilot setup" })).toBeDefined();
    connect.mockResolvedValue(Setup);
    fireEvent.click(screen.getByRole("button", { name: "Retry Copilot setup" }));
    await connectCli();
    ask("Keep this question");
    await screen.findByText("Run copilot login");
    expect((screen.getByLabelText("Message Copilot") as HTMLTextAreaElement).value).toBe("Keep this question");
    expect(screen.getByRole("log").textContent).toBe("");
    chat.mockResolvedValue({ answer: "Retry succeeded", contextEntryCount: 1, contextTruncated: false });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Retry succeeded");
    expect(chat.mock.calls[1]?.[2]).toEqual([]);
    expect(screen.getAllByText("Keep this question")).toHaveLength(1);
  });

  it("bounds outbound history without truncating answers already displayed", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue(Setup);
    const longAnswer = `${"Diagnosis ".repeat(300)} See #42 at the end.`;
    const chat = vi.spyOn(api, "askCopilot")
      .mockResolvedValueOnce({ answer: longAnswer, contextEntryCount: 1, contextTruncated: false })
      .mockResolvedValueOnce({ answer: "Follow-up answer", contextEntryCount: 1, contextTruncated: false });
    render(<CopilotChatPanel status={Status} sessionId="" onClose={vi.fn()} returnFocus={vi.fn()} />);
    await connectCli();
    ask("First question");
    await screen.findByText(/See #42 at the end/);
    ask("Follow-up question");
    await screen.findByText("Follow-up answer");
    expect(screen.getByRole("log").textContent).toContain(longAnswer);
    expect(chat.mock.calls[1]?.[2][1]?.content.length).toBe(2000);
  });

  it("can start a new chat from an unsent draft", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue(Setup);
    const chat = vi.spyOn(api, "askCopilot");
    render(<CopilotChatPanel status={Status} sessionId="" onClose={vi.fn()} returnFocus={vi.fn()} />);
    await connectCli();
    const input = screen.getByLabelText("Message Copilot") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Unsent draft" } });
    expect(screen.getByRole("button", { name: "New chat" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    expect(chat).not.toHaveBeenCalled();
  });

  it("prevents duplicate requests and closing while the owned process is running", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue(Setup);
    let finish: ((value: ChatResponse) => void) | undefined;
    const chat = vi.spyOn(api, "askCopilot").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const close = vi.fn();
    render(<CopilotChatPanel status={Status} sessionId="" onClose={close} returnFocus={vi.fn()} />);
    await connectCli();
    ask();
    fireEvent.click(screen.getByRole("button", { name: "Close Copilot chat" }));
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send message" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "New chat" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("log").textContent).toContain("Why did this fail?");
    expect(screen.getByRole("status").textContent).toBe("Thinking…");
    expect((screen.getByLabelText("Message Copilot") as HTMLTextAreaElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    fireEvent.keyDown(screen.getByLabelText("Message Copilot"), { key: "Enter" });
    expect(chat).toHaveBeenCalledTimes(1);
    await act(async () => finish?.({ answer: "<script>not HTML</script>", contextEntryCount: 1, contextTruncated: false }));
    expect(screen.getByText("<script>not HTML</script>").querySelector("script")).toBeNull();
  });

  it("returns focus on close and keeps a genuinely empty session from being sent", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue(Setup);
    const chat = vi.spyOn(api, "askCopilot");
    const close = vi.fn();
    const focus = vi.fn();
    render(<CopilotChatPanel status={{ ...Status, lastId: 0 }} sessionId="" onClose={close} returnFocus={focus} />);
    await connectCli();
    ask();
    expect(chat).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText("Message Copilot"), { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
  });

  it("sends with Enter, but leaves Shift+Enter and IME composition for editing", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue(Setup);
    const chat = vi.spyOn(api, "askCopilot").mockResolvedValue({ answer: "Keyboard answer", contextEntryCount: 1, contextTruncated: false });
    render(<CopilotChatPanel status={Status} sessionId="saved" onClose={vi.fn()} returnFocus={vi.fn()} />);
    await connectCli();
    const input = screen.getByLabelText("Message Copilot");
    fireEvent.change(input, { target: { value: "First line\nSecond line" } });
    expect(fireEvent.keyDown(input, { key: "Enter", shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(input, { key: "Enter", isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(input, { key: "Enter", keyCode: 229 })).toBe(true);
    expect(chat).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    await screen.findByText("Keyboard answer");
    expect(chat).toHaveBeenCalledWith("saved", "First line\nSecond line", [], {}, expect.any(Function));
    expect(document.activeElement).toBe(input);
  });

  it("does not steal focus from log exploration when a request finishes", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue(Setup);
    let finish!: (value: ChatResponse) => void;
    vi.spyOn(api, "askCopilot").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<>
      <input aria-label="Search logs" />
      <CopilotChatPanel status={Status} sessionId="" onClose={vi.fn()} returnFocus={vi.fn()} />
    </>);
    await connectCli();
    ask();
    const search = screen.getByLabelText("Search logs");
    search.focus();
    await act(async () => finish({ answer: "Answer while exploring", contextEntryCount: 1, contextTruncated: false }));
    expect(document.activeElement).toBe(search);
  });

  it("keeps the entire displayed conversation while limiting outbound history to three pairs", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue(Setup);
    const chat = vi.spyOn(api, "askCopilot").mockImplementation(async (_session, question) => ({
      answer: `Answer to ${question}`, contextEntryCount: 1, contextTruncated: false
    }));
    render(<CopilotChatPanel status={Status} sessionId="" onClose={vi.fn()} returnFocus={vi.fn()} />);
    await connectCli();
    for (let turn = 1; turn <= 6; turn++) {
      ask(`Question ${turn}`);
      await screen.findByText(`Answer to Question ${turn}`);
    }
    expect(screen.getByRole("log").querySelectorAll(".copilot-message")).toHaveLength(12);
    expect(screen.getByText("Question 1")).toBeDefined();
    expect(screen.getByText("Answer to Question 1")).toBeDefined();
    expect(chat.mock.calls[5]?.[2]).toEqual([3, 4, 5].flatMap(turn => [
      { role: "user", content: `Question ${turn}` }, { role: "assistant", content: `Answer to Question ${turn}` }
    ]));
  });

  it("restores full per-session history after reopening and bounds only outbound context", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue(Setup);
    const longAnswer = `${"Detailed answer ".repeat(300)} End of answer`;
    const history: ChatMessage[] = [1, 2, 3, 4, 5].flatMap(turn => [
      { role: "user", content: `Saved question ${turn}` }, { role: "assistant", content: `${turn}: ${longAnswer}` }
    ]);
    vi.mocked(api.fetchCopilotHistory).mockResolvedValue(history);
    const chat = vi.spyOn(api, "askCopilot").mockResolvedValue({ answer: "Continued answer", contextEntryCount: 1, contextTruncated: false });
    const props = { status: Status, sessionId: "saved", onClose: vi.fn(), returnFocus: vi.fn() };
    const first = render(<CopilotChatPanel {...props} />);
    await connectCli();
    await screen.findByText("Saved question 1");
    expect(screen.getByRole("log").querySelectorAll(".copilot-message")).toHaveLength(10);
    expect(screen.getByRole("log").textContent).toContain(`1: ${longAnswer}`);
    first.unmount();
    render(<CopilotChatPanel {...props} />);
    await connectCli();
    await screen.findByText("Saved question 1");
    expect(api.fetchCopilotHistory).toHaveBeenLastCalledWith("saved", expect.any(AbortSignal));
    ask("Continue this conversation");
    await screen.findByText("Continued answer");
    expect(chat.mock.calls[0]?.[2]).toEqual(history.slice(-6).map(message => ({ ...message, content: message.content.slice(0, 2000) })));
    expect(screen.getByRole("log").textContent).toContain(`1: ${longAnswer}`);
  });

  it("reads saved chat without CLI access or remaining logs", async () => {
    vi.spyOn(api, "connectCopilot").mockRejectedValue(new Error("CLI unavailable"));
    vi.mocked(api.fetchCopilotHistory).mockResolvedValue([
      { role: "user", content: "Earlier question" }, { role: "assistant", content: "Earlier diagnosis" }
    ]);
    const chat = vi.spyOn(api, "askCopilot");
    render(<CopilotChatPanel status={{ ...Status, lastId: 0 }} sessionId="saved" onClose={vi.fn()} returnFocus={vi.fn()} />);
    await screen.findByText("Earlier diagnosis");
    expect(screen.getByText("CLI unavailable")).toBeDefined();
    ask("No logs remain");
    expect(chat).not.toHaveBeenCalled();
  });

  it("blocks sending until history loads and lets failed loads be retried without losing drafts", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue(Setup);
    vi.mocked(api.fetchCopilotHistory).mockRejectedValueOnce(new Error("History unavailable"));
    const chat = vi.spyOn(api, "askCopilot").mockResolvedValue({ answer: "Resumed", contextEntryCount: 1, contextTruncated: false });
    render(<CopilotChatPanel status={Status} sessionId="saved" onClose={vi.fn()} returnFocus={vi.fn()} />);
    await connectCli();
    await screen.findByText("History unavailable");
    ask("Keep my draft");
    expect(chat).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send message" }).hasAttribute("disabled")).toBe(true);
    vi.mocked(api.fetchCopilotHistory).mockResolvedValue([
      { role: "user", content: "Prior question" }, { role: "assistant", content: "Prior answer" }
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Retry chat history" }));
    await screen.findByText("Prior answer");
    expect((screen.getByLabelText("Message Copilot") as HTMLTextAreaElement).value).toBe("Keep my draft");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Resumed");
    expect(chat.mock.calls[0]?.[2]).toHaveLength(2);
  });

  it("does not replace the selected session's conversation with a stale history response", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue(Setup);
    let finish!: (messages: ChatMessage[]) => void;
    vi.mocked(api.fetchCopilotHistory).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce([{ role: "user", content: "Selected question" }, { role: "assistant", content: "Selected answer" }]);
    const props = { status: Status, onClose: vi.fn(), returnFocus: vi.fn() };
    const { rerender } = render(<CopilotChatPanel key="first" {...props} sessionId="first" />);
    await connectCli();
    rerender(<CopilotChatPanel key="second" {...props} sessionId="second" />);
    await screen.findByText("Selected answer");
    await act(async () => finish([{ role: "user", content: "Old question" }, { role: "assistant", content: "Old answer" }]));
    expect(screen.queryByText("Old answer")).toBeNull();
    expect(screen.getByText("Selected answer")).toBeDefined();
  });

  it("preserves the conversation and draft when a persisted New chat reset fails", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue(Setup);
    vi.mocked(api.fetchCopilotHistory).mockResolvedValue([
      { role: "user", content: "Saved question" }, { role: "assistant", content: "Saved answer" }
    ]);
    vi.mocked(api.clearCopilotHistory).mockRejectedValueOnce(new Error("Could not save chat history"));
    render(<CopilotChatPanel status={Status} sessionId="saved" onClose={vi.fn()} returnFocus={vi.fn()} />);
    await connectCli();
    await screen.findByText("Saved answer");
    fireEvent.change(screen.getByLabelText("Message Copilot"), { target: { value: "Keep draft" } });
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await screen.findByText("Could not save chat history");
    expect(screen.getByText("Saved answer")).toBeDefined();
    expect((screen.getByLabelText("Message Copilot") as HTMLTextAreaElement).value).toBe("Keep draft");
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(screen.getByRole("log").textContent).toBe(""));
    expect(api.clearCopilotHistory).toHaveBeenCalledWith("saved");
    expect((screen.getByLabelText("Message Copilot") as HTMLTextAreaElement).value).toBe("");
  });

  it("scrolls new messages inside the transcript without interrupting reading older messages", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue(Setup);
    let finish!: (value: ChatResponse) => void;
    vi.spyOn(api, "askCopilot").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<CopilotChatPanel status={Status} sessionId="" onClose={vi.fn()} returnFocus={vi.fn()} />);
    await connectCli();
    const log = screen.getByRole("log");
    Object.defineProperties(log, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { value: 200 } });
    ask("First question");
    expect(log.scrollTop).toBe(1000);
    log.scrollTop = 100;
    fireEvent.scroll(log);
    await act(async () => finish({ answer: "First answer", contextEntryCount: 1, contextTruncated: false }));
    expect(log.scrollTop).toBe(100);
    ask("Follow-up");
    expect(log.scrollTop).toBe(1000);
    Object.defineProperty(log, "scrollHeight", { value: 1400 });
    await act(async () => finish({ answer: "Follow-up answer", contextEntryCount: 1, contextTruncated: false }));
    expect(log.scrollTop).toBe(1400);
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  });
});
