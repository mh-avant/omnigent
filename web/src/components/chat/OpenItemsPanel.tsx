import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon, MessageSquareDotIcon } from "lucide-react";
import {
  ItemLabelChipMarks,
  ItemLabelPopover,
  itemLabelChipClass,
  itemLabelChipName,
} from "@/components/blocks/ChatMarkdown";
import {
  ItemLabelIndexContext,
  ItemLabelSessionContext,
  itemLabelTitle,
  type ItemLabelEntry,
} from "@/lib/itemLabels";
import { revealItemCommentTray, useItemCommentDraftCounts } from "@/lib/itemCommentDrafts";
import { cn } from "@/lib/utils";

// Header chips shown before the row has been measured (or without layout).
const UNMEASURED_CHIP_LIMIT = 6;

/**
 * How many chips of `chipWidths` fit in `available` pixels, `gap` apart,
 * leaving room for an `overflowWidth` "+N" count whenever some are left out.
 */
export function fitItemChipCount(
  chipWidths: readonly number[],
  available: number,
  gap: number,
  overflowWidth: number,
): number {
  let used = 0;
  for (const [index, width] of chipWidths.entries()) {
    used += (index > 0 ? gap : 0) + width;
    const leftOut = index < chipWidths.length - 1;
    if (used + (leftOut ? gap + overflowWidth : 0) > available) return index;
  }
  return chipWidths.length;
}

/**
 * Fits the header chips to the row's width: `measureRef` holds an invisible
 * copy of every chip then the "+N" count, which `rowRef` is sized against.
 * Null until measured, and in environments without layout.
 */
function useFittedChipCount(chipKey: string) {
  const rowRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [count, setCount] = useState<number | null>(null);
  useLayoutEffect(() => {
    const row = rowRef.current;
    const measure = measureRef.current;
    if (!row || !measure || typeof ResizeObserver === "undefined") return;
    const update = () => {
      if (row.clientWidth === 0) return;
      const widths = [...measure.children].map((child) => child.getBoundingClientRect().width);
      const overflowWidth = widths.pop() ?? 0;
      const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
      setCount(fitItemChipCount(widths, row.clientWidth, gap, overflowWidth));
    };
    update();
    // The row is flex-1 with a zero basis, so showing fewer chips never resizes it.
    const observer = new ResizeObserver(update);
    observer.observe(row);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [chipKey]);
  return { rowRef, measureRef, count };
}

/**
 * Collapses an expanded `<details>` when the user presses outside it. Presses
 * inside a popover don't count, since the panel's chips open popovers.
 */
export function useCollapseOnOutsidePress() {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const details = detailsRef.current;
      const target = event.target as Element | null;
      if (!details?.open || !target || details.contains(target)) return;
      if (target.closest("[data-slot=popover-content]")) return;
      details.open = false;
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);
  return detailsRef;
}

function ItemRow({ item, draftCount }: { item: ItemLabelEntry; draftCount: number }) {
  const closed = item.closedBy !== null;
  const title = useMemo(() => itemLabelTitle(item.source.text, item.label), [item]);
  return (
    <ItemLabelPopover item={item}>
      <button
        type="button"
        aria-label={itemLabelChipName(item.label, closed, item.comments.length, draftCount)}
        className="flex w-full min-w-0 items-baseline gap-2 px-3 py-1.5 text-left text-ui hover:bg-muted"
      >
        <span className={cn(itemLabelChipClass(closed), "shrink-0")}>
          {item.label}
          <ItemLabelChipMarks commentCount={item.comments.length} draftCount={draftCount} />
        </span>
        <span className={cn("truncate", closed && "text-muted-foreground line-through")}>
          {title}
        </span>
      </button>
    </ItemLabelPopover>
  );
}

/**
 * Collapsible "Open items" tracker pinned above the chat thread, beside the
 * Plan tracker. The header lists open item labels as chips, plus a jump to the
 * comment drafts when there are any; expanding lists every item with its
 * title, closed ones last. Self-hides until the transcript uses item labels.
 */
