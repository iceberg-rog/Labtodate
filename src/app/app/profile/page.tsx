import { Mail, User, Shield, Calendar } from 'lucide-react';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { ProfileForm } from './ProfileForm';
import { EmailVerifyButton } from './EmailVerifyButton';
import { AvatarUploader } from './AvatarUploader';

export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  const session = await requireSession({ redirectTo: '/app/profile' });
  const me = await prisma.user.findUnique({
    where: { id: session.user.id },
    include: { company: true },
  });

  if (!me) return null;

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Profile</h1>
        <p className="text-muted-foreground mt-1">Account details on file.</p>
      </div>

      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="p-6 flex items-center gap-5 border-b border-border">
          <AvatarUploader name={me.name} image={me.image} />
          <div>
            <h2 className="text-lg font-bold">{me.name}</h2>
            <p className="text-sm text-muted-foreground">{me.email}</p>
          </div>
        </div>

        <dl className="divide-y divide-border">
          <Row icon={User} label="Name" value={me.name} />
          <div className="p-5 flex items-center gap-4">
            <Mail className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            <dt className="text-sm font-medium text-muted-foreground w-32">Email</dt>
            <dd className="text-sm font-semibold flex-1 flex items-center gap-3 flex-wrap">
              <span>{me.email}</span>
              <EmailVerifyButton email={me.email} verified={me.emailVerified} />
            </dd>
          </div>
          <Row icon={Shield} label="Role" value={me.role} />
          {me.company && <Row icon={User} label="Company" value={me.company.name} />}
          <Row icon={Calendar} label="Joined" value={new Date(me.createdAt).toLocaleDateString('en-US', { dateStyle: 'long' })} />
        </dl>
      </div>

      <ProfileForm initialName={me.name} />

      <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
        <div>
          <h2 className="font-bold">Your data</h2>
          <p className="text-sm text-muted-foreground">Download a copy of everything we hold on your account.</p>
        </div>
        <a
          href="/app/privacy/export"
          className="inline-flex items-center rounded-full border border-border px-4 py-2 text-sm font-semibold hover:bg-muted"
        >
          Download my data (JSON)
        </a>
      </div>
    </div>
  );
}

function Row({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <div className="p-5 flex items-center gap-4">
      <Icon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
      <dt className="text-sm font-medium text-muted-foreground w-32">{label}</dt>
      <dd className="text-sm font-semibold flex-1">{value}</dd>
    </div>
  );
}
