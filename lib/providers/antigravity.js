// SPDX-License-Identifier: GPL-2.0-or-later
//
// Reads Antigravity limits with `agy -p /usage --output-format json`, the
// official CLI's usage report for scripts. agy handles its own login; this
// file never reads its credentials or calls Google's servers itself.

import GLib from 'gi://GLib';

import {nowSeconds} from '../format.js';
import {findProgram, firstLine, run} from './cli.js';

// Older agy sent unknown slash commands in print mode to the model as a
// prompt, which would spend quota.
const MIN_VERSION = [1, 1, 11];
const TIMEOUT_SECONDS = 60;
const SIGNED_OUT = /authentication required/i;
const SIGNED_OUT_MESSAGE = 'agy is signed out. Run agy in a terminal to sign in.';

const DURATIONS = {'5h': 300, 'weekly': 10080};
const LABELS = {'5h': '5 hour usage limit', 'weekly': 'Weekly usage limit'};

export class AntigravityProvider {
    constructor(settings) {
        this.id = 'antigravity';
        this.name = 'Antigravity';
        this._settings = settings;
        this._supported = new Set();
    }

    async refresh(cancellable) {
        const agy = findProgram('agy', this._settings.get_string('agy-path'));
        if (!agy)
            return {error: 'Antigravity CLI (agy) not found. Set its path in Settings.'};

        // Only remember a supported version, so agy update is picked up.
        if (!this._supported.has(agy)) {
            const version = await this._checkVersion(agy, cancellable);
            if (version !== true)
                return {error: `Usage reports need agy ${MIN_VERSION.join('.')} or later (found ${version}). Run agy update.`};
            this._supported.add(agy);
        }

        // Run outside any project. Without a terminal, a signed-out agy
        // prints an error instead of starting a browser sign-in; BROWSER
        // guards against versions that would try anyway.
        const {stdout, stderr} = await run(
            [agy, '-p', '/usage', '--output-format', 'json', '--print-timeout', `${TIMEOUT_SECONDS - 5}s`],
            {
                cancellable,
                timeoutSeconds: TIMEOUT_SECONDS,
                cwd: GLib.get_home_dir(),
                env: {BROWSER: 'false'},
                // Signed out, agy can print a login URL and wait for it.
                stopWhen: (_stdout, stderr) => SIGNED_OUT.test(stderr) ? SIGNED_OUT_MESSAGE : null,
            });

        let report;
        try {
            report = JSON.parse(stdout);
        } catch {
            return {error: firstLine(stderr) ?? 'agy returned no usage report. Run agy once to sign in.'};
        }
        if (report.status !== 'SUCCESS' && SIGNED_OUT.test(stderr))
            return {error: SIGNED_OUT_MESSAGE};
        if (report.status !== 'SUCCESS' || report.command?.name !== 'usage')
            return {error: firstLine(report.response) ?? firstLine(report.error) ?? firstLine(stderr) ?? 'agy could not read usage.'};
        return toSnapshot(report.command.data);
    }

    destroy() {
        this._supported.clear();
    }

    // Resolves to true, or the version text when it is too old.
    async _checkVersion(agy, cancellable) {
        const {stdout} = await run([agy, '--version'], {cancellable, timeoutSeconds: 10});
        const text = stdout.trim();
        const parts = text.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
        if (!parts)
            return text || 'unknown';
        for (let i = 0; i < 3; i++) {
            if (parts[i] !== MIN_VERSION[i])
                return parts[i] > MIN_VERSION[i] ? true : text;
        }
        return true;
    }
}

function toSnapshot(data) {
    const windows = [];
    for (const group of data?.groups ?? []) {
        const groupWindows = (group.buckets ?? [])
            .filter(bucket => typeof bucket.remaining_fraction === 'number')
            .map(bucket => ({
                ...toWindow(group.name, bucket),
                // "Models within this group: Gemini Flash, Gemini Pro"
                groupDetail: group.description?.replace(/^Models within this group:\s*/i, '') || null,
            }))
            // 5 hour window first, then weekly.
            .sort((a, b) => (a.durationMins ?? Number.MAX_VALUE) - (b.durationMins ?? Number.MAX_VALUE));
        windows.push(...groupWindows);
    }
    if (windows.length === 0)
        return {error: 'agy reported no usage limits for this account.'};
    return {windows, checkedAt: nowSeconds()};
}

function toWindow(group, bucket) {
    const resetsAt = Date.parse(bucket.reset_time);
    return {
        group,
        label: LABELS[bucket.window] ?? bucket.name ?? 'Usage limit',
        usedPercent: (1 - bucket.remaining_fraction) * 100,
        resetsAt: Number.isNaN(resetsAt) ? null : Math.floor(resetsAt / 1000),
        durationMins: DURATIONS[bucket.window] ?? null,
    };
}
