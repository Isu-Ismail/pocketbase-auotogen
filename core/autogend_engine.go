package core

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/tools/types"
)

// AutogendConfig represents the full JSON configuration for a collection
type AutogendConfig struct {
	Collection   string                       `json:"collection"`
	CollectionID string                       `json:"collectionId"`
	SampleCount  int                          `json:"sampleCount"`
	Fields       map[string]AutogendFieldRule `json:"fields"`
}

// AutogendFieldRule represents rules for generating values for a specific field
type AutogendFieldRule struct {
	Type                   string              `json:"type"`
	System                 bool                `json:"system,omitempty"`
	Autogenerate           bool                `json:"autogenerate,omitempty"`
	Required               bool                `json:"required,omitempty"`
	Unique                 bool                `json:"unique,omitempty"`
	DefaultValue           string              `json:"defaultValue,omitempty"`
	Pattern                string              `json:"pattern,omitempty"`
	NumberType             string              `json:"numberType,omitempty"` // "int" or "float"
	Min                    float64             `json:"min,omitempty"`
	Max                    float64             `json:"max,omitempty"`
	AutogenerateRange      bool                `json:"autogenerateRange,omitempty"`
	Variations             []AutogendVariation `json:"variations,omitempty"`
	Distribution           string              `json:"distribution,omitempty"`
	UniqueSalt             bool                `json:"uniqueSalt,omitempty"`
	FileExtension          string              `json:"fileExtension,omitempty"`
	SampleFilesCount       int                 `json:"sampleFilesCount,omitempty"`
	DateMode               string              `json:"dateMode,omitempty"`
	AutogenerateActionTime bool                `json:"autogenerateActionTime,omitempty"`
	DateRanges             []AutogendDateRange `json:"dateRanges,omitempty"`
}

// AutogendVariation represents a value variation with a percentage weight
type AutogendVariation struct {
	Value  string  `json:"value"`
	Weight float64 `json:"weight"`
}

// AutogendDateRange represents a From-To datetime pair with a weight
type AutogendDateRange struct {
	From   string  `json:"from"`
	To     string  `json:"to"`
	Weight float64 `json:"weight"`
}

// GenerateCollectionRecords generates a slice of record data maps based on the collection schema and AutogendConfig
func GenerateCollectionRecords(col *Collection, config *AutogendConfig) ([]map[string]any, error) {
	if col == nil {
		return nil, fmt.Errorf("collection cannot be nil")
	}
	if config == nil {
		return nil, fmt.Errorf("config cannot be nil")
	}

	sampleCount := config.SampleCount
	if sampleCount <= 0 {
		sampleCount = 100
	}

	records := make([]map[string]any, 0, sampleCount)

	for i := 1; i <= sampleCount; i++ {
		recData := make(map[string]any)

		for _, field := range col.Fields {
			fieldName := field.GetName()
			rule, exists := config.Fields[fieldName]
			if !exists {
				// Default fallback for unconfigured fields
				recData[fieldName] = generateDefaultFieldValue(field, i)
				continue
			}

			// Strictly system fields
			if rule.System && (fieldName == "id" || fieldName == "tokenKey") {
				continue // PocketBase generates id / tokenKey automatically
			}

			val := generateValueForRule(field, rule, i)
			if val != nil {
				recData[fieldName] = val
			}
		}

		records = append(records, recData)
	}

	return records, nil
}

func generateValueForRule(field Field, rule AutogendFieldRule, recordIdx int) any {
	// Date / Timestamp field handling
	if field.Type() == FieldTypeDate || field.Type() == FieldTypeAutodate || rule.DateMode != "" {
		if rule.DateMode == "range" && len(rule.DateRanges) > 0 {
			rangePair := pickWeightedDateRange(rule.DateRanges, rule.Distribution, recordIdx)
			return randomDateBetween(rangePair.From, rangePair.To)
		}
		// Action time (Current execution timestamp)
		return types.NowDateTime().String()
	}

	// Number field range handling (Integer vs Floating Point Float)
	if field.Type() == FieldTypeNumber || rule.AutogenerateRange {
		minVal := rule.Min
		maxVal := rule.Max
		if minVal == 0 && maxVal == 0 {
			minVal = 20
			maxVal = 30
		}

		numVal := randomFloatBetween(minVal, maxVal)
		if rule.NumberType == "int" || rule.NumberType == "" {
			return math.Round(numVal)
		}
		return numVal
	}

	// Static Default Value override (Apply exact constant value to all generated rows)
	if rule.DefaultValue != "" {
		if field.Type() == FieldTypeBool {
			return strings.ToLower(rule.DefaultValue) == "true" || rule.DefaultValue == "1"
		}
		if field.Type() == FieldTypeNumber {
			if v, err := strconv.ParseFloat(rule.DefaultValue, 64); err == nil {
				return v
			}
		}
		return rule.DefaultValue
	}

	// Pattern mode handling (Regex / Bracket pattern / Multi-list choices pattern e.g. [Alex|Jordan|Emma] [Smith|Brown|Johnson])
	if rule.Pattern != "" {
		val := expandPattern(rule.Pattern, recordIdx)
		if rule.UniqueSalt {
			val = fmt.Sprintf("%s_%s", val, randomHex(4))
		}
		return val
	}

	// Variations mode (Select, Bool, Generic)
	if len(rule.Variations) > 0 {
		picked := pickWeightedVariation(rule.Variations, rule.Distribution, recordIdx)
		if rule.UniqueSalt {
			picked = fmt.Sprintf("%s_%s", picked, randomHex(4))
		}

		if field.Type() == FieldTypeBool {
			return strings.ToLower(picked) == "true" || picked == "1"
		}
		return picked
	}

	return generateDefaultFieldValue(field, recordIdx)
}

