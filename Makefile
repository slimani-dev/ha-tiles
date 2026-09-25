UUID = ha-tiles@slimani.dev
PACKAGE = $(UUID).shell-extension.zip

.PHONY: all package install uninstall icons lint clean

all: package install

icons:
	python3 tools/fetch-icons.py

$(PACKAGE): metadata.json extension.js prefs.js stylesheet.css $(wildcard lib/*.js) $(wildcard schemas/*.xml) $(wildcard icons/mdi/*.svg)
	gnome-extensions pack --force \
		--extra-source=lib \
		--extra-source=icons \
		--extra-source=LICENSE

package: $(PACKAGE)

install: $(PACKAGE)
	gnome-extensions install --force $(PACKAGE)

uninstall:
	gnome-extensions uninstall $(UUID)

lint:
	@for f in extension.js prefs.js lib/*.js; do node --check $$f || exit 1; done
	glib-compile-schemas --strict --dry-run schemas

clean:
	rm -f $(PACKAGE)
