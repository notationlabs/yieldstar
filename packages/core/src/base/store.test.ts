import { expect, test } from "vitest";
import {
  cloneStoreState,
  diffStorePaths,
  storePathsIntersect,
  trackStoreSelector,
  trackStoreUpdater,
  unwrapTrackedValue,
  type StorePath,
} from "./store";

type State = {
  messages: { id: string; processed?: boolean; claimedBy?: string }[];
  status: string;
  profile: { name: string; tags: Record<string, string> };
};

function makeState(): State {
  return {
    messages: [
      { id: "msg-1" },
      { id: "msg-2" },
      { id: "msg-3" },
      { id: "msg-4" },
    ],
    status: "idle",
    profile: { name: "dan", tags: {} },
  };
}

function wakes(readPath: StorePath, writePaths: StorePath[]): boolean {
  return storePathsIntersect([readPath], writePaths);
}

test("trackStoreUpdater: push onto an array records index paths that wake array waiters", () => {
  const draft = makeState();
  const tracked = trackStoreUpdater(draft);

  tracked.draft.messages.push({ id: "msg-5" });

  const paths = tracked.writePaths();
  expect(paths).toContainEqual(["messages", 4]);
  // A waiter on ["messages"] wakes via prefix intersection
  expect(wakes(["messages"], paths)).toBe(true);
  // The mutation landed on the raw draft
  expect(draft.messages).toHaveLength(5);
  expect(draft.messages[4]).toEqual({ id: "msg-5" });
});

test("trackStoreUpdater: splice and shift record the shifted indices", () => {
  const draft = makeState();
  const tracked = trackStoreUpdater(draft);

  tracked.draft.messages.splice(1, 1);

  const paths = tracked.writePaths();
  // Elements shift down: indices 1..2 rewritten, index 3 deleted
  expect(wakes(["messages", 1], paths)).toBe(true);
  expect(wakes(["messages", 2], paths)).toBe(true);
  expect(wakes(["messages", 3], paths)).toBe(true);
  expect(draft.messages.map((m) => m.id)).toEqual(["msg-1", "msg-3", "msg-4"]);

  const shifted = trackStoreUpdater(makeState());
  shifted.draft.messages.shift();
  const shiftPaths = shifted.writePaths();
  expect(wakes(["messages", 0], shiftPaths)).toBe(true);
  expect(wakes(["messages", 2], shiftPaths)).toBe(true);
});

test("trackStoreUpdater: nested field set records the full path", () => {
  const draft = makeState();
  const tracked = trackStoreUpdater(draft);

  tracked.draft.profile.name = "grant";
  tracked.draft.messages[0]!.processed = true;

  const paths = tracked.writePaths();
  expect(paths).toContainEqual(["profile", "name"]);
  expect(paths).toContainEqual(["messages", 0, "processed"]);
  // Unrelated paths do not intersect
  expect(wakes(["status"], paths)).toBe(false);
  expect(draft.profile.name).toBe("grant");
  expect(draft.messages[0]!.processed).toBe(true);
});

test("trackStoreUpdater: Object.assign onto a nested object records each assigned key", () => {
  const draft = makeState();
  const tracked = trackStoreUpdater(draft);

  Object.assign(tracked.draft.profile.tags, { a: "1", b: "2" });

  const paths = tracked.writePaths();
  expect(paths).toContainEqual(["profile", "tags", "a"]);
  expect(paths).toContainEqual(["profile", "tags", "b"]);
  expect(draft.profile.tags).toEqual({ a: "1", b: "2" });
});

test("trackStoreUpdater: delete records the deleted path", () => {
  const draft = makeState();
  draft.profile.tags = { a: "1" };
  const tracked = trackStoreUpdater(draft);

  delete tracked.draft.profile.tags["a"];

  expect(tracked.writePaths()).toContainEqual(["profile", "tags", "a"]);
  expect(draft.profile.tags).toEqual({});
});

test("trackStoreUpdater: defineProperty records conservatively", () => {
  const draft = makeState();
  const tracked = trackStoreUpdater(draft);

  Object.defineProperty(tracked.draft.profile, "name", {
    value: "defined",
    writable: true,
    enumerable: true,
    configurable: true,
  });

  expect(tracked.writePaths()).toContainEqual(["profile", "name"]);
  expect(draft.profile.name).toBe("defined");
});

