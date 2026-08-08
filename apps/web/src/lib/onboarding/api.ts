/**
 * Client for the Nest `/onboarding` controller, proxied through
 * `/api/onboarding` by the rewrites in next.config.ts.
 *
 * Types mirror `apps/api/src/onboarding/services/onboarding.service.ts`.
 * There is no shared types package between the two apps, so this file
 * is the seam — keep it in step with the service's return shape.
 */

export type OnboardingStep = "workspace" | "plan" | "done";

export interface OnboardingPlan {
  name: string;
  displayName: string;
  description: string | null;
  priceMonthly: number;
  priceYearly: number;
  trialDays: number | null;
  features: string[];
  maxContacts: number;
  maxMessagesMonthly: number;
  maxBroadcastsMonthly: number;
  /** null = unlimited. */
  maxFlows: number | null;
  maxTeamMembers: number;
  maxStorageMb: number;
  /** Quoted rather than listed — render an enquiry form, not a price. */
  isEnquiryOnly: boolean;
}

export interface OnboardingState {
  step: OnboardingStep;
  workspace: {
    name: string;
    /** Public URL in the `workspace-logos` bucket, or null for none. */
    logoUrl: string | null;
    goals: string[];
    teamSize: string | null;
    referralSource: string | null;
    referralOther: string | null;
  };
  subscription: {
    planName: string;
    planDisplayName: string;
    status: string;
    trialEndsAt: string | null;
  } | null;
  plans: OnboardingPlan[];
}

export interface WorkspacePayload {
  workspaceName: string;
  goals: string[];
  teamSize: string;
  referralSource: string;
  referralOther?: string;
  /**
   * Already uploaded to the `workspace-logos` bucket by the time this is
   * sent — the API stores the URL, never the bytes. `null` clears a logo
   * picked on an earlier pass; omit the key to leave it untouched.
   */
  logoUrl?: string | null;
}

export interface EnquiryPayload {
  fullName: string;
  workEmail: string;
  phone?: string;
  companySize?: string;
  message?: string;
}

/**
 * Nest's ValidationPipe reports failures as `message: string[]`, while
 * thrown HttpExceptions use a plain string. Flatten both so callers get
 * something they can put in front of a user.
 */
async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    const message = body?.message ?? body?.error;
    if (Array.isArray(message)) return message.join(", ");
    if (typeof message === "string") return message;
  } catch {
    // Non-JSON body (a proxy error page, say) — fall through.
  }
  return `Request failed (${response.status})`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/onboarding${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });

  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as T;
}

export function fetchOnboardingState(): Promise<OnboardingState> {
  return request<OnboardingState>("");
}

export function saveWorkspace(
  payload: WorkspacePayload,
): Promise<OnboardingState> {
  return request<OnboardingState>("/workspace", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function selectPlan(planName: string): Promise<OnboardingState> {
  return request<OnboardingState>("/plan", {
    method: "POST",
    body: JSON.stringify({ planName }),
  });
}

export function submitEnquiry(
  payload: EnquiryPayload,
): Promise<OnboardingState> {
  return request<OnboardingState>("/enquiry", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
