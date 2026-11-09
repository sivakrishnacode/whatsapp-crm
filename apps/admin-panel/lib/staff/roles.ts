/**
 * Staff roles and what each may do — the ONE permission table.
 *
 * The nav hides what a role cannot use, every page asks
 * `requireCapability()` before it reads, and every Server Action asks again
 * before it writes. All three read this map, so they cannot disagree. Hiding
 * a link is a courtesy; the page and action checks are the boundary (a
 * Server Action is reachable by direct POST whatever the nav showed).
 *
 * Pure and secret-free on purpose, so client components may import it for
 * labels.
 *
 * Roles follow the C2.0 handoff: L1 reads basic health and onboarding; L2
 * makes approved safe configuration changes; L3 adds API/webhook
 * diagnostics; Super Admin governs staff, model mapping and settings. Account
 * managers own client relationships; billing owns money. NO role can reveal
 * a plaintext secret — there is no capability for that because no screen
 * reads one.
 */

export const STAFF_ROLES = [
  'super_admin',
  'account_manager',
  'billing',
  'support_l1',
  'support_l2',
  'support_l3',
] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];

export const ROLE_LABEL: Record<StaffRole, string> = {
  super_admin: 'Super Admin',
  account_manager: 'Account Manager',
  billing: 'Billing',
  support_l1: 'Support L1',
  support_l2: 'Support L2',
  support_l3: 'Support L3',
};

export const ROLE_SUMMARY: Record<StaffRole, string> = {
  super_admin:
    'Everything, including staff accounts, the AI catalog mapping and settings.',
  account_manager:
    'Owns client relationships: assignment, lifecycle, notes, tasks, tickets and safe workspace changes. Reads billing.',
  billing:
    'Subscriptions, plans, renewals and AI credit adjustments. Works billing tickets.',
  support_l1:
    'Reads onboarding, health and client records; works tickets. No billing figures.',
  support_l2:
    'L1, plus safe configuration changes on a workspace (membership, invitations, settings).',
  support_l3:
    'L2, plus API keys, webhooks and integration diagnostics, and the internal model mapping.',
};

export type Capability =
  /** See the client directory, Customer 360, health, onboarding. */
  | 'clients.read'
  /** Assign owners, pin lifecycle, set tier/tags. */
  | 'clients.manage'
  /** Write notes and tasks on a client. */
  | 'clients.notes'
  /** Membership, invitations, workspace name/country/currency. */
  | 'members.manage'
  /** See money: MRR, prices, subscriptions, invoices, credit revenue. */
  | 'billing.read'
  /** Edit subscriptions, plans and credit pack prices. */
  | 'billing.manage'
  /** Move AI credits through admin_adjust_ai_credits. */
  | 'credits.adjust'
  /** See and work the support desk. */
  | 'tickets.work'
  /** API keys, webhook endpoints, integration diagnostics. */
  | 'integrations.read'
  /** See the provider/model behind each Converse alias. */
  | 'catalog.read_mapping'
  /** Edit the AI catalog. */
  | 'catalog.manage'
  /** Create, deactivate and re-role staff. */
  | 'staff.manage'
  /** The full cross-tenant audit log. */
  | 'audit.read'
  /** SLA targets, watch windows, thresholds. */
  | 'settings.manage'
  /** CSV exports of client and portfolio data. */
  | 'export';

const ALL: Capability[] = [
  'clients.read',
  'clients.manage',
  'clients.notes',
  'members.manage',
  'billing.read',
  'billing.manage',
  'credits.adjust',
  'tickets.work',
  'integrations.read',
  'catalog.read_mapping',
  'catalog.manage',
  'staff.manage',
  'audit.read',
  'settings.manage',
  'export',
];

const SUPPORT_BASE: Capability[] = [
  'clients.read',
  'clients.notes',
  'tickets.work',
];

export const ROLE_CAPABILITIES: Record<StaffRole, ReadonlySet<Capability>> = {
  super_admin: new Set(ALL),
  account_manager: new Set<Capability>([
    'clients.read',
    'clients.manage',
    'clients.notes',
    'members.manage',
    'billing.read',
    'tickets.work',
    'audit.read',
    'export',
  ]),
  billing: new Set<Capability>([
    'clients.read',
    'clients.notes',
    'billing.read',
    'billing.manage',
    'credits.adjust',
    'tickets.work',
    'audit.read',
    'export',
  ]),
  support_l1: new Set<Capability>(SUPPORT_BASE),
  support_l2: new Set<Capability>([
    ...SUPPORT_BASE,
    'members.manage',
    'billing.read',
  ]),
  support_l3: new Set<Capability>([
    ...SUPPORT_BASE,
    'members.manage',
    'billing.read',
    'integrations.read',
    'catalog.read_mapping',
    'audit.read',
  ]),
};

export function isStaffRole(value: unknown): value is StaffRole {
  return (
    typeof value === 'string' &&
    (STAFF_ROLES as readonly string[]).includes(value)
  );
}

export function roleCan(role: StaffRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].has(capability);
}
