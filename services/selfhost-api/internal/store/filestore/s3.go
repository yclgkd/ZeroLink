package filestore

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

const (
	defaultUploadURLTTL                    = 15 * time.Minute
	defaultDownloadURLTTL                  = 5 * time.Minute
	uploadCompletionLeaseDuration          = 5 * time.Minute
	uploadCompletionCleanupTimeout         = 10 * time.Second
	uploadCompletionMarkerAcquireAttempts  = 4
	uploadCompletionStateMetadata          = "zerolink-completion-state"
	uploadCompletionFingerprintMetadata    = "zerolink-request-fingerprint"
	uploadCompletionLeaseExpiresAtMetadata = "zerolink-lease-expires-at"
	chunkObjectPrefix                      = "files"
	channelUUIDLength                      = 21
)

// ErrUploadCompleted indicates that an upload has already been finalized.
var ErrUploadCompleted = errors.New("upload already completed")

// ErrUploadInProgress indicates that another request is finalizing the upload.
var ErrUploadInProgress = errors.New("upload finalization in progress")

var errUploadCompletionMismatch = errors.New("upload completion payload does not match the original request")

type uploadCompletionMarkerState string

const (
	uploadCompletionInProgress uploadCompletionMarkerState = "in_progress"
	uploadCompletionCompleted  uploadCompletionMarkerState = "completed"
	uploadCompletionReleased   uploadCompletionMarkerState = "released"
)

type uploadCompletionMarker struct {
	state              uploadCompletionMarkerState
	requestFingerprint string
	leaseExpiresAt     time.Time
}

type uploadCompletionMarkerAcquisition struct {
	owned     bool
	completed bool
	etag      string
}

type FileStorageBackend string

const (
	FileStorageBackendR2 FileStorageBackend = "r2"
	FileStorageBackendS3 FileStorageBackend = "s3"
)

type Config struct {
	Endpoint       string
	PublicEndpoint string
	AccessKey      string
	SecretKey      string
	Bucket         string
	UseSSL         bool
	Region         string
}

type FileUploadInitiateRequest struct {
	ChannelUUID          string `json:"channelUuid"`
	ChunkCount           int    `json:"chunkCount"`
	TotalCiphertextBytes int64  `json:"totalCiphertextBytes"`
}

type FileUploadChunkTarget struct {
	Index     int    `json:"index"`
	UploadURL string `json:"uploadUrl"`
}

type FileUploadInitiateResponse struct {
	OK       bool                    `json:"ok"`
	UploadID string                  `json:"uploadId"`
	Chunks   []FileUploadChunkTarget `json:"chunks"`
}

type FileUploadCompleteChunk struct {
	Index           int    `json:"index"`
	ETag            string `json:"etag"`
	CiphertextBytes int64  `json:"ciphertextBytes"`
	CiphertextHash  string `json:"ciphertextHash"`
}

type MultipartFileRefChunk struct {
	Index           int    `json:"index"`
	StorageKey      string `json:"storageKey"`
	CiphertextBytes int64  `json:"ciphertextBytes"`
	CiphertextHash  string `json:"ciphertextHash"`
}

type MultipartFileRef struct {
	StorageBackend       FileStorageBackend      `json:"storageBackend"`
	ChunkSizeBytes       int64                   `json:"chunkSizeBytes"`
	ChunkCount           int                     `json:"chunkCount"`
	TotalPlaintextBytes  int64                   `json:"totalPlaintextBytes"`
	TotalCiphertextBytes int64                   `json:"totalCiphertextBytes"`
	BaseIV               string                  `json:"baseIv"`
	EncContentKey        string                  `json:"encContentKey"`
	Chunks               []MultipartFileRefChunk `json:"chunks"`
}

type FileUploadCompleteRequest struct {
	UploadID             string                    `json:"uploadId"`
	BaseIV               string                    `json:"baseIv"`
	EncContentKey        string                    `json:"encContentKey"`
	ChunkSizeBytes       int64                     `json:"chunkSizeBytes"`
	TotalPlaintextBytes  int64                     `json:"totalPlaintextBytes"`
	TotalCiphertextBytes int64                     `json:"totalCiphertextBytes"`
	Chunks               []FileUploadCompleteChunk `json:"chunks"`
}

