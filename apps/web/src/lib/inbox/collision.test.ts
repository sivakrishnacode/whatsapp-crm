import { describe, it, expect } from "vitest";
import {
  collisionLabel,
  dedupeByUser,
  occupiedConversationIds,
  viewersOf,
  PRESENCE_STALE_AFTER_MS,
  type InboxPresence,
} from "./collision";

const NOW = 1_700_000_000_000;

function p(over: Partial<InboxPresence> = {}): InboxPresence {
  return {
    userId: "u1",
    name: "Anil",
    conversationId: "c1",
    typing: false,
    at: NOW,
    ...over,
  };
}

describe("dedupeByUser", () => {
  it("keeps the newest entry when one person has two tabs open", () => {
    const out = dedupeByUser([
      p({ conversationId: "c1", at: NOW - 5_000 }),
      p({ conversationId: "c2", at: NOW }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].conversationId).toBe("c2");
  });

  it("keeps distinct people apart", () => {
    expect(
      dedupeByUser([p({ userId: "u1" }), p({ userId: "u2", name: "Priya" })]),
    ).toHaveLength(2);
  });
});

describe("viewersOf", () => {
  it("excludes me — otherwise every thread looks occupied", () => {
    expect(viewersOf([p({ userId: "me" })], "c1", "me", NOW)).toEqual([]);
  });

  it("reports a teammate in the same thread", () => {
    const out = viewersOf([p({ userId: "u2", name: "Priya" })], "c1", "me", NOW);
    expect(out.map((v) => v.name)).toEqual(["Priya"]);
  });

  it("ignores teammates in other threads", () => {
    expect(
      viewersOf([p({ userId: "u2", conversationId: "c9" })], "c1", "me", NOW),
    ).toEqual([]);
  });

  it("drops entries past the staleness backstop", () => {
    const stale = p({ userId: "u2", at: NOW - PRESENCE_STALE_AFTER_MS - 1 });
    expect(viewersOf([stale], "c1", "me", NOW)).toEqual([]);
  });

  it("returns nothing when no thread is open", () => {
    expect(viewersOf([p({ userId: "u2" })], null, "me", NOW)).toEqual([]);
  });

  it("sorts by name so the header does not reshuffle on every sync", () => {
    const out = viewersOf(
      [
        p({ userId: "u2", name: "Zoya" }),
        p({ userId: "u3", name: "Anil" }),
      ],
      "c1",
      "me",
      NOW,
    );
    expect(out.map((v) => v.name)).toEqual(["Anil", "Zoya"]);
  });
});

describe("occupiedConversationIds", () => {
  it("collects other people's threads, never my own", () => {
    const ids = occupiedConversationIds(
      [
        p({ userId: "me", conversationId: "mine" }),
        p({ userId: "u2", conversationId: "theirs" }),
      ],
      "me",
      NOW,
    );
    expect([...ids]).toEqual(["theirs"]);
  });

  it("skips entries with no thread open", () => {
    expect(
      occupiedConversationIds(
        [p({ userId: "u2", conversationId: null })],
        "me",
        NOW,
      ).size,
    ).toBe(0);
  });
});

describe("collisionLabel", () => {
  it("is silent when nobody else is here", () => {
    expect(collisionLabel([])).toBeNull();
  });

  it("names one viewer", () => {
    expect(collisionLabel([p({ name: "Priya" })])).toBe("Priya is also viewing");
  });

  it("names two", () => {
    expect(
      collisionLabel([p({ name: "Anil" }), p({ userId: "u2", name: "Priya" })]),
    ).toBe("Anil and Priya are also viewing");
  });

  it("counts past two", () => {
    expect(
      collisionLabel([
        p({ name: "Anil" }),
        p({ userId: "u2", name: "Priya" }),
        p({ userId: "u3", name: "Zoya" }),
      ]),
    ).toBe("Anil and 2 others are also viewing");
  });

  // The distinction the feature exists for: viewing is a reason to
  // coordinate, typing is a reason to stop.
  it("promotes a typist over mere viewers", () => {
    expect(
      collisionLabel([
        p({ name: "Anil", typing: false }),
        p({ userId: "u2", name: "Priya", typing: true }),
      ]),
    ).toBe("Priya is also replying");
  });
});
