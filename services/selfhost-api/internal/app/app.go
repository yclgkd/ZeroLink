package app

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/yclgkd/ZeroLink/services/selfhost-api/internal/config"
	"github.com/yclgkd/ZeroLink/services/selfhost-api/internal/httpapi"
	"github.com/yclgkd/ZeroLink/services/selfhost-api/internal/realtime"
	"github.com/yclgkd/ZeroLink/services/selfhost-api/internal/service"
	"github.com/yclgkd/ZeroLink/services/selfhost-api/internal/store"
	"github.com/yclgkd/ZeroLink/services/selfhost-api/internal/store/filestore"
	"github.com/yclgkd/ZeroLink/services/selfhost-api/internal/webauthn"
)

// inlineBase64Overhead is the multiplier applied to convert raw file bytes to a
// worst-case JSON body size. AES-GCM ciphertext is base64url-encoded in the
// protocol JSON (3 raw bytes → 4 base64 chars), and the remaining JSON framing
// adds a small additional overhead, so 4× is a safe upper bound.
const inlineBase64Overhead = int64(4)
const minInlineProtocolBodyBytes = int64(2_097_152) * inlineBase64Overhead

type Runtime struct {
	server          *http.Server
	shutdownTimeout time.Duration
	db              *store.Database
	maintenanceDB   expiredDataSweeper
	multipartStore  store.MultipartChunkStore
	realtime        realtime.Publisher
	logger          *slog.Logger
}

func resolveMaxProtocolBodyBytes(inlineMaxBytes int64) int64 {
	if inlineMaxBytes <= 0 {
		return minInlineProtocolBodyBytes
	}
	return max(inlineMaxBytes*inlineBase64Overhead, minInlineProtocolBodyBytes)
}

func New(ctx context.Context, cfg config.Config, logger *slog.Logger) (*Runtime, error) {
	db, err := store.Open(ctx, cfg.Database)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}

	realtimeHub := realtime.NewHub(logger)
	verifier := webauthn.NewVerifier()

	var fileStore httpapi.FileStore
	var multipartStore store.MultipartChunkStore
	if cfg.File.StorageBackend == "s3" {
		s3Store, err := filestore.NewS3(ctx, filestore.Config{
			Endpoint:       cfg.File.S3.Endpoint,
			PublicEndpoint: cfg.File.S3.PublicEndpoint,
			AccessKey:      cfg.File.S3.AccessKey,
			SecretKey:      cfg.File.S3.SecretKey,
			Bucket:         cfg.File.S3.Bucket,
			UseSSL:         cfg.File.S3.UseSSL,
			Region:         cfg.File.S3.Region,
		})
		if err != nil {
			return nil, fmt.Errorf("init file storage: %w", err)
		}
		fileStore = s3Store
		multipartStore = s3Store
	}
	if fileStore != nil {
		db.SetMultipartCleaner(fileStore)
	}

	protocolService := service.NewProtocolService(
		db,
		service.ProtocolConfig{
			RPID:              cfg.RP.ID,
			RPOrigin:          cfg.RP.Origin,
			CommitTokenSecret: cfg.CommitTokenSecret,
			Verifier:          verifier,
			Publisher:         realtimeHub,
			File: service.FilePolicy{
				MaxFileBytes:            cfg.File.MaxBytes,
				MultipartThresholdBytes: cfg.File.MultipartThresholdBytes,
				ChunkSizeBytes:          cfg.File.ChunkSizeBytes,
				MaxChunks:               cfg.File.MaxChunks,
				MultipartSupported:      cfg.File.MultipartSupported,
			},
		},
	)
	services := service.New(
		db,
		verifier,
		realtimeHub,
		protocolService,
		logger,
	)

	handler := httpapi.NewRouter(httpapi.Dependencies{
		Logger:            logger,
		Services:          services,
		AllowedOrigin:     cfg.RP.Origin,
		Realtime:          realtimeHub,
		FileStore:         fileStore,
		UploadTokenSecret: cfg.File.S3.SecretKey,
		FilePolicy: httpapi.FilePolicy{
			MaxFileBytes:            cfg.File.MaxBytes,
			MultipartThresholdBytes: cfg.File.MultipartThresholdBytes,
			ChunkSizeBytes:          cfg.File.ChunkSizeBytes,
			MaxChunks:               cfg.File.MaxChunks,
			MultipartSupported:      cfg.File.MultipartSupported,
		},
		TrustedProxyCIDRs:    cfg.HTTP.TrustedProxyCIDRs,
		MaxProtocolBodyBytes: resolveMaxProtocolBodyBytes(min(cfg.File.MaxBytes, cfg.File.MultipartThresholdBytes)),
	})

	// WriteTimeout is intentionally 0: hijacked WebSocket connections
	// inherit the server-level deadline, which would kill long-lived
	// sessions. Per-write deadlines are enforced inside the realtime hub.
	server := &http.Server{
		Addr:              cfg.HTTP.BindAddr,
		Handler:           handler,
		ReadTimeout:       cfg.HTTP.ReadTimeout,
		ReadHeaderTimeout: cfg.HTTP.ReadHeaderTimeout,
		IdleTimeout:       cfg.HTTP.IdleTimeout,
	}

	return &Runtime{
		server:          server,
		shutdownTimeout: cfg.HTTP.ShutdownTimeout,
		db:              db,
		maintenanceDB:   db,
		multipartStore:  multipartStore,
		realtime:        realtimeHub,
		logger:          logger,
	}, nil
}

func (r *Runtime) Run(ctx context.Context) error {
	go r.runMaintenanceLoop(ctx)

	errCh := make(chan error, 1)
	go func() {
		errCh <- r.server.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), r.shutdownTimeout)
		defer cancel()
		return r.server.Shutdown(shutdownCtx)
	}
}

func (r *Runtime) Close() {
	logger := r.logger
	if logger == nil {
		logger = slog.Default()
	}

	if r.realtime != nil {
		if err := r.realtime.Close(); err != nil {
			logger.Error("close realtime publisher", "error", err)
		}
	}
	if r.db != nil {
		r.db.Close()
	}
}
