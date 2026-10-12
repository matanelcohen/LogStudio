import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { CopilotChatPanel } from "./CopilotChatPanel";
import type { ChatResponse } from "./model";
import { Status } from "./test-fixtures";

afterEach(() => vi.restoreAllMocks());

async function connectCli() {
  fireEvent.click(screen.getByRole("button", { name: "Connect local Copilot" }));
  await screen.findByLabelText("Question about these logs");
}

function ask(question = "Why did this fail?") {
  fireEvent.change(screen.getByLabelText("Question about these logs"), { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "Ask Copilot" }));
}

describe("full-session log chat panel", () => {
  it("does not connect automatically or send logs until an explicit question, without a checkbox", async () => {
    const connect = vi.spyOn(api, "connectCopilot").mockResolvedValue("test CLI");
    const chat = vi.spyOn(api, "askCopilot").mockResolvedValue({ answer: "Check #1", contextEntryCount: 1, contextTruncated: false });
    render(<CopilotChatPanel status={Status} sessionId="saved" onClose={vi.fn()} returnFocus={vi.fn()} />);
    expect(connect).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    expect(screen.getByText(/sent to GitHub Copilot's service/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Connect local Copilot" }));
    await screen.findByLabelText("Question about these logs");
    expect(chat).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Ask Copilot" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("complementary", { name: "Ask Copilot about logs" })).toBeDefined();
    ask();
    await screen.findByText("Check #1");
    expect(chat).toHaveBeenCalledWith("saved", "Why did this fail?", []);
    expect(screen.getByLabelText("Question about these logs").getAttribute("maxlength")).toBe("2000");
  });

  it("uses the full session, updates its count, and preserves recent conversation", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue("test CLI");
    const chat = vi.spyOn(api, "askCopilot").mockResolvedValue({ answer: "Answer #101", contextEntryCount: 151, contextTruncated: false });
    const props = { sessionId: "", onClose: vi.fn(), returnFocus: vi.fn() };
    const { rerender } = render(<CopilotChatPanel {...props} status={{ ...Status, lastId: 150 }} />);
    await connectCli();
    rerender(<CopilotChatPanel {...props} status={{ ...Status, lastId: 151 }} />);
    ask("First question");
    await screen.findByText("Answer #101");
    expect(chat.mock.calls[0]).toEqual(["", "First question", []]);
    expect(screen.getByText(/Full session \(151 log records\)/)).toBeDefined();
    expect(screen.getByText(/Full session file available: 151/)).toBeDefined();
    expect(screen.queryByText(/Not the full session/)).toBeNull();
    ask("Follow-up");
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[1]?.[2]).toEqual([
      { role: "user", content: "First question" }, { role: "assistant", content: "Answer #101" }
    ]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Clear chat" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Clear chat" }));
    expect(screen.getByRole("log").textContent).toBe("");
  });

  it("shows setup and chat errors without discarding the question", async () => {
    const connect = vi.spyOn(api, "connectCopilot").mockRejectedValue(new Error("Install Copilot CLI"));
    vi.spyOn(api, "askCopilot").mockRejectedValue(new Error("Run copilot login"));
    render(<CopilotChatPanel status={Status} sessionId="" onClose={vi.fn()} returnFocus={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect local Copilot" }));
    await screen.findByText("Install Copilot CLI");
    connect.mockResolvedValue("test CLI");
    await connectCli();
    ask("Keep this question");
    await screen.findByText("Run copilot login");
    expect((screen.getByLabelText("Question about these logs") as HTMLTextAreaElement).value).toBe("Keep this question");
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
    expect(screen.getByRole("button", { name: "Asking Copilot…" }).hasAttribute("disabled")).toBe(true);
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
    fireEvent.keyDown(screen.getByLabelText("Question about these logs"), { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
  });
});
