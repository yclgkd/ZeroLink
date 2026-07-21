package app

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"
)

type fakeExpiredDataSweeper struct {
	now               time.Time
	channelCalls      int
	ephemeraCalls     int
	deletedChannels   int64
	deletedChallenges int64
	deletedNonces     int64
	channelsError     error
	ephemeraError     error
}

func (f *fakeExpiredDataSweeper) SweepExpiredChannels(_ context.Context, now time.Time) (int64, error) {
	f.channelCalls++
	f.now = now
	return f.deletedChannels, f.channelsError
}

func (f *fakeExpiredDataSweeper) SweepExpiredEphemera(_ context.Context, now time.Time) (int64, int64, error) {
	f.ephemeraCalls++
	f.now = now
	return f.deletedChallenges, f.deletedNonces, f.ephemeraError
}

func TestRunMaintenanceOnceSweepsExpiredDataWithoutMultipartStore(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.July, 12, 10, 30, 0, 0, time.UTC)
	database := &fakeExpiredDataSweeper{
		deletedChannels:   2,
		deletedChallenges: 3,
		deletedNonces:     4,
	}
	runtime := &Runtime{
		maintenanceDB: database,
		logger:        slog.New(slog.NewTextHandler(io.Discard, nil)),
	}

	if err := runtime.runMaintenanceOnce(context.Background(), now); err != nil {
		t.Fatalf("runMaintenanceOnce() error = %v", err)
	}
	if database.channelCalls != 1 {
		t.Fatalf("SweepExpiredChannels() calls = %d, want 1", database.channelCalls)
	}
	if database.ephemeraCalls != 1 {
		t.Fatalf("SweepExpiredEphemera() calls = %d, want 1", database.ephemeraCalls)
	}
	if !database.now.Equal(now) {
		t.Fatalf("sweep time = %v, want %v", database.now, now)
	}
}

func TestSweepExpiredDataStopsWhenChannelSweepFails(t *testing.T) {
	t.Parallel()

	wantErr := errors.New("database unavailable")
	database := &fakeExpiredDataSweeper{channelsError: wantErr}

	_, err := sweepExpiredData(context.Background(), database, time.Now().UTC())
	if err == nil || !errors.Is(err, wantErr) {
		t.Fatalf("sweepExpiredData() error = %v, want wrapped channel error", err)
	}
	if database.ephemeraCalls != 0 {
		t.Fatalf("SweepExpiredEphemera() calls = %d, want 0", database.ephemeraCalls)
	}
}
