package store

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"time"

	"github.com/yclgkd/ZeroLink/services/selfhost-api/internal/store/filestore"
)

var multipartChunkObjectKeyPattern = regexp.MustCompile(`^files/[^/]+/(?:final/\d{4}\.bin|\d{4}\.bin|complete)$`)

type MultipartChunkStore interface {
	ListChunkObjects(context.Context) ([]filestore.ChunkObject, error)
	DeleteObjects(context.Context, []string) error
}

type MultipartOrphanCleanupSummary struct {
	ScannedObjects          int
	DeletedObjects          int
	KeptActiveObjects       int
	SkippedFreshObjects     int
	SkippedMalformedObjects int
}

func (d *Database) ListActiveMultipartFileRefs(
	ctx context.Context,
	now time.Time,
) ([]filestore.MultipartFileRef, error) {
	rows, err := d.pool.Query(
		ctx,
		`
SELECT uuid, file_ref
FROM channels
WHERE expires_at > $1
  AND file_ref IS NOT NULL
ORDER BY uuid
`,
		now.UTC(),
	)
	if err != nil {
		return nil, fmt.Errorf("list active multipart file refs: %w", err)
	}
	defer rows.Close()

	refs := make([]filestore.MultipartFileRef, 0)
	for rows.Next() {
		var channelID string
		var fileRefJSON []byte
		if err := rows.Scan(&channelID, &fileRefJSON); err != nil {
			return nil, fmt.Errorf("scan active multipart file ref: %w", err)
		}

		var fileRef filestore.MultipartFileRef
		if err := json.Unmarshal(fileRefJSON, &fileRef); err != nil {
			return nil, fmt.Errorf("decode multipart fileRef for channel %s: %w", channelID, err)
		}
		if err := fileRef.Validate(); err != nil {
			return nil, fmt.Errorf("validate multipart fileRef for channel %s: %w", channelID, err)
		}

		refs = append(refs, fileRef)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate active multipart file refs: %w", err)
	}

	return refs, nil
}

func CleanupOrphanMultipartChunks(
	ctx context.Context,
	db *Database,
	chunkStore MultipartChunkStore,
	now time.Time,
	staleAge time.Duration,
) (MultipartOrphanCleanupSummary, error) {
	summary := MultipartOrphanCleanupSummary{}
	if db == nil || chunkStore == nil {
		return summary, nil
	}
	if staleAge <= 0 {
		return summary, fmt.Errorf("staleAge must be positive")
	}

	activeRefs, err := db.ListActiveMultipartFileRefs(ctx, now)
	if err != nil {
		return summary, err
	}

	activeKeys := make(map[string]struct{}, len(activeRefs))
	for _, ref := range activeRefs {
		for _, chunk := range ref.Chunks {
			activeKeys[chunk.StorageKey] = struct{}{}
		}
	}

	chunkObjects, err := chunkStore.ListChunkObjects(ctx)
	if err != nil {
		return summary, err
	}

	staleBefore := now.UTC().Add(-staleAge)
	keysToDelete := make([]string, 0)

	for _, object := range chunkObjects {
		summary.ScannedObjects++

		if !multipartChunkObjectKeyPattern.MatchString(object.Key) {
			summary.SkippedMalformedObjects++
			continue
		}
		if _, ok := activeKeys[object.Key]; ok {
			summary.KeptActiveObjects++
			continue
		}
		if object.LastModified.After(staleBefore) {
			summary.SkippedFreshObjects++
			continue
		}

		keysToDelete = append(keysToDelete, object.Key)
	}

	if err := chunkStore.DeleteObjects(ctx, keysToDelete); err != nil {
		return summary, fmt.Errorf("delete orphan multipart chunks: %w", err)
	}
	summary.DeletedObjects = len(keysToDelete)

	return summary, nil
}
