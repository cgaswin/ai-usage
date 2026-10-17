// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

export function nowSeconds() {
    return Math.floor(Date.now() / 1000);
}

// 302400 -> "3d 12h", 7500 -> "2h 5m", 300 -> "5m"
export function formatDuration(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    const minutes = Math.floor((s % 3600) / 60);

    if (days > 0)
        return `${days}d ${hours}h`;
    if (hours > 0)
        return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

// Time of day for today, otherwise date and time.
export function formatClock(unixSeconds, use12h) {
    const time = GLib.DateTime.new_from_unix_local(unixSeconds);
    const now = GLib.DateTime.new_now_local();
    const clock = time.format(use12h ? '%-l:%M %p' : '%H:%M');

    if (time.get_year() === now.get_year() &&
        time.get_day_of_year() === now.get_day_of_year())
        return clock;
    return `${time.format('%a %-d %b')}, ${clock}`;
}

export function formatAge(unixSeconds) {
    const age = nowSeconds() - unixSeconds;
    if (age < 60)
        return 'just now';
    return `${formatDuration(age)} ago`;
}

// A window whose reset time has passed has been refilled, even if
// our last reading still shows it as used.
export function remainingPercent(window) {
    if (window.resetsAt && window.resetsAt <= nowSeconds())
        return 100;
    return Math.max(0, Math.min(100, Math.round(100 - window.usedPercent)));
}

// When the limit runs out if usage keeps the average rate it has had so far
// in this window, or null when it lasts until the reset. The first
// 15 minutes are too short to judge.
export function runsOutAt(window) {
    if (!window.resetsAt || !window.durationMins || window.usedPercent <= 0 || window.usedPercent >= 100)
        return null;
    const now = nowSeconds();
    const elapsed = window.durationMins * 60 - (window.resetsAt - now);
    if (elapsed < 15 * 60)
        return null;
    const at = now + (100 - window.usedPercent) * elapsed / window.usedPercent;
    return at < window.resetsAt ? Math.round(at) : null;
}

// An unused window has not started: its reset time is just checkedAt plus
// the window length and moves with every check.
export function notStarted(window, checkedAt) {
    if (!window.resetsAt || !window.durationMins || !checkedAt || window.usedPercent >= 0.5)
        return false;
    return window.resetsAt - checkedAt >= window.durationMins * 60 - 120;
}