type FileUploadCompleteResponse struct {
	OK      bool             `json:"ok"`
	FileRef MultipartFileRef `json:"fileRef"`
}

type FileDownloadChunkTarget struct {
	Index       int    `json:"index"`
	DownloadURL string `json:"downloadUrl"`
}

type FileFetchResponse struct {
	OK     bool                      `json:"ok"`
	Chunks []FileDownloadChunkTarget `json:"chunks"`
}

type ChunkObject struct {
	Key          string
	LastModified time.Time
}

type Store struct {
	client         *minio.Client
	presignClient  *minio.Client
	bucket         string
	region         string
	publicEndpoint string
	bucketReady    atomic.Bool
	bucketMu       sync.Mutex
}

func NewS3(ctx context.Context, cfg Config) (*Store, error) {
	if cfg.AccessKey == "" {
		return nil, errors.New("s3 access key is required")
	}
	if cfg.SecretKey == "" {
		return nil, errors.New("s3 secret key is required")
	}
	if cfg.Bucket == "" {
		return nil, errors.New("s3 bucket is required")
	}

	endpoint, useSSL, err := parseS3Endpoint(cfg.Endpoint, cfg.UseSSL)
	if err != nil {
		return nil, err
	}
	client, err := newMinioClient(endpoint, useSSL, cfg.Region, cfg.AccessKey, cfg.SecretKey)
	if err != nil {
		return nil, fmt.Errorf("create s3 client: %w", err)
	}

	var presignClient *minio.Client
	if strings.TrimSpace(cfg.PublicEndpoint) != "" {
		publicEndpoint, publicUseSSL, err := parseS3Endpoint(cfg.PublicEndpoint, cfg.UseSSL)
		if err != nil {
			return nil, fmt.Errorf("parse public s3 endpoint: %w", err)
		}
		presignClient, err = newMinioClient(publicEndpoint, publicUseSSL, cfg.Region, cfg.AccessKey, cfg.SecretKey)
		if err != nil {
			return nil, fmt.Errorf("create public s3 client: %w", err)
		}
	}

	store := &Store{
		client:         client,
		presignClient:  presignClient,
		bucket:         cfg.Bucket,
		region:         cfg.Region,
		publicEndpoint: cfg.PublicEndpoint,
	}

	if err := store.ensureBucket(ctx); err != nil {
		return nil, err
	}

	return store, nil
}

func NewUploadID() (string, error) {
	return randomBase64URL(16)
}

func (s *Store) Initiate(ctx context.Context, uploadID string, chunkCount int) error {
	_ = ctx
	if err := validateUploadID(uploadID); err != nil {
		return err
	}
	if chunkCount <= 0 {
		return errors.New("chunkCount must be positive")
	}
	return nil
}

func (s *Store) PutChunk(ctx context.Context, uploadID string, index int, body io.Reader, size int64) (string, error) {
	if err := validateUploadID(uploadID); err != nil {
		return "", err
	}
	if index < 0 {
		return "", errors.New("chunk index must be non-negative")
	}
	if size < 0 {
		return "", errors.New("chunk size must be non-negative")
	}
	if _, err := s.client.StatObject(ctx, s.bucket, finalUploadObjectKey(uploadID, index), minio.StatObjectOptions{}); err == nil {
		return "", ErrUploadCompleted
	} else if !isObjectNotFound(err) {
		return "", fmt.Errorf("check upload completion: %w", err)
	}

	objectKey := uploadObjectKey(uploadID, index)
	info, err := s.client.PutObject(ctx, s.bucket, objectKey, body, size, minio.PutObjectOptions{})
	if err != nil {
		return "", fmt.Errorf("put chunk %d: %w", index, err)
	}
	return normalizeETag(info.ETag), nil
}

