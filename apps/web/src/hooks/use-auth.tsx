"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
import { DEFAULT_CURRENCY } from "@/lib/currency";
import { DEFAULT_COUNTRY } from "@/lib/whatsapp/phone-utils";
import {
  canEditSettings as canEditSettingsFor,
  canManageMembers as canManageMembersFor,
  canSendMessages as canSendMessagesFor,
  isAccountRole,
  type AccountRole,
} from "@/lib/auth/roles";
import type { UserSubscription } from "@/lib/subscription/plans";

/**
 * The PERSON. One name, one avatar, one email, however many workspaces —
 * migration 095 moved `account_id` / `account_role` off this row into
 * `account_members`, because a role is a property of a membership and the same
 * user is an owner in their own workspace and a viewer in a client's.
 */
interface Profile {
  id: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
  role: string | null;
  /**
   * Opted-in beta feature keys for this account. No current feature
   * reads this — Flows was the last user and went to soft-GA in PR
   * #134 — but the column survives for future beta gates.
   */
  beta_features: string[];
}

/**
 * One workspace this user belongs to, as `GET /api/account/workspaces` returns
 * it. Shape matches `list_my_workspaces()` (migration 095).
 */
export interface Workspace {
  id: string;
  name: string;
  /** Workspace logo (migration 071). null = none; render the initial
   *  fallback rather than a broken image. */
  logo_url: string | null;
  /** Default deal currency (ISO-4217). NOT NULL DEFAULT 'USD' in the
   *  DB (migration 021); narrowed to DEFAULT_CURRENCY when absent. */
  default_currency: string | null;
  /** Country assumed for phone numbers entered without a country code
   *  (ISO 3166-1 alpha-2). NOT NULL DEFAULT 'IN' in the DB (migration
   *  059); narrowed to DEFAULT_COUNTRY when absent. */
  default_country: string | null;
  /**
   * The role held IN THIS WORKSPACE — not "this user's role".
   *
   * Narrowed from the wire in `fetchWorkspaces`, and nullable because of it: a
   * future migration that broadens `account_role_enum` without updating this
   * union must leave the caller least-privileged rather than crash the app or,
   * worse, fall through a `=== 'viewer'` check into something permissive.
   */
  role: AccountRole | null;
  is_owner: boolean;
  member_count: number;
  plan_name: string | null;
  subscription_status: string | null;
  /**
   * `good` | `grace` | `lapsed` from `get_account_entitlement`.
   *
   * ⚠️ `grace` is dunning and still ENTITLED — writes work, and the product is
   * not taken away. Painting it like `lapsed` would tell a paying customer
   * whose card bounced once that their workspace is dead.
   */
  standing: "good" | "grace" | "lapsed" | null;
  trial_end_at: string | null;
  current_period_end: string | null;
  onboarding_done: boolean;
}

interface AccountSummary {
  id: string;
  name: string;
  logo_url: string | null;
  default_currency: string;
  default_country: string;
}

interface AuthContextValue {
  user: User | null;
  profile: Profile | null;
  /**
   * Session-level loading. Flips to false as soon as we know whether
   * a user is signed in, *without* waiting for the profile row. Use
   * this for chrome (sidebar / header) that can render with just the
   * user object.
   */
  loading: boolean;
  /**
   * Profile-row loading. Stays true until `fetchProfile` settles
   * (success, missing row, or error). Code that branches on
   * `profile.beta_features` MUST gate on this — otherwise it sees the
   * `{ loading: false, profile: null }` window during initial load
   * and may take the "not opted in" branch incorrectly.
   */
  profileLoading: boolean;
  signOut: () => Promise<void>;
  /** Re-fetch the current user's profile row — call after a save from
   *  the settings form so header/sidebar reflect the change without a
   *  full page reload. */
  refreshProfile: () => Promise<void>;

  // ----------------------------------------------------------
  // Workspace context
  //
  // ⚠️ All of these are nullable until `workspacesLoading` is false —
  // NOT `profileLoading`. They used to come off the profile row, so
  // gating on the profile was the same thing; since migration 095 they
  // come from `GET /api/account/workspaces` and settle separately.
  // Gating account-scoped work on `profileLoading` now reads
  // `accountId === null` as "no workspace" instead of "not yet known".
  //
  // And nullable is a REAL state, not just a loading one: a user removed
  // from the only workspace they were in belongs to none. `workspaces`
  // is empty and `accountId` stays null — which is what the dashboard
  // shell renders "you're not in any workspace" from.
  // ----------------------------------------------------------

