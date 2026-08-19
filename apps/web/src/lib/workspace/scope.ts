/**
 * ⚠️⚠️ WHY EVERY BROWSER QUERY NOW CARRIES `.eq('account_id', accountId)`
 *
 * Read this before adding a Supabase query to a client component.
 *
 * ## What changed
 *
 * RLS scopes a browser query to the caller's MEMBERSHIPS —
 * `is_account_member(account_id)` is true for every workspace they belong to.
 * Until migration 095 that was the same thing as "one workspace", because
 * `profiles.user_id` was UNIQUE and the row named exactly one account. So
 * ~49 queries in this app were written with no account filter at all and were
 * nonetheless perfectly scoped, for free, by the policy.
 *
 * The moment a user can belong to several workspaces, those queries return the
 * UNION of all of them. Not a tenant leak — they really are a member of each —
 * but a correctness failure precisely in the case this feature exists for: an
 * agency opens Contacts and sees every client's contacts in one list, with no
 * indication that is what happened.
 *
 * ## The rule
 *
 * **RLS decides what you MAY see. The query decides what you ARE seeing.**
 *
 * Every read of an account-scoped table from the browser must filter on the
 * active workspace explicitly, and the active workspace comes from
 * `useAuth().accountId` — which is resolved server-side by apps/api's
 * active-workspace.ts and is the only resolver (see the comment there).
 *
 * This is the sibling of the rule already in CLAUDE.md for the API: *if a query
 * runs through Prisma or a SECURITY DEFINER function, RLS is not protecting you
 * — scope it yourself.* Here: *RLS scopes you to your memberships, not to one
 * workspace — scope the workspace yourself.*
 *
 * ## Waiting for it
 *
 * `accountId` is null until `workspacesLoading` is false. A query fired with
 * null must not run — filtering on null returns nothing, and an empty list is
 * indistinguishable from an empty workspace. Gate on `accountId` being present,
 * which `WORKSPACE_NOT_READY` below exists to make greppable.
 *
 * ## What does NOT need it
 *
 * A child table already filtered by a parent id that is itself workspace-scoped
 * — `messages` by `conversation_id`, `contact_tags` by `contact_id`,
 * `pipeline_stages` by `pipeline_id`. The parent lookup carries the scope. A
 * child queried WITHOUT a parent id does need it (or a parent join), which is
 * how `messages` in the dashboard charts slipped through.
 */

/** Sentinel for "the active workspace is not known yet, so do not query". */
export const WORKSPACE_NOT_READY = Symbol('workspace-not-ready');
