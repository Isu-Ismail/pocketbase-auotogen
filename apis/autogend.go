package apis

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

func bindAutogendApi(_ core.App, rg *router.RouterGroup[*core.RequestEvent]) {
	sub := rg.Group("/autogend")
	sub.Bind(RequireSuperuserAuth())
	sub.POST("/generate", generateCollectionData)
}

type autogendGenerateRequest struct {
	Collection string `json:"collection"`
}

func generateCollectionData(e *core.RequestEvent) error {
	var req autogendGenerateRequest
	if err := e.BindBody(&req); err != nil {
		return e.BadRequestError("Invalid request body", err)
	}

	if req.Collection == "" {
		return e.BadRequestError("Collection name is required", nil)
	}

	col, err := e.App.FindCollectionByNameOrId(req.Collection)
	if err != nil {
		return e.NotFoundError(fmt.Sprintf("Collection %q not found", req.Collection), err)
	}

	// Fetch saved configs from PocketBase app settings (support both typed struct & raw meta map)
	settings := e.App.Settings()
	meta := settings.Meta
	configsMap := meta.AutogendConfigs

	// Fallback to unmarshaled settings map if AutogendConfigs is empty
	if configsMap == nil {
		rawSettingsStr := settings.String()
		var rawMap map[string]any
		if json.Unmarshal([]byte(rawSettingsStr), &rawMap) == nil {
			if metaMap, ok := rawMap["meta"].(map[string]any); ok {
				if autoMap, ok := metaMap["autogendConfigs"].(map[string]any); ok {
					configsMap = autoMap
				}
			}
		}
	}

	if configsMap == nil {
		return e.BadRequestError(fmt.Sprintf("No autogend configurations found for collection %q. Please click 'Save changes' first.", req.Collection), nil)
	}

	colConfigRaw, ok := configsMap[col.Name]
	if !ok || colConfigRaw == nil {
		return e.BadRequestError(fmt.Sprintf("No autogend configuration found for collection %q. Please click 'Save changes' first.", col.Name), nil)
	}

	// Marshal and Unmarshal into core.AutogendConfig struct
	configBytes, err := json.Marshal(colConfigRaw)
	if err != nil {
		return e.InternalServerError("Failed to parse collection autogend config", err)
	}

	var config core.AutogendConfig
	if err := json.Unmarshal(configBytes, &config); err != nil {
		return e.BadRequestError("Invalid autogend config format", err)
	}

	// Invoke core engine to generate record data maps
	recordsData, err := core.GenerateCollectionRecords(col, &config)
	if err != nil {
		return e.InternalServerError("Failed to generate collection records", err)
	}

	// Batch insert records inside a single database transaction using SaveNoValidate
	createdCount := 0
	err = e.App.RunInTransaction(func(txApp core.App) error {
		for _, recData := range recordsData {
			rec := core.NewRecord(col)

			// Populate record data fields
			for k, v := range recData {
				rec.Set(k, v)
			}

			// Save record to database without triggering client-side validation errors
			if err := txApp.SaveNoValidate(rec); err != nil {
				return fmt.Errorf("failed to create record: %w", err)
			}
			createdCount++
		}
		return nil
	})

	if err != nil {
		return e.InternalServerError(fmt.Sprintf("Failed during record batch creation (created %d): %v", createdCount, err), err)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"success":      true,
		"collection":   col.Name,
		"createdCount": createdCount,
		"message":      fmt.Sprintf("Successfully generated and inserted %d records for collection %q", createdCount, col.Name),
	})
}