  /** Every workspace the user is a member of, owned ones first. */
  workspaces: Workspace[];
  /** The workspace this session is acting in, or null. */
  activeWorkspace: Workspace | null;
  /** Loading state for the workspace list. Gate account-scoped reads on this. */
  workspacesLoading: boolean;
  /**
   * Switch workspace, then hard-reload.
   *
   * ⚠️ Reloads on purpose — realtime channels and caches are account-keyed,
   * and a soft switch would leave the previous workspace's subscriptions live.
   */
  switchWorkspace: (accountId: string) => Promise<void>;

  /** Active workspace's id. Null while loading, or if the user is in none. */
  accountId: string | null;
  /** Role held IN THE ACTIVE WORKSPACE — not "this user's role". */
  accountRole: AccountRole | null;
  /** Lightweight account meta — id + name + default_currency. Null while loading. */
  account: AccountSummary | null;
  /** Account default deal currency. Falls back to DEFAULT_CURRENCY
   *  while loading or when no account is resolved, so callers can use
   *  it unconditionally. */
  defaultCurrency: string;
  /** Country assumed for phone numbers typed without a country code.
   *  Pass this to toE164() on every contact write — the contacts UI
   *  writes to Supabase directly, so these components are real write
   *  paths and the CHECK constraint (migration 061) rejects anything
   *  un-normalized. Falls back to DEFAULT_COUNTRY while loading. */
  defaultCountry: string;
  /** True if `accountRole === 'owner'`. */
  isOwner: boolean;
  /** True if `accountRole === 'admin'` (does NOT include owner — use canManageMembers for "admin or above"). */
  isAdmin: boolean;
  /** True if `accountRole === 'agent'`. */
  isAgent: boolean;
  /** True if `accountRole === 'viewer'`. */
  isViewer: boolean;
  /** True if the caller can manage members (admin+). */
  canManageMembers: boolean;
  /** True if the caller can edit account-wide settings (admin+). */
  canEditSettings: boolean;
  /** True if the caller can send messages and edit operational data (agent+). */
  canSendMessages: boolean;

  // ----------------------------------------------------------
  // Subscription context
  // ----------------------------------------------------------

  /** User's current subscription with plan details. Null while loading. */
  subscription: UserSubscription | null;
  /** Loading state for subscription data. */
  subscriptionLoading: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * AuthProvider — wrap this around the dashboard layout.
 * Makes ONE getSession() call for the whole tree instead of one per
 * component, avoiding internal lock contention in the Supabase client.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [workspacesLoading, setWorkspacesLoading] = useState(true);
  const [subscription, setSubscription] = useState<UserSubscription | null>(null);
  const [loading, setLoading] = useState(true);
  // Tracked separately from `loading`. The session settles fast (one
  // local cookie read); the profile fetch crosses the network and
  // settles later. Callers that gate on `profile.*` need to know which
  // window they're in — see the type doc above.
  const [profileLoading, setProfileLoading] = useState(true);
  const [subscriptionLoading, setSubscriptionLoading] = useState(true);

  // Tracks the user ID we've successfully initiated/completed fetching
  // a profile for. This prevents redundant re-fetches and toggling
  // profileLoading back to true on window focus events/token refresh.
  const lastFetchedUserIdRef = useRef<string | null>(null);

  // Shared across init, auth-state-change listener, and the exposed
  // refreshProfile() callback. Reads the current session's user id and
  // pulls the matching profile row along with its account summary.
  /**
   * Which workspaces am I in, and which one am I looking at?
   *
   * ⚠️ THE API IS THE ONLY RESOLVER, and that is deliberate. Before migration
   * 095 "my account" was a column on my one profile row, so five different
   * modules each resolved it with their own `profiles.account_id` query and all
   * five necessarily agreed. Now the answer is a fallback chain (cookie →
   * last_account_id → owned → oldest, in apps/api's active-workspace.ts), and a
   * second implementation of that chain in the browser would disagree with the
   * server on exactly the cases the chain exists for — a fresh device, a stale
   * cookie — leaving the page querying workspace A while every API call served
   * workspace B. So we ask, and `activeAccountId` from that answer is what the
   * whole app scopes itself by.
   */
  const fetchWorkspaces = useCallback(async () => {
    setWorkspacesLoading(true);
    try {
      const res = await fetch("/api/account/workspaces", {
        cache: "no-store",
      });

      if (!res.ok) {
        // 401 is the ordinary signed-out case. Anything else and we leave the
        // previous list standing rather than blanking workspace context —
        // losing it mid-session logs the user out of every scoped query at
        // once, which is far worse than showing a slightly stale name.
        if (res.status === 401) {
          setWorkspaces([]);
          setActiveAccountId(null);
        }
        return;
      }

      const body = (await res.json()) as {
        activeAccountId: string | null;
        workspaces: Array<Omit<Workspace, "role"> & { role: unknown }>;
      };
      setWorkspaces(
        (body.workspaces ?? []).map((w) => ({
          ...w,
          role: isAccountRole(w.role) ? w.role : null,
        })),
      );
      setActiveAccountId(body.activeAccountId ?? null);
    } catch (err) {
      console.error("[AuthProvider] fetchWorkspaces threw:", err);
    } finally {
      setWorkspacesLoading(false);
    }
  }, []);

