import type { Metadata } from 'next';

import { LoginForm } from '@/app/login/login-form';

export const metadata: Metadata = { title: 'Sign in · Converse360 Admin' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <p className="text-ink text-lg font-semibold">Converse360 Admin</p>
          <p className="text-muted mt-1 text-sm">
            Subscriber accounts, subscriptions and sales.
          </p>
        </div>

        <div className="border-ring bg-surface rounded-xl border p-5">
          <LoginForm next={next} />
        </div>

        <p className="text-muted mt-6 text-xs leading-relaxed">
          One shared administrator credential, set in this deployment&apos;s env
          file. Sessions are signed and expire on their own.
        </p>
      </div>
    </div>
  );
}
