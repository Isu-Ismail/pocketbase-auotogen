import { settingsSidebar } from "../settingsSidebar";
import {
    renderBoolFieldCard,
    renderDateFieldCard,
    renderEmailFieldCard,
    renderFileFieldCard,
    renderGenericFieldCard,
    renderNumberFieldCard,
    renderPasswordFieldCard,
    renderSelectFieldCard,
    renderSystemFieldCard,
    renderTextFieldCard,
    renderUrlFieldCard,
} from "./autogendForms";
import {
    buildAutogendJSON,
    initDefaultFieldConfig,
    parseJSONToFieldConfigs,
    validateAutogendJSON,
} from "./autogendJsonParser";

export function pageAutogendSettings(route) {
    app.store.title = "Autogenerate Data";

    const uniqueId = "autogend_" + app.utils.randomString();

    const data = store({
        isLoading: false,
        isSaving: false,
        isGenerating: false,
        collections: [],
        selectedCollectionId: "",
        sampleCount: 100,

        // Mode: 'ui' or 'json'
        viewMode: "ui",

        // Field settings state
        fieldConfigs: {},

        // Two-way JSON config string in JSON mode
        customJSONConfig: "",
        jsonErrors: [],

        // Saved configurations in PocketBase settings
        savedAutogendConfigs: {},
        initialConfigHash: "",

        get selectedCollection() {
            return data.collections.find((c) => c.id === data.selectedCollectionId) || null;
        },

        get generatedJSONPreview() {
            if (!data.selectedCollection) return "{}";
            const obj = buildAutogendJSON(data.selectedCollection, data.sampleCount, data.fieldConfigs);
            return JSON.stringify(obj, null, 2);
        },

        get currentConfigHash() {
            return JSON.stringify({
                colId: data.selectedCollectionId,
                sample: data.sampleCount,
                configs: data.fieldConfigs,
            });
        },

        get isNewUnsavedCollection() {
            if (!data.selectedCollection) return false;
            return !data.savedAutogendConfigs[data.selectedCollection.name];
        },

        get hasChanges() {
            return data.isNewUnsavedCollection || data.initialConfigHash !== data.currentConfigHash;
        },

        get canGenerate() {
            return !data.isLoading && !data.isGenerating && data.jsonErrors.length === 0 && data.selectedCollection;
        },
    });

    loadData();

    async function loadData() {
        data.isLoading = true;
        try {
            const [settings, collections] = await Promise.all([
                app.pb.settings.getAll(),
                app.pb.collections.getFullList({ requestKey: uniqueId }),
            ]);

            app.store.settings = JSON.parse(JSON.stringify(settings));
            data.savedAutogendConfigs = settings?.meta?.autogendConfigs || {};

            const userCols = collections.filter((c) => !c.system);
            data.collections = app.utils.sortedCollectionsByType(userCols);

            if (data.collections.length > 0) {
                selectCollection(data.collections[0].id);
            }

            data.isLoading = false;
        } catch (err) {
            if (!err.isAbort) {
                app.checkApiError(err);
                data.isLoading = false;
            }
        }
    }

    function selectCollection(id) {
        data.selectedCollectionId = id;
        const col = data.collections.find((c) => c.id === id);
        if (!col) return;

        const savedConfig = data.savedAutogendConfigs[col.name];

        if (savedConfig && savedConfig.fields) {
            data.sampleCount = savedConfig.sampleCount || 100;
            const res = parseJSONToFieldConfigs(savedConfig, col, data.fieldConfigs);
            data.fieldConfigs = res.fieldConfigs;
        } else {
            const newConfigs = {};
            for (const field of col.fields || []) {
                newConfigs[field.id] = initDefaultFieldConfig(field);
            }
            data.fieldConfigs = newConfigs;
        }

        data.customJSONConfig = data.generatedJSONPreview;
        data.jsonErrors = [];
        validateCurrentConfig();
        data.initialConfigHash = data.currentConfigHash;
    }

    function switchViewMode(mode) {
        if (mode === "json") {
            data.customJSONConfig = data.generatedJSONPreview;
            validateJSONAndSync();
        } else if (mode === "ui") {
            validateJSONAndSync();
        }
        data.viewMode = mode;
    }

    function validateJSONAndSync() {
        const valRes = validateAutogendJSON(data.customJSONConfig, data.selectedCollection);
        data.jsonErrors = valRes.errors;

        if (valRes.isValid && valRes.parsedConfig) {
            const res = parseJSONToFieldConfigs(valRes.parsedConfig, data.selectedCollection, data.fieldConfigs);
            if (res.sampleCount) {
                data.sampleCount = res.sampleCount;
            }
            data.fieldConfigs = res.fieldConfigs;
        }
        return valRes.isValid;
    }

    function validateCurrentConfig() {
        data.customJSONConfig = data.generatedJSONPreview;
        validateJSONAndSync();
    }

    async function saveSettings() {
        if (data.isSaving || data.jsonErrors.length > 0) return;

        data.isSaving = true;
        try {
            const currentConfigObj = buildAutogendJSON(data.selectedCollection, data.sampleCount, data.fieldConfigs);
            const currentSettings = JSON.parse(JSON.stringify(app.store.settings || {}));

            currentSettings.meta = currentSettings.meta || {};
            currentSettings.meta.autogendConfigs = currentSettings.meta.autogendConfigs || {};
            currentSettings.meta.autogendConfigs[data.selectedCollection.name] = currentConfigObj;

            const redacted = app.utils.filterRedactedProps(currentSettings);
            const updated = await app.pb.settings.update(redacted);

            app.store.settings = JSON.parse(JSON.stringify(updated));
            data.savedAutogendConfigs = updated?.meta?.autogendConfigs || {};
            data.initialConfigHash = data.currentConfigHash;

            app.toasts.success(`Successfully saved autogen rules for "${data.selectedCollection.name}"`);
        } catch (err) {
            app.checkApiError(err);
        }
        data.isSaving = false;
    }

    async function generateData() {
        if (!data.canGenerate) return;

        // Auto save before generation if changes or new unsaved collection
        if (data.hasChanges) {
            await saveSettings();
        }

        data.isGenerating = true;
        try {
            const res = await app.pb.send("/api/autogend/generate", {
                method: "POST",
                body: { collection: data.selectedCollection.name },
            });

            app.toasts.success(res.message || `Successfully generated ${res.createdCount} records!`);
        } catch (err) {
            app.checkApiError(err);
        }
        data.isGenerating = false;
    }

    function resetForm() {
        selectCollection(data.selectedCollectionId);
    }

    // Smart weight balancer algorithm ensuring sum <= 100% and auto-balancing last variation
    function balanceVariationsWeights(variations, changedIndex, newWeight) {
        if (!variations || variations.length === 0) return;

        let parsed = Math.min(100, Math.max(0, Math.floor(Number(newWeight) || 0)));
        variations[changedIndex].weight = parsed;

        if (variations.length === 1) {
            variations[0].weight = 100;
            return;
        }

        // Calculate sum of all non-last items (or items up to the last manually edited item)
        let sumOtherExplicit = 0;
        const lastIdx = variations.length - 1;

        for (let i = 0; i < variations.length; i++) {
            if (i !== lastIdx) {
                sumOtherExplicit += Math.floor(Number(variations[i].weight) || 0);
            }
        }

        if (sumOtherExplicit > 100) {
            // Cap changed input so total cannot exceed 100%
            const maxAllowed = 100 - (sumOtherExplicit - parsed);
            variations[changedIndex].weight = Math.max(0, maxAllowed);
            variations[lastIdx].weight = 0;
        } else {
            // Automatically balance the last variation to make total sum exactly 100%
            variations[lastIdx].weight = Math.max(0, 100 - sumOtherExplicit);
        }
    }

    // Action Handlers passed to modular field form builders
    const handlers = {
        addVariation: (fieldId, defaultOptValue = "") => {
            const conf = data.fieldConfigs[fieldId];
            if (!conf) return;
            const val = defaultOptValue || `Variation ${conf.variations.length + 1}`;
            conf.variations.push({ value: val, weight: 0 });

            // Re-balance equal weights by default upon adding
            const equalShare = Math.floor(100 / conf.variations.length);
            conf.variations.forEach((v, idx) => {
                v.weight = idx === conf.variations.length - 1 ? 100 - (equalShare * (conf.variations.length - 1)) : equalShare;
            });

            data.fieldConfigs = Object.assign({}, data.fieldConfigs);
            validateCurrentConfig();
        },

        removeVariation: (fieldId, index) => {
            const conf = data.fieldConfigs[fieldId];
            if (!conf || conf.variations.length <= 1) return;
            conf.variations.splice(index, 1);

            // Re-balance remaining variations
            const equalShare = Math.floor(100 / conf.variations.length);
            conf.variations.forEach((v, idx) => {
                v.weight = idx === conf.variations.length - 1 ? 100 - (equalShare * (conf.variations.length - 1)) : equalShare;
            });

            data.fieldConfigs = Object.assign({}, data.fieldConfigs);
            validateCurrentConfig();
        },

        updateVariationValue: (fieldId, index, val) => {
            const conf = data.fieldConfigs[fieldId];
            if (!conf) return;
            conf.variations[index].value = val;
            data.fieldConfigs = Object.assign({}, data.fieldConfigs);
            validateCurrentConfig();
        },

        updateVariationWeight: (fieldId, index, weight) => {
            const conf = data.fieldConfigs[fieldId];
            if (!conf) return;
            balanceVariationsWeights(conf.variations, index, weight);
            data.fieldConfigs = Object.assign({}, data.fieldConfigs);
            validateCurrentConfig();
        },

        toggleDistribution: (fieldId, dist) => {
            const conf = data.fieldConfigs[fieldId];
            if (!conf) return;
            conf.distribution = dist;
            if (dist === "manual" && conf.variations && conf.variations.length > 0) {
                const equalShare = Math.floor(100 / conf.variations.length);
                conf.variations.forEach((v, idx) => {
                    v.weight = idx === conf.variations.length - 1 ? 100 - (equalShare * (conf.variations.length - 1)) : equalShare;
                });
            }
            data.fieldConfigs = Object.assign({}, data.fieldConfigs);
            validateCurrentConfig();
        },

        toggleUniqueSalt: (fieldId, checked) => {
            const conf = data.fieldConfigs[fieldId];
            if (!conf) return;
            conf.uniqueSalt = checked;
            data.fieldConfigs = Object.assign({}, data.fieldConfigs);
            validateCurrentConfig();
        },

        updateFieldPattern: (fieldId, pattern) => {
            const conf = data.fieldConfigs[fieldId];
            if (!conf) return;
            conf.pattern = pattern;
            data.fieldConfigs = Object.assign({}, data.fieldConfigs);
            validateCurrentConfig();
        },

        updateDefaultValue: (fieldId, val) => {
            const conf = data.fieldConfigs[fieldId];
            if (!conf) return;
            conf.defaultValue = val;
            data.fieldConfigs = Object.assign({}, data.fieldConfigs);
            validateCurrentConfig();
        },

        updateNumberType: (fieldId, type) => {
            const conf = data.fieldConfigs[fieldId];
            if (!conf) return;
            conf.numberType = type;
            data.fieldConfigs = Object.assign({}, data.fieldConfigs);
            validateCurrentConfig();
        },

        updateNumberRange: (fieldId, min, max) => {
            const conf = data.fieldConfigs[fieldId];
            if (!conf) return;
            conf.min = Math.floor(Number(min) || 0);
            conf.max = Math.floor(Number(max) || 0);
            data.fieldConfigs = Object.assign({}, data.fieldConfigs);
            validateCurrentConfig();
        },

        updateFileExtension: (fieldId, ext) => {
            const conf = data.fieldConfigs[fieldId];
            if (!conf) return;
            conf.fileExtension = ext;
            data.fieldConfigs = Object.assign({}, data.fieldConfigs);
            validateCurrentConfig();
        },

        addSampleFile: (fieldId, fileObj) => {
            const conf = data.fieldConfigs[fieldId];
            if (!conf) return;
            conf.sampleFiles = conf.sampleFiles || [];
            if (conf.sampleFiles.length >= 5) return;
            conf.sampleFiles.push(fileObj);
            data.fieldConfigs = Object.assign({}, data.fieldConfigs);
            validateCurrentConfig();
        },

        removeSampleFile: (fieldId, index) => {
            const conf = data.fieldConfigs[fieldId];
            if (!conf || !conf.sampleFiles) return;
            conf.sampleFiles.splice(index, 1);
            data.fieldConfigs = Object.assign({}, data.fieldConfigs);
            validateCurrentConfig();
        },

        toggleDateMode: (fieldId, mode) => {
            const conf = data.fieldConfigs[fieldId];
            if (!conf) return;
            conf.dateMode = mode;
            if (mode === "range" && (!conf.dateRanges || conf.dateRanges.length === 0)) {
                const nowStr = new Date().toISOString().slice(0, 16);
                const prevStr = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16);
                conf.dateRanges = [{ from: prevStr, to: nowStr, weight: 100 }];
            }
            data.fieldConfigs = Object.assign({}, data.fieldConfigs);
            validateCurrentConfig();
        },

        addDateRangePair: (fieldId) => {
            const conf = data.fieldConfigs[fieldId];
            if (!conf) return;
            conf.dateRanges = conf.dateRanges || [];
            const nowStr = new Date().toISOString().slice(0, 16);
            const prevStr = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16);
            conf.dateRanges.push({ from: prevStr, to: nowStr, weight: 0 });

            // Re-balance date range weights to total 100
            const equalShare = Math.floor(100 / conf.dateRanges.length);
            conf.dateRanges.forEach((r, idx) => {
                r.weight = idx === conf.dateRanges.length - 1 ? 100 - (equalShare * (conf.dateRanges.length - 1)) : equalShare;
            });

            data.fieldConfigs = Object.assign({}, data.fieldConfigs);
            validateCurrentConfig();
        },

        removeDateRangePair: (fieldId, index) => {
            const conf = data.fieldConfigs[fieldId];
            if (!conf || !conf.dateRanges || conf.dateRanges.length <= 1) return;
            conf.dateRanges.splice(index, 1);

            const equalShare = Math.floor(100 / conf.dateRanges.length);
            conf.dateRanges.forEach((r, idx) => {
                r.weight = idx === conf.dateRanges.length - 1 ? 100 - (equalShare * (conf.dateRanges.length - 1)) : equalShare;
            });

            data.fieldConfigs = Object.assign({}, data.fieldConfigs);
            validateCurrentConfig();
        },

        updateDateRangePair: (fieldId, index, from, to, weight) => {
            const conf = data.fieldConfigs[fieldId];
            if (!conf || !conf.dateRanges) return;
            conf.dateRanges[index] = {
                from: from,
                to: to,
                weight: Number(weight) || 0,
            };
            balanceVariationsWeights(conf.dateRanges, index, weight);
            data.fieldConfigs = Object.assign({}, data.fieldConfigs);
            validateCurrentConfig();
        },
    };

    /**
     * Renders appropriate card for a field depending on its type and system status
     */
    function renderFieldCard(field) {
        const conf = data.fieldConfigs[field.id] || initDefaultFieldConfig(field);

        // 1. Strictly system autogenerated fields
        const isStrictSystemAuto = (field.system && (field.name === "id" || field.name === "tokenKey"))
            || field.primaryKey;

        if (isStrictSystemAuto) {
            return renderSystemFieldCard(field);
        }

        // 2. Date / Timestamp fields
        if (field.type === "date" || field.type === "autodate" || field.name === "created" || field.name === "updated") {
            return renderDateFieldCard(field, conf, handlers, uniqueId);
        }

        // 3. Email field type
        if (field.type === "email" || field.name === "email") {
            return renderEmailFieldCard(field, conf, handlers, uniqueId);
        }

        // 4. URL field type
        if (field.type === "url" || field.name === "website") {
            return renderUrlFieldCard(field, conf, handlers, uniqueId);
        }

        // 4. Password field type
        if (field.type === "password" || field.name === "password") {
            return renderPasswordFieldCard(field, conf, handlers, uniqueId);
        }

        // 5. File field type
        if (field.type === "file") {
            return renderFileFieldCard(field, conf, handlers, uniqueId);
        }

        // 6. Bool field type (Max 2 variations: true / false)
        if (field.type === "bool") {
            return renderBoolFieldCard(field, conf, handlers, uniqueId);
        }

        // 7. Number field type
        if (field.type === "number") {
            return renderNumberFieldCard(field, conf, handlers, uniqueId);
        }

        // 8. Select field type
        if (field.type === "select") {
            return renderSelectFieldCard(field, conf, handlers, uniqueId);
        }

        // 9. Text / String field types
        if (field.type === "text" || field.type === "editor") {
            return renderTextFieldCard(field, conf, handlers, uniqueId);
        }

        // 10. Generic field types
        return renderGenericFieldCard(field, conf, handlers, uniqueId);
    }

    return t.div(
        {
            pbEvent: "pageAutogendSettings",
            className: "page page-autogend-settings",
        },
        settingsSidebar(),
        t.div(
            { className: "page-content full-height" },
            t.header(
                { className: "page-header" },
                t.nav(
                    { className: "breadcrumbs" },
                    t.div({ className: "breadcrumb-item" }, "Settings"),
                    t.div({ className: "breadcrumb-item" }, () => app.store.title),
                ),
            ),
            t.div({ className: "wrapper m-b-base" }, () => {
                if (data.isLoading) {
                    return t.div({ className: "txt-center p-30" }, t.span({ className: "loader lg" }));
                }

                if (!data.collections.length) {
                    return t.div(
                        { className: "panel txt-center p-30" },
                        t.div({ className: "txt-lg m-b-sm" }, "No non-system collections found"),
                        t.p({ className: "txt-hint" }, "Please create a user collection first."),
                    );
                }

                return t.div(
                    { className: "autogend-container" },

                    // Top Bar Header
                    t.div(
                        { className: "autogend-top-bar" },
                        t.div(
                            { className: "top-controls-group" },
                            t.div(
                                { className: "field flex-2" },
                                t.label({ className: "txt-bold" }, "Select Target Collection"),
                                t.select(
                                    {
                                        className: "select",
                                        value: () => data.selectedCollectionId,
                                        onchange: (e) => selectCollection(e.target.value),
                                    },
                                    () => {
                                        return data.collections.map((col) =>
                                            t.option({ value: col.id }, `${col.name} (${col.type})`)
                                        );
                                    },
                                ),
                            ),
                            t.div(
                                { className: "field flex-1" },
                                t.label({ className: "txt-bold" }, "Sample Count"),
                                t.input({
                                    type: "number",
                                    className: "input",
                                    min: 1,
                                    max: 10000,
                                    step: 1,
                                    value: () => data.sampleCount,
                                    onchange: (e) => {
                                        data.sampleCount = Math.max(1, Math.floor(Number(e.target.value) || 100));
                                        validateCurrentConfig();
                                    },
                                }),
                            ),
                        ),
                        t.div(
                            { className: "pill-mode-switcher" },
                            t.button(
                                {
                                    type: "button",
                                    className: () => `pill-item ${data.viewMode === "ui" ? "active" : ""}`,
                                    onclick: () => switchViewMode("ui"),
                                },
                                t.i({ className: "ri-options-line" }),
                                t.span({}, "UI Form Rules"),
                            ),
                            t.button(
                                {
                                    type: "button",
                                    className: () => `pill-item ${data.viewMode === "json" ? "active" : ""}`,
                                    onclick: () => switchViewMode("json"),
                                },
                                t.i({ className: "ri-code-s-slash-line" }),
                                t.span({}, "JSON Spec"),
                            ),
                        ),
                    ),

                    // Main Panel
                    t.div(
                        { className: "autogend-panel-full m-b-base" },

                        // Unsaved Default Config Notification Banner
                        () => {
                            if (!data.isNewUnsavedCollection) return null;

                            return t.div(
                                { className: "alert alert-warning m-b-lg flex align-center justify-between" },
                                t.div(
                                    { className: "flex align-center gap-10" },
                                    t.i({ className: "ri-information-line txt-lg" }),
                                    t.div(
                                        {},
                                        t.div({ className: "txt-bold" }, `Unsaved Default Rules for "${data.selectedCollection?.name}"`),
                                        t.div({ className: "txt-sm" }, "Default autogenerator rules have been pre-filled below. Click 'Save changes' to store them."),
                                    ),
                                ),
                                t.button(
                                    {
                                        type: "button",
                                        className: `btn sm primary ${data.isSaving ? "loading" : ""}`,
                                        disabled: () => data.isSaving,
                                        onclick: saveSettings,
                                    },
                                    t.span({ className: "txt" }, "Save default rules"),
                                ),
                            );
                        },

                        // Validation Errors Banner inside panel above Section Header
                        () => {
                            if (!data.jsonErrors.length) return null;
                            return t.div(
                                { className: "alert alert-danger m-b-lg" },
                                t.div({ className: "txt-bold m-b-xs" }, "Validation Errors:"),
                                t.ul(
                                    { className: "m-0 p-l-20" },
                                    data.jsonErrors.map((err) => t.li({}, err)),
                                ),
                            );
                        },

                        // VIEW MODE 1: UI Form Rules View
                        () => {
                            if (data.viewMode !== "ui") return null;

                            const fields = data.selectedCollection?.fields || [];

                            return t.div(
                                { className: "ui-rules-wrapper" },

                                // Section Title Bar with Primary "Generate Data" Action Button
                                t.div(
                                    { className: "section-title-bar" },
                                    t.div(
                                        { className: "title-left" },
                                        t.h3({}, "Field Generator Rules"),
                                        t.span({ className: "badge-count" }, () => `${fields.length} fields`),
                                    ),
                                    t.button(
                                        {
                                            type: "button",
                                            className: () => `btn primary ${data.isGenerating ? "loading" : ""}`,
                                            disabled: () => !data.canGenerate,
                                            onclick: generateData,
                                        },
                                        t.i({ className: "ri-magic-line" }),
                                        t.span({ className: "txt" }, () =>
                                            data.isGenerating
                                                ? "Generating Data..."
                                                : `Generate ${data.sampleCount} Records`,
                                        ),
                                    ),
                                ),

                                t.div(
                                    { className: "fields-stack" },
                                    () => fields.map((field) => renderFieldCard(field)),
                                ),
                            );
                        },

                        // VIEW MODE 2: JSON Config Editor View
                        () => {
                            if (data.viewMode !== "json") return null;

                            return t.div(
                                { className: "json-rules-wrapper" },
                                t.div(
                                    { className: "section-title-bar" },
                                    t.div(
                                        { className: "title-left" },
                                        t.h3({}, "Editable JSON Configuration"),
                                    ),
                                    t.div(
                                        { className: "flex align-center gap-10" },
                                        app.components.copyButton(() => data.customJSONConfig),
                                        t.button(
                                            {
                                                type: "button",
                                                className: () => `btn primary ${data.isGenerating ? "loading" : ""}`,
                                                disabled: () => !data.canGenerate,
                                                onclick: generateData,
                                            },
                                            t.i({ className: "ri-magic-line" }),
                                            t.span({ className: "txt" }, () =>
                                                data.isGenerating
                                                    ? "Generating Data..."
                                                    : `Generate ${data.sampleCount} Records`,
                                            ),
                                        ),
                                    ),
                                ),
                                t.div(
                                    { className: "field" },
                                    t.textarea({
                                        className: "input json-editor-textarea",
                                        spellcheck: false,
                                        autocorrect: "off",
                                        autocapitalize: "off",
                                        value: () => data.customJSONConfig,
                                        oninput: (e) => {
                                            data.customJSONConfig = e.target.value;
                                            validateJSONAndSync();
                                        },
                                    }),
                                ),
                            );
                        },
                    ),

                    // Save / Cancel Action Bar
                    () => {
                        if (!data.hasChanges) return null;

                        return t.div(
                            { className: "flex justify-end gap-10 m-t-base" },
                            t.button(
                                {
                                    type: "button",
                                    className: "btn transparent secondary",
                                    onclick: resetForm,
                                },
                                t.span({ className: "txt" }, "Cancel"),
                            ),
                            t.button(
                                {
                                    type: "button",
                                    className: () => `btn expanded-lg ${data.isSaving ? "loading" : ""}`,
                                    disabled: () => !data.hasChanges || data.isSaving || data.jsonErrors.length > 0,
                                    onclick: saveSettings,
                                },
                                t.span({ className: "txt" }, "Save changes"),
                            ),
                        );
                    },
                );
            }),
            t.footer({ className: "page-footer" }, app.components.credits()),
        ),
    );
}
