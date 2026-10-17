// SPDX-License-Identifier: GPL-2.0-or-later
//
// Claude Code has two official sources for its limits:
//  - `claude -p /usage` prints the plan usage report. It is a local command:
//    no model turn, no quota spent.
//  - The status line command receives rate_limits while Claude Code runs
//    (https://code.claude.com/docs/en/statusline). tools/claude-statusline.js
//    saves them to a cache file, which this provider watches.
// The newest reading of each window wins. Claude Code's credentials are never
// read here.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {nowSeconds} from '../format.js';
import {findProgram, firstLine, run} from './cli.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');

const TIMEOUT_SECONDS = 30;

// No hooks or MCP servers for the probe, and nothing saved to the history.
const PROBE_ARGS = [
    '-p', '/usage',
    '--output-format', 'json',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--settings', JSON.stringify({disableAllHooks: true, remoteControlAtStartup: false}),
];

const SESSION = {key: 'five_hour', label: '5 hour usage limit', durationMins: 300};
const WEEK = {key: 'seven_day', label: 'Weekly usage limit', durationMins: 10080};

// "Current session: 72% used · resets Oct 17, 8:30pm (Asia/Kolkata)"
// "Current week (all models): 41% used · resets Oct 22, 9am (Asia/Kolkata)"
const USAGE_LINE = /^Current (session|week)(?: \(([^)]+)\))?: (\d+(?:\.\d+)?)% used(?: · [Rr]esets (.+))?$/gm;
// "Oct 17, 8:30pm (Asia/Kolkata)", "9am (Asia/Kolkata)"
const RESET_TIME = /^(?:([A-Za-z]{3})[a-z]* (\d{1,2}),? )?(\d{1,2})(?::(\d{2}))?\s*([ap]m)(?: \(([^)]+)\))?$/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export class ClaudeProvider {
    constructor(settings, onChanged) {
        this.id = 'claude';
        this.name = 'Claude Code';
        this._settings = settings;
        // Newest reading of each window: key -> {window, at}.
        this._readings = new Map();
        // From claude auth status: {account, plan}.
        this._account = null;
        // claude binaries that ran /usage as a prompt instead of a command.
        this._unsupported = new Set();

        this._file = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_cache_dir(), 'ai-usage', 'claude.json']));
        // The directory must exist for the monitor to see the file appear.
        GLib.mkdir_with_parents(this._file.get_parent().get_path(), 0o700);
        this._monitor = this._file.monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect('changed', (_monitor, _file, _other, event) => {
            if (event === Gio.FileMonitorEvent.CHANGES_DONE_HINT ||
                event === Gio.FileMonitorEvent.CREATED)
                onChanged(this);
        });
    }

    // Runs claude /usage unless the status line updated within staleAfter
    // seconds.
    async refresh(cancellable, staleAfter = 0) {
        const cached = await this._readCache(cancellable);
        if (cached)
            this._recordCache(cached);

        let warning = null;
        if (!cached?.windows.length || nowSeconds() - cached.updatedAt >= staleAfter) {
            try {
                const claude = findProgram('claude', this._settings.get_string('claude-path'));
                if (!claude)
                    throw new Error('Claude Code CLI (claude) not found. Set its path in Settings.');
                const [windows] = await Promise.all([
                    this._probe(claude, cancellable),
                    this._readAccount(claude, cancellable),
                ]);
                this._record(windows, nowSeconds());
            } catch (e) {
                // With an earlier reading, show it along with the problem.
                if (cancellable.is_cancelled() || this._readings.size === 0)
                    throw e;
                warning = `Could not read ${this.name} usage: ${e.message}`;
            }
            // The status line may have written while the probe ran.
            const latest = await this._readCache(cancellable);
            if (latest)
                this._recordCache(latest);
        }

        // Fetch account details once even while the status line keeps the
        // probe from running.
        if (this._account === null && !this._accountTried) {
            const claude = findProgram('claude', this._settings.get_string('claude-path'));
            if (claude)
                await this._readAccount(claude, cancellable);
        }

        if (this._readings.size === 0)
            return {error: 'Claude Code reports limits only for Pro and Max plans.'};

        const readings = [...this._readings.values()];
        const order = key => [SESSION.key, WEEK.key].indexOf(key) >>> 0;
        return {
            account: this._account?.email ?? null,
            plan: this._account?.plan ?? null,
            windows: readings.map(r => r.window).sort((a, b) => order(a.key) - order(b.key)),
            checkedAt: Math.max(...readings.map(r => r.at)),
            warning,
        };
    }

    destroy() {
        this._monitor.cancel();
        this._monitor = null;
        this._readings.clear();
    }

    _recordCache(cached) {
        for (const window of cached.windows)
            this._record([window], window.at);
    }

    _record(windows, at) {
        for (const window of windows) {
            const current = this._readings.get(window.key);
            if (!current || current.at <= at)
                this._readings.set(window.key, {window, at});
        }
    }

    // Account details are extras: a failure keeps the last ones.
    async _readAccount(claude, cancellable) {
        this._accountTried = true;
        try {
            const {stdout} = await run([claude, 'auth', 'status', '--json'],
                {cancellable, timeoutSeconds: 15, cwd: GLib.get_home_dir(), env: {DISABLE_AUTOUPDATER: '1'}});
            const status = JSON.parse(stdout);
            if (!status.loggedIn) {
                this._account = null;
                return;
            }
            const plan = status.subscriptionType
                ? status.subscriptionType[0].toUpperCase() + status.subscriptionType.slice(1)
                : null;
            this._account = {
                email: status.email ?? null,
                // Personal accounts get a generated "…'s Organization".
                plan: [plan, /'s Organi[sz]ation$/.test(status.orgName ?? '') ? null : status.orgName]
                    .filter(Boolean).join(' · ') || null,
            };
        } catch (e) {
            if (!cancellable.is_cancelled())
                console.warn(`AI Usage: claude auth status: ${e.message}`);
        }
    }

    async _probe(claude, cancellable) {
        if (this._unsupported.has(claude))
            throw new Error('this Claude Code is too old to print /usage. Run claude update.');

        const {stdout, stderr} = await run([claude, ...PROBE_ARGS], {
            cancellable,
            timeoutSeconds: TIMEOUT_SECONDS,
            cwd: GLib.get_home_dir(),
            env: {DISABLE_AUTOUPDATER: '1'},
        });

        let report;
        try {
            report = JSON.parse(stdout);
        } catch {
            throw new Error(firstLine(stderr) ?? firstLine(stdout) ?? 'claude returned no usage report.');
        }
        const text = report.result ?? '';
        if (report.is_error)
            throw new Error(firstLine(text) ?? 'claude could not read usage.');
        // Older versions send unknown commands in print mode to the model.
        // Never repeat that: it spends quota.
        if (report.local_command !== 'usage') {
            this._unsupported.add(claude);
            throw new Error('this Claude Code is too old to print /usage. Run claude update.');
        }

        const windows = parseUsage(text);
        if (windows.length > 0)
            return windows;
        // Subscribers always get a session line, so the format has changed.
        if (/subscription/i.test(text)) {
            console.warn(`AI Usage: unrecognised claude /usage report:\n${text}`);
            throw new Error('the claude /usage report was not recognised. Claude Code may have changed its format.');
        }
        throw new Error(firstLine(text) ?? 'claude reported no usage limits.');
    }

    async _readCache(cancellable) {
        let contents;
        try {
            [contents] = await this._file.load_contents_async(cancellable);
        } catch (e) {
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                return null;
            throw e;
        }

        let data;
        try {
            data = JSON.parse(new TextDecoder().decode(contents));
        } catch {
            return null;
        }
        const windows = [SESSION, WEEK]
            .filter(({key}) => data.rate_limits?.[key])
            .map(window => ({
                ...window,
                usedPercent: data.rate_limits[window.key].used_percentage,
                resetsAt: data.rate_limits[window.key].resets_at ?? null,
                // When this window was last reported; older caches only
                // have one time for the whole file.
                at: data.rate_limits[window.key].at ?? data.updatedAt ?? 0,
            }));
        return {windows, updatedAt: data.updatedAt ?? 0};
    }
}