func (s *Store) PresignedUpload(ctx context.Context, uploadID string, index int, size int64, ttl time.Duration) (string, error) {
	if err := validateUploadID(uploadID); err != nil {
		return "", err
	}
	if index < 0 {
		return "", errors.New("chunk index must be non-negative")
	}
	if size <= 0 {
		return "", errors.New("chunk size must be positive")
	}
	if ttl <= 0 {
		ttl = defaultUploadURLTTL
	}

	objectKey := uploadObjectKey(uploadID, index)
	headers := http.Header{}
	headers.Set("Content-Length", strconv.FormatInt(size, 10))
	u, err := s.presignTarget().PresignHeader(ctx, http.MethodPut, s.bucket, objectKey, ttl, nil, headers)
	if err != nil {
		return "", fmt.Errorf("presign upload chunk %d: %w", index, err)
	}
	return u.String(), nil
}

func (s *Store) CompleteUpload(ctx context.Context, req FileUploadCompleteRequest) (MultipartFileRef, error) {
	if err := req.Validate(); err != nil {
		return MultipartFileRef{}, err
	}
	for i, chunk := range req.Chunks {
		if chunk.Index != i {
			return MultipartFileRef{}, fmt.Errorf("chunks must be ordered from 0 to %d", len(req.Chunks)-1)
		}
	}

	uploadID := req.UploadID
	requestFingerprint, err := uploadCompletionRequestFingerprint(req)
	if err != nil {
		return MultipartFileRef{}, err
	}
	marker, err := s.acquireUploadCompletionMarker(ctx, uploadID, requestFingerprint)
	if err != nil {
		return MultipartFileRef{}, err
	}

	if marker.completed {
		chunks := make([]MultipartFileRefChunk, len(req.Chunks))
		var totalCiphertext int64
		for i, chunk := range req.Chunks {
			finalKey := finalUploadObjectKey(uploadID, chunk.Index)
			finalStat, err := s.client.StatObject(ctx, s.bucket, finalKey, minio.StatObjectOptions{})
			if err != nil {
				if isObjectNotFound(err) {
					return MultipartFileRef{}, ErrUploadInProgress
				}
				return MultipartFileRef{}, fmt.Errorf("stat finalized chunk %d: %w", chunk.Index, err)
			}
			if finalStat.Size != chunk.CiphertextBytes {
				return MultipartFileRef{}, fmt.Errorf("finalized chunk %d ciphertext bytes mismatch", chunk.Index)
			}
			totalCiphertext += finalStat.Size
			chunks[i] = MultipartFileRefChunk{
				Index:           chunk.Index,
				StorageKey:      finalKey,
				CiphertextBytes: finalStat.Size,
				CiphertextHash:  chunk.CiphertextHash,
			}
		}
		if totalCiphertext != req.TotalCiphertextBytes {
			return MultipartFileRef{}, fmt.Errorf("total ciphertext bytes mismatch: got %d want %d", totalCiphertext, req.TotalCiphertextBytes)
		}

		ref := MultipartFileRef{
			StorageBackend:       FileStorageBackendS3,
			ChunkSizeBytes:       req.ChunkSizeBytes,
			ChunkCount:           len(chunks),
			TotalPlaintextBytes:  req.TotalPlaintextBytes,
			TotalCiphertextBytes: totalCiphertext,
			BaseIV:               req.BaseIV,
			EncContentKey:        req.EncContentKey,
			Chunks:               chunks,
		}
		if err := ref.Validate(); err != nil {
			return MultipartFileRef{}, err
		}
		return ref, nil
	}

	completionFinished := false
	defer func() {
		if marker.owned && !completionFinished {
			cleanupCtx, cancel := context.WithTimeout(
				context.WithoutCancel(ctx),
				uploadCompletionCleanupTimeout,
			)
			defer cancel()
			_, _ = s.transitionUploadCompletionMarker(
				cleanupCtx,
				uploadID,
				requestFingerprint,
				marker.etag,
				uploadCompletionReleased,
			)
		}
	}()

	chunks := make([]MultipartFileRefChunk, len(req.Chunks))
	sourceETags := make([]string, len(req.Chunks))
	var totalCiphertext int64
	for i, chunk := range req.Chunks {
		finalKey := finalUploadObjectKey(uploadID, chunk.Index)
		objectKey := uploadObjectKey(uploadID, chunk.Index)
		stat, err := s.client.StatObject(ctx, s.bucket, objectKey, minio.StatObjectOptions{})
		if err != nil {
			return MultipartFileRef{}, fmt.Errorf("stat chunk %d: %w", chunk.Index, err)
		}

		etag := normalizeETag(stat.ETag)
		if etag != normalizeETag(chunk.ETag) {
			return MultipartFileRef{}, fmt.Errorf("chunk %d etag mismatch", chunk.Index)
		}
		if stat.Size != chunk.CiphertextBytes {
			return MultipartFileRef{}, fmt.Errorf("chunk %d ciphertext bytes mismatch", chunk.Index)
		}

		sourceETags[i] = etag
		totalCiphertext += stat.Size
		chunks[i] = MultipartFileRefChunk{
			Index:           chunk.Index,
			StorageKey:      finalKey,
			CiphertextBytes: stat.Size,
			CiphertextHash:  chunk.CiphertextHash,
		}
	}

	if totalCiphertext != req.TotalCiphertextBytes {
		return MultipartFileRef{}, fmt.Errorf("total ciphertext bytes mismatch: got %d want %d", totalCiphertext, req.TotalCiphertextBytes)
	}

	for i, chunk := range chunks {
		_, err := s.client.CopyObject(
			ctx,
			minio.CopyDestOptions{
				Bucket: s.bucket,
				Object: chunk.StorageKey,
			},
			minio.CopySrcOptions{
				Bucket:    s.bucket,
				Object:    uploadObjectKey(uploadID, chunk.Index),
				MatchETag: sourceETags[i],
			},
		)
		if err != nil {
			return MultipartFileRef{}, fmt.Errorf("finalize chunk %d: %w", chunk.Index, err)
		}
	}

	ref := MultipartFileRef{
		StorageBackend:       FileStorageBackendS3,
		ChunkSizeBytes:       req.ChunkSizeBytes,
		ChunkCount:           len(chunks),
		TotalPlaintextBytes:  req.TotalPlaintextBytes,
		TotalCiphertextBytes: totalCiphertext,
		BaseIV:               req.BaseIV,
		EncContentKey:        req.EncContentKey,
		Chunks:               chunks,
	}
	if err := ref.Validate(); err != nil {
		return MultipartFileRef{}, err
	}
	if _, err := s.transitionUploadCompletionMarker(
		ctx,
		uploadID,
		requestFingerprint,
		marker.etag,
		uploadCompletionCompleted,
	); err != nil {
		if isConditionalWriteConflict(err) {
			return MultipartFileRef{}, ErrUploadInProgress
		}
		return MultipartFileRef{}, fmt.Errorf("complete upload marker: %w", err)
	}
	completionFinished = true
	return ref, nil
}

