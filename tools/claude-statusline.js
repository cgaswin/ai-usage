#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Status line command for Claude Code. Claude Code pipes session JSON to
// stdin; this saves its rate_limits for the AI Usage extension and prints
// a short status line. Add to ~/.claude/settings.json:
//
//   "statusLine": {"type": "command", "command": "gjs -m /path/to/claude-statusline.js"}

import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';

const CACHE_PATH = GLib.build_filenamev([GLib.get_user_cache_dir(), 'ai-usage', 'claude.json']);

function readStdin() {
    const stream = new GioUnix.InputStream({fd: 0, close_fd: false});
    const chunks = [];
    let chunk;
    while ((chunk = stream.read_bytes(65536, null)).get_size() > 0)
        chunks.push(...chunk.toArray());
    return new TextDecoder().decode(new Uint8Array(chunks));
}

function readCache() {
    try {
        const [, contents] = GLib.file_get_contents(CACHE_PATH);
        return JSON.parse(new TextDecoder().decode(contents));
    } catch {
        return {};
    }
}

// Each window can be missing from a single update, so keep the last
// known value of the other one, with the time it was reported.
function saveLimits(limits) {
    const now = Math.floor(Date.now() / 1000);
    const merged = readCache().rate_limits ?? {};
    for (const [key, value] of Object.entries(limits))
        merged[key] = {...value, at: now};
    GLib.mkdir_with_parents(GLib.path_get_dirname(CACHE_PATH), 0o700);
    GLib.file_set_contents(CACHE_PATH, JSON.stringify({
        updatedAt: now,
        rate_limits: merged,
    }));
}

function statusLine(input) {
    const parts = [input.model?.display_name ?? 'Claude'];
    const limits = input.rate_limits ?? {};
    if (limits.five_hour)
        parts.push(`5h ${Math.round(100 - limits.five_hour.used_percentage)}% left`);
    if (limits.seven_day)
        parts.push(`week ${Math.round(100 - limits.seven_day.used_percentage)}% left`);
    return parts.join(' · ');
}

const input = JSON.parse(readStdin());
if (input.rate_limits)
    saveLimits(input.rate_limits);
print(statusLine(input));
