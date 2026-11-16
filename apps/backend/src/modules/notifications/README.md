# notifications

A person's in-app inbox plus its email counterpart. Generic: features call
`notify(...)` and never touch the table or the mail module.

- `kinds.ts`: the kind registry. A kind says whether it is emailed by default,
  which mail template it uses (none means in-app only) and where it leads. Adding
  a kind is one entry (and a template if it can be emailed).
- `service.ts`:
  - `notify({ kind, teamId, userId, ref, payload, email? })` stores the
    notification and emails it when asked. The same kind for the same `ref`
    within 24 hours merges into one row (`occurrence_count`, `last_occurred_at`)
    and does not email again, so a failing job produces one entry and one email
    a day. A mail failure never fails the notification; the next merged
    occurrence retries it.
  - `listNotifications`, `unreadCount`, `markRead`, `markAllRead`, all scoped to
    the person and the team.
- Payloads are flat, small (2 KB) and carry only what a list row may show. Mail
  carries only the task name and a link, never prompts or results.
- `notification.*` mail templates live in `modules/mail/templates` (en, zh-CN
  by hand; zh-TW generated from zh-CN with the shared Taiwan glossary and
  reviewed string by string).