func expandPattern(pattern string, idx int) string {
	res := pattern

	// 1. Handle choice list syntax e.g. [Alex|Jordan|Emma|Sam] [Smith|Brown|Jones]
	listRegex := regexp.MustCompile(`\[([a-zA-Z0-9_\-\s]+(?:\|[a-zA-Z0-9_\-\s]+)+)\]`)
	if listRegex.MatchString(res) {
		res = listRegex.ReplaceAllStringFunc(res, func(m string) string {
			inner := strings.Trim(m, "[]")
			parts := strings.Split(inner, "|")
			if len(parts) == 0 {
				return m
			}
			rndIdx, _ := rand.Int(rand.Reader, big.NewInt(int64(len(parts))))
			return strings.TrimSpace(parts[rndIdx.Int64()])
		})
	}

	// 2. Handle numeric bracket counter like [1-100] or [1-1000]
	bracketRegex := regexp.MustCompile(`\[(\d+)-(\d+)\]`)
	if bracketRegex.MatchString(res) {
		res = bracketRegex.ReplaceAllStringFunc(res, func(m string) string {
			sub := bracketRegex.FindStringSubmatch(m)
			if len(sub) == 3 {
				min, _ := strconv.Atoi(sub[1])
				max, _ := strconv.Atoi(sub[2])
				rangeLen := (max - min) + 1
				if rangeLen <= 0 {
					rangeLen = 1
				}
				val := min + ((idx - 1) % rangeLen)
				return strconv.Itoa(val)
			}
			return m
		})
	}

	// 3. Handle random hex pattern like [a-z0-9]{15}
	regexPattern := regexp.MustCompile(`\[a-zA-Z0-9\]\{(\d+)\}`)
	if regexPattern.MatchString(res) {
		res = regexPattern.ReplaceAllStringFunc(res, func(m string) string {
			sub := regexPattern.FindStringSubmatch(m)
			if len(sub) == 2 {
				length, _ := strconv.Atoi(sub[1])
				return randomHex(length / 2)
			}
			return m
		})
	}

	return res
}

func pickWeightedVariation(variations []AutogendVariation, distribution string, recordIdx int) string {
	if len(variations) == 0 {
		return ""
	}

	if distribution == "equal" || len(variations) == 1 {
		idx := (recordIdx - 1) % len(variations)
		return variations[idx].Value
	}

	var totalWeight float64
	for _, v := range variations {
		totalWeight += v.Weight
	}

	if totalWeight <= 0 {
		idx := (recordIdx - 1) % len(variations)
		return variations[idx].Value
	}

	rnd, _ := rand.Int(rand.Reader, big.NewInt(int64(totalWeight)))
	rndVal := float64(rnd.Int64())

	var current float64
	for _, v := range variations {
		current += v.Weight
		if rndVal < current {
			return v.Value
		}
	}

	return variations[0].Value
}

func pickWeightedDateRange(ranges []AutogendDateRange, distribution string, recordIdx int) AutogendDateRange {
	if len(ranges) == 0 {
		now := time.Now().Format("2006-01-02T15:04")
		return AutogendDateRange{From: now, To: now}
	}

	if distribution == "equal" || len(ranges) == 1 {
		idx := (recordIdx - 1) % len(ranges)
		return ranges[idx]
	}

	var totalWeight float64
	for _, r := range ranges {
		totalWeight += r.Weight
	}

	if totalWeight <= 0 {
		idx := (recordIdx - 1) % len(ranges)
		return ranges[idx]
	}

	rnd, _ := rand.Int(rand.Reader, big.NewInt(int64(totalWeight)))
	rndVal := float64(rnd.Int64())

	var current float64
	for _, r := range ranges {
		current += r.Weight
		if rndVal < current {
			return r
		}
	}

	return ranges[0]
}

func randomDateBetween(fromStr, toStr string) string {
	layout := "2006-01-02T15:04"
	fromDate, err1 := time.Parse(layout, fromStr)
	toDate, err2 := time.Parse(layout, toStr)

	if err1 != nil || err2 != nil || toDate.Before(fromDate) {
		return types.NowDateTime().String()
	}

	delta := toDate.Sub(fromDate).Nanoseconds()
	if delta <= 0 {
		return fromDate.Format("2006-01-02 15:04:05.000Z")
	}

	rnd, _ := rand.Int(rand.Reader, big.NewInt(delta))
	randomNano := rnd.Int64()
	resDate := fromDate.Add(time.Duration(randomNano))

	return resDate.Format("2006-01-02 15:04:05.000Z")
}

func randomFloatBetween(min, max float64) float64 {
	if min >= max {
		return min
	}
	diff := int64((max - min) * 100)
	if diff <= 0 {
		return min
	}
	rnd, _ := rand.Int(rand.Reader, big.NewInt(diff))
	return min + (float64(rnd.Int64()) / 100.0)
}

func randomHex(bytesLen int) string {
	if bytesLen <= 0 {
		bytesLen = 4
	}
	b := make([]byte, bytesLen)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func generateDefaultFieldValue(field Field, idx int) any {
	switch field.Type() {
	case FieldTypeBool:
		return idx%2 == 0
	case FieldTypeNumber:
		return float64(20 + (idx % 10))
	case FieldTypeDate, FieldTypeAutodate:
		return types.NowDateTime().String()
	default:
		return fmt.Sprintf("Sample %s %d", field.GetName(), idx)
	}
}
