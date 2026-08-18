'use client';

import type { ReactNode } from 'react';
import { CheckCircle2, Loader2, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { WhatsAppEmbeddedSignupButton } from './whatsapp-embedded-signup-button';
import type { WhatsAppConfig } from '@/types';

export interface WhatsAppPhoneInfo {
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
}

interface WhatsAppConnectedCardProps {
  config: WhatsAppConfig;
  phoneInfo: WhatsAppPhoneInfo | null;
  tokenExpiresAt: string | null;
  tokenExpiringSoon: boolean;
  verifying: boolean;
  onVerify: () => void;
  onConnected: () => void;
}

/**
 * Meta grades a number's send quality GREEN / YELLOW / RED, and returns
 * UNKNOWN for one that has not sent enough yet. Anything outside the three
 * graded values falls through to plain body colour rather than being
 * mislabelled — a new number reading "UNKNOWN" in red would look broken.
 */
const QUALITY_TONE: Record<string, string> = {
  GREEN: 'text-success',
  YELLOW: 'text-warning',
  RED: 'text-destructive',
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-border/60 py-2.5 last:border-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground text-right">{children}</dd>
    </div>
  );
}

/**
 * What a connected workspace sees instead of the setup walkthrough.
 *
 * Once a number is live, the seven-step "Login to Facebook" carousel is
 * describing something the user already did, and a second "Connect with
 * Facebook" button reads as though the connection had not taken. This card
 * replaces both, and absorbs the credentials/registration banners that sat
 * above them: those two facts are only worth separating when they disagree
 * (a valid token with no registration means you can send but never receive),
 * and the parent still splits them out whenever that happens.
 *
 * Reconnecting stays available, but as a labelled action rather than the
 * primary call — it is how a workspace moves to a different number, and how
 * an expiring token gets refreshed.
 */
export function WhatsAppConnectedCard({
  config,
  phoneInfo,
  tokenExpiresAt,
  tokenExpiringSoon,
  verifying,
  onVerify,
  onConnected,
}: WhatsAppConnectedCardProps) {
  const quality = phoneInfo?.quality_rating;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-foreground flex items-center gap-2">
              <CheckCircle2 className="size-4 shrink-0 text-success" />
              {phoneInfo?.verified_name || 'WhatsApp connected'}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {phoneInfo?.display_phone_number ? (
                <>
                  Sending and receiving on{' '}
                  <span className="font-medium text-foreground">
                    {phoneInfo.display_phone_number}
                  </span>
                  .
                </>
              ) : (
                'This workspace is connected to the WhatsApp Business API.'
              )}
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onVerify}
            disabled={verifying}
            className="h-7 border-border bg-transparent text-foreground hover:bg-muted"
          >
            {verifying ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Zap className="size-3.5" />
            )}
            Verify with Meta
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        <dl>
          {quality && (
            <Row label="Quality rating">
              <span className={QUALITY_TONE[quality] ?? 'text-foreground'}>
                {quality}
              </span>
            </Row>
          )}

          <Row label="Receiving events">
            {config.registered_at
              ? `since ${new Date(config.registered_at).toLocaleString()}`
              : 'yes'}
          </Row>

          {config.coexistence && (
            <Row label="Mode">
              Coexistence — this number stays on the WhatsApp Business App
            </Row>
          )}

          {/* Only rendered when Meta actually told us an expiry. A token with
              no `expires_in` in the exchange response is not proof that it
              never expires, so this says nothing rather than promising
              "never" and being wrong about it 60 days later. */}
          {tokenExpiresAt && (
            <Row label="Access token">
              <span className={tokenExpiringSoon ? 'text-warning' : undefined}>
                Expires {new Date(tokenExpiresAt).toLocaleDateString()}
              </span>
              {tokenExpiringSoon && (
                <span className="block text-xs text-warning">
                  Reconnect below before it lapses, or messages stop sending.
                </span>
              )}
            </Row>
          )}

          <Row label="Phone number ID">
            <code className="font-mono text-xs">{config.phone_number_id}</code>
          </Row>

          {config.waba_id && (
            <Row label="WhatsApp Business Account ID">
              <code className="font-mono text-xs">{config.waba_id}</code>
            </Row>
          )}
        </dl>

        <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-4">
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">
              Connect a different number
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Runs WhatsApp signup again and replaces the credentials stored
              for this workspace.
            </p>
          </div>
          <WhatsAppEmbeddedSignupButton onConnected={onConnected} />
        </div>
      </CardContent>
    </Card>
  );
}
