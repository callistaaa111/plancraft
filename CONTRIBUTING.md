# Contributing to PlanCraft

PlanCraft is a small, offline takeoff app. It has no build step for the UI and only a handful of Python
dependencies, and it should stay that way: a new framework or service is a hard sell, a clear fix with a test is easy.

## Set up

```powershell
git clone https://github.com/callistaaa111/plancraft.git
cd plancraft
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements-dev.txt
python server.py --open
```

Python 3.10 or newer. Projects are written to `data/` next to `server.py` and are ignored by git.

## Test and lint

```powershell
python -m unittest discover -s tests -v
ruff check .
python -m coverage run -m unittest discover -s tests
python -m coverage report -m
```

CI runs the tests on Python 3.10, 3.11, 3.12 and 3.13, and runs ruff. Please add a test when you change:

- a quantity, scale, allowance, unit or pricing rule (use a small, made-up plan);
- an import or export format;
- an HTTP endpoint or a file path rule.

## Build a release locally

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build.ps1
```

It runs the tests, builds `dist/PlanCraft/PlanCraft.exe` with PyInstaller, makes the portable zip, and builds the
installer when [Inno Setup](https://jrsoftware.org/isdl.php) is installed. The build is unsigned; sign it with your
own certificate before distributing it widely.

## Style

- Match the surrounding code. The backend is standard-library Python; the frontend is plain ES modules with no
  bundler.
- Keep comments about *why*, not *what*.
- UI text is sentence case and speaks to an estimator, not to a programmer.
- Never commit `data/`, client plans, price lists, or a `.venv`.
- For a UI change, include a screenshot or a short recording in the pull request.

## Commits and pull requests

Small, focused commits are easiest to review. In the pull request, say what changed, how you tested it, and include
a screenshot for visible changes. By contributing you agree that your work is licensed under the MIT License.

## Security

Please do not open a public issue for a security problem. See [SECURITY.md](SECURITY.md).