func uploadCompletionRequestFingerprint(req FileUploadCompleteRequest) (string, error) {
	canonical := req
	canonical.Chunks = append([]FileUploadCompleteChunk(nil), req.Chunks...)
	for i := range canonical.Chunks {
		canonical.Chunks[i].ETag = normalizeETag(canonical.Chunks[i].ETag)
	}
	encoded, err := json.Marshal(canonical)
	if err != nil {
		return "", fmt.Errorf("encode upload completion fingerprint: %w", err)
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

func uploadCompletionMetadataValue(info minio.ObjectInfo, key string) string {
	if value := info.Metadata.Get("X-Amz-Meta-" + key); value != "" {
		return value
	}
	for name, value := range info.UserMetadata {
		if strings.EqualFold(name, key) || strings.EqualFold(name, "X-Amz-Meta-"+key) {
			return value
		}
	}
	return ""
}

func parseUploadCompletionMarker(info minio.ObjectInfo) (uploadCompletionMarker, bool) {
	state := uploadCompletionMarkerState(
		uploadCompletionMetadataValue(info, uploadCompletionStateMetadata),
	)
	if state != uploadCompletionInProgress &&
		state != uploadCompletionCompleted &&
		state != uploadCompletionReleased {
		return uploadCompletionMarker{}, false
	}
	requestFingerprint := uploadCompletionMetadataValue(
		info,
		uploadCompletionFingerprintMetadata,
	)
	leaseExpiresAtMillis, err := strconv.ParseInt(
		uploadCompletionMetadataValue(info, uploadCompletionLeaseExpiresAtMetadata),
		10,
		64,
	)
	if err != nil || requestFingerprint == "" {
		return uploadCompletionMarker{}, false
	}
	return uploadCompletionMarker{
		state:              state,
		requestFingerprint: requestFingerprint,
		leaseExpiresAt:     time.UnixMilli(leaseExpiresAtMillis),
	}, true
}

func (s *Store) putUploadCompletionMarker(
	ctx context.Context,
	uploadID string,
	requestFingerprint string,
	state uploadCompletionMarkerState,
	matchETag string,
	createOnly bool,
) (minio.UploadInfo, error) {
	nonce, err := randomBase64URL(16)
	if err != nil {
		return minio.UploadInfo{}, err
	}
	body := []byte(fmt.Sprintf("%s:%s:%s", state, requestFingerprint, nonce))
	leaseExpiresAt := time.Now()
	if state == uploadCompletionInProgress {
		leaseExpiresAt = leaseExpiresAt.Add(uploadCompletionLeaseDuration)
	}
	options := minio.PutObjectOptions{
		DisableMultipart: true,
		UserMetadata: map[string]string{
			uploadCompletionStateMetadata:          string(state),
			uploadCompletionFingerprintMetadata:    requestFingerprint,
			uploadCompletionLeaseExpiresAtMetadata: strconv.FormatInt(leaseExpiresAt.UnixMilli(), 10),
		},
	}
	if createOnly {
		options.SetMatchETagExcept("*")
	} else {
		options.SetMatchETag(normalizeETag(matchETag))
	}
	return s.client.PutObject(
		ctx,
		s.bucket,
		completionObjectKey(uploadID),
		bytes.NewReader(body),
		int64(len(body)),
		options,
	)
}

func (s *Store) acquireUploadCompletionMarker(
	ctx context.Context,
	uploadID string,
	requestFingerprint string,
) (uploadCompletionMarkerAcquisition, error) {
	markerKey := completionObjectKey(uploadID)
	for attempt := 0; attempt < uploadCompletionMarkerAcquireAttempts; attempt++ {
		info, err := s.client.StatObject(ctx, s.bucket, markerKey, minio.StatObjectOptions{})
		if err != nil {
			if !isObjectNotFound(err) {
				return uploadCompletionMarkerAcquisition{}, fmt.Errorf("stat upload completion marker: %w", err)
			}
			created, err := s.putUploadCompletionMarker(
				ctx,
				uploadID,
				requestFingerprint,
				uploadCompletionInProgress,
				"",
				true,
			)
			if err == nil {
				return uploadCompletionMarkerAcquisition{
					owned: true,
					etag:  normalizeETag(created.ETag),
				}, nil
			}
			if isConditionalWriteConflict(err) {
				continue
			}
			return uploadCompletionMarkerAcquisition{}, fmt.Errorf("acquire upload completion marker: %w", err)
		}

		current, ok := parseUploadCompletionMarker(info)
		if !ok {
			return uploadCompletionMarkerAcquisition{}, ErrUploadInProgress
		}
		if current.state == uploadCompletionCompleted {
			if current.requestFingerprint != requestFingerprint {
				return uploadCompletionMarkerAcquisition{}, errUploadCompletionMismatch
			}
			return uploadCompletionMarkerAcquisition{completed: true}, nil
		}
		if current.state == uploadCompletionInProgress {
			if current.requestFingerprint != requestFingerprint {
				return uploadCompletionMarkerAcquisition{}, errUploadCompletionMismatch
			}
			if current.leaseExpiresAt.After(time.Now()) {
				return uploadCompletionMarkerAcquisition{}, ErrUploadInProgress
			}
		}

		claimed, err := s.putUploadCompletionMarker(
			ctx,
			uploadID,
			requestFingerprint,
			uploadCompletionInProgress,
			info.ETag,
			false,
		)
		if err == nil {
			return uploadCompletionMarkerAcquisition{
				owned: true,
				etag:  normalizeETag(claimed.ETag),
			}, nil
		}
		if isConditionalWriteConflict(err) {
			continue
		}
		return uploadCompletionMarkerAcquisition{}, fmt.Errorf("claim upload completion marker: %w", err)
	}
	return uploadCompletionMarkerAcquisition{}, ErrUploadInProgress
}

func (s *Store) transitionUploadCompletionMarker(
	ctx context.Context,
	uploadID string,
	requestFingerprint string,
	ownerETag string,
	state uploadCompletionMarkerState,
) (minio.UploadInfo, error) {
	return s.putUploadCompletionMarker(
		ctx,
		uploadID,
		requestFingerprint,
		state,
		ownerETag,
		false,
	)
}

func (s *Store) PresignedDownload(ctx context.Context, fileRef MultipartFileRef, index int, ttl time.Duration) (string, error) {
	if err := fileRef.Validate(); err != nil {
		return "", err
	}
	if index < 0 {
		return "", errors.New("chunk index must be non-negative")
	}
	if ttl <= 0 {
		ttl = defaultDownloadURLTTL
	}

	chunk, ok := fileRef.chunkByIndex(index)
	if !ok {
		return "", fmt.Errorf("chunk %d not found", index)
	}

	u, err := s.presignTarget().PresignedGetObject(ctx, s.bucket, chunk.StorageKey, ttl, nil)
	if err != nil {
		return "", fmt.Errorf("presign download chunk %d: %w", index, err)
	}
	return u.String(), nil
}

// UsePresignedURLs returns true when the browser can reach the S3 endpoint
// directly (PublicEndpoint is set). When false, the API proxies file chunks.
func (s *Store) UsePresignedURLs() bool {
	return s.presignClient != nil
}

func (s *Store) GetChunk(ctx context.Context, key string) (io.ReadCloser, error) {
	obj, err := s.client.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, fmt.Errorf("get chunk: %w", err)
	}
	return obj, nil
}

func (s *Store) DeleteUpload(ctx context.Context, fileRef MultipartFileRef) error {
	if err := fileRef.Validate(); err != nil {
		return err
	}

	var errs []error
	for _, chunk := range fileRef.Chunks {
		if err := s.client.RemoveObject(ctx, s.bucket, chunk.StorageKey, minio.RemoveObjectOptions{}); err != nil {
			errs = append(errs, fmt.Errorf("delete chunk %d: %w", chunk.Index, err))
		}
	}

	return errors.Join(errs...)
}

func (s *Store) ListChunkObjects(ctx context.Context) ([]ChunkObject, error) {
	objects := make([]ChunkObject, 0)
	for object := range s.client.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{
		Prefix:    chunkObjectPrefix + "/",
		Recursive: true,
	}) {
		if object.Err != nil {
			return nil, fmt.Errorf("list chunk objects: %w", object.Err)
		}
		objects = append(objects, ChunkObject{
			Key:          object.Key,
			LastModified: object.LastModified.UTC(),
		})
	}
	return objects, nil
}

