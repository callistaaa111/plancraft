# Privacy and client-data check

**Checked:** 27 October 2026, on the local checkout and its full git history.

This is the answer to "are my job documents exposed?" for the PlanCraft repository. It is not a scan of every file on
the PC, and it does not upload anything.

## Result

**No client or job documents are in the repository or its history, and no secrets or personal contact data were
found in tracked files.**

| Check | Result |
|---|---|
| Tracked files | 85 |
| Client/job documents tracked (PDF, Office, CSV, DWG, SwiftJob, TIFF, ZIP, log) | **0** |
| Other images tracked | 1, the synthetic README image |
| Files over 5 MB tracked | 0 |
| Job documents ever added in git history | **0** |
| Blobs over 5 MB anywhere in history | 0 |
| Secret patterns (AWS, GitHub, OpenAI, Slack, Google, private key) | 0 |
| Email addresses outside noreply/example | 0 |
| Phone-number patterns | 0 |
| Local data folder | present, **ignored by git**, 265 files / about 1.08 GB |

The only committed binary files are `PlanCraft.ico` and the synthetic `docs/screenshots/plan-with-takeoff.png`.
The screenshot was generated from a made-up electrical sheet; it contains no client name, address, phone number or
real plan.

## What is local but not published

`data/` holds the real projects: page images, `project.json`, backups, source PDFs and the trash. Git ignores the
whole folder. The scans confirm it was never committed, on any branch or tag.

That folder is still **sensitive**:

- It contains client plans, project names and possibly prices.
- It is not encrypted at rest. Anyone who can sign in to the Windows account, or read a copy of the folder or a
  backup, can read it.
- `data/trash/` and `data/projects/*/backups/` keep old versions and deleted projects.
- `data/plancraft.log` contains local paths (and therefore your Windows user name), not plan contents.

Protect it with BitLocker/device encryption, keep it out of shared folders, and use an encrypted archive if you send a
project to someone. Do not zip the `data` folder into a release, issue or pull request.

## Why the git history is clean

The repository started with a `.gitignore` that excludes `data/`, and no client document was ever added. The
scanner also walks every blob in `git log --all`, so a file that was added and later deleted would still be found.
It found none.

## Guard rail in CI

`scripts/privacy_scan.py` is now part of CI (the **privacy** job). It fails a pull request when:

- a PDF, Office file, CSV, DWG/DXF, SwiftJob, TIFF, ZIP/7z/RAR or log is tracked;
- a `data/` or `backups/` path is tracked, or `data/` stops being ignored;
- an image other than the two allowed ones is tracked;
- a tracked file or history blob is over 5 MB;
- a known credential pattern or a private key is found.

It reports e-mail and phone-number patterns for review but does not fail on them unless they are a real credential.
Run it locally before pushing:

```powershell
python scripts/privacy_scan.py
```

## Residual risks

1. **A future `git add -f data`** would defeat `.gitignore`. The CI gate blocks the push if the forbidden extension
   or `data/` path is committed, but do not rely on it alone.
2. **Screenshots in issues/PRs** can contain client information even when the repository is clean. The issue forms
   ask people not to attach client plans.
3. **Logs and crash reports** can contain paths and project names. Redact the user name and project folder before
   sharing.
4. **GitHub itself** stores the public repository, issues, PRs and Actions logs. Do not paste plan contents into
   them.
5. **The local API** is loopback-only and has no account; another process running as the same Windows user can read
   the data folder. This is normal for a desktop app, but it is not a multi-user boundary.

## If a document was exposed

1. Remove it from the working tree and from git history (rewriting history is a separate, deliberate operation).
2. Rotate any credential that was in it.
3. If the repository is public, assume it was copied; deleting the commit is not enough.
4. Check the GitHub Actions logs and artifacts for the same file.

The scanner is intentionally conservative: it blocks whole document types rather than trying to judge contents.
