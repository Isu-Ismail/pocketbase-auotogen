/**
 * autogendJsonParser.js
 *
 * Single Source of Truth helper for Autogen JSON specifications.
 * Handles generation from UI state, parsing into UI state, and cross-validation against collection schema.
 */

/**
 * Builds default field configuration for a schema field
 */
export function initDefaultFieldConfig(field) {
    if (field.name === "password" || field.type === "password") {
        return {
            mode: "pattern",
            pattern: "1234567890",
            variations: [],
            distribution: "equal",
            uniqueSalt: false,
        };
    }

    if (field.name === "email" || field.type === "email") {
        return {
            mode: "pattern",
            pattern: "user[1-1000]@example.com",
            variations: [],
            distribution: "equal",
            uniqueSalt: false,
        };
    }

    if (field.type === "date" || field.type === "autodate" || field.name === "created" || field.name === "updated") {
        const nowStr = new Date().toISOString().slice(0, 16);
        const prevStr = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16);
        return {
            mode: "date",
            dateMode: "action_time", // 'action_time' or 'range'
            dateRanges: [
                { from: prevStr, to: nowStr, weight: 50 },
            ],
            distribution: "equal",
            uniqueSalt: false,
        };
    }

    if (field.type === "bool") {
        return {
            mode: "variations",
            variations: [
                { value: "true", weight: 50 },
                { value: "false", weight: 50 },
            ],
            distribution: "equal",
            uniqueSalt: false,
        };
    }

    if (field.type === "number") {
        return {
            mode: "range",
            numberType: field.onlyInt ? "int" : "int",
            min: field.min !== null && field.min !== undefined ? field.min : 20,
            max: field.max !== null && field.max !== undefined ? field.max : 30,
            variations: [],
            distribution: "equal",
            uniqueSalt: false,
        };
    }

    if (field.type === "file") {
        const mimeTypes = field.mimeTypes || [];
        return {
            mode: "file",
            fileExtension: mimeTypes.length ? mimeTypes.join(", ") : "pdf",
            sampleFiles: [],
            distribution: "equal",
            uniqueSalt: false,
        };
    }

    if (field.type === "select") {
        const availableOptions = field.values || field.options || [];
        const firstOpt = availableOptions[0] || "";
        const secondOpt = availableOptions[1] || firstOpt;

        return {
            mode: "variations",
            variations: [
                { value: firstOpt, weight: 50 },
                { value: secondOpt, weight: 50 },
            ].filter((v) => v.value !== ""),
            distribution: "equal",
            uniqueSalt: false,
        };
    }

    const defaultPattern = field.autogeneratePattern || `Sample ${field.name} [1-100]`;
    const isTextField = field.type === "text" || field.type === "editor";

    return {
        mode: isTextField ? "pattern" : "variations",
        pattern: defaultPattern,
        variations: [
            { value: `Sample ${field.name} 1`, weight: 50 },
            { value: `Sample ${field.name} 2`, weight: 50 },
        ],
        distribution: "equal",
        uniqueSalt: field.name === "id" || field.name === "email" || field.primaryKey || field.unique || false,
    };
}

/**
 * Generates the JSON specification object from UI state
 */
