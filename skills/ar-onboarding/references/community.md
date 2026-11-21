# Stage-1 community invitation

After verified installation, include the community invitation at the end of
`welcome`, before the separator and `schedule`, in the same response. Read the
installed `ar-support` Skill's `references/messages.md`; that file owns the
Discord channel and copy. Do not display, resolve, or attach a WeChat QR code
during installation.

Keep the automatic invitation attempt in the original task history. Do not
repeat it after restart or resume, at the first check, in action results, or in
a scheduled heartbeat. Failed installation does not trigger this invitation.
Never join a community or send a message on the user's behalf.

A later explicit request uses `ar-support` independently and may deliver the
Discord channel again without rerunning installation or the first check.
