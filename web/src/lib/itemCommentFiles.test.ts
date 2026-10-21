import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

async function waitForSave() {
  // The bytes are read and written asynchronously after the id is returned.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 100);
  });
}

describe("item comment draft files", () => {
  it("reads a draft's file back in a later page", async () => {
    const first = await import("./itemCommentFiles");
    const file = new File(["col\n1"], "sizes.csv", { type: "text/csv" });
    const id = first.rememberDraftFile(file);
    expect(first.rememberDraftFile(file)).toBe(id);
    expect(await first.loadDraftFile(id)).toBe(file);
    await waitForSave();

    vi.resetModules();
    const later = await import("./itemCommentFiles");
    const loaded = await later.loadDraftFile(id);
    expect(loaded?.name).toBe("sizes.csv");
    expect(loaded?.type).toBe("text/csv");
    expect(await loaded?.text()).toBe("col\n1");

    later.forgetDraftFiles([id]);
    await waitForSave();
    expect(await later.loadDraftFile(id)).toBeNull();
  });
});