func (s *Store) DeleteObjects(ctx context.Context, keys []string) error {
	if len(keys) == 0 {
		return nil
	}

	objectsCh := make(chan minio.ObjectInfo, len(keys))
	for _, key := range keys {
		objectsCh <- minio.ObjectInfo{Key: key}
	}
	close(objectsCh)

	var errs []error
	for removeErr := range s.client.RemoveObjects(ctx, s.bucket, objectsCh, minio.RemoveObjectsOptions{}) {
		if removeErr.Err == nil {
			continue
		}
		errs = append(errs, fmt.Errorf("delete chunk %s: %w", removeErr.ObjectName, removeErr.Err))
	}

	return errors.Join(errs...)
}

func (ref MultipartFileRef) Validate() error {
	if ref.StorageBackend != FileStorageBackendS3 && ref.StorageBackend != FileStorageBackendR2 {
		return fmt.Errorf("unsupported storage backend %q", ref.StorageBackend)
	}
	if ref.ChunkSizeBytes <= 0 {
		return errors.New("chunkSizeBytes must be positive")
	}
	if ref.ChunkCount <= 0 {
		return errors.New("chunkCount must be positive")
	}
	if ref.TotalPlaintextBytes <= 0 {
		return errors.New("totalPlaintextBytes must be positive")
	}
	if ref.TotalCiphertextBytes <= 0 {
		return errors.New("totalCiphertextBytes must be positive")
	}
	if !isBase64URL(ref.BaseIV) {
		return errors.New("baseIv must be base64url")
	}
	if !isBase64URL(ref.EncContentKey) {
		return errors.New("encContentKey must be base64url")
	}
	if len(ref.Chunks) == 0 {
		return errors.New("chunks must not be empty")
	}
	if len(ref.Chunks) != ref.ChunkCount {
		return errors.New("chunks length must equal chunkCount")
	}

	var totalCiphertext int64
	for i, chunk := range ref.Chunks {
		if chunk.Index != i {
			return fmt.Errorf("chunk %d index mismatch", i)
		}
		if chunk.StorageKey == "" {
			return fmt.Errorf("chunk %d storageKey is required", i)
		}
		if chunk.CiphertextBytes <= 0 {
			return fmt.Errorf("chunk %d ciphertextBytes must be positive", i)
		}
		if !isHexString(chunk.CiphertextHash, 64) {
			return fmt.Errorf("chunk %d ciphertextHash must be lowercase hex", i)
		}
		totalCiphertext += chunk.CiphertextBytes
	}

	if totalCiphertext != ref.TotalCiphertextBytes {
		return fmt.Errorf("totalCiphertextBytes must match chunk sum")
	}
	return nil
}

