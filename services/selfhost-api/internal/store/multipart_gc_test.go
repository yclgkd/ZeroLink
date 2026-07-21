package store

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/yclgkd/ZeroLink/services/selfhost-api/internal/store/filestore"
)

type fakeMultipartChunkStore struct {
	objects        []filestore.ChunkObject
	deletedBatches [][]string
	deleteErr      error
}

func (f *fakeMultipartChunkStore) ListChunkObjects(_ context.Context) ([]filestore.ChunkObject, error) {
	return append([]filestore.ChunkObject(nil), f.objects...), nil
}

func (f *fakeMultipartChunkStore) DeleteObjects(_ context.Context, keys []string) error {
	f.deletedBatches = append(f.deletedBatches, append([]string(nil), keys...))
	if f.deleteErr != nil {
		return f.deleteErr
	}
	return nil
}

func TestCleanupOrphanMultipartChunksDeletesOnlyStaleOrphans(t *testing.T) {
	db := openTestDatabase(t)
	resetTestTables(t, db)

	now := time.Date(2026, 4, 12, 10, 0, 0, 0, time.UTC)
	activeKey := "files/active-upload/final/0000.bin"
	expiredKey := "files/expired-upload/0000.bin"
	orphanKey := "files/orphan-upload/0000.bin"
	freshKey := "files/fresh-upload/0000.bin"
	malformedKey := "files/not-a-chunk"

	saveMultipartChannelForCleanupTest(t, db, Channel{
		UUID:            "active-multipart-channel",
		State:           ChannelStateDelivered,
		CreatedAt:       now.Add(-time.Hour),
		ExpiresAt:       now.Add(time.Hour),
		TTLMS:           int64((2 * time.Hour) / time.Millisecond),
		SecurityProfile: SecurityProfileSecure,
		FileRef:         mustMarshalMultipartFileRef(t, activeKey),
		DeliveredAt:     timePtrValue(now.Add(-30 * time.Minute)),
		Version:         1,
	})
	saveMultipartChannelForCleanupTest(t, db, Channel{
		UUID:            "expired-multipart-channel",
		State:           ChannelStateDelivered,
		CreatedAt:       now.Add(-2 * time.Hour),
		ExpiresAt:       now.Add(-time.Minute),
		TTLMS:           int64((time.Hour) / time.Millisecond),
		SecurityProfile: SecurityProfileSecure,
		FileRef:         mustMarshalMultipartFileRef(t, expiredKey),
		DeliveredAt:     timePtrValue(now.Add(-90 * time.Minute)),
		Version:         1,
	})

	chunkStore := &fakeMultipartChunkStore{
		objects: []filestore.ChunkObject{
			{Key: activeKey, LastModified: now.Add(-30 * time.Minute)},
			{Key: expiredKey, LastModified: now.Add(-30 * time.Minute)},
			{Key: orphanKey, LastModified: now.Add(-30 * time.Minute)},
			{Key: freshKey, LastModified: now.Add(-5 * time.Minute)},
			{Key: malformedKey, LastModified: now.Add(-30 * time.Minute)},
		},
	}

	summary, err := CleanupOrphanMultipartChunks(
		context.Background(),
		db,
		chunkStore,
		now,
		15*time.Minute,
	)
	if err != nil {
		t.Fatalf("CleanupOrphanMultipartChunks() error = %v", err)
	}

	if summary.ScannedObjects != 5 {
		t.Fatalf("summary.ScannedObjects = %d, want 5", summary.ScannedObjects)
	}
	if summary.DeletedObjects != 2 {
		t.Fatalf("summary.DeletedObjects = %d, want 2", summary.DeletedObjects)
	}
	if summary.KeptActiveObjects != 1 {
		t.Fatalf("summary.KeptActiveObjects = %d, want 1", summary.KeptActiveObjects)
	}
	if summary.SkippedFreshObjects != 1 {
		t.Fatalf("summary.SkippedFreshObjects = %d, want 1", summary.SkippedFreshObjects)
	}
	if summary.SkippedMalformedObjects != 1 {
		t.Fatalf("summary.SkippedMalformedObjects = %d, want 1", summary.SkippedMalformedObjects)
	}

	if len(chunkStore.deletedBatches) != 1 {
		t.Fatalf("delete batches = %d, want 1", len(chunkStore.deletedBatches))
	}
	deletedKeys := append([]string(nil), chunkStore.deletedBatches[0]...)
	sort.Strings(deletedKeys)
	wantDeleted := []string{expiredKey, orphanKey}
	sort.Strings(wantDeleted)
	if strings.Join(deletedKeys, ",") != strings.Join(wantDeleted, ",") {
		t.Fatalf("deleted keys = %v, want %v", deletedKeys, wantDeleted)
	}
}

func TestCleanupOrphanMultipartChunksPropagatesDeleteError(t *testing.T) {
	db := openTestDatabase(t)
	resetTestTables(t, db)

	now := time.Date(2026, 4, 12, 10, 0, 0, 0, time.UTC)
	chunkStore := &fakeMultipartChunkStore{
		objects: []filestore.ChunkObject{
			{Key: "files/orphan-upload/0000.bin", LastModified: now.Add(-30 * time.Minute)},
		},
		deleteErr: errors.New("s3 unavailable"),
	}

	_, err := CleanupOrphanMultipartChunks(
		context.Background(),
		db,
		chunkStore,
		now,
		15*time.Minute,
	)
	if err == nil {
		t.Fatal("CleanupOrphanMultipartChunks() error = nil, want delete error")
	}
	if !strings.Contains(err.Error(), "s3 unavailable") {
		t.Fatalf("CleanupOrphanMultipartChunks() error = %v, want propagated delete error", err)
	}
}

func saveMultipartChannelForCleanupTest(t *testing.T, db *Database, channel Channel) {
	t.Helper()

	if err := db.WithChannelTx(context.Background(), channel.UUID, func(ctx context.Context, tx *ChannelTx) error {
		_, err := tx.SaveChannel(ctx, channel)
		return err
	}); err != nil {
		t.Fatalf("save multipart cleanup test channel %s: %v", channel.UUID, err)
	}
}

func mustMarshalMultipartFileRef(t *testing.T, storageKey string) []byte {
	t.Helper()

	fileRefJSON, err := json.Marshal(filestore.MultipartFileRef{
		StorageBackend:       filestore.FileStorageBackendS3,
		ChunkSizeBytes:       8,
		ChunkCount:           1,
		TotalPlaintextBytes:  4,
		TotalCiphertextBytes: 20,
		BaseIV:               "YmFzZS1pdg",
		EncContentKey:        "ZW5jLWtleQ",
		Chunks: []filestore.MultipartFileRefChunk{
			{
				Index:           0,
				StorageKey:      storageKey,
				CiphertextBytes: 20,
				CiphertextHash:  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			},
		},
	})
	if err != nil {
		t.Fatalf("marshal multipart fileRef: %v", err)
	}

	return fileRefJSON
}
