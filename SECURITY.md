# Security policy

## Supported versions

PlanCraft 1.x receives security fixes. Older builds should be updated to the latest release.

## Reporting a vulnerability

Report privately through GitHub's [security advisory form](https://github.com/callistaaa111/plancraft/security/advisories/new).
Please include the version, the steps to reproduce, and what an attacker could do. Do not include client plans or
personal data. You should get an acknowledgement within a few days.

## What PlanCraft is expected to protect

PlanCraft is a single-user, offline desktop app:

- The server binds to `127.0.0.1` only and rejects requests whose `Host` header is not the local address, which
  blocks DNS-rebinding attacks from a web page.
- Projects, plans and backups stay in the local data folder. There is no account, telemetry, or cloud upload.
- The app is not encrypted at rest; anyone with access to the Windows account and the data folder can read the
  projects. Use full-disk encryption (BitLocker) for confidential client plans, and encrypt archives before
  sending them.
- A malicious local process or a browser running as the same user can reach the local API. Do not run PlanCraft on
  a shared Windows account with untrusted software.

Reports about the app writing outside its data folder, path traversal through project/page/export names, a remote
page reading local projects, or a crafted plan executing code are especially welcome.