func (req FileUploadInitiateRequest) Validate() error {
	if req.ChannelUUID == "" {
		return errors.New("channelUuid is required")
	}
	if !isChannelUUID(req.ChannelUUID) {
		return fmt.Errorf("channelUuid must be %d base64url-alphabet characters", channelUUIDLength)
	}
	if req.ChunkCount <= 0 {
		return errors.New("chunkCount must be positive")
	}
	if req.TotalCiphertextBytes <= 0 {
		return errors.New("totalCiphertextBytes must be positive")
	}
	return nil
}

func (req FileUploadCompleteRequest) Validate() error {
	if !isBase64URL(req.UploadID) {
		return errors.New("uploadId must be base64url")
	}
	if !isBase64URL(req.BaseIV) {
		return errors.New("baseIv must be base64url")
	}
	if !isBase64URL(req.EncContentKey) {
		return errors.New("encContentKey must be base64url")
	}
	if req.ChunkSizeBytes <= 0 {
		return errors.New("chunkSizeBytes must be positive")
	}
	if req.TotalPlaintextBytes <= 0 {
		return errors.New("totalPlaintextBytes must be positive")
	}
	if req.TotalCiphertextBytes <= 0 {
		return errors.New("totalCiphertextBytes must be positive")
	}
	if len(req.Chunks) == 0 {
		return errors.New("chunks must not be empty")
	}
	for i, chunk := range req.Chunks {
		if chunk.Index < 0 {
			return fmt.Errorf("chunk %d index must be non-negative", i)
		}
		if chunk.ETag == "" {
			return fmt.Errorf("chunk %d etag is required", i)
		}
		if chunk.CiphertextBytes <= 0 {
			return fmt.Errorf("chunk %d ciphertextBytes must be positive", i)
		}
		if !isHexString(chunk.CiphertextHash, 64) {
			return fmt.Errorf("chunk %d ciphertextHash must be lowercase hex", i)
		}
	}
	return nil
}

