UUID = ai-usage@cgaswin.github.io
EXTENSIONS_DIR = $(HOME)/.local/share/gnome-shell/extensions

.PHONY: pack install link nested logs clean

# Zip for extensions.gnome.org and manual installs.
pack:
	mkdir -p dist
	gnome-extensions pack --force --out-dir=dist \
		--extra-source=lib --extra-source=tools --extra-source=icons --extra-source=stylesheet-light.css .

install: pack
	gnome-extensions install --force dist/$(UUID).shell-extension.zip

# Development: symlink this checkout into the extensions directory.
link:
	glib-compile-schemas schemas
	mkdir -p $(EXTENSIONS_DIR)
	ln -sfn $(CURDIR) $(EXTENSIONS_DIR)/$(UUID)

# Nested GNOME Shell for testing (needs: sudo dnf install mutter-devkit).
nested: link
	MUTTER_DEBUG_DUMMY_MODE_SPECS=1400x900 dbus-run-session gnome-shell --devkit --wayland

logs:
	journalctl -f -o cat /usr/bin/gnome-shell /usr/bin/gjs

clean:
	rm -rf dist schemas/gschemas.compiled
