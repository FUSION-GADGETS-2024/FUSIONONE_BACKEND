# FUSION ONE Email Templates — FUSION ONE branded redesign

Redesigned presentation of the Supabase auth email templates (invite user,
reset password, confirm signup, password changed). This is a
**presentation-only redesign**: every purpose, content element, Supabase template
variable, link format and action is preserved exactly (two auth lifecycles,
`/set-password` token-hash links, dashboard application steps).

One HTML file per email type; a shared visual structure (no generic template):

```
logo (https://assets.fusionone.fusiongadgets.in/Logo_Rounded.png)
→ email heading + content
→ primary action
→ existing supporting/fallback content
→ footer
```

## Templates

| File | Supabase dashboard template slot | Purpose | Link format |
|---|---|---|---|
| `invite-user.html` | Authentication → Email Templates → **Invite User** | Owner-invited account creation | `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=invite` |
| `reset-password.html` | Authentication → Email Templates → **Reset Password** | Self-service + owner-triggered password recovery | `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery` |
| `confirm-signup.html` | Authentication → Email Templates → **Confirm Signup** | Email address confirmation | `{{ .ConfirmationURL }}` (native semantics — deliberately NOT a password-setup link) |
| `password-changed.html` | — (no Supabase template slot yet; see source README status note) | Post-change security notification | — (no link; informational) |

## Design language (same as the web app)

White content surface on a very light neutral background (`#f8fafc`), thin neutral
borders (`#e2e8f0`), restrained rounded corners (12px card / 8px controls), the
FUSION ONE purple accent (`#4f46e5`) for the wordmark and primary action, dark
primary text (`#0f172a`), muted secondary text (`#475569`/`#64748b`), and a
compact typography hierarchy. Email-safe: table-based layout, inline styles only,
no framework, no build step.

## Applying (manual dashboard step)

Supabase dashboard → Authentication → Email Templates → replace the Subject and
Body of the matching slot with the file's contents. Variables are unchanged, so
the flows keep working with the existing URL Configuration (Site URL / Redirect
URLs).
