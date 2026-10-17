// SPDX-License-Identifier: GPL-2.0-or-later
//
// Reads Codex limits through `codex app-server`, the documented JSON-RPC
// interface of the official CLI (https://learn.chatgpt.com/docs/app-server).
// Codex handles its own login; this file never touches ~/.codex/auth.json.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {nowSeconds} from '../format.js';
import {findProgram, programEnv} from './cli.js';

Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async');

const TIMEOUT_SECONDS = 20;
const ACCOUNT_ID = 2;
const LIMITS_ID = 3;

export class CodexProvider {
    constructor(settings, version) {
        this.id = 'codex';
        this.name = 'Codex';
        this._settings = settings;
        this._version = version;
    }

    async refresh(cancellable) {
        const codex = findProgram('codex', this._settings.get_string('codex-path'));
        if (!codex)
            return {error: 'Codex CLI not found. Set its path in Settings.'};

        const {account, limits} = await this._query(codex, cancellable);
        return toSnapshot(account, limits);
    }

    destroy() {
    }

    async _query(codex, parentCancellable) {
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDIN_PIPE |
                Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_SILENCE,
        });
        launcher.set_cwd(GLib.get_home_dir());
        for (const [key, value] of Object.entries(programEnv(codex)))
            launcher.setenv(key, value, true);
        const proc = launcher.spawnv([codex, 'app-server']);

        const cancellable = new Gio.Cancellable();
        const parentId = parentCancellable.connect(() => cancellable.cancel());
        const killId = cancellable.connect(() => proc.force_exit());
        let timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TIMEOUT_SECONDS, () => {
            timeoutId = 0;
            cancellable.cancel();
            return GLib.SOURCE_REMOVE;
        });

        try {
            const requests = [
                {method: 'initialize', id: 1, params: {clientInfo: {name: 'ai_usage', title: 'AI Usage', version: this._version}}},
                {method: 'initialized'},
                {method: 'account/read', id: ACCOUNT_ID, params: {}},
                {method: 'account/rateLimits/read', id: LIMITS_ID},
            ];
            const payload = requests.map(r => `${JSON.stringify(r)}\n`).join('');
            await proc.get_stdin_pipe().write_bytes_async(
                new GLib.Bytes(new TextEncoder().encode(payload)), GLib.PRIORITY_DEFAULT, cancellable);

            const stdout = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
            const results = new Map();
            while (results.size < 2) {
                const [line] = await stdout.read_line_async(GLib.PRIORITY_DEFAULT, cancellable);
                if (line === null)
                    throw new Error('codex app-server stopped before answering');

                const message = JSON.parse(new TextDecoder().decode(line));
                if (message.id !== ACCOUNT_ID && message.id !== LIMITS_ID)
                    continue;
                if (message.error)
                    throw new Error(message.error.message);
                results.set(message.id, message.result);
            }
            return {account: results.get(ACCOUNT_ID)?.account ?? null, limits: results.get(LIMITS_ID)};
        } finally {
            // app-server exits when its input closes; the timeout kills it
            // if it does not.
            proc.get_stdin_pipe().close(null);
            await proc.wait_async(null);
            if (timeoutId)
                GLib.Source.remove(timeoutId);
            cancellable.disconnect(killId);
            parentCancellable.disconnect(parentId);
        }
    }
}

function toSnapshot(account, limits) {
    const snapshot = limits?.rateLimitsByLimitId?.codex ?? limits.rateLimits;
    if (!snapshot)
        return {error: 'Codex reports usage limits only when signed in with ChatGPT.'};
    const windows = [];
    if (snapshot.primary)
        windows.push(toWindow(snapshot.primary));
    if (snapshot.secondary)
        windows.push(toWindow(snapshot.secondary));

    const resetCredits = (limits?.rateLimitResetCredits?.credits ?? [])
        .filter(credit => credit.status === 'available')
        .map(credit => credit.expiresAt)
        .sort((a, b) => a - b);

    return {
        account: account?.email ?? null,
        plan: capitalize(snapshot.planType ?? account?.planType),
        resetCredits: resetCredits.length > 0 ? {count: resetCredits.length, nextExpiresAt: resetCredits[0]} : null,
        credits: formatCredits(snapshot.credits),
        windows,
        checkedAt: nowSeconds(),
    };
}

function toWindow(window) {
    return {
        label: windowLabel(window.windowDurationMins),
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt ?? null,
        durationMins: window.windowDurationMins ?? null,
    };
}

function windowLabel(minutes) {
    if (minutes === 10080)
        return 'Weekly usage limit';
    if (minutes && minutes % 1440 === 0)
        return `${minutes / 1440} day usage limit`;
    if (minutes && minutes % 60 === 0)
        return `${minutes / 60} hour usage limit`;
    return 'Usage limit';
}

function formatCredits(credits) {
    if (!credits)
        return null;
    if (credits.unlimited)
        return 'Unlimited credits';
    // Most plans have no credits; 0 is not worth a line.
    const balance = Number(credits.balance);
    return balance > 0 ? `${balance} credits` : null;
}

function capitalize(text) {
    return text ? text[0].toUpperCase() + text.slice(1) : null;
}
