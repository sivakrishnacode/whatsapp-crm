'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FacebookLeadsConfig } from '@/components/settings/facebook-leads-config';

export default function FacebookLeadsPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/integrations">
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
            <ArrowLeft className="size-3.5" />
            Back to Integrations
          </Button>
        </Link>
      </div>

      <div className="rounded-xl border border-border bg-card/30 p-6 shadow-sm">
        <FacebookLeadsConfig />
      </div>
    </div>
  );
}
