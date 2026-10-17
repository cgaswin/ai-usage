// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {nowSeconds} from './lib/format.js';
import {Indicator} from './lib/indicator.js';
import {AntigravityProvider} from './lib/providers/antigravity.js';
import {ClaudeProvider} from './lib/providers/claude.js';
import {CodexProvider} from './lib/providers/codex.js';

// Opening the menu refreshes data older than this.
const STALE_SECONDS = 60;

// Each provider's refresh() resolves to a snapshot:
//   {account, plan, credits, resetCredits: {count, nextExpiresAt},
//    windows: [{group?, label, usedPercent, resetsAt, durationMins}], checkedAt,
//    warning?}
// or {error} when no data is available. Times are Unix seconds.
// refresh(cancellable, staleAfter): staleAfter lets a provider that also
// receives pushed updates (Claude Code) skip work when they are newer.
export default class AiUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._cancellable = new Gio.Cancellable();
        this._snapshots = new Map();
        this._refreshing = new Set();
        // Providers asked to refresh while a refresh was running.
        this._pending = new Map();
        this._providers = [
            new CodexProvider(this._settings, this.metadata['version-name']),
            new ClaudeProvider(this._settings, provider => this._refresh(provider, Infinity)),
            new AntigravityProvider(this._settings),
        ];

        this._indicator = new Indicator(this, {
            select: id => this._settings.set_string('selected-provider', id),
            refresh: () => this._refreshAll(0, 0),
            openSettings: () => this.openPreferences(),
        });
        this._indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refreshAll(STALE_SECONDS, STALE_SECONDS);
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._settings.connectObject(
            'changed::refresh-interval', () => this._startTimer(),
            'changed::codex-path', () => this._refreshById('codex'),
            'changed::agy-path', () => this._refreshById('antigravity'),
            'changed::claude-path', () => this._refreshById('claude'),
            'changed', () => {
                this._update();
                this._refreshAll(Infinity, this._interval());
            },
            this);
        this._interfaceSettings.connectObject('changed::clock-format', () => this._update(), this);

        this._startTimer();
        this._update();
        this._refreshAll(0, this._interval());
    }

    disable() {
        this._cancellable.cancel();
        this._cancellable = null;

        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }

        this._settings.disconnectObject(this);
        this._interfaceSettings.disconnectObject(this);
        this._settings = null;
        this._interfaceSettings = null;

        this._indicator.destroy();
        this._indicator = null;

        this._providers.forEach(provider => provider.destroy());
        this._providers = null;
        this._snapshots = null;
        this._refreshing = null;
        this._pending = null;
    }

    _visibleProviders() {
        return this._providers.filter(p => this._settings.get_boolean(`show-${p.id}`));
    }

    _startTimer() {
        if (this._timerId)
            GLib.Source.remove(this._timerId);

        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._interval(), () => {
            this._refreshAll(0, this._interval());
            return GLib.SOURCE_CONTINUE;
        });
    }

    _interval() {
        return this._settings.get_uint('refresh-interval') * 60;
    }

    // Refreshes visible providers whose data is older than maxAge seconds.
    // Infinity only fills in providers that have no data yet.
    _refreshAll(maxAge, staleAfter) {
        for (const provider of this._visibleProviders()) {
            const snapshot = this._snapshots.get(provider.id);
            const age = snapshot ? nowSeconds() - (snapshot.checkedAt ?? 0) : Infinity;
            if (age >= maxAge)
                this._refresh(provider, staleAfter);
        }
    }

    _refreshById(id) {
        const provider = this._visibleProviders().find(p => p.id === id);
        if (!provider)
            return;
        // Drop the old reading so an error with the new path is shown.
        this._snapshots.delete(id);
        this._update();
        this._refresh(provider, 0);
    }

    async _refresh(provider, staleAfter) {
        // Run again once the current refresh ends: it may have started
        // before a new path was set or a newer reading was written.
        if (this._refreshing.has(provider.id)) {
            this._pending.set(provider.id, Math.min(staleAfter, this._pending.get(provider.id) ?? Infinity));
            return;
        }

        const cancellable = this._cancellable;
        this._refreshing.add(provider.id);
        this._update();
        let snapshot;
        try {
            snapshot = await provider.refresh(cancellable, staleAfter);
        } catch (e) {
            if (cancellable.is_cancelled())
                return;
            console.warn(`AI Usage: ${provider.name}: ${e.message}`);
            snapshot = {error: `Could not read ${provider.name} usage: ${e.message}`};
        }
        if (cancellable.is_cancelled())
            return;

        // Keep the last good reading on screen and show the problem under it.
        const previous = this._snapshots.get(provider.id);
        if (snapshot.error && previous?.windows)
            snapshot = {...previous, warning: snapshot.error};

        this._refreshing.delete(provider.id);
        this._snapshots.set(provider.id, snapshot);
        this._update();

        if (this._pending.has(provider.id)) {
            const pending = this._pending.get(provider.id);
            this._pending.delete(provider.id);
            this._refresh(provider, pending);
        }
    }

    _update() {
        this._indicator.update({
            providers: this._visibleProviders(),
            snapshots: this._snapshots,
            refreshing: this._refreshing,
            selectedId: this._settings.get_string('selected-provider'),
            use12h: this._interfaceSettings.get_string('clock-format') === '12h',
        });
    }
}
