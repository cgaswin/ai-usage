// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {formatAge, formatClock, formatDuration, notStarted, nowSeconds, remainingPercent, runsOutAt} from './format.js';

const VERTICAL = Clutter.Orientation.VERTICAL;

export const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    // actions: {select(id), refresh(), openSettings(), opened()}
    _init(extension, actions) {
        super._init(0.5, extension.metadata.name);
        this._actions = actions;
        this._iconDir = extension.dir.get_child('icons');
        this._state = {providers: [], snapshots: new Map(), refreshing: new Set(), selectedId: null, use12h: false};

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._panelIcon = new St.Icon({
            gicon: this._icon('ai-usage'),
            style_class: 'system-status-icon',
        });
        box.add_child(this._panelIcon);
        this._panelLabel = new St.Label({
            text: '–',
            style_class: 'aiu-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        // A crowded panel would otherwise shrink the label to nothing.
        this._panelLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        box.add_child(this._panelLabel);
        this.add_child(box);

        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._content = new St.BoxLayout({orientation: VERTICAL, x_expand: true, style_class: 'aiu-menu'});
        item.add_child(this._content);
        this.menu.addMenuItem(item);

        // Relative times ("in 2h 5m") go stale while the menu is closed.
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._render();
                this._actions.opened();
            }
        });
    }

    update(state) {
        this._state = state;
        this._render();
    }

    _render() {
        const {providers, snapshots, refreshing, selectedId} = this._state;
        const provider = providers.find(p => p.id === selectedId) ?? providers[0];
        const snapshot = provider ? snapshots.get(provider.id) : null;

        this._panelIcon.gicon = this._icon(provider?.id ?? 'ai-usage');
        this._panelLabel.text = panelText(snapshot);
        this._content.destroy_all_children();

        if (providers.length > 1)
            this._content.add_child(this._tabs(providers, provider));
        if (provider)
            this._content.add_child(this._body(provider, snapshot));
        this._content.add_child(this._footer(snapshot, refreshing.has(provider?.id)));
    }

    _tabs(providers, selected) {
        const tabs = new St.BoxLayout({style_class: 'aiu-tabs', x_expand: true});
        for (const provider of providers) {
            const content = new St.BoxLayout({style_class: 'aiu-tab-content', x_align: Clutter.ActorAlign.CENTER});
            content.add_child(new St.Icon({gicon: this._icon(provider.id), icon_size: 16}));
            content.add_child(new St.Label({text: provider.name, y_align: Clutter.ActorAlign.CENTER}));
            const tab = new St.Button({
                child: content,
                accessible_name: provider.name,
                style_class: 'aiu-tab',
                checked: provider === selected,
                can_focus: true,
                x_expand: true,
            });
            tab.connect('clicked', () => this._actions.select(provider.id));
            tabs.add_child(tab);
        }
        return tabs;
    }

    _icon(name) {
        return Gio.FileIcon.new(this._iconDir.get_child(`${name}-symbolic.svg`));
    }

    _body(provider, snapshot) {
        const body = new St.BoxLayout({orientation: VERTICAL, style_class: 'aiu-body'});

        if (!snapshot) {
            body.add_child(dimLabel(`Loading ${provider.name} usage…`));
            return body;
        }
        if (snapshot.error) {
            const message = new St.Label({text: snapshot.error, style_class: 'aiu-message'});
            message.clutter_text.line_wrap = true;
            body.add_child(message);
            return body;
        }

        const header = headerLines(snapshot);
        if (header.length > 0) {
            const section = newSection();
            header.forEach((text, i) => section.add_child(i === 0 ? new St.Label({text}) : dimLabel(text)));
            body.add_child(section);
        }

        // Providers with several quota groups (Antigravity) get a heading
        // above each group's windows.
        let group = null;
        let parent = body;
        for (const window of snapshot.windows) {
            if (window.group && window.group !== group) {
                group = window.group;
                parent = new St.BoxLayout({orientation: VERTICAL, style_class: 'aiu-group'});
                const heading = newSection();
                heading.add_child(new St.Label({text: group, style_class: 'aiu-group-title'}));
                if (window.groupDetail)
                    heading.add_child(dimLabel(window.groupDetail));
                parent.add_child(heading);
                body.add_child(parent);
            }
            parent.add_child(this._window(window, snapshot.checkedAt));
        }

        if (snapshot.warning)
            body.add_child(warning(snapshot.warning));
        return body;
    }

    _window(window, checkedAt) {
        const remaining = remainingPercent(window);
        const level = remaining < 10 ? 'critical' : remaining < 30 ? 'low' : 'ok';

        const section = newSection();
        section.add_child(dimLabel(window.label));

        section.add_child(new St.Label({text: `${remaining}% remaining`, style_class: 'aiu-remaining'}));
        section.add_child(bar(remaining / 100, level));

        const now = nowSeconds();
        if (notStarted(window, checkedAt)) {
            const idle = dimLabel('Not started · begins with your next request');
            idle.clutter_text.line_wrap = true;
            section.add_child(idle);
        } else if (window.resetsAt) {
            const text = window.resetsAt <= now
                ? 'Reset since last update'
                : `Resets ${formatClock(window.resetsAt, this._state.use12h)} · in ${formatDuration(window.resetsAt - now)}`;
            section.add_child(dimLabel(text));
        }

        const runsOut = runsOutAt(window);
        if (runsOut) {
            const pace = new St.Label({
                text: `At your pace so far, runs out in about ${formatDuration(runsOut - now)}`,
                style_class: 'aiu-pace',
            });
            pace.clutter_text.line_wrap = true;
            section.add_child(pace);
        }
        return section;
    }

    _footer(snapshot, refreshing) {
        const footer = new St.BoxLayout({style_class: 'aiu-footer', x_expand: true});
        let status = '';
        // Before the first reading the body already says it is loading.
        if (refreshing && snapshot)
            status = 'Checking…';
        else if (snapshot?.checkedAt)
            status = `Updated ${formatAge(snapshot.checkedAt)}`;
        footer.add_child(dimLabel(status, {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));

        const refresh = iconButton('view-refresh-symbolic', 'Refresh now', () => this._actions.refresh());
        if (refreshing)
            spin(refresh.child);
        footer.add_child(refresh);
        footer.add_child(iconButton('emblem-system-symbolic', 'Settings', () => {
            this.menu.close();
            this._actions.openSettings();
        }));
        return footer;
    }
});

