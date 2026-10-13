import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { CopilotChatPanel } from "./CopilotChatPanel";
import type { ChatResponse } from "./model";
import { Status } from "./test-fixtures";

afterEach(() => vi.restoreAllMocks());

async function connectCli() {
  fireEvent.click(screen.getByRole("button", { name: "Connect local Copilot" }));
  await waitFor(() => expect(screen.getByLabelText("Message Copilot").hasAttribute("disabled")).toBe(false));
}

function ask(question = "Why did this fail?") {
  fireEvent.change(screen.getByLabelText("Message Copilot"), { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
}

describe("full-session log chat panel", () => {
  it("opens a clean chat without introductory copy or sending logs until an explicit question", async () => {
    const connect = vi.spyOn(api, "connectCopilot").mockResolvedValue("test CLI");
    const chat = vi.spyOn(api, "askCopilot").mockResolvedValue({ answer: "Check #1", contextEntryCount: 1, contextTruncated: false });
    render(<CopilotChatPanel status={Status} sessionId="saved" onClose={vi.fn()} returnFocus={vi.fn()} />);
    expect(connect).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    expect(screen.getByRole("log").textContent).toBe("");
    expect(screen.queryByText(/sent to GitHub Copilot's service|Every question provides|Read-only chat|Install the current/)).toBeNull();
    expect(screen.getByLabelText("Message Copilot").hasAttribute("disabled")).toBe(true);
    await connectCli();
    expect(chat).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send message" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("complementary", { name: "Ask Copilot about logs" })).toBeDefined();
    ask();
    await screen.findByText("Check #1");
    expect(chat).toHaveBeenCalledWith("saved", "Why did this fail?", []);
    expect(screen.getByLabelText("Message Copilot").getAttribute("maxlength")).toBe("2000");
    expect(screen.queryByText(/Full session file available|Connected CLI|AI answers can be wrong/)).toBeNull();
  });

  it("uses the selected session and preserves recent conversation as new logs arrive", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue("test CLI");
    const chat = vi.spyOn(api, "askCopilot").mockResolvedValue({ answer: "Answer #101", contextEntryCount: 151, contextTruncated: false });
    const props = { sessionId: "", onClose: vi.fn(), returnFocus: vi.fn() };
    const { rerender } = render(<CopilotChatPanel {...props} status={{ ...Status, lastId: 150 }} />);
    await connectCli();
    rerender(<CopilotChatPanel {...props} status={{ ...Status, lastId: 151 }} />);
    ask("First question");
    await screen.findByText("Answer #101");
    expect(chat.mock.calls[0]).toEqual(["", "First question", []]);
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
    expect(screen.getByRole("log").textContent).toBe("");
    expect((screen.getByLabelText("Message Copilot") as HTMLTextAreaElement).value).toBe("");
    expect(document.activeElement).toBe(screen.getByLabelText("Message Copilot"));
    ask("Fresh question");
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(3));
    expect(chat.mock.calls[2]).toEqual(["", "Fresh question", []]);
  });

  it("shows setup and chat errors without discarding the question", async () => {
    const connect = vi.spyOn(api, "connectCopilot").mockRejectedValue(new Error("Install Copilot CLI"));
    const chat = vi.spyOn(api, "askCopilot").mockRejectedValue(new Error("Run copilot login"));
    render(<CopilotChatPanel status={Status} sessionId="" onClose={vi.fn()} returnFocus={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect local Copilot" }));
    await screen.findByText("Install Copilot CLI");
    connect.mockResolvedValue("test CLI");
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
    vi.spyOn(api, "connectCopilot").mockResolvedValue("test CLI");
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
    vi.spyOn(api, "connectCopilot").mockResolvedValue("test CLI");
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
    vi.spyOn(api, "connectCopilot").mockResolvedValue("test CLI");
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
    vi.spyOn(api, "connectCopilot").mockResolvedValue("test CLI");
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
    vi.spyOn(api, "connectCopilot").mockResolvedValue("test CLI");
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
    expect(chat).toHaveBeenCalledWith("saved", "First line\nSecond line", []);
    expect(document.activeElement).toBe(input);
  });

  it("does not steal focus from log exploration when a request finishes", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue("test CLI");
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
    vi.spyOn(api, "connectCopilot").mockResolvedValue("test CLI");
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

  it("scrolls new messages inside the transcript without interrupting reading older messages", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue("test CLI");
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
