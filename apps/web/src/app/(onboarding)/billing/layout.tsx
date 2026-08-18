import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * Overrides the group layout's "Welcome" title — this route is not a
 * welcome. The group's noindex robots directives still apply.
 */
export const metadata: Metadata = {
  title: "Plan & billing",
};

export default function BillingLockedLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