export function OpenItemsPanel({ className }: { className?: string }) {
  const index = useContext(ItemLabelIndexContext);
  const sessionId = useContext(ItemLabelSessionContext);
  const draftCounts = useItemCommentDraftCounts(sessionId);
  const items = useMemo(() => (index?.enabled ? [...index.items.values()] : []), [index]);
  const open = items.filter((item) => item.closedBy === null);
  const closed = items.filter((item) => item.closedBy !== null);
  const chipKey = open
    .map((item) => `${item.label}:${item.comments.length}:${draftCounts.get(item.label) ?? 0}`)
    .join(" ");
  const fit = useFittedChipCount(chipKey);
  const detailsRef = useCollapseOnOutsidePress();
  if (items.length === 0) return null;
  const headerChips = open.slice(0, fit.count ?? UNMEASURED_CHIP_LIMIT);
  const draftTotal = [...draftCounts.values()].reduce((total, count) => total + count, 0);

  return (
    <div className={cn("shrink-0 px-3 md:px-4", className)}>
      <details
        ref={detailsRef}
        data-testid="open-items"
        className="group mx-auto mb-1 max-w-3xl overflow-hidden rounded-xl border border-border bg-card shadow-sm"
      >
        <summary className="relative flex cursor-pointer list-none select-none items-center gap-2 px-3 py-2 text-ui font-medium [&::-webkit-details-marker]:hidden">
          <MessageSquareDotIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0">Open items</span>
          <span className="shrink-0 opacity-70">({open.length})</span>
          {/* Chips open their popover; keep their clicks from toggling the panel. */}
          <span
            ref={fit.rowRef}
            className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden font-normal"
            onClick={(event) => {
              if ((event.target as Element).closest("button")) event.preventDefault();
            }}
          >
            {headerChips.map((item) => {
              const draftCount = draftCounts.get(item.label) ?? 0;
              return (
                <ItemLabelPopover key={item.label} item={item} openOnHover>
                  <button
                    type="button"
                    aria-label={itemLabelChipName(
                      item.label,
                      false,
                      item.comments.length,
                      draftCount,
                    )}
                    className={cn(itemLabelChipClass(false), "shrink-0")}
                  >
                    {item.label}
                    <ItemLabelChipMarks
                      commentCount={item.comments.length}
                      draftCount={draftCount}
                    />
                  </button>
                </ItemLabelPopover>
              );
            })}
            {open.length > headerChips.length && (
              <span className="shrink-0 text-xs text-muted-foreground">
                +{open.length - headerChips.length}
              </span>
            )}
          </span>
          <span
            ref={fit.measureRef}
            aria-hidden="true"
            className="pointer-events-none invisible absolute top-0 left-0 flex gap-1 font-normal whitespace-nowrap"
          >
            {open.map((item) => (
              <span key={item.label} className={itemLabelChipClass(false)}>
                {item.label}
                <ItemLabelChipMarks
                  commentCount={item.comments.length}
                  draftCount={draftCounts.get(item.label) ?? 0}
                />
              </span>
            ))}
            <span className="text-xs">+{open.length}</span>
          </span>
          {draftTotal > 0 && (
            <button
              type="button"
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2 text-xs font-normal text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={(event) => {
                event.preventDefault();
                revealItemCommentTray();
              }}
            >
              <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />
              {draftTotal} draft{draftTotal === 1 ? "" : "s"}
            </button>
          )}
          <ChevronDownIcon className="size-4 shrink-0 transition-transform group-open:rotate-180" />
        </summary>
        {/* Capped like the Plan tracker so a long list can't swallow the chat. */}
        <div className="max-h-[180px] overflow-y-auto border-t border-border py-1">
          {open.map((item) => (
            <ItemRow key={item.label} item={item} draftCount={draftCounts.get(item.label) ?? 0} />
          ))}
          {closed.length > 0 && (
            <div className="px-3 pt-2 pb-1 text-xs text-muted-foreground">
              Closed ({closed.length})
            </div>
          )}
          {closed.map((item) => (
            <ItemRow key={item.label} item={item} draftCount={draftCounts.get(item.label) ?? 0} />
          ))}
        </div>
      </details>
    </div>
  );
}
