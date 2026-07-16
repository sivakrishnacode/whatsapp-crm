'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Loader2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

/* eslint-disable @typescript-eslint/no-explicit-any -- the Facebook JS SDK ships no types */
declare global {
  interface Window {
    FB: any;
    fbAsyncInit: any;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// Keep in sync with META_API_VERSION in src/lib/whatsapp/meta-api.ts —
// the JS SDK version doesn't have to match the Graph API version Meta
// calls are made against, but there's no reason to let them drift.
const FB_SDK_VERSION = 'v21.0';

type SignupStatus = 'idle' | 'connecting' | 'exchanging' | 'error' | 'cancelled';

interface EmbeddedSignupSession {
  wabaId: string | null;
  phoneNumberId: string | null;
  businessId: string | null;
  /** True for Meta's FINISH_ONLY_WABA event — see the postMessage handler below. */
  coexistence: boolean;
}

interface WhatsAppEmbeddedSignupButtonProps {
  /** Called after a successful /api/whatsapp/connect call so the parent can reload the saved config. */
  onConnected: () => void;
}

export function WhatsAppEmbeddedSignupButton({
  onConnected,
}: WhatsAppEmbeddedSignupButtonProps) {
  const appId = process.env.NEXT_PUBLIC_FACEBOOK_APP_ID || '';
  const configId = process.env.NEXT_PUBLIC_FACEBOOK_CONFIG_ID || '';
  const notConfigured = !appId || !configId;

  const [status, setStatus] = useState<SignupStatus>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  // Populated by the postMessage listener below, read once FB.login's
  // own callback delivers the `code`. A ref, not state, because the
  // two events (postMessage vs. FB.login callback) fire independently
  // and in no guaranteed order — whichever handler runs second needs
  // to see what the other already captured.
  const sessionRef = useRef<EmbeddedSignupSession | null>(null);

  // Load the Facebook JS SDK once. Same script-injection pattern as
  // FacebookLeadsConfig (facebook-leads-config.tsx) — a second FB
  // product on this page reuses the same window.FB instance, so the
  // "if (window.FB) return" guard prevents double-injecting the script
  // when both settings panels are mounted.
  useEffect(() => {
    if (typeof window === 'undefined' || !appId) return;
    if (window.FB) return;

    window.fbAsyncInit = function () {
      window.FB.init({
        appId,
        xfbml: false,
        version: FB_SDK_VERSION,
      });
    };

    (function (d, s, id) {
      const fjs = d.getElementsByTagName(s)[0];
      if (d.getElementById(id)) return;
      const js = d.createElement(s) as HTMLScriptElement;
      js.id = id;
      js.src = 'https://connect.facebook.net/en_US/sdk.js';
      fjs.parentNode?.insertBefore(js, fjs);
    })(document, 'script', 'facebook-jssdk');
  }, [appId]);

  // Embedded Signup's popup reports its own progress via
  // window.postMessage — it's the only place waba_id / phone_number_id
  // / business_id ever show up; FB.login's callback only ever carries
  // the OAuth `code`. Origin-checked so only Facebook's own domain can
  // drive this handler.
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.origin !== 'https://www.facebook.com') return;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let data: any;
      try {
        data = JSON.parse(event.data);
      } catch {
        return; // not a WA_EMBEDDED_SIGNUP message
      }
      if (data?.type !== 'WA_EMBEDDED_SIGNUP') return;

      if (data.event === 'CANCEL') {
        setStatus('cancelled');
        return;
      }

      if (data.event === 'ERROR') {
        setStatus('error');
        setErrorMessage(
          data.data?.error_message || 'Facebook reported an error during setup.'
        );
        return;
      }

      // FINISH = standard flow, the number is being fully migrated to
      // the Cloud API. FINISH_ONLY_WABA = "coexistence" — the merchant
      // kept the number on the WhatsApp Business App and only shared
      // the WABA. The backend must never call /register in that case
      // (see src/lib/whatsapp/connect-account.ts).
      if (data.event === 'FINISH' || data.event === 'FINISH_ONLY_WABA') {
        sessionRef.current = {
          wabaId: data.data?.waba_id ?? null,
          phoneNumberId: data.data?.phone_number_id ?? null,
          businessId: data.data?.business_id ?? null,
          coexistence: data.event === 'FINISH_ONLY_WABA',
        };
      }
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  async function exchangeAndConnect(code: string, session: EmbeddedSignupSession) {
    setStatus('exchanging');
    try {
      const res = await fetch('/api/whatsapp/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          waba_id: session.wabaId,
          phone_number_id: session.phoneNumberId,
          business_id: session.businessId,
          coexistence: session.coexistence,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to connect WhatsApp account');
      }

      setStatus('idle');
      if (data.registration_error) {
        toast.error(
          `Connected, but Meta couldn't register the number: ${data.registration_error}`,
          { duration: 12000 }
        );
      } else if (data.registration_skipped) {
        toast.success(
          session.coexistence
            ? 'WhatsApp Business Account connected. This number stays on the WhatsApp Business App (coexistence mode).'
            : 'Credentials saved and verified. See Registration status below.',
          { duration: 10000 }
        );
      } else {
        toast.success(
          data.phone_info?.verified_name
            ? `Connected — ${data.phone_info.verified_name} is live.`
            : 'WhatsApp connected via Facebook.'
        );
      }
      onConnected();
    } catch (err) {
      console.error('[embedded-signup] connect failed:', err);
      setStatus('error');
      setErrorMessage(
        err instanceof Error ? err.message : 'Failed to connect WhatsApp account'
      );
    }
  }

  const handleConnect = useCallback(() => {
    if (!window.FB) {
      toast.error('Facebook SDK not loaded yet. Try again in a moment, or check for ad blockers.');
      return;
    }
    if (notConfigured) {
      toast.error('Embedded Signup is not configured for this app yet.');
      return;
    }

    sessionRef.current = null;
    setErrorMessage('');
    setStatus('connecting');

    window.FB.login(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (response: any) => {
        if (!response.authResponse) {
          // Either the popup was closed before completing, or FB never
          // got as far as posting a WA_EMBEDDED_SIGNUP message. If the
          // message listener already flipped status to 'cancelled' or
          // 'error', leave that in place — it's more specific.
          setStatus((s) => (s === 'connecting' ? 'cancelled' : s));
          return;
        }

        const code = response.authResponse.code as string | undefined;
        const session = sessionRef.current;

        if (!code || !session?.wabaId || !session?.phoneNumberId) {
          setStatus('error');
          setErrorMessage(
            "Facebook didn't return the expected WhatsApp account details. Please try again."
          );
          return;
        }

        void exchangeAndConnect(code, session);
      },
      {
        config_id: configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: { sessionInfoVersion: '3' },
      }
    );
    // exchangeAndConnect intentionally omitted — it's stable across
    // renders (no closed-over state) and including it would force this
    // callback to be redefined on every status change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configId, notConfigured]);

  const busy = status === 'connecting' || status === 'exchanging';

  return (
    <div className="space-y-2">
      <Button
        onClick={handleConnect}
        disabled={busy || notConfigured}
        className="bg-[#1877F2] hover:bg-[#1877F2]/90 text-white"
      >
        {busy ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            {status === 'connecting' ? 'Waiting for Facebook…' : 'Connecting…'}
          </>
        ) : (
          <>
            <svg className="size-4" xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 24 24">
              <path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-3.5H16c-1.21 0-1.5.59-1.5 1.5v2H11v-6h2.5V11h-2.5V8.5C11 6.57 12 5.5 14.5 5.5c.9 0 1.5.1 2 .2v2.3h-1.5c-.83 0-1 .39-1 1V11h2.5l-.5 2.5H14v5h4.5z" />
            </svg>
            Connect with Facebook
          </>
        )}
      </Button>

      {status === 'error' && errorMessage && (
        <p className="text-xs text-red-400">{errorMessage}</p>
      )}
      {status === 'cancelled' && (
        <p className="text-xs text-muted-foreground">Setup was cancelled.</p>
      )}
      {notConfigured && (
        <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
          <span>
            Set <code className="font-mono">NEXT_PUBLIC_FACEBOOK_APP_ID</code> and{' '}
            <code className="font-mono">NEXT_PUBLIC_FACEBOOK_CONFIG_ID</code> to enable
            one-click connect.
          </span>
        </div>
      )}
    </div>
  );
}
