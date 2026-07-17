import { MembersTab } from '@/components/settings/members-tab';

export default function MembersPage() {
  return (
    <div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Team members
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          People with access to this account. Roles control what each teammate can do.
        </p>
      </div>
      <div className="mt-6">
        <MembersTab />
      </div>
    </div>
  );
}
