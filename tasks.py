"""Background jobs (imports) with progress the browser can poll."""
from __future__ import annotations

import secrets
import threading
import time
import traceback


class Task:
    def __init__(self, kind: str):
        self.id = secrets.token_hex(6)
        self.kind = kind
        self.status = "running"
        self.done = 0
        self.total = 0
        self.message = "Starting..."
        self.result = None
        self.error = None
        self.finished_at = None

    def progress(self, done: int, total: int, message: str | None = None) -> None:
        self.done, self.total = done, total
        if message is not None:
            self.message = message

    def as_dict(self) -> dict:
        return {"id": self.id, "kind": self.kind, "status": self.status, "done": self.done, "total": self.total,
                "message": self.message, "result": self.result, "error": self.error}


_tasks: dict[str, Task] = {}
_lock = threading.Lock()


def start(kind: str, fn, *args, cleanup=None) -> Task:
    """Run fn(task, *args) in a thread; its return value becomes task.result. cleanup() runs afterwards."""
    task = Task(kind)
    with _lock:
        cutoff = time.time() - 3600
        for k in [k for k, t in _tasks.items() if t.finished_at and t.finished_at < cutoff]:
            del _tasks[k]
        _tasks[task.id] = task

    def run():
        try:
            task.result = fn(task, *args)
            task.status = "done"
            task.message = "Done"
        except Exception as exc:  # reported to the browser
            traceback.print_exc()
            task.status = "error"
            task.error = str(exc) or exc.__class__.__name__
        finally:
            task.finished_at = time.time()
            if cleanup:
                try:
                    cleanup()
                except OSError:
                    pass

    threading.Thread(target=run, daemon=True, name=f"task-{kind}").start()
    return task


def get(task_id: str) -> Task | None:
    return _tasks.get(task_id)


def busy() -> bool:
    """Is an import still running? (don't stop the server in the middle of one)"""
    return any(t.status == "running" for t in list(_tasks.values()))
