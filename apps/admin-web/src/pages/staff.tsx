import { Fragment, useState, type FormEvent } from 'react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@installment/ui';
import type { StaffMember, StaffRole, StaffUserType } from '@installment/api-types';
import { apiErrorMessage, useAuth } from '@installment/web-kit';
import { X } from 'lucide-react';
import { useCreateStaff, useStaff, useStaffActions, useStaffRoles } from '../lib/workforce-api';
import { formatDate, formatDateTime } from '../lib/format';
import { PageHeader } from '../components/page-header';
import { EmptyState, ErrorState, LoadingState } from '../components/data-states';

const TYPE_WORDS: Record<StaffUserType, string> = { admin: 'Administrator', agent: 'Agent' };

const selectClass = 'flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm';

/** A password to hand to a new member of staff: 16 characters, no look-alikes. */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint32Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/**
 * Who can use the console, and what each of them may do.
 *
 * Access comes only from roles, and is read on every request: taking a role
 * away or switching an account off takes effect on that person's next click.
 * Nobody may change their own access here, and the last active administrator
 * cannot be removed — after that, only the database could grant access back.
 */
export function StaffPage() {
  const staff = useStaff();
  const roles = useStaffRoles();
  const { session } = useAuth();
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Staff and roles"
        description="Who can sign in to the console, and what each role allows."
        actions={
          <Button size="sm" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Close' : 'Add staff'}
          </Button>
        }
      />

      {adding && roles.data ? (
        <AddStaffCard roles={roles.data} onDone={() => setAdding(false)} />
      ) : null}

      <Card>
        <CardContent className="p-0">
          {staff.isPending || roles.isPending ? (
            <LoadingState />
          ) : staff.isError ? (
            <ErrorState error={staff.error} onRetry={() => void staff.refetch()} />
          ) : roles.isError ? (
            <ErrorState error={roles.error} onRetry={() => void roles.refetch()} />
          ) : staff.data.length === 0 ? (
            <EmptyState message="No staff accounts." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  <TableHead>Roles</TableHead>
                  <TableHead>Last signed in</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {staff.data.map((m) => (
                  <StaffRow
                    key={m.id}
                    member={m}
                    roles={roles.data}
                    isSelf={m.id === session?.userId}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {roles.data ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Roles</CardTitle>
            <CardDescription>
              What each role allows. Roles are set up in the database.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {roles.data.map((r) => (
              <div key={r.name} className="space-y-2">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium">{r.name}</span>
                  <span className="text-sm text-muted-foreground">
                    {r.description ?? ''} · {r.holders} active{' '}
                    {r.holders === 1 ? 'holder' : 'holders'}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {r.permissions.length === 0 ? (
                    <span className="text-sm text-muted-foreground">No permissions.</span>
                  ) : (
                    r.permissions.map((p) => (
                      <Badge key={p} variant="muted" className="font-mono text-xs">
                        {p}
                      </Badge>
                    ))
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function StaffRow({
  member,
  roles,
  isSelf,
}: {
  member: StaffMember;
  roles: StaffRole[];
  isSelf: boolean;
}) {
  const actions = useStaffActions(member.id);
  const [grantRole, setGrantRole] = useState('');
  const [switching, setSwitching] = useState(false);
  const [reason, setReason] = useState('');
  const grantable = roles.filter((r) => !member.roles.includes(r.name));
  const error = actions.grant.error ?? actions.revoke.error ?? actions.setActive.error;

  function onSwitch(e: FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 3) return;
    actions.setActive.mutate(
      { active: !member.is_active, reason: reason.trim() },
      {
        onSuccess: () => {
          setSwitching(false);
          setReason('');
        },
      },
    );
  }

  return (
    <Fragment>
      <TableRow className={member.is_active ? undefined : 'opacity-60'}>
        <TableCell>
          <div className="font-medium">
            {member.name}
            {isSelf ? <span className="ml-2 text-xs text-muted-foreground">(you)</span> : null}
          </div>
          <div className="text-xs text-muted-foreground">
            {member.email} · {TYPE_WORDS[member.user_type] ?? member.user_type}
          </div>
        </TableCell>
        <TableCell>
          <div className="flex flex-wrap items-center gap-1">
            {member.roles.length === 0 ? (
              <span className="text-sm text-muted-foreground">No roles — can do nothing</span>
            ) : null}
            {member.roles.map((r) => (
              <Badge key={r} variant="info" className="gap-1">
                {r}
                {!isSelf ? (
                  <button
                    type="button"
                    aria-label={`Remove the ${r} role from ${member.name}`}
                    className="rounded-sm hover:bg-background/40 disabled:opacity-50"
                    disabled={actions.revoke.isPending}
                    onClick={() => actions.revoke.mutate(r)}
                  >
                    <X className="size-3" />
                  </button>
                ) : null}
              </Badge>
            ))}
            {!isSelf && grantable.length > 0 ? (
              <span className="ml-1 inline-flex items-center gap-1">
                <select
                  aria-label={`Give ${member.name} a role`}
                  className="h-7 rounded-md border border-input bg-background px-2 text-xs"
                  value={grantRole}
                  onChange={(e) => setGrantRole(e.target.value)}
                >
                  <option value="">Add a role…</option>
                  {grantable.map((r) => (
                    <option key={r.name} value={r.name}>
                      {r.name}
                    </option>
                  ))}
                </select>
                {grantRole ? (
                  <Button
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={actions.grant.isPending}
                    onClick={() =>
                      actions.grant.mutate(grantRole, { onSuccess: () => setGrantRole('') })
                    }
                  >
                    Give
                  </Button>
                ) : null}
              </span>
            ) : null}
          </div>
        </TableCell>
        <TableCell className="text-muted-foreground">
          {member.last_login_at ? formatDateTime(member.last_login_at) : 'Never'}
        </TableCell>
        <TableCell>
          {member.is_active ? (
            <StatusBadge status="active" label="On" />
          ) : (
            <StatusBadge status="inactive" tone="muted" label="Switched off" />
          )}
          <div className="text-xs text-muted-foreground">since {formatDate(member.created_at)}</div>
        </TableCell>
        <TableCell className="text-right">
          {!isSelf && !switching ? (
            <Button
              size="sm"
              variant={member.is_active ? 'outline' : 'default'}
              onClick={() => setSwitching(true)}
            >
              {member.is_active ? 'Switch off…' : 'Switch on…'}
            </Button>
          ) : null}
        </TableCell>
      </TableRow>
      {switching || error ? (
        <TableRow className="bg-muted/40 hover:bg-muted/40">
          <TableCell colSpan={5}>
            {switching ? (
              <form onSubmit={onSwitch} className="space-y-2 py-1">
                <p className="text-sm">
                  {member.is_active
                    ? `${member.name} loses every permission on their next request, and cannot sign in or stay signed in until switched back on.`
                    : `${member.name} will be able to sign in again, with the roles shown.`}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    aria-label="Reason"
                    className="h-9 min-w-72 flex-1"
                    maxLength={500}
                    placeholder="Reason (required)"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <Button
                    type="submit"
                    size="sm"
                    variant={member.is_active ? 'destructive' : 'default'}
                    disabled={actions.setActive.isPending || reason.trim().length < 3}
                  >
                    {member.is_active ? 'Switch off' : 'Switch on'}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setSwitching(false);
                      actions.setActive.reset();
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : null}
            {error ? <p className="text-sm text-destructive">{apiErrorMessage(error)}</p> : null}
          </TableCell>
        </TableRow>
      ) : null}
    </Fragment>
  );
}

function AddStaffCard({ roles, onDone }: { roles: StaffRole[]; onDone: () => void }) {
  const create = useCreateStaff();
  const [form, setForm] = useState({
    name: '',
    email: '',
    user_type: 'agent' as StaffUserType,
    role: roles.find((r) => r.name === 'ops') ? 'ops' : (roles[0]?.name ?? ''),
    password: generatePassword(),
  });
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    create.mutate(
      {
        name: form.name.trim(),
        email: form.email.trim(),
        user_type: form.user_type,
        password: form.password,
        ...(form.role ? { roleNames: [form.role] } : {}),
      },
      { onSuccess: onDone },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add a member of staff</CardTitle>
        <CardDescription>
          Give them the password below yourself, by a channel other than email. There is no way yet
          for staff to change it, so choose it as you would a permanent one.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="staff-name">Name</Label>
              <Input
                id="staff-name"
                required
                maxLength={120}
                value={form.name}
                onChange={(e) => set('name')(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="staff-email">Email (they sign in with it)</Label>
              <Input
                id="staff-email"
                type="email"
                required
                value={form.email}
                onChange={(e) => set('email')(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="staff-type">Kind of account</Label>
              <select
                id="staff-type"
                className={selectClass}
                value={form.user_type}
                onChange={(e) => set('user_type')(e.target.value)}
              >
                <option value="agent">Agent</option>
                <option value="admin">Administrator</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="staff-role">Role</Label>
              <select
                id="staff-role"
                className={selectClass}
                value={form.role}
                onChange={(e) => set('role')(e.target.value)}
              >
                <option value="">None for now</option>
                {roles.map((r) => (
                  <option key={r.name} value={r.name}>
                    {r.name}
                    {r.description ? ` — ${r.description}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2 lg:col-span-2">
              <Label htmlFor="staff-password">Password (at least 8 characters)</Label>
              <div className="flex gap-2">
                <Input
                  id="staff-password"
                  required
                  minLength={8}
                  maxLength={200}
                  className="font-mono"
                  value={form.password}
                  onChange={(e) => set('password')(e.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9"
                  onClick={() => set('password')(generatePassword())}
                >
                  New
                </Button>
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              type="submit"
              disabled={
                create.isPending ||
                !form.name.trim() ||
                !form.email.trim() ||
                form.password.length < 8
              }
            >
              {create.isPending ? 'Adding…' : 'Add'}
            </Button>
            <Button type="button" variant="ghost" onClick={onDone}>
              Cancel
            </Button>
          </div>
          {create.isError ? (
            <p className="text-sm text-destructive">{apiErrorMessage(create.error)}</p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
