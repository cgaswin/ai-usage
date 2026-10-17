// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class AiUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        const providers = new Adw.PreferencesGroup({title: 'Providers'});
        page.add(providers);
        for (const [key, title] of [
            ['show-codex', 'Codex'],
            ['show-claude', 'Claude Code'],
            ['show-antigravity', 'Antigravity'],
        ]) {
            const row = new Adw.SwitchRow({title});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            providers.add(row);
        }

        const general = new Adw.PreferencesGroup({title: 'General'});
        page.add(general);
        const interval = new Adw.SpinRow({
            title: 'Refresh interval',
            subtitle: 'Minutes between checks',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 60, step_increment: 1}),
        });
        settings.bind('refresh-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);
        general.add(interval);

        const codex = new Adw.PreferencesGroup({
            title: 'Codex',
            description: 'Limits are read through codex app-server, the official CLI interface.',
        });
        page.add(codex);
        const codexPath = new Adw.EntryRow({show_apply_button: true, title: 'Codex executable (empty to detect automatically)'});
        codexPath.text = settings.get_string('codex-path');
        codexPath.connect('apply', () => settings.set_string('codex-path', codexPath.text.trim()));
        codex.add(codexPath);

        const antigravity = new Adw.PreferencesGroup({
            title: 'Antigravity',
            description: 'Limits are read with agy -p /usage, the CLI\'s own usage report. Needs agy 1.1.11 or later.',
        });
        page.add(antigravity);
        const agyPath = new Adw.EntryRow({show_apply_button: true, title: 'agy executable (empty to detect automatically)'});
        agyPath.text = settings.get_string('agy-path');
        agyPath.connect('apply', () => settings.set_string('agy-path', agyPath.text.trim()));
        antigravity.add(agyPath);

        const claude = new Adw.PreferencesGroup({
            title: 'Claude Code',
            description: 'Limits are read with claude -p /usage, the CLI\'s own usage report. It spends no quota.',
        });
        page.add(claude);
        const claudePath = new Adw.EntryRow({show_apply_button: true, title: 'claude executable (empty to detect automatically)'});
        claudePath.text = settings.get_string('claude-path');
        claudePath.connect('apply', () => settings.set_string('claude-path', claudePath.text.trim()));
        claude.add(claudePath);

        const command = `gjs -m ${this.path}/tools/claude-statusline.js`;
        claude.add(new Adw.ActionRow({
            title: 'Optional: instant updates',
            subtitle: 'While Claude Code runs, its status line can update the menu after every reply. ' +
                `Add to ~/.claude/settings.json:\n"statusLine": ${JSON.stringify({type: 'command', command})}`,
            subtitle_selectable: true,
        }));
    }
}
