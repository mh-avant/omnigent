import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";

interface AppErrorBoundaryState {
  failed: boolean;
  error?: unknown;
  componentStack?: string;
}

/** Last-resort boundary: without it, any render error unmounts the app and leaves a blank page. */
export class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  override state: AppErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Unhandled render error", error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? undefined });
  }

  override render() {
    const { failed, error, componentStack } = this.state;
    if (!failed) return this.props.children;
    const details = [
      describeError(error),
      componentStack ? `Component stack:${componentStack}` : "",
      `Path: ${location.pathname}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    return (
      <div role="alert" className="flex min-h-dvh flex-col items-center justify-center gap-4 p-8">
        <h1 className="text-lg font-medium">Something went wrong</h1>
        <p className="max-w-md text-center text-sm text-muted-foreground">
          The app hit an error while drawing this page. Reload to continue.
        </p>
        <div className="flex gap-2">
          <Button onClick={() => location.reload()}>Reload</Button>
          <Button variant="outline" onClick={() => void copyText(details).catch(() => {})}>
            Copy details
          </Button>
        </div>
        <pre className="max-h-80 w-full max-w-3xl overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap select-text">
          {details}
        </pre>
      </div>
    );
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  try {
    return String(error);
  } catch {
    // Objects without a prototype have no toString; the fallback must not throw.
    return "Unknown error";
  }
}
