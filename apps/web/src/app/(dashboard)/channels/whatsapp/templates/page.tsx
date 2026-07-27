import { TemplateManager } from '@/components/settings/template-manager';

export default function TemplatesPage() {
  return (
    <div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Templates
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Create templates and submit them to Meta for approval.
        </p>
      </div>
      <div className="mt-6">
        <TemplateManager />
      </div>
    </div>
  );
}
