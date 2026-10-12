import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { CopilotChatDialog } from "./CopilotChatDialog";
import type { ChatResponse } from "./model";
import { Entry, fixturePage } from "./test-fixtures";

afterEach(() => vi.restoreAllMocks());

async function connectAndConsent() {
  fireEvent.click(screen.getByRole("button", { name: "Connect local Copilot" }));
  await screen.findByRole("checkbox");
  fireEvent.click(screen.getByRole("checkbox"));
}

function ask(question = "Why did this fail?") {
  fireEvent.change(screen.getByLabelText("Question about these logs"), { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "Ask Copilot" }));
}

describe("opt-in log chat", () => {
  it("does not connect automatically or send logs until consent and an explicit question", async () => {
    const connect = vi.spyOn(api, "connectCopilot").mockResolvedValue("test CLI");
    const chat = vi.spyOn(api, "askCopilot").mockResolvedValue({ answer: "Check #1", contextEntryCount: 1, contextTruncated: false });
    render(<CopilotChatDialog page={fixturePage()} sessionId="saved" onClose={vi.fn()} returnFocus={vi.fn()} />);
    expect(connect).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    expect(screen.getByText(/sent to GitHub Copilot's service/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Connect local Copilot" }));
    await screen.findByRole("checkbox");
    expect(chat).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Ask Copilot" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    ask();
    await screen.findByText("Check #1");
    expect(chat).toHaveBeenCalledWith("saved", [Entry.id], "Why did this fail?", []);
    expect(screen.getByLabelText("Question about these logs").getAttribute("maxlength")).toBe("2000");
  });

  it("uses a stable bounded visible-page snapshot and preserves recent conversation", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue("test CLI");
    const chat = vi.spyOn(api, "askCopilot").mockResolvedValue({ answer: "Answer #101", contextEntryCount: 5, contextTruncated: true });
    const page = { ...fixturePage(), entries: Array.from({ length: 150 }, (_, index) => ({ ...Entry, id: index + 1 })) };
    const props = { sessionId: "", onClose: vi.fn(), returnFocus: vi.fn() };
    const { rerender } = render(<CopilotChatDialog {...props} page={page} />);
    await connectAndConsent();
    rerender(<CopilotChatDialog {...props} page={fixturePage()} />);
    ask("First question");
    await screen.findByText("Answer #101");
    expect(chat.mock.calls[0]?.[1]).toEqual(Array.from({ length: 100 }, (_, index) => index + 51));
    expect(screen.getByText(/Context was truncated/)).toBeDefined();
    ask("Follow-up");
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[1]?.[3]).toEqual([
      { role: "user", content: "First question" }, { role: "assistant", content: "Answer #101" }
    ]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Clear chat" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Clear chat" }));
    expect(screen.getByRole("log").textContent).toBe("");
  });

  it("shows setup and chat errors without discarding the question", async () => {
    const connect = vi.spyOn(api, "connectCopilot").mockRejectedValue(new Error("Install Copilot CLI"));
    vi.spyOn(api, "askCopilot").mockRejectedValue(new Error("Run copilot login"));
    render(<CopilotChatDialog page={fixturePage()} sessionId="" onClose={vi.fn()} returnFocus={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect local Copilot" }));
    await screen.findByText("Install Copilot CLI");
    connect.mockResolvedValue("test CLI");
    await connectAndConsent();
    ask("Keep this question");
    await screen.findByText("Run copilot login");
    expect((screen.getByLabelText("Question about these logs") as HTMLTextAreaElement).value).toBe("Keep this question");
  });

  it("prevents duplicate requests and closing while the owned process is running", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue("test CLI");
    let finish: ((value: ChatResponse) => void) | undefined;
    const chat = vi.spyOn(api, "askCopilot").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const close = vi.fn();
    render(<CopilotChatDialog page={fixturePage()} sessionId="" onClose={close} returnFocus={vi.fn()} />);
    await connectAndConsent();
    ask();
    fireEvent.click(screen.getByRole("button", { name: "Close Copilot chat" }));
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Asking Copilot…" }).hasAttribute("disabled")).toBe(true);
    expect(chat).toHaveBeenCalledTimes(1);
    await act(async () => finish?.({ answer: "<script>not HTML</script>", contextEntryCount: 1, contextTruncated: false }));
    expect(screen.getByText("<script>not HTML</script>").querySelector("script")).toBeNull();
  });
});
