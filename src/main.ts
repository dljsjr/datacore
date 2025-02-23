import { DatacoreApi } from "api/api";
import { Datacore } from "index/datacore";
import { DateTime } from "luxon";
import { App, Plugin, PluginSettingTab, SearchComponent, setIcon, Setting } from "obsidian";
import { createElement, render } from "preact";
import { DEFAULT_SETTINGS, Settings } from "settings";
import { IndexStatusBar } from "ui/index-status";
import { FuzzyFolderSearchSuggest } from "utils/settings/fuzzy-folder-finder";

import * as _Obsidian from "obsidian";
import "./settings.css";

/** Reactive data engine for your Obsidian.md vault. */
export default class DatacorePlugin extends Plugin {
    /** Plugin-wide default settings. */
    public settings: Settings;

    /** Central internal state. */
    public core: Datacore;
    /** Externally visible API for querying. */
    public api: DatacoreApi;

    async onload() {
        const obsidianFreeFunctions: Record<string, any> = {};
        for (const property in _Obsidian) {
            const mod = _Obsidian as Record<string, any>;
            if (mod[property] && typeof mod[property] === "function") {
                const fun = mod[property];
                const isClass = !!Object.keys(fun.prototype).length || /^[A-Z]/.test(property);
                if (!isClass) {
                    obsidianFreeFunctions[property] = fun;
                }
            }
        }
        this.app.functions = obsidianFreeFunctions;

        this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) ?? {});
        this.settings.scriptRoots = new Set([...this.settings.scriptRoots]);
        this.addSettingTab(new GeneralSettingsTab(this.app, this));

        // Initialize the core API for usage in all views and downstream apps.
        this.addChild((this.core = new Datacore(this.app, this.manifest.version, this.settings)));
        this.api = new DatacoreApi(this.core);

        // Add a visual aid for what datacore is currently doing.
        this.mountIndexState(this.addStatusBarItem(), this.core);

        // Primary visual elements (DatacoreJS and Datacore blocks).
        this.registerMarkdownCodeBlockProcessor(
            "datacorejs",
            async (source: string, el, ctx) => this.api.executeJs(source, el, ctx, ctx.sourcePath),
            -100
        );

        this.registerMarkdownCodeBlockProcessor(
            "datacorejsx",
            async (source: string, el, ctx) => this.api.executeJsx(source, el, ctx, ctx.sourcePath),
            -100
        );

        this.registerMarkdownCodeBlockProcessor(
            "datacorets",
            async (source: string, el, ctx) => this.api.executeTs(source, el, ctx, ctx.sourcePath),
            -100
        );

        this.registerMarkdownCodeBlockProcessor(
            "datacoretsx",
            async (source: string, el, ctx) => this.api.executeTsx(source, el, ctx, ctx.sourcePath),
            -100
        );

        // Register JS highlighting for codeblocks.
        this.register(this.registerCodeblockHighlighting());

        // Initialize as soon as the workspace is ready.
        if (!this.app.workspace.layoutReady) {
            this.app.workspace.onLayoutReady(async () => this.core.initialize());
        } else {
            this.core.initialize();
        }

        // Make the API globally accessible from any context.
        window.datacore = this.api;

        // bon appetit
        console.log(`Datacore: version ${this.manifest.version} (requires obsidian ${this.manifest.minAppVersion})`);
    }

    onunload() {
        console.log(`Datacore: version ${this.manifest.version} unloaded.`);
    }

    /** Register codeblock highlighting and return a closure which unregisters. */
    registerCodeblockHighlighting(): () => void {
        window.CodeMirror.defineMode("datacorejs", (config) => window.CodeMirror.getMode(config, "javascript"));
        window.CodeMirror.defineMode("datacorejsx", (config) => window.CodeMirror.getMode(config, "jsx"));
        window.CodeMirror.defineMode("datacorets", (config) => window.CodeMirror.getMode(config, "javascript"));
        window.CodeMirror.defineMode("datacoretsx", (config) => window.CodeMirror.getMode(config, "jsx"));

        return () => {
            window.CodeMirror.defineMode("datacorejs", (config) => window.CodeMirror.getMode(config, "null"));
            window.CodeMirror.defineMode("datacorejsx", (config) => window.CodeMirror.getMode(config, "null"));
            window.CodeMirror.defineMode("datacorets", (config) => window.CodeMirror.getMode(config, "null"));
            window.CodeMirror.defineMode("datacoretsx", (config) => window.CodeMirror.getMode(config, "null"));
        };
    }

    public async saveData(data: any) {
        const serialized: Record<string, any> = {};
        Object.entries(data).forEach(([key, val]) => {
            var serializedVal;
            if (val instanceof Set) {
                serializedVal = Array.from(val);
            } else {
                serializedVal = val;
            }
            serialized[key] = serializedVal;
        });
        super.saveData(serialized);
    }

    /** Update the given settings to new values. */
    async updateSettings(settings: Partial<Settings>) {
        Object.assign(this.settings, settings);
        await this.saveData(this.settings);
    }

    async addScriptRootsToSettings(newRoots: string[]) {
        newRoots.forEach((newRoot) => this.settings.scriptRoots.add(newRoot));
        await this.saveData(this.settings);
    }

    async removeScriptRoots(rootsToRemove: string[]) {
        rootsToRemove.forEach((root) => this.settings.scriptRoots.delete(root));
        await this.saveData(this.settings);
    }

    /** Render datacore indexing status using the index. */
    private mountIndexState(root: HTMLElement, core: Datacore): void {
        render(createElement(IndexStatusBar, { datacore: core }), root);

        this.register(() => render(null, root));
    }
}

