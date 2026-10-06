import { useState } from 'react'
import { supabase } from '@/platform/supabase/client'
import { useQueryClient } from '@tanstack/react-query'
import { useSession } from '@/components/providers/SessionProvider'
import {
  validateDisplayName,
  updateOwnDisplayName,
} from '@/features/profile/display-name'
import {
  useUsers,
  useInviteUser,
  useUserAction,
  useChangeUserRole,
  blockUser,
  unblockUser,
  resetUserPassword,
  removeUser,
  resendInvite,
  type AppUserView,
  type AppRole,
  type ManagedUserState,
} from '@/features/users/api'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { useToast } from '@/components/ui/Toast'
import { useSkeletonDelay } from '@/components/ui/Skeleton'
import { cn } from '@/components/ui/utils'
import {
  User,
  UserRound,
  Pencil,
  Mail,
  ShieldCheck,
  KeyRound,
  Users,
  UserPlus,
  BadgeCheck,
  Clock,
  RefreshCw,
  AlertCircle,
  MoreVertical,
  ArrowLeftRight,
  Ban,
  Unlock,
  Trash2,
  Send,
} from 'lucide-react'

/** ACCOUNT section — the account center: name, identity, verification, role.
 * The name is the one self-editable field (the same narrow display_name
 * self-update mechanism /profile-setup uses); role stays read-only. */