  // Shared across init, auth-state-change listener, and the exposed
  // refreshProfile() callback. `profiles` is now just the PERSON — name,
  // avatar, beta flags — so there is no account lookup here any more.
  const fetchProfile = useCallback(async (userId: string) => {
    const supabase = createClient();
    setProfileLoading(true);
    lastFetchedUserIdRef.current = userId;
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, email, avatar_url, role, beta_features")
        .eq("user_id", userId)
        .maybeSingle();

      if (error) {
        console.error("[AuthProvider] fetchProfile error:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        lastFetchedUserIdRef.current = null;
        return;
      }

      if (data) {
        setProfile({
          id: data.id,
          full_name: data.full_name,
          email: data.email,
          avatar_url: data.avatar_url,
          role: data.role,
          // `beta_features` is `NOT NULL DEFAULT ARRAY[]` in the DB, but
          // narrow defensively in case the column hasn't been migrated yet
          // (older deployments running 011 lazily) — `null` reads as no
          // opt-ins, which is the safe default for any future beta gate.
          beta_features: data.beta_features ?? [],
        });
      } else {
        lastFetchedUserIdRef.current = null;
      }
    } catch (err) {
      console.error("[AuthProvider] fetchProfile threw:", err);
      lastFetchedUserIdRef.current = null;
    } finally {
      setProfileLoading(false);
    }
  }, []);

  /**
   * Switch workspace.
   *
   * ⚠️ A FULL PAGE LOAD, not a router.push. Every realtime channel, SWR cache
   * and Supabase subscription in the dashboard is keyed by account id, and a
   * soft navigation leaves the previous workspace's channels subscribed — one
   * client's inbound messages would arrive in another client's inbox. There is
   * no partial-teardown story worth trusting here; reloading is cheap and
   * correct.
   */
  const switchWorkspace = useCallback(async (accountId: string) => {
    const res = await fetch("/api/account/workspaces/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(body?.error ?? "Could not switch workspace");
    }
    window.location.assign("/dashboard");
  }, []);

  // Fetch user's subscription data
  const fetchSubscription = useCallback(async (userId: string) => {
    const supabase = createClient();
    setSubscriptionLoading(true);
    try {
      const { data, error } = await supabase.rpc('get_user_subscription', {
        p_user_id: userId,
      });

      if (error) {
        console.error("[AuthProvider] fetchSubscription error:", error);
        setSubscription(null);
        return;
      }

      if (data && data.length > 0) {
        setSubscription(data[0] as UserSubscription);
      } else {
        setSubscription(null);
      }
    } catch (err) {
      console.error("[AuthProvider] fetchSubscription threw:", err);
      setSubscription(null);
    } finally {
      setSubscriptionLoading(false);
    }
  }, []);

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;

    const safetyTimer = setTimeout(() => {
      if (mounted) {
        console.warn("[AuthProvider] getSession() timed out after 3s");
        setLoading(false);
        setProfileLoading(false);
      }
    }, 3000);

    const init = async () => {
      try {
        const {
          data: { session },
          error,
        } = await supabase.auth.getSession();

        if (error) console.error("[AuthProvider] getSession error:", error.message);

        if (!mounted) return;
        const currentUser = session?.user ?? null;
        setUser(currentUser);

        if (currentUser) {
          // Don't block session loading on profile fetch — chrome
          // (header, sidebar) can render from the user object alone,
          // profile enriches async. Callers that need to branch on
          // profile data gate on `profileLoading` instead.
          fetchProfile(currentUser.id);
          fetchWorkspaces();
          fetchSubscription(currentUser.id);
        } else {
          // No user → no profile to load. Flip profileLoading off so
          // pages that gate on it don't wait forever on the logged-out
          // path (the route guard or redirect should fire instead).
          setProfileLoading(false);
          setWorkspacesLoading(false);
          setSubscriptionLoading(false);
        }
      } catch (err) {
        console.error("[AuthProvider] init threw:", err);
      } finally {
        if (mounted) setLoading(false);
        clearTimeout(safetyTimer);
      }
    };

    init();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      const currentUser = session?.user ?? null;
      setUser(currentUser);

