import { describe, expect, it } from "vitest";
import {
  buildReactionRequest,
  channelSupportsReactions,
  igReactionFor,
  quickEmojisFor,
} from "./reactions";

/**
 * The regression these pin: every reaction used to POST to
 * /api/whatsapp/react, which resolves the recipient through
 * `contacts.phone`. Instagram contacts have no phone, so reacting on an
 * Instagram thread always failed with "Contact phone number not found".
 */
describe("buildReactionRequest", () => {
  const base = { conversationId: "conv-1", messageId: "msg-1" };

  it("sends a WhatsApp reaction to the WhatsApp endpoint, by emoji", () => {
    expect(
      buildReactionRequest({ ...base, channel: "whatsapp", emoji: "🙏" }),
    ).toEqual({
      path: "/api/whatsapp/react",
      body: { message_id: "msg-1", emoji: "🙏" },
    });
  });

  it("NEVER routes an Instagram reaction through the WhatsApp endpoint", () => {
    const req = buildReactionRequest({
      ...base,
      channel: "instagram",
      emoji: "❤️",
    });
    expect(req?.path).toBe("/api/instagram/react");
    expect(req?.body).not.toHaveProperty("emoji");
  });

  it("translates the emoji to Instagram's named reaction", () => {
    expect(
      buildReactionRequest({ ...base, channel: "instagram", emoji: "😂" }),
    ).toEqual({
      path: "/api/instagram/react",
      body: {
        conversation_id: "conv-1",
        message_id: "msg-1",
        reaction: "laugh",
      },
    });
  });

  it("spells removal as an absent reaction on Instagram, empty emoji on WhatsApp", () => {
    expect(
      buildReactionRequest({ ...base, channel: "instagram", emoji: "" })?.body,
    ).toEqual({ conversation_id: "conv-1", message_id: "msg-1" });

    expect(
      buildReactionRequest({ ...base, channel: "whatsapp", emoji: "" })?.body,
    ).toEqual({ message_id: "msg-1", emoji: "" });
  });

  it("refuses an emoji Instagram has no name for, rather than falling back", () => {
    expect(
      buildReactionRequest({ ...base, channel: "instagram", emoji: "🙏" }),
    ).toBeNull();
  });

  it("refuses the web channel, which has no reaction transport", () => {
    expect(
      buildReactionRequest({ ...base, channel: "web", emoji: "👍" }),
    ).toBeNull();
  });
});

describe("the Instagram quick set", () => {
  it("offers only emoji the API accepts", () => {
    for (const emoji of quickEmojisFor("instagram")) {
      expect(igReactionFor(emoji)).not.toBeNull();
    }
  });

  it("covers all six of Instagram's named reactions", () => {
    const names = quickEmojisFor("instagram").map(igReactionFor);
    expect(new Set(names)).toEqual(
      new Set(["like", "love", "laugh", "wow", "sad", "angry"]),
    );
  });

  it("leaves web empty so the button is hidden, not shown-and-failing", () => {
    expect(quickEmojisFor("web")).toHaveLength(0);
    expect(channelSupportsReactions("web")).toBe(false);
    expect(channelSupportsReactions("instagram")).toBe(true);
    expect(channelSupportsReactions("whatsapp")).toBe(true);
  });
});