function parseUsage(text) {
    const windows = [];
    for (const [, kind, scope, used, reset] of text.matchAll(USAGE_LINE)) {
        let window;
        if (kind === 'session')
            window = SESSION;
        else if (!scope || /^all models$/i.test(scope))
            window = WEEK;
        else
            window = {key: `seven_day:${scope}`, label: `Weekly usage limit (${scope})`, durationMins: 10080};
        windows.push({...window, usedPercent: Number(used), resetsAt: parseReset(reset)});
    }
    return windows;
}

// Reset times have no year, and today's have no date either.
function parseReset(text) {
    const match = text?.trim().match(RESET_TIME);
    if (!match)
        return null;
    const [, monthName, day, hour, minute = '0', meridiem, zone] = match;

    const timeZone = (zone && GLib.TimeZone.new_identifier(zone)) || GLib.TimeZone.new_local();
    const now = GLib.DateTime.new_now(timeZone);
    let month = now.get_month();
    let dayOfMonth = now.get_day_of_month();
    if (monthName) {
        month = MONTHS.indexOf(monthName.toLowerCase()) + 1;
        dayOfMonth = Number(day);
        if (month === 0)
            return null;
    }
    const hours = Number(hour) % 12 + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
    let time = GLib.DateTime.new(timeZone, now.get_year(), month, dayOfMonth, hours, Number(minute), 0);
    if (!time)
        return null;

    // Resets lie ahead; allow an hour for a report read just before one.
    if (time.to_unix() < now.to_unix() - 3600)
        time = monthName ? time.add_years(1) : time.add_days(1);
    return time.to_unix();
}
