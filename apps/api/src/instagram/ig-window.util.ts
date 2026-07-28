/**
 * Instagram's messaging window.
 *
 * THE RULE
 *   A business may reply freely for 24 hours after the customer's last
 *   message. After that the thread is closed — unless the app holds
 *   Meta's **Human Agent** permission, which extends it to 7 days for
 *   messages sent by a human agent (not a bot).
 *
 * WHY THERE IS NO THIRD OPTION
 *   WhatsApp solves out-of-window re-engagement with pre-approved
 *   message templates. Instagram has no template mechanism at all.
 *   Past 7 days there is simply no compliant way to message the
 *   customer — the business has to wait for them.
 *
 * WHY THIS IS A PURE FUNCTION
 *   It is the single most consequential branch in the Instagram send
 *   path (get it wrong in the permissive direction and Meta restricts
 *   the app), so it is kept free of I/O and directly unit-tested.
 */

export const IG_STANDARD_WINDOW_MS = 24 * 60 * 60 * 1000;
export const IG_HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type IgSendDecision =
  /** Inside 24h — an ordinary reply. */
  | { allowed: true; requiresTag: null }
  /** 24h–7d and Human Agent is approved — must carry tag: HUMAN_AGENT. */
  | { allowed: true; requiresTag: 'HUMAN_AGENT' }
  /** Refused before any network call, with a reason for the UI. */
  | { allowed: false; reason: string; code: IgSendBlockCode };

export type IgSendBlockCode =
  /** The customer has never messaged us — no window was ever opened. */
  | 'no_inbound'
  /** Past 24h and the app lacks Human Agent approval. */
  | 'window_closed'
  /** Past 7 days. Nothing can send. */
  | 'human_agent_window_closed';

export interface IgWindowInput {
  /** `conversations.last_inbound_at`. */
  lastInboundAt: Date | null | undefined;
  /** Whether Meta has approved the Human Agent permission for this app. */
  humanAgentEnabled: boolean;
  /** Injectable for tests. Defaults to now. */
  now?: Date;
}

export function evaluateSendWindow(input: IgWindowInput): IgSendDecision {
  const now = input.now ?? new Date();

  if (!input.lastInboundAt) {
    return {
      allowed: false,
      code: 'no_inbound',
      reason:
        'This person has not messaged you yet. Instagram only allows a business to ' +
        'reply to a conversation the customer started.',
    };
  }

  const elapsed = now.getTime() - input.lastInboundAt.getTime();

  // A clock skew or a bad backfill could produce a future timestamp.
  // Treat it as "inside the window" rather than refusing a send that
  // is almost certainly legitimate.
  if (elapsed < IG_STANDARD_WINDOW_MS) {
    return { allowed: true, requiresTag: null };
  }

  if (!input.humanAgentEnabled) {
    return {
      allowed: false,
      code: 'window_closed',
      reason:
        'The 24-hour reply window has closed. Instagram has no message templates, so ' +
        'you cannot re-open it — wait for the customer to message again. ' +
        '(Meta’s Human Agent permission would extend this to 7 days.)',
    };
  }

  if (elapsed < IG_HUMAN_AGENT_WINDOW_MS) {
    return { allowed: true, requiresTag: 'HUMAN_AGENT' };
  }

  return {
    allowed: false,
    code: 'human_agent_window_closed',
    reason:
      'It has been more than 7 days since this person last messaged you. Instagram does ' +
      'not allow any further messages until they write again.',
  };
}

/**
 * Milliseconds left in the current window, for a countdown in the UI.
 * Null when there is no window (nothing to count down), 0 when closed.
 */
export function windowRemainingMs(input: IgWindowInput): number | null {
  if (!input.lastInboundAt) return null;
  const now = input.now ?? new Date();
  const limit = input.humanAgentEnabled
    ? IG_HUMAN_AGENT_WINDOW_MS
    : IG_STANDARD_WINDOW_MS;
  const remaining = input.lastInboundAt.getTime() + limit - now.getTime();
  return Math.max(0, remaining);
}