function AccountSection() {
  const { appUser, user } = useSession()
  const queryClient = useQueryClient()
  const { success } = useToast()
  const [editing, setEditing] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  const startEdit = () => {
    setNameDraft(appUser?.displayName ?? '')
    setEditError(null)
    setEditing(true)
  }

  const cancelEdit = () => {
    setEditing(false)
    setEditError(null)
  }

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (saving) return
    const userId = user?.id
    if (!userId) return
    // Client-side pre-validation mirrors the database contract exactly.
    const validation = validateDisplayName(nameDraft)
    if (!validation.valid) {
      setEditError(validation.message)
      return
    }
    setSaving(true)
    setEditError(null)
    const result = await updateOwnDisplayName(userId, nameDraft)
    setSaving(false)
    if (!result.ok) {
      // The database value is untouched — the owner can retry or cancel.
      setEditError(result.message)
      return
    }
    // Confirmed success: update the app-user cache (display_name stays the
    // single source of truth) and leave edit mode.
    queryClient.setQueryData<{ userType: 'owner' | 'user'; status: string; displayName: string | null } | null>(
      ['app-user', userId],
      (prev) => (prev ? { ...prev, displayName: result.displayName } : prev),
    )
    setEditing(false)
    success('Name updated', 'Your name has been saved.')
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-3.5 border-b border-slate-100">
        <User className="h-3.5 w-3.5 text-indigo-600" />
        <span className="text-xs font-semibold text-slate-900">Account</span>
      </div>
      <div className="p-5 space-y-4">
        {editing ? (
          <form onSubmit={saveEdit} className="space-y-2">
            <div className="space-y-1">
              <label htmlFor="account-name" className="text-[11px] text-slate-400 pl-1">
                Name
              </label>
              <Input
                id="account-name"
                type="text"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                autoFocus
                autoComplete="name"
                icon={<UserRound className="h-4 w-4" />}
                aria-invalid={editError != null}
                disabled={saving}
              />
            </div>
            {editError && (
              <p className="text-[11px] text-rose-600 pl-1" role="alert">
                {editError}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-0.5">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-xs h-8"
                onClick={cancelEdit}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                className="text-xs h-8 bg-indigo-600 hover:bg-indigo-700"
                isLoading={saving}
                disabled={saving}
              >
                Save
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <UserRound className="h-4 w-4 text-slate-400 shrink-0" />
              <div className="min-w-0">
                <p className="text-[11px] text-slate-400">Name</p>
                <p className="text-xs font-semibold text-slate-900 truncate">{appUser?.displayName}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={startEdit}
              aria-label="Edit name"
              title="Edit name"
              className="shrink-0 h-7 w-7 flex items-center justify-center rounded-md transition-colors text-slate-400 hover:text-slate-700 hover:bg-slate-100"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        <div className="flex items-center justify-between gap-4 pt-3 border-t border-slate-100">
          <div className="flex items-center gap-3 min-w-0">
            <Mail className="h-4 w-4 text-slate-400 shrink-0" />
            <div className="min-w-0">
              <p className="text-[11px] text-slate-400">Email</p>
              <p className="text-xs font-semibold text-slate-900 truncate">{appUser?.email}</p>
            </div>
          </div>
          <span
            className={cn(
              'inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-semibold border shrink-0',
              appUser
                ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
                : 'bg-amber-50 text-amber-700 border-amber-100',
            )}
          >
            <BadgeCheck className="h-3 w-3" />
            Verified
          </span>
        </div>
        <div className="flex items-center justify-between gap-4 pt-3 border-t border-slate-100">
          <div className="flex items-center gap-3">
            <ShieldCheck className="h-4 w-4 text-slate-400 shrink-0" />
            <div>
              <p className="text-[11px] text-slate-400">Role</p>
              <p className="text-xs font-semibold text-slate-900">
                {appUser?.userType === 'owner' ? 'Owner' : 'User'}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** SECURITY section — native Supabase password reset. */
function SecuritySection() {
  const { appUser } = useSession()
  const { success, error } = useToast()
  const [sending, setSending] = useState(false)

  const handleReset = async () => {
    if (!appUser?.email) return
    setSending(true)
    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(appUser.email, {
        redirectTo: `${window.location.origin}/set-password`,
      })
      if (resetError) throw resetError
      success('Reset email sent', `Check ${appUser.email} for the password reset link.`)
    } catch (err) {
      error('Could not send email', err instanceof Error ? err.message : 'Please try again later.')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-3.5 border-b border-slate-100">
        <KeyRound className="h-3.5 w-3.5 text-indigo-600" />
        <span className="text-xs font-semibold text-slate-900">Security</span>
      </div>
      <div className="p-5 flex items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold text-slate-900">Reset Password</p>
          <p className="text-[11px] text-slate-400 mt-0.5">
            We&apos;ll email you a link to choose a new password.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleReset}
          disabled={sending || !appUser?.email}
          isLoading={sending}
          className="text-xs h-8 shrink-0"
        >
          {/* Icon always mounted — the Button's loading overlay keeps the
              reserved footprint identical in every state. */}
          <RefreshCw className="h-3.5 w-3.5 mr-1" />
          Send reset link
        </Button>
      </div>
    </div>
  )
}

// ─── USERS section (owner-only) ─────────────────────────────────────────────
//
// The list stays quiet — identity, role and state information plus ONE
// management affordance (⋮). All actions happen through dialogs: the Manage
// user dialog (role + status + actions), then a purpose-specific
// confirmation. The requester is never listed here (the backend excludes
// them; their own account lives in the Account section above) — other
// owners appear with an Owner pill and can have their role changed, but are
// never blockable or removable while they hold the Owner role.

const STATE_LABEL: Record<ManagedUserState, string> = {
  active: 'Active',
  blocked: 'Blocked',
  invitation_pending: 'Invitation pending',
}

const STATE_DOT: Record<ManagedUserState, string> = {
  active: 'bg-emerald-500',
  blocked: 'bg-rose-500',
  invitation_pending: 'bg-amber-500',
}

type ConfirmKind = 'block' | 'unblock' | 'reset' | 'remove' | 'resend' | 'role'

interface ConfirmCopy {
  title: string
  body: string
  confirm: string
  destructive?: boolean
}

function confirmCopy(kind: ConfirmKind, email: string, role?: AppRole): ConfirmCopy {
  switch (kind) {
    case 'block':
      return {
        title: 'Block user?',
        body: `${email} will no longer be able to access FUSION ONE until you unblock them.`,
        confirm: 'Block user',
        destructive: true,
      }
    case 'unblock':
      return {
        title: 'Unblock user?',
        body: `${email} will be able to access FUSION ONE again.`,
        confirm: 'Unblock',
      }
    case 'reset':
      return {
        title: 'Send password reset?',
        body: `A password reset link will be sent to ${email}.`,
        confirm: 'Send reset link',
      }
    case 'resend':
      return {
        title: 'Resend invitation?',
        body: `A fresh invitation email will be sent to ${email}.`,
        confirm: 'Resend invitation',
      }
    case 'remove':
      return {
        title: 'Remove user?',
        body: 'This permanently removes their FUSION ONE account. Their invoices, parties, transactions, and store data will not be deleted.',
        confirm: 'Remove',
        destructive: true,
      }
    case 'role':
      return role === 'owner'
        ? {
            title: 'Make this user an owner?',
            body: `${email} will gain owner privileges — full access to store settings, WhatsApp message settings and user management, including changing roles.`,
            confirm: 'Make owner',
          }
        : {
            title: 'Change owner to user?',
            body: `${email} will no longer have owner privileges — they keep access to shared business data, but lose store settings and user management. Another active owner will remain.`,
            confirm: 'Change to user',
          }
  }
}

function successToast(
  kind: Exclude<ConfirmKind, 'role'>,
  email: string,
): { title: string; message: string } {
  switch (kind) {
    case 'block':
      return { title: 'User blocked', message: `${email} can no longer access FUSION ONE.` }
    case 'unblock':
      return { title: 'User unblocked', message: `${email} can access FUSION ONE again.` }
    case 'reset':
      return { title: 'Reset link sent', message: `${email} will receive an email to set a new password.` }
    case 'resend':
      return { title: 'Invitation resent', message: `A new invitation email was sent to ${email}.` }
    case 'remove':
      return { title: 'User removed', message: `${email} no longer has a FUSION ONE account.` }
  }
}

/** A full-width action row inside the Manage user dialog. */
function ActionRow({
  icon: Icon,
  label,
  destructive,
  disabled,
  onClick,
}: {
  icon: typeof Mail
  label: string
  destructive?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'w-full flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg text-xs transition-colors text-left disabled:opacity-50 disabled:pointer-events-none',
        destructive
          ? 'font-semibold text-rose-600 hover:bg-rose-50'
          : 'font-medium text-slate-700 hover:bg-slate-50',
      )}
    >
      <Icon className={cn('h-3.5 w-3.5 shrink-0', !destructive && 'text-slate-400')} />
      {label}
    </button>
  )
}

function UsersSection() {
  const { isOwner } = useSession()
  const { data: users, isLoading, isError, refetch } = useUsers(isOwner)
  const invite = useInviteUser()
  const block = useUserAction(blockUser)
  const unblock = useUserAction(unblockUser)
  const reset = useUserAction(resetUserPassword)
  const remove = useUserAction(removeUser)
  const resend = useUserAction(resendInvite)
  const roleMutation = useChangeUserRole()
  const { success, error } = useToast()

  const [addOpen, setAddOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [manageTarget, setManageTarget] = useState<AppUserView | null>(null)
  // The Manage dialog's role dropdown is a DRAFT — changing it alone never
  // saves anything; only the confirmed “Change role” action mutates.
  const [roleDraft, setRoleDraft] = useState<AppRole>('user')
  const [confirm, setConfirm] = useState<{ kind: ConfirmKind; user: AppUserView; role?: AppRole } | null>(null)
  const pulsing = useSkeletonDelay(isLoading)

  if (!isOwner) return null

  const mutationFor = (kind: Exclude<ConfirmKind, 'role'>) =>
    ({
      block,
      unblock,
      reset,
      remove,
      resend,
    })[kind]

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = email.trim()
    if (!trimmed) return
    try {
      await invite.mutateAsync(trimmed)
      success('Invitation sent', `${trimmed} will receive an email to set up their password.`)
      setEmail('')
      setAddOpen(false)
    } catch (err) {
      error('Invite failed', err instanceof Error ? err.message : 'Please try again.')
    }
  }

  // Manage dialog → (close it) → confirmation dialog. Never a nested stack.
  const openConfirm = (kind: ConfirmKind, user: AppUserView, role?: AppRole) => {
    setManageTarget(null)
    setConfirm({ kind, user, role })
  }

  // Opening the Manage dialog always resets the role dropdown to the
  // account's CURRENT role — a previous draft never leaks between users.
  const openManage = (u: AppUserView) => {
    setRoleDraft(u.userType === 'owner' ? 'owner' : 'user')
    setManageTarget(u)
  }

  const pendingMutation = confirm && confirm.kind !== 'role' ? mutationFor(confirm.kind) : null
  const confirmBusy = confirm
    ? confirm.kind === 'role'
      ? roleMutation.isPending
      : (pendingMutation?.isPending ?? false)
    : false

  const handleConfirm = async () => {
    if (!confirm || confirmBusy) return
    const emailOf = confirm.user.email ?? 'this user'
    try {
      if (confirm.kind === 'role' && confirm.role) {
        await roleMutation.mutateAsync({ userId: confirm.user.id, role: confirm.role })
        success('Role updated', `${emailOf} is now ${confirm.role === 'owner' ? 'an Owner' : 'a User'}.`)
      } else if (pendingMutation && confirm.kind !== 'role') {
        await pendingMutation.mutateAsync(confirm.user.id)
        const toast = successToast(confirm.kind, emailOf)
        success(toast.title, toast.message)
      }
      setConfirm(null)
    } catch (err) {
      // Keep the confirmation open: the owner can retry or cancel.
      error('Action failed', err instanceof Error ? err.message : 'Please try again.')
    }
  }

  const lastSeen = (u: AppUserView) =>
    u.lastSignInAt
      ? new Date(u.lastSignInAt).toLocaleDateString('en-IN', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        })
      : null

  // Row identity: the display name when set (avatar initials + primary
  // line), the email otherwise — with an explicit "Name not set" state so a
  // missing profile is always graceful, never a fake email-derived name.
  const rowName = (u: AppUserView): string | null => {
    const name = u.displayName?.trim()
    return name && name.length > 0 ? name : null
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-5 py-3.5 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <Users className="h-3.5 w-3.5 text-indigo-600" />
          <span className="text-xs font-semibold text-slate-900">Users</span>
        </div>
        <Button
          size="sm"
          onClick={() => setAddOpen(true)}
          className="text-xs h-7 bg-indigo-600 hover:bg-indigo-700 gap-1"
        >
          <UserPlus className="h-3.5 w-3.5" />
          Add User
        </Button>
      </div>

      {isLoading ? (
        <div className={cn('p-5 space-y-3', pulsing && 'animate-pulse')} role="status" aria-live="polite">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-full bg-slate-100" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-48 bg-slate-100 rounded" />
                <div className="h-2.5 w-28 bg-slate-100 rounded" />
              </div>
              <div className="h-5 w-16 bg-slate-100 rounded-full" />
            </div>
          ))}
        </div>
      ) : isError ? (
        <div className="p-5 flex flex-col items-center gap-3 text-center">
          <AlertCircle className="h-5 w-5 text-rose-400" />
          <p className="text-xs text-slate-500">Could not load users.</p>
          <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 max-h-96 overflow-y-auto">
          {(users ?? []).map((u) => {
            const name = rowName(u)
            return (
            <li key={u.id} className="flex items-center gap-3 px-5 py-3.5">
              <div
                className={cn(
                  'h-8 w-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0',
                  u.state === 'blocked'
                    ? 'bg-rose-50 text-rose-500'
                    : 'bg-indigo-50 text-indigo-700',
                )}
              >
                {(name ?? u.email ?? '?')[0]?.toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                {name ? (
                  <>
                    <p className="text-xs font-semibold text-slate-900 truncate">{name}</p>
                    <p className="text-[11px] text-slate-500 truncate">{u.email ?? '—'}</p>
                  </>
                ) : (
                  <p className="text-xs font-semibold text-slate-900 truncate">{u.email ?? '—'}</p>
                )}
                <p className="text-[10px] text-slate-400 mt-0.5">
                  {u.state === 'invitation_pending' ? (
                    <span className="text-amber-600">Invitation pending</span>
                  ) : u.state === 'blocked' ? (
                    <span className="text-rose-600">{name ? 'Blocked' : 'Name not set · Blocked'}</span>
                  ) : (
                    <>
                      {!name && <span className="text-slate-500">Name not set</span>}
                      {!name && <span aria-hidden> · </span>}
                      <span className="text-emerald-600">Verified</span>
                      {lastSeen(u) && (
                        <>
                          <span aria-hidden> · </span>
                          <Clock className="h-2.5 w-2.5 inline -mt-0.5" />
                          {' Last seen '}
                          {lastSeen(u)}
                        </>
                      )}
                    </>
                  )}
                </p>
              </div>
              <span
                className={cn(
                  'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border shrink-0',
                  u.userType === 'owner'
                    ? 'bg-indigo-50 text-indigo-700 border-indigo-100'
                    : 'bg-slate-50 text-slate-600 border-slate-200',
                )}
              >
                {u.userType === 'owner' ? 'Owner' : 'User'}
              </span>
              <button
                type="button"
                onClick={() => openManage(u)}
                aria-label={`Manage ${name ?? u.email ?? 'user'}`}
                title="Manage user"
                className="shrink-0 h-7 w-7 flex items-center justify-center rounded-md transition-colors text-slate-400 hover:text-slate-700 hover:bg-slate-100"
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </button>
            </li>
            )
          })}
          {(users ?? []).length === 0 && (
            <li className="px-5 py-6 text-center text-xs text-slate-400">
              No users yet. Use Add User to invite someone.
            </li>
          )}
        </ul>
      )}

      {/* Add user — email only; the role is always User and the password is
          set by the invitee through the native Supabase invitation email. */}
      <Modal
        isOpen={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add user"
        hideClose
        description="An invitation will be sent to this email address."
        className="max-w-md"
      >
        <form onSubmit={handleInvite} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="invite-email" className="text-xs font-medium text-slate-700">
              Email
            </label>
            <Input
              id="invite-email"
              type="email"
              placeholder="user@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              icon={<Mail className="h-4 w-4" />}
            />
          </div>
          <p className="text-[11px] text-slate-400 leading-relaxed">
            New users join with the <strong>User</strong> role — the same store, the same data, no
            store settings or user management.
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-xs h-8"
              onClick={() => setAddOpen(false)}
              disabled={invite.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              className="text-xs h-8 bg-indigo-600 hover:bg-indigo-700"
              isLoading={invite.isPending}
              disabled={invite.isPending || !email.trim()}
            >
              Send invitation
            </Button>
          </div>
        </form>
      </Modal>

      {/* Manage user — identity + role + status + the actions valid for that
          state. Changing the role dropdown alone saves nothing — the Change
          role action opens a purpose-specific confirmation first. For another
          OWNER only role management applies (owners can never be blocked or
          removed); destructive Remove stays visually separated at the bottom. */}
      <Modal
        isOpen={!!manageTarget}
        onClose={() => setManageTarget(null)}
        title="Manage user"
        className="max-w-sm"
      >
        {manageTarget &&
          (() => {
            const targetRole: AppRole = manageTarget.userType === 'owner' ? 'owner' : 'user'
            const roleEditable = manageTarget.state === 'active'
            return (
              <div>
                <div className="space-y-1 px-1">
                  {manageTarget.displayName?.trim() ? (
                    <>
                      <p className="text-sm font-semibold text-slate-900 truncate">{manageTarget.displayName.trim()}</p>
                      <p className="text-xs text-slate-500 truncate">{manageTarget.email}</p>
                    </>
                  ) : (
                    <p className="text-sm font-semibold text-slate-900 truncate">{manageTarget.email}</p>
                  )}
                </div>

                <div className="mt-4 px-1 space-y-3.5">
                  <div className="space-y-1.5">
                    <span className="block text-xs font-medium text-slate-700">Role</span>
                    <Select
                      value={roleDraft}
                      onChange={(v) => setRoleDraft(v === 'owner' ? 'owner' : 'user')}
                      options={[
                        { value: 'user', label: 'User' },
                        { value: 'owner', label: 'Owner' },
                      ]}
                      disabled={!roleEditable}
                    />
                    {!roleEditable && (
                      <p className="text-[11px] text-slate-400">
                        {manageTarget.state === 'invitation_pending'
                          ? 'The invitation must be accepted before the role can change.'
                          : 'Unblock this user to change their role.'}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <span className="block text-xs font-medium text-slate-700">Status</span>
                    <p className="flex items-center gap-1.5 text-xs text-slate-700">
                      <span
                        aria-hidden
                        className={cn('h-1.5 w-1.5 rounded-full shrink-0', STATE_DOT[manageTarget.state])}
                      />
                      {STATE_LABEL[manageTarget.state]}
                    </p>
                  </div>
                </div>

                <div className="mt-4 space-y-1">
                  <ActionRow
                    icon={ArrowLeftRight}
                    label="Change role"
                    disabled={!roleEditable || roleDraft === targetRole}
                    onClick={() => openConfirm('role', manageTarget, roleDraft)}
                  />
                  {targetRole === 'owner' ? (
                    <p className="px-3.5 pt-1 text-[11px] text-slate-400 leading-relaxed">
                      Owners can&apos;t be blocked or removed. Change the role to User first.
                    </p>
                  ) : (
                    <>
                      {manageTarget.state === 'active' && (
                        <>
                          <ActionRow
                            icon={KeyRound}
                            label="Reset password"
                            onClick={() => openConfirm('reset', manageTarget)}
                          />
                          <ActionRow
                            icon={Ban}
                            label="Block user"
                            onClick={() => openConfirm('block', manageTarget)}
                          />
                        </>
                      )}
                      {manageTarget.state === 'blocked' && (
                        <>
                          <ActionRow
                            icon={Unlock}
                            label="Unblock user"
                            onClick={() => openConfirm('unblock', manageTarget)}
                          />
                          <ActionRow
                            icon={KeyRound}
                            label="Reset password"
                            onClick={() => openConfirm('reset', manageTarget)}
                          />
                        </>
                      )}
                      {manageTarget.state === 'invitation_pending' && (
                        <ActionRow
                          icon={Send}
                          label="Resend invitation"
                          onClick={() => openConfirm('resend', manageTarget)}
                        />
                      )}
                      <div className="pt-2 mt-2 border-t border-slate-100">
                        <ActionRow
                          icon={Trash2}
                          label="Remove user"
                          destructive
                          onClick={() => openConfirm('remove', manageTarget)}
                        />
                      </div>
                    </>
                  )}
                </div>
              </div>
            )
          })()}
      </Modal>

      {/* Purpose-specific confirmation for the chosen action. */}
      <Modal
        isOpen={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm ? confirmCopy(confirm.kind, confirm.user.email ?? 'this user', confirm.role).title : ''}
        hideClose
        className="max-w-md"
        footer={
          confirm && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="text-xs h-8"
                onClick={() => setConfirm(null)}
                disabled={confirmBusy}
              >
                Cancel
              </Button>
              <Button
                variant={confirmCopy(confirm.kind, '', confirm.role).destructive ? 'danger' : 'primary'}
                size="sm"
                className="text-xs h-8"
                onClick={() => void handleConfirm()}
                isLoading={confirmBusy}
                disabled={confirmBusy}
              >
                {confirmCopy(confirm.kind, confirm.user.email ?? 'this user', confirm.role).confirm}
              </Button>
            </>
          )
        }
      >
        {confirm && (
          <p className="text-sm text-slate-600 leading-relaxed">
            {confirmCopy(confirm.kind, confirm.user.email ?? 'this user', confirm.role).body}
          </p>
        )}
      </Modal>
    </div>
  )
}

/**
 * /profile — account, security and (owner-only) user management.
 * The role shown comes from the actual application authorization state.
 */
export default function ProfilePage() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-sm font-semibold text-slate-900 tracking-tight leading-none">Profile</h1>
        <p className="text-[11px] text-slate-400 mt-1">Your account and application access</p>
      </div>
      <AccountSection />
      <SecuritySection />
      <UsersSection />
    </div>
  )
}