func (ref MultipartFileRef) chunkByIndex(index int) (MultipartFileRefChunk, bool) {
	for _, chunk := range ref.Chunks {
		if chunk.Index == index {
			return chunk, true
		}
	}
	return MultipartFileRefChunk{}, false
}

func (s *Store) ensureBucket(ctx context.Context) error {
	if s.bucketReady.Load() {
		return nil
	}

	s.bucketMu.Lock()
	defer s.bucketMu.Unlock()
	if s.bucketReady.Load() {
		return nil
	}

	exists, err := s.client.BucketExists(ctx, s.bucket)
	if err != nil {
		return fmt.Errorf("check s3 bucket %s: %w", s.bucket, err)
	}
	if exists {
		s.bucketReady.Store(true)
		return nil
	}
	if err := s.client.MakeBucket(ctx, s.bucket, minio.MakeBucketOptions{Region: s.region}); err != nil {
		return fmt.Errorf("create s3 bucket %s: %w", s.bucket, err)
	}
	s.bucketReady.Store(true)
	return nil
}

func uploadObjectKey(uploadID string, index int) string {
	return fmt.Sprintf("%s/%s/%04d.bin", chunkObjectPrefix, uploadID, index)
}

func finalUploadObjectKey(uploadID string, index int) string {
	return fmt.Sprintf("%s/%s/final/%04d.bin", chunkObjectPrefix, uploadID, index)
}

