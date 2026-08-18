import { describe, expect, it } from "vitest";

import {
  SUPPORT_EMAIL,
  SUPPORT_WHATSAPP,
  trialExtensionMailto,
  trialExtensionWhatsApp,
} from "./support";

const CONTEXT = {
  workspaceName: "Acme Retail",
  planDisplayName: "Starter",
  email: "owner@acme.test",
};

describe("support contact links", () => {
  it("falls back to the address published on the marketing site", () => {
    // No NEXT_PUBLIC_SUPPORT_EMAIL in the test env, so this is the default.
    expect(SUPPORT_EMAIL).toBe("support@converse360.in");
  });

  it("prefills a mailto with everything an operator needs to find them", () => {
    const href = trialExtensionMailto(CONTEXT);

    expect(href.startsWith(`mailto:${SUPPORT_EMAIL}?`)).toBe(true);

    const query = new URLSearchParams(href.slice(href.indexOf("?") + 1));
    expect(query.get("subject")).toBe("More trial time for Acme Retail");

    const body = query.get("body") ?? "";
    expect(body).toContain("Workspace: Acme Retail");
    expect(body).toContain("Plan: Starter");
    expect(body).toContain("Account email: owner@acme.test");
  });

  /** Missing facts are omitted, not rendered as "Plan: null". */
  it("leaves out details it does not have", () => {
    const href = trialExtensionMailto({
      workspaceName: "Acme",
      planDisplayName: null,
      email: null,
    });
    const body =
      new URLSearchParams(href.slice(href.indexOf("?") + 1)).get("body") ?? "";

    expect(body).toContain("Workspace: Acme");
    expect(body).not.toContain("Plan:");
    expect(body).not.toContain("Account email:");
    expect(body).not.toContain("null");
  });

  /**
   * ⚠️ No number configured means NO button. A wa.me link built from a
   * placeholder opens a chat with nobody, and the customer reads silence
   * as being ignored.
   */
  it("returns no WhatsApp link when no number is configured", () => {
    expect(SUPPORT_WHATSAPP).toBeNull();
    expect(trialExtensionWhatsApp(CONTEXT)).toBeNull();
  });
});
