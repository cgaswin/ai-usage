// SPDX-License-Identifier: GPL-2.0-or-later
//
// Helpers for running the official CLIs.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');

// GNOME Shell starts before shell profiles run, so its PATH lacks the
// directories that installers and version managers add there.
const EXTRA_DIRS = [
    '.local/bin',
    '.npm-global/bin',
    '.bun/bin',
    '.volta/bin',
    '.local/share/pnpm',
    '.yarn/bin',
    '.local/share/mise/shims',
    '.asdf/shims',
    '.claude/local',
];

export function findProgram(name, configured = '') {
    if (configured)
        return configured;
    const inPath = GLib.find_program_in_path(name);
    if (inPath)
        return inPath;

    const home = GLib.get_home_dir();
    const dirs = [
        ...EXTRA_DIRS.map(dir => GLib.build_filenamev([home, dir])),
        ...nvmDirs(home),
        '/usr/local/bin',
    ];
    for (const dir of dirs) {
        const path = GLib.build_filenamev([dir, name]);
        if (GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE))
            return path;
    }
    return null;
}

// bin directories of the Node versions installed with nvm, newest first.
function nvmDirs(home) {
    const root = GLib.build_filenamev([home, '.nvm', 'versions', 'node']);
    let dir;
    try {
        dir = GLib.Dir.open(root, 0);
    } catch {
        return [];
    }
    const versions = [];
    let name;
    while ((name = dir.read_name()) !== null)
        versions.push(name);
    dir.close();
    const key = version => version.replace(/^v/, '').split('.').map(Number);
    versions.sort((a, b) => {
        const [x, y] = [key(a), key(b)];
        return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
    });
    return versions.map(version => GLib.build_filenamev([root, version, 'bin']));
}

// Environment for running program: its own directory goes first in PATH,
// so a script it starts with "#!/usr/bin/env node" finds the Node next to
// it (nvm, Volta).
export function programEnv(program, env = {}) {
    const path = env.PATH ?? GLib.getenv('PATH') ?? '/usr/bin:/bin';
    return {...env, PATH: `${GLib.path_get_dirname(program)}:${path}`};
}

export function firstLine(text) {
    return text?.trim().split('\n')[0] || null;
}

// Runs argv to completion and returns {status, stdout, stderr}. The process
// is killed when the cancellable fires or after timeoutSeconds.
// stopWhen(stdout, stderr) is checked as output arrives; when it returns a
// message, the process is killed and run() throws an Error with it.
export async function run(argv, {cancellable, timeoutSeconds, cwd = null, env = {}, stopWhen = null}) {
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDIN_PIPE |
            Gio.SubprocessFlags.STDOUT_PIPE |
            Gio.SubprocessFlags.STDERR_PIPE,
    });
    if (cwd)
        launcher.set_cwd(cwd);
    for (const [key, value] of Object.entries(programEnv(argv[0], env)))
        launcher.setenv(key, value, true);
    const proc = launcher.spawnv(argv);
    proc.get_stdin_pipe().close(null);

    const local = new Gio.Cancellable();
    const parentId = cancellable.connect(() => local.cancel());
    const killId = local.connect(() => proc.force_exit());
    let timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSeconds, () => {
        timeoutId = 0;
        local.cancel();
        return GLib.SOURCE_REMOVE;
    });

    // Output is small; decode it whole so characters split across reads
    // come out right.
    const chunks = {stdout: [], stderr: []};
    const text = key => new TextDecoder().decode(new Uint8Array(chunks[key].flatMap(c => [...c])));
    let stopMessage = null;
    const read = async (stream, key) => {
        for (;;) {
            const bytes = await stream.read_bytes_async(8192, GLib.PRIORITY_DEFAULT, local);
            if (bytes.get_size() === 0)
                return;
            chunks[key].push(bytes.toArray());
            if (stopWhen)
                stopMessage ??= stopWhen(text('stdout'), text('stderr'));
            if (stopMessage) {
                local.cancel();
                return;
            }
        }
    };

    try {
        await Promise.all([
            read(proc.get_stdout_pipe(), 'stdout'),
            read(proc.get_stderr_pipe(), 'stderr'),
        ]);
        if (stopMessage)
            throw new Error(stopMessage);
        await proc.wait_async(local);
        return {
            status: proc.get_if_exited() ? proc.get_exit_status() : -1,
            stdout: text('stdout'),
            stderr: text('stderr'),
        };
    } catch (e) {
        if (stopMessage)
            throw new Error(stopMessage);
        if (timeoutId === 0 && !cancellable.is_cancelled())
            throw new Error(`${GLib.path_get_basename(argv[0])} did not answer within ${timeoutSeconds} seconds`);
        throw e;
    } finally {
        await proc.wait_async(null);
        if (timeoutId)
            GLib.Source.remove(timeoutId);
        local.disconnect(killId);
        cancellable.disconnect(parentId);
    }
}
