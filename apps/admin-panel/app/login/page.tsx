import type { Metadata } from 'next';

import { LoginForm } from '@/app/login/login-form';

export const metadata: Metadata = {
  title: 'Sign in · Converse360 Control Center',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="bg-rail hidden flex-col justify-between p-10 lg:flex">
        <p className="text-[22px] font-extrabold tracking-tight text-white">
          Converse<span className="text-[#80abed]">360</span>
          <span className="text-rail-muted block text-[10px] font-semibold tracking-[0.16em] uppercase">
            Control Center
          </span>
        </p>
        <div className="max-w-md">
          <p className="text-2xl leading-snug font-semibold text-white">
            Every client, channel, ticket and renewal — in one place.
          </p>
          <p className="text-rail-ink mt-3 text-sm leading-relaxed">
            Internal operations for the Converse360 team. Access is per staff
            member, role-scoped, and every change is recorded in the audit log.
          </p>
        </div>
        <p className="text-rail-muted text-xs">
          Internal use only. Not for customers.
        </p>
      </div>

      <div className="flex items-center justify-center px-4 py-16">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <p className="text-ink text-xl font-extrabold tracking-tight">
              Converse<span className="text-primary">360</span>
            </p>
            <p className="text-muted text-xs font-semibold tracking-[0.16em] uppercase">
              Control Center
            </p>
          </div>

          <h1 className="text-ink text-2xl font-bold tracking-tight">
            Sign in
          </h1>
          <p className="text-muted mt-1 text-sm">
            Use your staff email and password.
          </p>

          <div className="border-ring bg-surface shadow-card mt-6 rounded-2xl border p-6">
            <LoginForm next={next} />
          </div>

          <p className="text-muted mt-6 text-xs leading-relaxed">
            Sessions are signed, expire on their own, and end immediately when a
            Super Admin deactivates an account or resets its password.
          </p>
        </div>
      </div>
    </div>
  );
}
