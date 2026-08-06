import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * Full-screen route group for the signup wizard.
 *
 * Deliberately outside `(dashboard)`: the wizard is a hard gate, and
 * rendering it inside the shell would show a nav rail full of links to
 * pages the visitor is not yet allowed to open.
 */
export const metadata: Metadata = {
  title: "Welcome",
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false, noimageindex: true },
  },
};

export default function OnboardingLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
