"""Prefer live OSC 7501 state while preserving Claude's file fallback."""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable

from omnigent.harnesses.claude_native.status_file import SessionStatusPoller
from omnigent.terminals.program_status import (
    ProgramStatus,
    ProgramStatusReader,
    blocked_reason,
)

_logger = logging.getLogger(__name__)


class ClaudeProgramStatusPoller:
    """Adapt one terminal's OSC snapshot to existing session-status callbacks.

    Claude keeps reporting ``working`` while a background agent or teammate
    outlives its turn. After a ``Stop`` that left such a delegate running, the
    ``working`` report seen when the ``Stop`` arrives reads as idle until a turn
    starts again: the runner delivers one, Claude submits a prompt of its own,
    or the report leaves ``working``. A message-only change does not end it,
    since Claude may clear the turn's message after the ``Stop`` is noted.
    """

    def __init__(
        self,
        reader: ProgramStatusReader,
        fallback: SessionStatusPoller,
        on_status: Callable[[str, str | None], None],
        prompt_submitted_at_getter: Callable[[], int | None] | None = None,
    ) -> None:
        self._reader = reader
        self._fallback = fallback
        self._on_status = on_status
        self._prompt_submitted_at_getter = prompt_submitted_at_getter
        self._last: ProgramStatus | None = None
        self._published: str | None = None
        self._using_osc = False
        self._retired = False
        self._resync_lock = threading.Lock()
        self._resync_requested = False
        self._turn_started_at_ms: int | None = None
        self._turn_ended_at_ms: int | None = None
        # Last report read, kept across resyncs; the baseline a new Stop holds.
        self._observed: ProgramStatus | None = None
        # The Stop a holdover belongs to, the report it holds, and whether it ended.
        self._held_for_ms: int | None = None
        self._held_report: ProgramStatus | None = None
        self._released = False
        self._holding = False

    @property
    def active(self) -> bool:
        """Whether OSC or the file owns status instead of pane activity."""
        return not self._retired and (self._reader.status is not None or self._fallback.active)

    @property
    def blocked_on(self) -> str | None:
        """Current blocking reason for native input delivery."""
        if self._retired:
            return None
        report = self._reader.status
        return blocked_reason(report) if report is not None else self._fallback.blocked_on

    @property
    def reports_busy(self) -> bool:
        """Whether Claude still reports work, even while a holdover publishes idle."""
        if self._retired:
            return False
        report = self._reader.status
        if report is not None:
            return report.state == "working"
        return self._fallback.reports_busy

    def tick(self) -> None:
        """Publish changed reports; never interpret silence as completion."""
        if self._retired:
            return
        with self._resync_lock:
            requested = self._resync_requested
            self._resync_requested = False
        if requested:
            self._last = None
        report = self._reader.status
        self._track_holdover(report)
        self._observed = report
        if report is not None:
            self._using_osc = True
            changed = report != self._last
            if not changed and not self._holding:
                return
            self._last = report
            status = self._osc_status(report)
            if changed or status != self._published:
                self._published = status
                self._on_status(status, blocked_reason(report))
        else:
            if self._using_osc:
                self._fallback.resync()
            self._using_osc = False
            self._last = None
            self._holding = False
            self._fallback.tick()

    def resync(self) -> None:
        """Re-arm the next poll after a reconnect or a forwarded idle edge."""
        with self._resync_lock:
            self._resync_requested = True
        self._fallback.resync()

    def note_turn_started(self, started_at_ms: int) -> None:
        """Record that the runner delivered a turn, then re-assert the report.

        :param started_at_ms: Delivery time in epoch milliseconds.
        """
        with self._resync_lock:
            self._turn_started_at_ms = max(started_at_ms, self._turn_started_at_ms or 0)
            self._resync_requested = True
        self._fallback.note_turn_started(started_at_ms)

    def note_turn_ended(self, ended_at_ms: int) -> None:
        """Record a ``Stop`` that left a delegate running, then re-assert the report.

        :param ended_at_ms: When the hook was recorded, in epoch milliseconds.
        """
        with self._resync_lock:
            self._turn_ended_at_ms = max(ended_at_ms, self._turn_ended_at_ms or 0)
            self._resync_requested = True
        self._fallback.note_turn_ended(ended_at_ms)

    def retire(self) -> None:
        """Let terminal lifecycle handling own the outcome after process exit."""
        self._retired = True
        self._fallback.retire()

    def _track_holdover(self, report: ProgramStatus | None) -> None:
        """Start a holdover on a new Stop, and end it once the report leaves ``working``."""
        with self._resync_lock:
            ended_at_ms = self._turn_ended_at_ms
        if ended_at_ms is not None and ended_at_ms != self._held_for_ms:
            self._held_for_ms = ended_at_ms
            self._held_report = self._observed if self._observed is not None else report
            self._released = self._held_report is None or self._held_report.state != "working"
        if report is None or self._held_report is None or report.state != self._held_report.state:
            self._released = True

    def _osc_status(self, report: ProgramStatus) -> str:
        """Map a report to the runner vocabulary, reading a delegate holdover as idle."""
        self._holding = self._holds()
        if self._holding or report.state not in {"working", "blocked", "error"}:
            return "idle"
        return "failed" if report.state == "error" else "running"

    def _holds(self) -> bool:
        """Whether the held ``working`` report is the leftover of a turn that already ended."""
        if self._held_for_ms is None or self._released:
            return False
        with self._resync_lock:
            started_at_ms = self._turn_started_at_ms
        if started_at_ms is not None and started_at_ms > self._held_for_ms:
            return False
        prompt_at_ms = self._prompt_submitted_at()
        return prompt_at_ms is None or prompt_at_ms <= self._held_for_ms

    def _prompt_submitted_at(self) -> int | None:
        """Read Claude's last prompt time, treating a failed read as unknown."""
        if self._prompt_submitted_at_getter is None:
            return None
        try:
            return self._prompt_submitted_at_getter()
        except Exception:  # noqa: BLE001 - a best-effort read must not stop the watcher.
            _logger.debug("claude prompt time read failed", exc_info=True)
            return None