      if (currentUser) {
        if (currentUser.id !== lastFetchedUserIdRef.current) {
          fetchProfile(currentUser.id);
          fetchWorkspaces();
          fetchSubscription(currentUser.id);
        }
      } else {
        lastFetchedUserIdRef.current = null;
        setProfile(null);
        setWorkspaces([]);
        setActiveAccountId(null);
        setSubscription(null);
        setProfileLoading(false);
        setWorkspacesLoading(false);
        setSubscriptionLoading(false);
      }

      setLoading(false);
    });

    return () => {
      mounted = false;
      clearTimeout(safetyTimer);
      subscription.unsubscribe();
    };
  }, [fetchProfile, fetchWorkspaces, fetchSubscription]);

  const signOut = useCallback(async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
    setWorkspaces([]);
    setActiveAccountId(null);
    setSubscription(null);
    window.location.href = "/login";
  }, []);

  const refreshProfile = useCallback(async () => {
    if (!user?.id) return;
    // Workspaces too: renaming the workspace or changing its logo used to land
    // on the `accounts` row this hook fetched itself, and now arrives through
    // `GET /account/workspaces`. Without this, saving a new name in Settings
    // leaves the old one in the header until a reload.
    await Promise.all([fetchProfile(user.id), fetchWorkspaces()]);
  }, [user?.id, fetchProfile, fetchWorkspaces]);

  /**
   * The workspace this session is acting in. Everything account-scoped derives
   * from here.
   *
   * ⚠️ `accountId` and `accountRole` keep their names and meanings on purpose —
   * dozens of components read them — but their SOURCE changed: they were the
   * caller's one profile row, and they are now the active membership. So
   * `accountRole` is the role held HERE. A component that caches it across a
   * switch would apply one workspace's permissions to another's data, which is
   * the other half of why switching does a full page load.
   */
  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeAccountId) ?? null,
    [workspaces, activeAccountId],
  );

  const account = useMemo<AccountSummary | null>(
    () =>
      activeWorkspace
        ? {
            id: activeWorkspace.id,
            name: activeWorkspace.name,
            logo_url: activeWorkspace.logo_url ?? null,
            default_currency:
              activeWorkspace.default_currency ?? DEFAULT_CURRENCY,
            default_country:
              activeWorkspace.default_country ?? DEFAULT_COUNTRY,
          }
        : null,
    [activeWorkspace],
  );

  // Derive the role booleans once per membership change rather than on
  // every consumer render. Cheap regardless, but the memo also gives
  // each derived value a stable identity for React.memo / useEffect
  // dependencies downstream.
  const derived = useMemo(() => {
    const role = activeWorkspace?.role ?? null;
    return {
      accountRole: role,
      accountId: activeWorkspace?.id ?? null,
      isOwner: role === "owner",
      isAdmin: role === "admin",
      isAgent: role === "agent",
      isViewer: role === "viewer",
      canManageMembers: role ? canManageMembersFor(role) : false,
      canEditSettings: role ? canEditSettingsFor(role) : false,
      canSendMessages: role ? canSendMessagesFor(role) : false,
    };
  }, [activeWorkspace]);

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        profileLoading,
        signOut,
        refreshProfile,
        account,
        workspaces,
        activeWorkspace,
        workspacesLoading,
        switchWorkspace,
        defaultCurrency: account?.default_currency ?? DEFAULT_CURRENCY,
        defaultCountry: account?.default_country ?? DEFAULT_COUNTRY,
        subscription,
        subscriptionLoading,
        ...derived,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

/**
 * useAuth — read the shared auth state from context.
 * Must be used inside an <AuthProvider>.
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    // Fallback for components rendered outside the provider (shouldn't
    // happen in normal flow, but don't crash the page). Account state
    // collapses to least-privileged null — every `canX` boolean is
    // false so UI gates fail closed.
    return {
      user: null,
      profile: null,
      loading: false,
      profileLoading: false,
      signOut: async () => {
        window.location.href = "/login";
      },
      refreshProfile: async () => {},
      account: null,
      workspaces: [],
      activeWorkspace: null,
      // `false`, not `true`: this fallback is a terminal state, not a load in
      // progress. A component outside the provider that gated on `true` would
      // spin for ever instead of rendering its empty case.
      workspacesLoading: false,
      switchWorkspace: async () => {},
      defaultCurrency: DEFAULT_CURRENCY,
      defaultCountry: DEFAULT_COUNTRY,
      subscription: null,
      subscriptionLoading: false,
      accountId: null,
      accountRole: null,
      isOwner: false,
      isAdmin: false,
      isAgent: false,
      isViewer: false,
      canManageMembers: false,
      canEditSettings: false,
      canSendMessages: false,
    };
  }
  return ctx;
}