func completionObjectKey(uploadID string) string {
	return fmt.Sprintf("%s/%s/complete", chunkObjectPrefix, uploadID)
}

func isObjectNotFound(err error) bool {
	response := minio.ToErrorResponse(err)
	return response.StatusCode == http.StatusNotFound || response.Code == "NoSuchKey" || response.Code == "NoSuchObject"
}

func isConditionalWriteConflict(err error) bool {
	response := minio.ToErrorResponse(err)
	return response.StatusCode == http.StatusPreconditionFailed ||
		response.Code == "PreconditionFailed" ||
		(response.StatusCode == http.StatusConflict &&
			response.Code == "ConditionalRequestConflict")
}

func (s *Store) presignTarget() *minio.Client {
	if s.presignClient != nil {
		return s.presignClient
	}
	return s.client
}

func newMinioClient(
	endpoint string,
	useSSL bool,
	region string,
	accessKey string,
	secretKey string,
) (*minio.Client, error) {
	return minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: useSSL,
		Region: region,
	})
}

func parseS3Endpoint(raw string, defaultUseSSL bool) (string, bool, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", false, errors.New("s3 endpoint is required")
	}
	if !strings.Contains(value, "://") {
		if strings.ContainsAny(value, "/?#") {
			return "", false, fmt.Errorf("invalid s3 endpoint %q", value)
		}
		return value, defaultUseSSL, nil
	}

	parsed, err := url.Parse(value)
	if err != nil {
		return "", false, fmt.Errorf("invalid s3 endpoint %q: %w", value, err)
	}
	if parsed.Host == "" {
		return "", false, fmt.Errorf("s3 endpoint %q must include a host", value)
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", false, fmt.Errorf("s3 endpoint %q must not include user info, query, or fragment", value)
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return "", false, fmt.Errorf("s3 endpoint %q must not include a path", value)
	}

	switch parsed.Scheme {
	case "http":
		return parsed.Host, false, nil
	case "https":
		return parsed.Host, true, nil
	default:
		return "", false, fmt.Errorf("s3 endpoint %q must use http or https", value)
	}
}

func validateUploadID(uploadID string) error {
	if !isBase64URL(uploadID) {
		return errors.New("uploadId must be base64url")
	}
	return nil
}

func normalizeETag(etag string) string {
	return strings.Trim(etag, `"`)
}

func randomBase64URL(size int) (string, error) {
	if size <= 0 {
		return "", errors.New("size must be positive")
	}
	data := make([]byte, size)
	if _, err := rand.Read(data); err != nil {
		return "", fmt.Errorf("generate random bytes: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}

func isBase64URL(value string) bool {
	if value == "" {
		return false
	}
	_, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil
}

func isChannelUUID(value string) bool {
	if len(value) != channelUUIDLength {
		return false
	}
	for _, r := range value {
		switch {
		case r >= 'A' && r <= 'Z':
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9':
		case r == '-' || r == '_':
		default:
			return false
		}
	}
	return true
}

func isHexString(value string, length int) bool {
	if len(value) != length {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil && value == strings.ToLower(value)
}
