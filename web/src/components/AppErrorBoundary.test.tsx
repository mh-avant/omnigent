import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./AppErrorBoundary";

const { copyText } = vi.hoisted(() => ({ copyText: vi.fn(async () => {}) }));
vi.mock("@/lib/clipboard", () => ({ copyText }));

const reload = vi.fn();
const renderError = new Error("Cannot read properties of undefined (reading 'items')");

// Every test here throws on purpose; keep jsdom from reporting those as uncaught.
function suppressExpectedError(event: ErrorEvent) {
  event.preventDefault();
}

function Throws({ value }: { value: unknown }): never {
  throw value;
}

function renderCrash(value: unknown) {
  return render(
    <StrictMode>
      <AppErrorBoundary>
        <Throws value={value} />
      </AppErrorBoundary>
    </StrictMode>,
  );
}

beforeEach(() => {
  window.addEventListener("error", suppressExpectedError);
  vi.stubGlobal("location", { reload, pathname: "/c/abc" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  window.removeEventListener("error", suppressExpectedError);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  copyText.mockReset();
  copyText.mockImplementation(async () => {});
  reload.mockReset();
});

describe("AppErrorBoundary", () => {
  it("renders children when nothing throws", () => {
    render(
      <AppErrorBoundary>
        <p>Page loaded</p>
      </AppErrorBoundary>,
    );
    expect(screen.getByText("Page loaded")).toBeInTheDocument();
  });

  it("replaces a crashed tree with the error, a reload and copyable details", () => {
    renderCrash(renderError);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong");
    expect(alert).toHaveTextContent("reading 'items'");
    expect(alert).toHaveTextContent("Throws");
    expect(alert).toHaveTextContent("/c/abc");

    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    expect(copyText).toHaveBeenCalledWith(expect.stringMatching(/reading 'items'[\s\S]*Throws/));

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "null", value: null, shown: "null" },
    { label: "a string", value: "plain string", shown: "plain string" },
    { label: "an object without a prototype", value: Object.create(null), shown: "Unknown error" },
  ])("shows the fallback when $label is thrown", ({ value, shown }) => {
    renderCrash(value);
    expect(screen.getByRole("alert")).toHaveTextContent(shown);
  });

  it("keeps the fallback when the clipboard write fails", async () => {
    copyText.mockRejectedValueOnce(new Error("Clipboard API not available"));
    renderCrash(renderError);
    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    await Promise.resolve();
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
  });
});