test("trackStoreUpdater: duplicate write paths are collapsed", () => {
  const draft = makeState();
  const tracked = trackStoreUpdater(draft);

  tracked.draft.status = "working";
  tracked.draft.status = "idle";
  tracked.draft.status = "working";

  expect(
    tracked.writePaths().filter((p) => p.join(".") === "status")
  ).toHaveLength(1);
});

test("trackStoreUpdater: values assigned through the proxy are unwrapped onto the raw draft", () => {
  const draft = makeState();
  const tracked = trackStoreUpdater(draft);

  // Read a child (returns a proxy) and store it elsewhere in the draft –
  // the raw draft must receive the raw object, not the proxy wrapper.
  const first = tracked.draft.messages[0]!;
  (tracked.draft as any).lastMessage = first;

  const stored = (draft as any).lastMessage;
  expect(stored).toBe(draft.messages[0]);
  expect(unwrapTrackedValue(stored)).toBe(stored);
  // Proxy-free: structuredClone rejects proxies, so this must not throw
  expect(() => structuredClone(draft)).not.toThrow();
});

test("trackStoreUpdater: mutations through a value selected via trackStoreSelector are recorded", () => {
  const draft = makeState();
  const tracked = trackStoreUpdater(draft);

  const { result } = trackStoreSelector(tracked.draft, (s) =>
    s.messages.find((m) => !m.claimedBy)
  );
  const selected = unwrapTrackedValue(result)!;
  selected.claimedBy = "exec-1";

  expect(tracked.writePaths()).toContainEqual(["messages", 0, "claimedBy"]);
  expect(draft.messages[0]!.claimedBy).toBe("exec-1");
});

test("cloneStoreState launders proxy wrappers into plain objects", () => {
  const tracked = trackStoreUpdater(makeState());
  // A fresh object holding a nested proxy (the shallow set-unwrap cannot
  // reach it) – commit-time cloning must still produce a proxy-free state.
  const dirty = { wrapper: { inner: tracked.draft.messages } };

  const clean = cloneStoreState(dirty);

  expect(() => structuredClone(clean)).not.toThrow();
  expect(clean.wrapper.inner).toEqual(makeState().messages);
});

type Ledger = { opened: Date; totals: Map<string, number>; seen: Set<string>; note: string };

function makeLedger(): Ledger {
  return {
    opened: new Date(0),
    totals: new Map([["mug", 1]]),
    seen: new Set(["mug"]),
    note: "",
  };
}

test("trackStoreUpdater: Map, Set and Date methods work on the draft and record their path", () => {
  const draft = makeLedger();
  const tracked = trackStoreUpdater(draft);

  tracked.draft.totals.set("cup", 2);
  tracked.draft.seen.add("cup");
  tracked.draft.opened.setTime(1);

  const paths = tracked.writePaths();
  expect(wakes(["totals"], paths)).toBe(true);
  expect(wakes(["seen"], paths)).toBe(true);
  expect(wakes(["opened"], paths)).toBe(true);
  expect(wakes(["note"], paths)).toBe(false);
  expect(draft.totals.get("cup")).toBe(2);
  expect(draft.seen.has("cup")).toBe(true);
  expect(draft.opened.getTime()).toBe(1);
});

test("trackStoreSelector: Map, Set and Date methods work and record a read of the whole value", () => {
  const { result, readPaths } = trackStoreSelector(makeLedger(), (state) => [
    state.totals.get("mug"),
    state.seen.has("mug"),
    state.opened.getTime(),
  ]);

  expect(result).toEqual([1, true, 0]);
  expect(readPaths).toEqual(
    expect.arrayContaining([["totals"], ["seen"], ["opened"]])
  );
});

test("diffStorePaths: compares Maps, Sets and Dates by content", () => {
  const next = makeLedger();
  expect(diffStorePaths(makeLedger(), next)).toEqual([]);

  next.totals.set("mug", 2);
  next.seen.add("cup");
  next.opened = new Date(1);
  expect(diffStorePaths(makeLedger(), next)).toEqual(
    expect.arrayContaining([["totals"], ["seen"], ["opened"]])
  );
  expect(diffStorePaths(makeLedger(), next)).toHaveLength(3);
});
