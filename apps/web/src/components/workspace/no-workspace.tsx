"use client";

import { Building2, LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";

/**
 * "You are not in any workspace."
 *
 * ⚠️ A REAL STATE, not an error, and it exists because of a decision worth
 * defending: `remove_account_member` (migration 095) deliberately stopped
 * minting a replacement personal workspace for the person it removes.
 *
 * Before 095 it had to — your membership WAS your account, so removing you from
 * one without creating another would have left your login pointing at nothing.
 * Now removal deletes one row and every other membership you hold survives. For
 * somebody who was only in that one workspace, the honest result is zero, and
 * conjuring an empty workspace they never asked for — which would immediately
 * resolve to `lapsed`, wear a "needs attention" dot and nag them to /billing —
 * is worse than saying what happened.
 *
 * The API returns `403 { error: 'no_workspace' }` for this, and
 * `GET /account/workspaces` returns an empty list rather than failing, which is
 * what lets this screen exist at all.
 *
 * Phase 2 adds a third button here: create one. Until self-serve creation ships
 * the only routes back in are an invite or an operator, so those are the only
 * two things this screen claims.
 */
export function NoWorkspace() {
  const { profile, signOut } = useAuth();

  return (
    <div className="flex h-dvh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex size-11 items-center justify-center rounded-full bg-muted">
            <Building2 className="size-5 text-muted-foreground" />
          </div>
          <CardTitle>You&apos;re not in any workspace</CardTitle>
          <CardDescription>
            {profile?.email ? (
              <>
                <span className="text-foreground">{profile.email}</span> isn&apos;t a
                member of a workspace right now.
              </>
            ) : (
              <>This account isn&apos;t a member of a workspace right now.</>
            )}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            This usually means you were removed from the last workspace you
            belonged to, or you left it. Ask an owner or admin to send you an
            invite link — accepting one adds you straight back in, and you can
            belong to as many workspaces as you like.
          </p>

          <Button
            variant="outline"
            className="w-full"
            onClick={() => {
              void signOut();
            }}
          >
            <LogOut className="size-4" />
            Sign out
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