export function buildAutogendJSON(collection, sampleCount, fieldConfigs) {
    if (!collection) return {};

    const config = {
        collection: collection.name,
        collectionId: collection.id,
        sampleCount: Number(sampleCount) || 100,
        fields: {},
    };

    const fields = collection.fields || [];
    for (const field of fields) {
        const fieldConf = fieldConfigs[field.id] || initDefaultFieldConfig(field);

        const isStrictSystemAuto = (field.system && (field.name === "id" || field.name === "tokenKey"))
            || field.primaryKey;

        if (isStrictSystemAuto) {
            config.fields[field.name] = {
                type: field.type,
                system: true,
                autogenerate: true,
            };
        } else if (field.type === "date" || field.type === "autodate" || field.name === "created" || field.name === "updated" || fieldConf.mode === "date") {
            if (fieldConf.dateMode === "range") {
                config.fields[field.name] = {
                    type: field.type,
                    dateMode: "range",
                    dateRanges: fieldConf.dateRanges || [],
                    distribution: fieldConf.distribution || "equal",
                };
            } else {
                config.fields[field.name] = {
                    type: field.type,
                    dateMode: "action_time",
                    autogenerateActionTime: true,
                };
            }
        } else if (field.type === "file" || fieldConf.mode === "file") {
            config.fields[field.name] = {
                type: field.type,
                required: !!field.required,
                fileExtension: fieldConf.fileExtension || "pdf",
                sampleFilesCount: fieldConf.sampleFiles ? fieldConf.sampleFiles.length : 0,
                sampleFiles: fieldConf.sampleFiles || [],
                maxSizePerFileBytes: 512000,
            };
        } else if (field.type === "number" || fieldConf.mode === "range") {
            config.fields[field.name] = {
                type: field.type,
                required: !!field.required,
                numberType: fieldConf.numberType || "int",
                min: Number(fieldConf.min) || 0,
                max: Number(fieldConf.max) || 100,
                autogenerateRange: true,
            };
        } else if (fieldConf.mode === "pattern") {
            config.fields[field.name] = {
                type: field.type,
                required: !!field.required,
                unique: !!field.unique,
                system: !!field.system,
                defaultValue: fieldConf.defaultValue || "",
                pattern: fieldConf.pattern || (field.name === "email" ? "user[1-1000]@example.com" : `Sample ${field.name} [1-100]`),
                uniqueSalt: fieldConf.uniqueSalt,
            };
        } else {
            config.fields[field.name] = {
                type: field.type,
                required: !!field.required,
                unique: !!field.unique,
                system: !!field.system,
                variations: fieldConf.variations,
                distribution: fieldConf.distribution,
                uniqueSalt: fieldConf.uniqueSalt,
            };
        }
    }

    return config;
}

/**
 * Cross-validates a JSON string against a PocketBase collection schema.
 * Returns { isValid: boolean, errors: string[], parsedConfig: object|null }
 */
export function validateAutogendJSON(jsonString, collection) {
    const result = {
        isValid: true,
        errors: [],
        parsedConfig: null,
    };

    if (!jsonString) {
        result.isValid = false;
        result.errors.push("Empty JSON configuration string.");
        return result;
    }

    try {
        result.parsedConfig = JSON.parse(jsonString);
    } catch (e) {
        result.isValid = false;
        result.errors.push("Syntax Error: Invalid JSON format (" + e.message + ")");
        return result;
    }

    const parsed = result.parsedConfig;

    if (!collection) {
        return result;
    }

    const tableFields = collection.fields || [];
    const tableFieldMap = {};
    for (const f of tableFields) {
        tableFieldMap[f.name] = f;
    }

    if (parsed.collection && parsed.collection !== collection.name) {
        result.errors.push(
            `Collection mismatch: JSON specifies collection "${parsed.collection}" but target is "${collection.name}"`,
        );
    }

    if (parsed.sampleCount !== undefined) {
        if (typeof parsed.sampleCount !== "number" || parsed.sampleCount < 1) {
            result.errors.push("Invalid sampleCount: Must be a positive number.");
        }
    }

    if (parsed.fields && typeof parsed.fields === "object") {
        const jsonFieldNames = Object.keys(parsed.fields);

        for (const fname of jsonFieldNames) {
            if (!tableFieldMap[fname]) {
                result.errors.push(`Unknown field: "${fname}" in JSON does not exist in collection "${collection.name}".`);
            }
        }

        for (const tf of tableFields) {
            if (tf.required && !parsed.fields[tf.name]) {
                result.errors.push(`Missing required field: Table requires field "${tf.name}" but it is omitted in JSON spec.`);
            }
        }

        for (const tf of tableFields) {
            if (parsed.fields[tf.name]) {
                const jsonF = parsed.fields[tf.name];

                if (jsonF.type && jsonF.type !== tf.type) {
                    result.errors.push(
                        `Type mismatch on field "${tf.name}": Table expects "${tf.type}" but JSON specifies "${jsonF.type}".`,
                    );
                }

                if (tf.name === "password" || tf.type === "password") {
                    if (jsonF.pattern && jsonF.pattern.length < 8 && !jsonF.pattern.includes("[")) {
                        result.errors.push(`Password field "${tf.name}" must be at least 8 characters long.`);
                    }
                }

                if (jsonF.type === "file") {
                    if (jsonF.sampleFiles && jsonF.sampleFiles.length > 5) {
                        result.errors.push(`File field "${tf.name}" exceeds maximum allowed limit of 5 sample files.`);
                    }
                    if (Array.isArray(jsonF.sampleFiles)) {
                        for (const sfile of jsonF.sampleFiles) {
                            if (sfile.size && sfile.size > 512000) {
                                result.errors.push(`Sample file "${sfile.name}" in field "${tf.name}" exceeds 500KB size limit.`);
                            }
                        }
                    }
                } else if (!jsonF.system && !jsonF.pattern && !jsonF.autogenerateRange && !jsonF.autogenerateActionTime) {
                    if (jsonF.dateMode === "range") {
                        if (!Array.isArray(jsonF.dateRanges) || jsonF.dateRanges.length === 0) {
                            result.errors.push(`Date field "${tf.name}" must have at least one From - To range defined.`);
                        }
                    } else if (!Array.isArray(jsonF.variations) || jsonF.variations.length === 0) {
                        result.errors.push(`Field "${tf.name}" must have at least one variation, pattern, or date range defined.`);
                    }
                }
            }
        }
    } else {
        result.errors.push('Missing "fields" object in JSON specification.');
    }

    result.isValid = result.errors.length === 0;
    return result;
}