// The 5-hour limit runs out first in practice, so the panel shows it; the
// lowest one when there are several (Antigravity has one per group).
function panelText(snapshot) {
    const windows = snapshot?.windows ?? [];
    const fiveHour = windows.filter(window => window.durationMins === 300);
    const shown = fiveHour.length > 0 ? fiveHour : windows;
    if (shown.length === 0)
        return '–';
    return `${Math.min(...shown.map(remainingPercent))}% left`;
}

function headerLines(snapshot) {
    const lines = [];
    if (snapshot.account)
        lines.push(snapshot.account);

    const plan = [snapshot.plan];
    if (snapshot.resetCredits) {
        const {count} = snapshot.resetCredits;
        plan.push(`${count} reset${count === 1 ? '' : 's'} available`);
    }
    plan.push(snapshot.credits);
    if (plan.some(Boolean))
        lines.push(plan.filter(Boolean).join(' · '));

    if (snapshot.resetCredits)
        lines.push(`Next reset expires in ${formatDuration(snapshot.resetCredits.nextExpiresAt - nowSeconds())}`);
    return lines;
}

function newSection() {
    return new St.BoxLayout({orientation: VERTICAL, style_class: 'aiu-section'});
}

function dimLabel(text, params = {}) {
    return new St.Label({text, style_class: 'aiu-dim', ...params});
}

function warning(text) {
    const box = new St.BoxLayout({style_class: 'aiu-warning'});
    box.add_child(new St.Icon({icon_name: 'dialog-warning-symbolic', icon_size: 16, y_align: Clutter.ActorAlign.START}));
    const label = new St.Label({text, x_expand: true});
    label.clutter_text.line_wrap = true;
    box.add_child(label);
    return box;
}

// Turns the actor until it is destroyed; the menu is rebuilt when the
// refresh finishes.
function spin(actor) {
    actor.set_pivot_point(0.5, 0.5);
    actor.ease({
        rotation_angle_z: 360,
        duration: 1000,
        mode: Clutter.AnimationMode.LINEAR,
        repeatCount: -1,
    });
}

function iconButton(iconName, accessibleName, onClicked) {
    const button = new St.Button({
        style_class: 'aiu-icon-button',
        child: new St.Icon({icon_name: iconName, icon_size: 16}),
        accessible_name: accessibleName,
        can_focus: true,
    });
    button.connect('clicked', onClicked);
    return button;
}

// fraction: share of the bar to fill.
function bar(fraction, level) {
    // The fill sits at x = 0 and never outgrows the track, so the track's
    // preferred width cannot push the menu wider.
    const track = new St.Widget({style_class: 'aiu-bar', x_expand: true});
    const fill = new St.Widget({style_class: `aiu-bar-fill aiu-${level}`});
    track.add_child(fill);
    track.connect('notify::width', () => {
        fill.width = Math.round(track.width * fraction);
    });
    return track;
}