/** Datacore Settings Tab. */
class GeneralSettingsTab extends PluginSettingTab {
    constructor(app: App, private plugin: DatacorePlugin) {
        super(app, plugin);
    }

    private async handleNewScriptRoot(component?: SearchComponent) {
        if (!component) {
            return;
        }

        const searchValue = component.getValue();
        if (!searchValue || searchValue.length === 0) {
            return;
        }

        if (this.plugin.settings.scriptRoots.has(searchValue)) {
            return;
        }

        const dirStat = await this.app.vault.adapter.stat(searchValue);
        if (!(dirStat?.type === "folder")) {
            return;
        }

        await this.plugin.addScriptRootsToSettings([searchValue]);
        this.display();
    }

    public display(): void {
        this.containerEl.empty();

        this.containerEl.createEl("h2", { text: "Scripting" });

        const importRootsDesc = new DocumentFragment();
        importRootsDesc.createDiv().innerHTML = `
<p>
Provide folders in the vault to be used when resolving module and/or script file names,
in addition to the vault root. These values are used with with
<code>require(...)</code>/<code>await dc.require(...)</code>/<code>import ...</code> when the path
<em>does not</em> start with some kind of indicator for resolving the root
(such as <code>./</code> or <code>/</code>).
</p>
`;
        var searchBar: SearchComponent | undefined = undefined;
        new Setting(this.containerEl).setName("Additional Script/Module Roots").setDesc(importRootsDesc);
        new Setting(this.containerEl)
            .addSearch((searchComponent) => {
                searchBar = searchComponent;
                const searcher = new FuzzyFolderSearchSuggest(this.app, searchComponent.inputEl);
                searcher.limit = 10;
                searcher.onSelect(async (val, evt) => {
                    evt.preventDefault();
                    evt.stopImmediatePropagation();
                    evt.stopPropagation();
                    searcher.setValue(val);
                    searcher.close();
                });

                searchComponent.setPlaceholder("New Script Root Folder...");
                searchComponent.onChange((val) => {
                    if (val.length > 0) {
                        searcher.open();
                    }
                });

                searchComponent.inputEl.addEventListener("keydown", (evt) => {
                    if (evt.key === "Enter") {
                        this.handleNewScriptRoot(searchComponent);
                    }
                });
                searchComponent.inputEl.addClass("datacore-settings-full-width-search-input");
            })
            .addButton((buttonComponent) => {
                buttonComponent
                    .setIcon("plus")
                    .setTooltip("Add Folder To Script Roots")
                    .onClick(async () => {
                        await this.handleNewScriptRoot(searchBar);
                    });
            });

        this.plugin.settings.scriptRoots.forEach((root) => {
            const folderItem = new Setting(this.containerEl);
            const folderItemFragment = new DocumentFragment();
            const folderItemDiv = folderItemFragment.createDiv();
            folderItemDiv.addClasses(["datacore-settings-script-root", "setting-item-info"]);
            setIcon(folderItemDiv, "folder");
            folderItemDiv.createEl("h2", { text: root });
            folderItem.infoEl.replaceWith(folderItemFragment);
            folderItem.addButton((buttonComponent) => {
                buttonComponent
                    .setIcon("cross")
                    .setTooltip("Remove Folder from Script Roots")
                    .onClick(async () => {
                        await this.plugin.removeScriptRoots([root]);
                        this.display();
                    });
            });
        });

        this.containerEl.createEl("h2", { text: "Views" });

        new Setting(this.containerEl)
            .setName("Pagination")
            .setDesc(
                "If enabled, splits up views into pages of results which can be traversed " +
                    "via buttons at the top and bottom of the view. This substantially improves " +
                    "the performance of large views, and can help with visual clutter. Note that " +
                    "this setting can also be set on a per-view basis."
            )
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.defaultPagingEnabled).onChange(async (value) => {
                    await this.plugin.updateSettings({ defaultPagingEnabled: value });
                });
            });

        new Setting(this.containerEl)
            .setName("Default Page Size")
            .setDesc("The number of entries to show per page, by default. This can be overriden on a per-view basis.")
            .addDropdown((dropdown) => {
                const OPTIONS: Record<string, string> = {
                    "25": "25",
                    "50": "50",
                    "100": "100",
                    "200": "200",
                    "500": "500",
                };
                const current = "" + this.plugin.settings.defaultPageSize;
                if (!(current in OPTIONS)) OPTIONS[current] = current;

                dropdown
                    .addOptions(OPTIONS)
                    .setValue(current)
                    .onChange(async (value) => {
                        const parsed = parseFloat(value);
                        if (isNaN(parsed)) return;

                        await this.plugin.updateSettings({ defaultPageSize: parsed | 0 });
                    });
            });

        new Setting(this.containerEl)
            .setName("Scroll on Page Change")
            .setDesc(
                "If enabled, table that are paged will scroll to the top of the table when the page changes. " +
                    "This can be overriden on a per-view basis."
            )
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.scrollOnPageChange).onChange(async (value) => {
                    await this.plugin.updateSettings({ scrollOnPageChange: value });
                });
            });

        this.containerEl.createEl("h2", { text: "Formatting" });

        new Setting(this.containerEl)
            .setName("Empty Values")
            .setDesc("What to show for unset/empty properties.")
            .addText((text) => {
                text.setValue(this.plugin.settings.renderNullAs).onChange(async (value) => {
                    await this.plugin.updateSettings({ renderNullAs: value });
                });
            });

        new Setting(this.containerEl)
            .setName("Default Date Format")
            .setDesc(
                "The default format that dates are rendered in. Uses luxon date formatting (https://github.com/moment/luxon/blob/master/docs/formatting.md#formatting-with-tokens-strings-for-cthulhu)."
            )
            .addText((text) => {
                text.setValue(this.plugin.settings.defaultDateFormat).onChange(async (value) => {
                    // check if date format is valid
                    try {
                        DateTime.fromMillis(Date.now()).toFormat(value);
                    } catch {
                        return;
                    }
                    await this.plugin.updateSettings({ defaultDateFormat: value });
                });
            });

        new Setting(this.containerEl)
            .setName("Default Date-Time format")
            .setDesc(
                "The default format that date-times are rendered in. Uses luxon date formatting (https://github.com/moment/luxon/blob/master/docs/formatting.md#formatting-with-tokens-strings-for-cthulhu)."
            )
            .addText((text) => {
                text.setValue(this.plugin.settings.defaultDateTimeFormat).onChange(async (value) => {
                    try {
                        DateTime.fromMillis(Date.now()).toFormat(value);
                    } catch {
                        return;
                    }
                    await this.plugin.updateSettings({ defaultDateTimeFormat: value });
                });
            });

        this.containerEl.createEl("h2", { text: "Performance Tuning" });

        new Setting(this.containerEl)
            .setName("Inline Fields")
            .setDesc(
                "If enabled, inline fields will be parsed in all documents. Finding inline fields requires a full text scan through each document, " +
                    "which noticably slows down indexing for large vaults. Disabling this functionality will mean metadata will only come from tags, links, and " +
                    "Properties / frontmatter"
            )
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.indexInlineFields).onChange(async (value) => {
                    await this.plugin.updateSettings({ indexInlineFields: value });

                    // TODO: Request a full index drop + reindex for correctness.
                });
            });

        new Setting(this.containerEl)
            .setName("Importer Threads")
            .setDesc("The number of importer threads to use for parsing metadata.")
            .addText((text) => {
                text.setValue("" + this.plugin.settings.importerNumThreads).onChange(async (value) => {
                    const parsed = parseInt(value);
                    if (isNaN(parsed)) return;

                    await this.plugin.updateSettings({ importerNumThreads: parsed });
                });
            });

        new Setting(this.containerEl)
            .setName("Importer Utilization")
            .setDesc("How much CPU time each importer thread should use, as a fraction (0.1 - 1.0).")
            .addText((text) => {
                text.setValue(this.plugin.settings.importerUtilization.toFixed(2)).onChange(async (value) => {
                    const parsed = parseFloat(value);
                    if (isNaN(parsed)) return;

                    const limited = Math.max(0.1, Math.min(1.0, parsed));
                    await this.plugin.updateSettings({ importerUtilization: limited });
                });
            });

        new Setting(this.containerEl)
            .setName("Maximum Recursive Render Depth")
            .setDesc(
                "Maximum depth that objects will be rendered to (i.e., how many levels of subproperties " +
                    "will be rendered by default). This avoids infinite recursion due to self-referential objects " +
                    "and ensures that rendering objects is acceptably performant."
            )
            .addText((text) => {
                text.setValue(this.plugin.settings.maxRecursiveRenderDepth.toString()).onChange(async (value) => {
                    const parsed = parseInt(value);
                    if (isNaN(parsed)) return;
                    await this.plugin.updateSettings({ maxRecursiveRenderDepth: parsed });
                });
            });
    }
}
