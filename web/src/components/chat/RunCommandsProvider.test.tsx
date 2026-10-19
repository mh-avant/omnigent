import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilePathAwareMessageResponse } from "@/components/blocks/ChatMarkdown";
import { RunCommandsProvider } from "./RunCommandsProvider";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 404 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderAgentText(
  markdown: string,
  { onRun = vi.fn(), allowRunCommands = true } = {},
): (commands: string[]) => void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RunCommandsProvider onRun={onRun}>
        <FilePathAwareMessageResponse allowRunCommands={allowRunCommands} mode="static">
          {markdown}
        </FilePathAwareMessageResponse>
      </RunCommandsProvider>
    </QueryClientProvider>,
  );
  return onRun;
}

describe("RunCommandsProvider", () => {
  it("confirms a block's ! commands and runs them in order", async () => {
    const onRun = renderAgentText("Please run:\n\n```\n! gcloud auth login\n!gh auth status\n```");

    fireEvent.click(await screen.findByRole("button", { name: "Run 2 commands" }));
    const dialog = await screen.findByRole("dialog", { name: "Run 2 commands?" });
    expect(within(dialog).getByText("!gcloud auth login")).toBeInTheDocument();
    expect(within(dialog).getByText("!gh auth status")).toBeInTheDocument();
    expect(onRun).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Run" }));
    expect(onRun).toHaveBeenCalledExactlyOnceWith(["gcloud auth login", "gh auth status"]);
  });

  it("runs nothing when the confirmation is cancelled", async () => {
    const onRun = renderAgentText("```\n!make\n```");

    fireEvent.click(await screen.findByRole("button", { name: "Run command" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(onRun).not.toHaveBeenCalled();
  });

  it("reads the fence language to offer a plain bash block", async () => {
    renderAgentText("```bash\nnpm install\nnpm test\n```");
    expect(await screen.findByRole("button", { name: "Run 2 commands" })).toBeInTheDocument();
  });

  it("offers an inline ! span", async () => {
    const onRun = renderAgentText("Run `! gh auth login` and tell me when done.");

    fireEvent.click(await screen.findByRole("button", { name: "Run command" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Run" }));
    expect(onRun).toHaveBeenCalledExactlyOnceWith(["gh auth login"]);
  });

  it("hides Run where the text does not opt in", async () => {
    renderAgentText("```\n!make\n```\n\n`!ls`", { allowRunCommands: false });
    await screen.findByRole("button", { name: "Copy Code" });
    expect(screen.queryByRole("button", { name: /^Run/ })).not.toBeInTheDocument();
  });

  it("hides Run when the session cannot run shell inputs", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RunCommandsProvider onRun={null}>
          <FilePathAwareMessageResponse allowRunCommands mode="static">
            {"```\n!make\n```"}
          </FilePathAwareMessageResponse>
        </RunCommandsProvider>
      </QueryClientProvider>,
    );
    await screen.findByRole("button", { name: "Copy Code" });
    expect(screen.queryByRole("button", { name: /^Run/ })).not.toBeInTheDocument();
  });
});