/**
 * Parses a validated JSON object back into UI fieldConfigs and sampleCount state.
 */
export function parseJSONToFieldConfigs(parsedConfig, collection, currentFieldConfigs) {
    const updatedConfigs = Object.assign({}, currentFieldConfigs);
    let sampleCount = parsedConfig.sampleCount;

    if (parsedConfig.fields && collection) {
        const fields = collection.fields || [];
        for (const field of fields) {
            if (parsedConfig.fields[field.name]) {
                const jsonF = parsedConfig.fields[field.name];

                if (field.type === "date" || field.type === "autodate" || field.name === "created" || field.name === "updated" || jsonF.dateMode !== undefined) {
                    const nowStr = new Date().toISOString().slice(0, 16);
                    const prevStr = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16);

                    updatedConfigs[field.id] = {
                        mode: "date",
                        dateMode: jsonF.dateMode || "action_time",
                        dateRanges: jsonF.dateRanges || [{ from: prevStr, to: nowStr, weight: 50 }],
                        distribution: jsonF.distribution || "equal",
                        uniqueSalt: false,
                    };
                } else if (field.type === "file" || jsonF.fileExtension !== undefined) {
                    updatedConfigs[field.id] = {
                        mode: "file",
                        fileExtension: jsonF.fileExtension || "pdf",
                        sampleFiles: jsonF.sampleFiles || [],
                        distribution: "equal",
                        uniqueSalt: false,
                    };
                } else if (field.type === "number" || jsonF.min !== undefined) {
                    updatedConfigs[field.id] = {
                        mode: "range",
                        numberType: jsonF.numberType || "int",
                        min: jsonF.min !== undefined ? jsonF.min : 20,
                        max: jsonF.max !== undefined ? jsonF.max : 30,
                        variations: [],
                        distribution: "equal",
                        uniqueSalt: false,
                    };
                } else if (jsonF.pattern !== undefined || jsonF.defaultValue !== undefined) {
                    updatedConfigs[field.id] = {
                        mode: "pattern",
                        defaultValue: jsonF.defaultValue || "",
                        pattern: jsonF.pattern || "",
                        variations: jsonF.variations || [],
                        distribution: jsonF.distribution || "equal",
                        uniqueSalt: !!jsonF.uniqueSalt,
                    };
                } else {
                    updatedConfigs[field.id] = {
                        mode: "variations",
                        pattern: "",
                        variations: jsonF.variations || [],
                        distribution: jsonF.distribution || "equal",
                        uniqueSalt: !!jsonF.uniqueSalt,
                    };
                }
            }
        }
    }

    return {
        sampleCount,
        fieldConfigs: updatedConfigs,
    };
}
