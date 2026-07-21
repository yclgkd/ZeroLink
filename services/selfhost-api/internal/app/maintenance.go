package app

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/yclgkd/ZeroLink/services/selfhost-api/internal/store"
)

const (
	defaultMaintenanceInterval     = time.Hour
	defaultMultipartOrphanStaleAge = 15 * time.Minute
)

type expiredDataSweeper interface {
	SweepExpiredChannels(context.Context, time.Time) (int64, error)
	SweepExpiredEphemera(context.Context, time.Time) (int64, int64, error)
}

type expiredDataCleanupSummary struct {
	Channels   int64
	Challenges int64
	Nonces     int64
}

func sweepExpiredData(
	ctx context.Context,
	db expiredDataSweeper,
	now time.Time,
) (expiredDataCleanupSummary, error) {
	deletedChannels, err := db.SweepExpiredChannels(ctx, now)
	if err != nil {
		return expiredDataCleanupSummary{}, fmt.Errorf("sweep expired channels: %w", err)
	}

	deletedChallenges, deletedNonces, err := db.SweepExpiredEphemera(ctx, now)
	if err != nil {
		return expiredDataCleanupSummary{}, fmt.Errorf("sweep expired ephemera: %w", err)
	}

	return expiredDataCleanupSummary{
		Channels:   deletedChannels,
		Challenges: deletedChallenges,
		Nonces:     deletedNonces,
	}, nil
}

func (r *Runtime) runMaintenanceLoop(ctx context.Context) {
	ticker := time.NewTicker(defaultMaintenanceInterval)
	defer ticker.Stop()

	run := func() {
		if err := r.runMaintenanceOnce(ctx, time.Now().UTC()); err != nil {
			r.maintenanceLogger().Error("run self-host maintenance failed", "error", err)
		}
	}

	run()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			run()
		}
	}
}

func (r *Runtime) runMaintenanceOnce(ctx context.Context, now time.Time) error {
	expired := expiredDataCleanupSummary{}
	if r.maintenanceDB != nil {
		var err error
		expired, err = sweepExpiredData(ctx, r.maintenanceDB, now)
		if err != nil {
			return err
		}
	}

	summary, err := store.CleanupOrphanMultipartChunks(
		ctx,
		r.db,
		r.multipartStore,
		now,
		defaultMultipartOrphanStaleAge,
	)
	if err != nil {
		return fmt.Errorf("cleanup orphan multipart chunks: %w", err)
	}

	r.maintenanceLogger().Info(
		"self-host maintenance complete",
		"expired_channels", expired.Channels,
		"expired_challenges", expired.Challenges,
		"expired_nonces", expired.Nonces,
		"multipart_scanned_objects", summary.ScannedObjects,
		"multipart_deleted_objects", summary.DeletedObjects,
		"multipart_kept_active_objects", summary.KeptActiveObjects,
		"multipart_skipped_fresh_objects", summary.SkippedFreshObjects,
		"multipart_skipped_malformed_objects", summary.SkippedMalformedObjects,
	)
	return nil
}

func (r *Runtime) maintenanceLogger() *slog.Logger {
	if r != nil && r.logger != nil {
		return r.logger
	}
	return slog.Default()
}
