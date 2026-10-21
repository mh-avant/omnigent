import { describe, expect, it } from "vitest";
import { chatFeaturesApplyOnRestart, withChatFeature } from "./chatFeatures";

const CATALOG = [
  { key: "run_commands", title: "Run suggested commands", description: "" },
  { key: "item_labels", title: "Item labels", description: "" },
];

describe("withChatFeature", () => {
  it("adds a feature in catalog order", () => {
    expect(withChatFeature(["item_labels"], "run_commands", true, CATALOG)).toEqual([
      "run_commands",
      "item_labels",
    ]);
  });

  it("removes a feature and keeps unknown keys at the end", () => {
    expect(withChatFeature(["future", "run_commands"], "run_commands", false, CATALOG)).toEqual([
      "future",
    ]);
    expect(withChatFeature(["future"], "item_labels", true, CATALOG)).toEqual([
      "item_labels",
      "future",
    ]);
  });

  it("does not duplicate an already enabled feature", () => {
    expect(withChatFeature(["run_commands"], "run_commands", true, CATALOG)).toEqual([
      "run_commands",
    ]);
  });
});

describe("chatFeaturesApplyOnRestart", () => {
  it("is true only for harnesses that read instructions at launch", () => {
    expect(chatFeaturesApplyOnRestart("claude-native")).toBe(true);
    expect(chatFeaturesApplyOnRestart("codex-native")).toBe(true);
    expect(chatFeaturesApplyOnRestart("claude-sdk")).toBe(false);
    expect(chatFeaturesApplyOnRestart(null)).toBe(false);
  });
});
