import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import { RunCommandsContext } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Lets agent messages offer Run on suggested shell commands, confirming the
 * exact list before handing it to `onRun`. A null `onRun` hides every Run
 * control, e.g. for a harness without a shell input mode.
 */
export function RunCommandsProvider({
  onRun,
  children,
}: {
  onRun: ((commands: string[]) => void) | null;
  children: ReactNode;
}) {
  const [pendingCommands, setPendingCommands] = useState<string[] | null>(null);
  const requestRun = useMemo(
    () => (onRun ? (commands: string[]) => setPendingCommands(commands) : null),
    [onRun],
  );
  const confirm = useCallback(() => {
    if (onRun && pendingCommands) onRun(pendingCommands);
    setPendingCommands(null);
  }, [onRun, pendingCommands]);

  // Each row keeps its position: the same command may repeat in one block.
  const rows = useMemo(
    () =>
      (pendingCommands ?? []).map((command, position) => ({
        id: `${position}:${command}`,
        command,
      })),
    [pendingCommands],
  );
  const count = rows.length;
  return (
    <RunCommandsContext.Provider value={requestRun}>
      {children}
      <Dialog
        open={pendingCommands !== null}
        onOpenChange={(open) => {
          if (!open) setPendingCommands(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {count === 1 ? "Run this command?" : `Run ${count} commands?`}
            </DialogTitle>
            <DialogDescription>
              {count === 1
                ? "It runs on the session's host as a shell input."
                : "Each runs on the session's host as its own shell input, in this order."}
            </DialogDescription>
          </DialogHeader>
          <ol className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
            {rows.map(({ id, command }) => (
              <li key={id}>
                <pre className="whitespace-pre-wrap break-all rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs">
                  !{command}
                </pre>
              </li>
            ))}
          </ol>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingCommands(null)}>
              Cancel
            </Button>
            <Button onClick={confirm}>Run</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </RunCommandsContext.Provider>
  );
}
