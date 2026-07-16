'use client';

import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { WhatsAppEmbeddedSignupButton } from './whatsapp-embedded-signup-button';

/**
 * Screenshots of Meta's actual Embedded Signup wizard (public/whatsapp-steps/),
 * one per step. Set expectations before the user clicks "Continue with
 * Facebook" below — Meta's UI is out of our control and can change without
 * notice, but this is the flow as of when these were captured.
 */
const STEPS: Array<{
  title: string;
  bullets: string[];
  tip?: string;
  image: string;
}> = [
  {
    title: 'Login to Facebook',
    bullets: [
      "Ensure it's the admin account of your Meta Business.",
      'Grant the requested permissions on the following page.',
    ],
    tip: 'Use the Facebook profile you already use to manage your WhatsApp Business.',
    image: '/whatsapp-steps/images_1.png',
  },
  {
    title: 'Fill in your business information',
    bullets: [
      'Select an existing business portfolio, or create a new one.',
      "Add your business name, website, and country — customers won't see this on WhatsApp.",
    ],
    image: '/whatsapp-steps/images_2.png',
  },
  {
    title: 'Choose how to connect',
    bullets: [
      'Connect your existing WhatsApp Business app to keep your current number and chat history.',
      'Or start fresh with a new phone number instead.',
    ],
    image: '/whatsapp-steps/images_3.png',
  },
  {
    title: 'Add your business phone number',
    bullets: [
      'Enter the number customers will message on WhatsApp.',
      "It must match your existing WhatsApp Business app account if you're migrating a number.",
    ],
    image: '/whatsapp-steps/images_4.png',
  },
  {
    title: 'Confirm your WhatsApp Business account',
    bullets: [
      'Review the WhatsApp Business Account name that will be shared.',
      "Set the account's time zone.",
    ],
    image: '/whatsapp-steps/images_5.png',
  },
  {
    title: 'Scan the QR code to share your history',
    bullets: [
      'Open your WhatsApp Business app and look for a message from the official Facebook Business account.',
      'Tap "Scan QR code" to import contacts and up to six months of chat history.',
    ],
    image: '/whatsapp-steps/images_6.png',
  },
  {
    title: 'Choose whether to share chat history',
    bullets: [
      "Decide whether to share your existing chats — this can't be changed later.",
      "Confirm to finish connecting your account.",
    ],
    image: '/whatsapp-steps/images_7.png',
  },
];

interface WhatsAppConnectStepsProps {
  onConnected: () => void;
}

export function WhatsAppConnectSteps({ onConnected }: WhatsAppConnectStepsProps) {
  const [activeStep, setActiveStep] = useState(0);
  const step = STEPS[activeStep];
  const isFirst = activeStep === 0;
  const isLast = activeStep === STEPS.length - 1;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">You&apos;re almost there</CardTitle>
        <CardDescription className="text-muted-foreground">
          Continue with Facebook and follow the instructions below to connect your
          WhatsApp Business Account.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-6 md:grid-cols-2 md:items-center">
          <div className="flex h-[420px] items-center justify-center overflow-hidden rounded-lg border border-border bg-white p-2 shadow-sm">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={step.image}
              alt={step.title}
              className="max-h-full max-w-full object-contain"
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-foreground">
                  Step {activeStep + 1} <span className="font-normal text-muted-foreground">of {STEPS.length}</span>
                </p>
                <p className="text-base font-bold text-foreground">{step.title}</p>
              </div>
              <button
                type="button"
                onClick={() => setActiveStep((s) => Math.min(s + 1, STEPS.length - 1))}
                disabled={isLast}
                aria-label="Preview next step"
                className="mt-1 shrink-0 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
              >
                <ChevronRight className="size-5" />
              </button>
            </div>

            <ul className="space-y-1.5 text-sm text-muted-foreground">
              {step.bullets.map((b) => (
                <li key={b} className="flex gap-2">
                  <span className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground" />
                  <span>{b}</span>
                </li>
              ))}
            </ul>

            {step.tip && (
              <p className="text-sm text-primary">{step.tip}</p>
            )}

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => setActiveStep((s) => Math.max(s - 1, 0))}
                disabled={isFirst}
                aria-label="Preview previous step"
                className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-0"
              >
                <ChevronLeft className="size-3.5" />
              </button>
              {STEPS.map((s, i) => (
                <button
                  key={s.title}
                  type="button"
                  onClick={() => setActiveStep(i)}
                  aria-label={`Preview step ${i + 1}`}
                  className={`size-1.5 rounded-full transition-colors ${
                    i === activeStep ? 'bg-foreground' : 'bg-muted-foreground/30'
                  }`}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="border-t border-border pt-5">
          <WhatsAppEmbeddedSignupButton onConnected={onConnected} />
        </div>
      </CardContent>
    </Card>
  );
}
