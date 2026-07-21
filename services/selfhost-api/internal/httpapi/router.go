package httpapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/yclgkd/ZeroLink/services/selfhost-api/internal/buildinfo"
	"github.com/yclgkd/ZeroLink/services/selfhost-api/internal/protocol"
	"github.com/yclgkd/ZeroLink/services/selfhost-api/internal/realtime"
	"github.com/yclgkd/ZeroLink/services/selfhost-api/internal/service"
	"github.com/yclgkd/ZeroLink/services/selfhost-api/internal/store/filestore"
)

type Dependencies struct {
	Logger               *slog.Logger
	Services             *service.Container
	AllowedOrigin        string
	Realtime             *realtime.Hub
	FileStore            FileStore
	UploadTokenSecret    string
	FilePolicy           FilePolicy
	TrustedProxyCIDRs    []netip.Prefix
	MaxProtocolBodyBytes int64
}

type FileStore interface {
	Initiate(context.Context, string, int) error
	PutChunk(ctx context.Context, uploadID string, index int, body io.Reader, size int64) (string, error)
	PresignedUpload(context.Context, string, int, int64, time.Duration) (string, error)
	CompleteUpload(context.Context, filestore.FileUploadCompleteRequest) (filestore.MultipartFileRef, error)
	PresignedDownload(context.Context, filestore.MultipartFileRef, int, time.Duration) (string, error)
	GetChunk(ctx context.Context, key string) (io.ReadCloser, error)
	DeleteUpload(context.Context, filestore.MultipartFileRef) error
	UsePresignedURLs() bool
}

type FilePolicy struct {
	MaxFileBytes            int64
	MultipartThresholdBytes int64
	ChunkSizeBytes          int64
	MaxChunks               int64
	MultipartSupported      bool
}

type errorResponse struct {
	OK      bool   `json:"ok"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type statusResponse struct {
	OK        bool              `json:"ok"`
	Service   string            `json:"service"`
	Version   string            `json:"version"`
	Status    string            `json:"status"`
	Timestamp string            `json:"timestamp"`
	Checks    map[string]string `json:"checks,omitempty"`
}

const (
	accessControlAllowHeaders      = "Content-Type"
	accessControlAllowMethods      = "GET,POST,PUT,OPTIONS"
	defaultMaxProtocolBodyBytes    = 64 * 1024
	maxWebSocketClientMessageBytes = defaultMaxProtocolBodyBytes
	fileEnvelopeFixedBytes         = int64(8)
	fileHeaderMaxBytes             = int64(16 * 1024)
	aesGCMTagBytes                 = int64(16)
)

func buildCallerRateLimitSubject(r *http.Request, trustedProxyCIDRs []netip.Prefix) string {
	return extractCallerIP(r, trustedProxyCIDRs) + "|" + normalizeUserAgentFamily(r.UserAgent())
}

func remoteAddrIP(remoteAddr string) (netip.Addr, bool) {
	normalized := strings.TrimSpace(remoteAddr)
	if normalized == "" {
		return netip.Addr{}, false
	}
	if host, _, err := net.SplitHostPort(normalized); err == nil && host != "" {
		normalized = host
	}
	ip, err := netip.ParseAddr(normalized)
	if err != nil {
		return netip.Addr{}, false
	}
	return ip.Unmap(), true
}

func isTrustedProxy(remoteAddr string, trustedProxyCIDRs []netip.Prefix) bool {
	ip, ok := remoteAddrIP(remoteAddr)
	if !ok {
		return false
	}
	for _, prefix := range trustedProxyCIDRs {
		if prefix.Contains(ip) {
			return true
		}
	}
	return false
}

func extractCallerIP(r *http.Request, trustedProxyCIDRs []netip.Prefix) string {
	if r == nil {
		return "unknown"
	}

	if isTrustedProxy(r.RemoteAddr, trustedProxyCIDRs) {
		for _, header := range []string{"CF-Connecting-IP", "X-Forwarded-For", "X-Real-IP"} {
			value := strings.TrimSpace(r.Header.Get(header))
			if value == "" {
				continue
			}
			if header == "X-Forwarded-For" {
				parts := strings.Split(value, ",")
				value = strings.TrimSpace(parts[0])
			}
			if ip, err := netip.ParseAddr(value); err == nil {
				return ip.Unmap().String()
			}
		}
	}

	if ip, ok := remoteAddrIP(r.RemoteAddr); ok {
		return ip.String()
	}
	return "unknown"
}

func isSecureRequest(r *http.Request, trustedProxyCIDRs []netip.Prefix) bool {
	if r != nil && r.TLS != nil {
		return true
	}
	if r == nil || !isTrustedProxy(r.RemoteAddr, trustedProxyCIDRs) {
		return false
	}

	forwardedProto := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto"))
	if forwardedProto == "" {
		return false
	}
	return strings.EqualFold(strings.Split(forwardedProto, ",")[0], "https")
}

func applyCommitCookieSignal(
	w http.ResponseWriter,
	signal *service.CommitCookieSignal,
	uuid string,
	secure bool,
) {
	for _, cookie := range service.BuildCommitCookies(signal, uuid, secure) {
		http.SetCookie(w, cookie)
	}
}

func normalizeUserAgentFamily(userAgent string) string {
	normalized := strings.ToLower(strings.TrimSpace(userAgent))
	if normalized == "" {
		return "unknown"
	}
	if strings.Contains(normalized, "curl/") {
		return "curl"
	}
	if strings.Contains(normalized, "edg/") || strings.Contains(normalized, "edga/") || strings.Contains(normalized, "edgios/") {
		return "edge"
	}
	looksLikeAndroidWebView := strings.Contains(normalized, "android") &&
		(strings.Contains(normalized, "; wv)") ||
			strings.Contains(normalized, " version/") ||
			(strings.Contains(normalized, "version/") && strings.Contains(normalized, "chrome/")))
	if looksLikeAndroidWebView {
		return "android-webview"
	}
	if strings.Contains(normalized, "firefox/") || strings.Contains(normalized, "fxios/") {
		return "firefox"
	}
	if strings.Contains(normalized, "chrome/") || strings.Contains(normalized, "chromium/") || strings.Contains(normalized, "crios/") {
		return "chromium"
	}
	if strings.Contains(normalized, "safari/") || strings.Contains(normalized, "iphone") || strings.Contains(normalized, "ipad") || strings.Contains(normalized, "macintosh") {
		return "safari"
	}
	if strings.HasPrefix(normalized, "mozilla/") {
		return "other"
	}
	return "unknown"
}

func NewRouter(deps Dependencies) http.Handler {
	logger := deps.Logger
	if logger == nil {
		logger = slog.Default()
	}

	mux := http.NewServeMux()
	maxCompoundCommitBodyBytes := deps.MaxProtocolBodyBytes
	if maxCompoundCommitBodyBytes <= 0 {
		maxCompoundCommitBodyBytes = defaultMaxProtocolBodyBytes
	}
	proxyTargets := newProxyTargetAuthorizer(deps.UploadTokenSecret)
	createBeginRateLimiter := newRequestRateLimiter()
	fileInitiateRateLimiter := newRequestRateLimiter()

	mux.HandleFunc("/healthz", methodOnly(http.MethodGet, logger, healthHandler(deps.Services.Health.Live, logger)))
	mux.HandleFunc("/readyz", methodOnly(http.MethodGet, logger, readyHandler(deps.Services.Health, logger)))
	mux.HandleFunc("/api/file_policy", methodOnly(http.MethodGet, logger, filePolicyHandler(deps.FilePolicy, logger)))
	mux.HandleFunc("/api/file/initiate", methodOnly(http.MethodPost, logger, fileInitiateHandler(deps.Services.Protocol, deps.FileStore, deps.FilePolicy, proxyTargets, deps.TrustedProxyCIDRs, fileInitiateRateLimiter, logger, maxCompoundCommitBodyBytes)))
	mux.HandleFunc("/api/file/complete", methodOnly(http.MethodPost, logger, fileCompleteHandler(deps.FileStore, deps.FilePolicy, proxyTargets, logger, maxCompoundCommitBodyBytes)))
	mux.HandleFunc("/api/file/chunk/{token}", methodOnly(http.MethodPut, logger, fileChunkProxyHandler(deps.FileStore, deps.FilePolicy, proxyTargets, logger)))
	mux.HandleFunc("/api/file/fetch/{uuid}", methodOnly(http.MethodGet, logger, fileFetchHandler(deps.Services.Protocol, deps.FileStore, proxyTargets, logger)))
	mux.HandleFunc("/api/file/download/{token}", methodOnly(http.MethodGet, logger, fileDownloadProxyHandler(deps.Services.Protocol, deps.FileStore, proxyTargets, logger)))

	for _, route := range protocol.RouteSpecs() {
		if route.Name == "ws" {
			mux.HandleFunc(
				route.Pattern,
				methodOnly(route.Method, logger, websocketHandler(deps.Services.Protocol, deps.Realtime, logger, deps.AllowedOrigin)),
			)
			continue
		}
		mux.HandleFunc(
			route.Pattern,
			methodOnly(
				route.Method,
				logger,
				protocolHandler(
					route.Name,
					deps.Services.Protocol,
					logger,
					deps.TrustedProxyCIDRs,
					createBeginRateLimiter,
					maxCompoundCommitBodyBytes,
				),
			),
		)
	}

	mux.HandleFunc("/", notFound(logger))

	return loggingMiddleware(
		securityHeadersMiddleware(recoverMiddleware(mux, logger), deps.AllowedOrigin),
		logger,
	)
}

func healthHandler(load func() service.Status, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		status := load()
		writeJSON(logger, w, http.StatusOK, statusResponse{
			OK:        status.OK,
			Service:   buildinfo.ServiceName,
			Version:   buildinfo.Version,
			Status:    status.Status,
			Timestamp: status.Timestamp.Format(time.RFC3339Nano),
			Checks:    status.Checks,
		})
	}
}

func readyHandler(health *service.HealthService, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := health.Ready(r.Context())
		httpStatus := http.StatusOK
		if !status.OK {
			httpStatus = http.StatusServiceUnavailable
		}

		writeJSON(logger, w, httpStatus, statusResponse{
			OK:        status.OK,
			Service:   buildinfo.ServiceName,
			Version:   buildinfo.Version,
			Status:    status.Status,
			Timestamp: status.Timestamp.Format(time.RFC3339Nano),
			Checks:    status.Checks,
		})
	}
}

func protocolPlaceholder(routeName string, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeError(logger, w, http.StatusNotImplemented, "NOT_IMPLEMENTED", routeName+" is not implemented yet")
	}
}

func protocolHandler(
	routeName string,
	protocolService service.Protocol,
	logger *slog.Logger,
	trustedProxyCIDRs []netip.Prefix,
	createBeginRateLimiter *requestRateLimiter,
	maxCompoundCommitBodyBytes int64,
) http.HandlerFunc {
	if protocolService == nil {
		return protocolPlaceholder(routeName, logger)
	}

	switch routeName {
	case "create_begin":
		return createBeginHandler(protocolService, logger, trustedProxyCIDRs, createBeginRateLimiter, defaultMaxProtocolBodyBytes)
	case "create_finish":
		return createFinishHandler(protocolService, logger, defaultMaxProtocolBodyBytes)
	case "lock_begin":
		return lockBeginHandler(protocolService, logger, trustedProxyCIDRs, defaultMaxProtocolBodyBytes)
	case "lock_commit":
		return lockCommitHandler(protocolService, logger, trustedProxyCIDRs, defaultMaxProtocolBodyBytes)
	case "compound_begin":
		return compoundBeginHandler(protocolService, logger, trustedProxyCIDRs, defaultMaxProtocolBodyBytes)
	case "compound_commit":
		return compoundCommitHandler(protocolService, logger, trustedProxyCIDRs, false, maxCompoundCommitBodyBytes)
	case "delete_commit":
		return compoundCommitHandler(protocolService, logger, trustedProxyCIDRs, true, defaultMaxProtocolBodyBytes)
	case "public_status":
		return publicStatusHandler(protocolService, logger)
	case "decrypt_fetch":
		return decryptFetchHandler(protocolService, logger)
	default:
		return protocolPlaceholder(routeName, logger)
	}
}

func filePolicyHandler(filePolicy FilePolicy, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(logger, w, http.StatusOK, map[string]any{
			"ok": true,
			"policy": map[string]any{
				"maxFileBytes":            filePolicy.MaxFileBytes,
				"multipartThresholdBytes": filePolicy.MultipartThresholdBytes,
				"chunkSizeBytes":          filePolicy.ChunkSizeBytes,
				"maxChunks":               filePolicy.MaxChunks,
				"multipartSupported":      filePolicy.MultipartSupported,
			},
		})
	}
}

func resolveMaxMultipartPlaintextBytes(maxFileBytes int64) int64 {
	return maxFileBytes + fileEnvelopeFixedBytes + fileHeaderMaxBytes
}

func resolveMaxMultipartCiphertextBytes(maxFileBytes int64, chunkCount int) int64 {
	return resolveMaxMultipartPlaintextBytes(maxFileBytes) + int64(chunkCount)*aesGCMTagBytes
}

func resolveMultipartPlaintextBytes(totalCiphertextBytes int64, chunkCount int) (int64, bool) {
	if chunkCount <= 0 {
		return 0, false
	}
	totalPlaintextBytes := totalCiphertextBytes - int64(chunkCount)*aesGCMTagBytes
	if totalPlaintextBytes <= 0 {
		return 0, false
	}
	return totalPlaintextBytes, true
}

func resolveExpectedChunkCiphertextBytes(
	totalPlaintextBytes int64,
	chunkSizeBytes int64,
	chunkCount int,
	index int,
) (int64, bool) {
	if index < 0 || index >= chunkCount {
		return 0, false
	}
	if index < chunkCount-1 {
		return chunkSizeBytes + aesGCMTagBytes, true
	}

	lastChunkPlaintextBytes := totalPlaintextBytes - int64(chunkCount-1)*chunkSizeBytes
	if lastChunkPlaintextBytes <= 0 || lastChunkPlaintextBytes > chunkSizeBytes {
		return 0, false
	}
	return lastChunkPlaintextBytes + aesGCMTagBytes, true
}

func fileInitiateHandler(
	protocolService service.Protocol,
	fileStore FileStore,
	filePolicy FilePolicy,
	proxyTargets *proxyTargetAuthorizer,
	trustedProxyCIDRs []netip.Prefix,
	rateLimiter *requestRateLimiter,
	logger *slog.Logger,
	maxProtocolBodyBytes int64,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if fileStore == nil {
			writeError(logger, w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "file storage backend is not configured")
			return
		}
		if protocolService == nil {
			writeError(logger, w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "protocol service is not configured")
			return
		}

		var input filestore.FileUploadInitiateRequest
		if !decodeJSONBody(w, r, &input, logger, maxProtocolBodyBytes) {
			return
		}
		if err := input.Validate(); err != nil {
			writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
			return
		}
		if !filePolicy.MultipartSupported {
			writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", "multipart file delivery is disabled")
			return
		}
		if int64(input.ChunkCount) > filePolicy.MaxChunks {
			writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", "chunkCount exceeds deployment file policy")
			return
		}
		if input.TotalCiphertextBytes > resolveMaxMultipartCiphertextBytes(filePolicy.MaxFileBytes, input.ChunkCount) {
			writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", "totalCiphertextBytes exceeds deployment file policy")
			return
		}
		if _, err := protocolService.PublicStatus(r.Context(), input.ChannelUUID); err != nil {
			writeProtocolError(logger, w, err)
			return
		}
		rateLimitSubject := input.ChannelUUID + ":public:" + buildCallerRateLimitSubject(r, trustedProxyCIDRs)
		if retryAfterSeconds, limited := rateLimiter.Enforce(rateLimitSubject, time.Now(), fileInitiateRateLimitConfig); limited {
			w.Header().Set("Retry-After", strconv.Itoa(retryAfterSeconds))
			writeError(logger, w, http.StatusTooManyRequests, "RATE_LIMITED", "file initiate rate limit exceeded")
			return
		}
		totalPlaintextBytes, ok := resolveMultipartPlaintextBytes(input.TotalCiphertextBytes, input.ChunkCount)
		if !ok {
			writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", "totalCiphertextBytes does not match multipart boundaries")
			return
		}

		uploadID, err := proxyTargets.IssueUploadSession(
			input.ChannelUUID,
			input.ChunkCount,
			input.TotalCiphertextBytes,
			proxyUploadTargetTTL,
		)
		if err != nil {
			writeError(logger, w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to generate upload id")
			return
		}
		if err := fileStore.Initiate(r.Context(), uploadID, input.ChunkCount); err != nil {
			proxyTargets.RevokeUpload(uploadID)
			writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
			return
		}

		chunks := make([]filestore.FileUploadChunkTarget, 0, input.ChunkCount)
		usePresigned := fileStore.UsePresignedURLs()
		for index := 0; index < input.ChunkCount; index++ {
			expectedCiphertextBytes, valid := resolveExpectedChunkCiphertextBytes(
				totalPlaintextBytes,
				filePolicy.ChunkSizeBytes,
				input.ChunkCount,
				index,
			)
			if !valid {
				writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", "totalCiphertextBytes does not match multipart boundaries")
				return
			}

			var uploadURL string
			if usePresigned {
				uploadURL, err = fileStore.PresignedUpload(
					r.Context(),
					uploadID,
					index,
					expectedCiphertextBytes,
					proxyUploadTargetTTL,
				)
				if err != nil {
					writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
					return
				}
			} else {
				token, err := proxyTargets.IssueUploadTarget(uploadID, index, proxyUploadTargetTTL)
				if err != nil {
					writeError(logger, w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to issue upload target")
					return
				}
				uploadURL = buildProxyUploadURL(token)
			}
			chunks = append(chunks, filestore.FileUploadChunkTarget{Index: index, UploadURL: uploadURL})
		}

		writeJSON(logger, w, http.StatusOK, filestore.FileUploadInitiateResponse{
			OK:       true,
			UploadID: uploadID,
			Chunks:   chunks,
		})
	}
}

func fileCompleteHandler(
	fileStore FileStore,
	filePolicy FilePolicy,
	proxyTargets *proxyTargetAuthorizer,
	logger *slog.Logger,
	maxProtocolBodyBytes int64,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if fileStore == nil {
			writeError(logger, w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "file storage backend is not configured")
			return
		}

		var input filestore.FileUploadCompleteRequest
		if !decodeJSONBody(w, r, &input, logger, maxProtocolBodyBytes) {
			return
		}
		if err := input.Validate(); err != nil {
			writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
			return
		}
		session, ok := proxyTargets.UploadSessionForCompletion(input.UploadID)
		if !ok {
			writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", "upload session expired or not found")
			return
		}
		if input.ChunkSizeBytes != filePolicy.ChunkSizeBytes {
			writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", "chunkSizeBytes exceeds deployment file policy")
			return
		}
		if int64(session.chunkCount) > filePolicy.MaxChunks {
			writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", "chunkCount exceeds deployment file policy")
			return
		}
		if input.TotalPlaintextBytes > resolveMaxMultipartPlaintextBytes(filePolicy.MaxFileBytes) {
			writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", "totalPlaintextBytes exceeds deployment file policy")
			return
		}
		if input.TotalCiphertextBytes != input.TotalPlaintextBytes+int64(session.chunkCount)*aesGCMTagBytes {
			writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", "totalCiphertextBytes does not match multipart boundaries")
			return
		}
		if len(input.Chunks) != session.chunkCount {
			writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", "chunkCount does not match upload session")
			return
		}
		if input.TotalCiphertextBytes != session.totalCiphertextBytes {
			writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", "totalCiphertextBytes does not match upload session")
			return
		}
		for index, chunk := range input.Chunks {
			if chunk.Index != index {
				writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", "chunks must be ordered")
				return
			}
			expectedCiphertextBytes, valid := resolveExpectedChunkCiphertextBytes(
				input.TotalPlaintextBytes,
				input.ChunkSizeBytes,
				session.chunkCount,
				chunk.Index,
			)
			if !valid || chunk.CiphertextBytes != expectedCiphertextBytes {
				writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", "chunks do not match multipart boundaries")
				return
			}
		}

		fileRef, err := fileStore.CompleteUpload(r.Context(), input)
		if err != nil {
			if errors.Is(err, filestore.ErrUploadInProgress) {
				writeError(logger, w, http.StatusConflict, "UPLOAD_IN_PROGRESS", "upload finalization in progress")
				return
			}
			writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
			return
		}
		proxyTargets.RevokeUpload(input.UploadID)

		writeJSON(logger, w, http.StatusOK, filestore.FileUploadCompleteResponse{
			OK:      true,
			FileRef: fileRef,
		})
	}
}

func fileFetchHandler(
	protocolService service.Protocol,
	fileStore FileStore,
	proxyTargets *proxyTargetAuthorizer,
	logger *slog.Logger,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if fileStore == nil {
			writeError(logger, w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "file storage backend is not configured")
			return
		}
		if protocolService == nil {
			writeError(logger, w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "protocol service is not configured")
			return
		}

		output, err := protocolService.DecryptFetch(r.Context(), r.PathValue("uuid"))
		if err != nil {
			writeProtocolError(logger, w, err)
			return
		}
		if output.FileRef == nil {
			writeError(logger, w, http.StatusNotFound, "NOT_FOUND", "file payload is not available")
			return
		}

		usePresigned := fileStore.UsePresignedURLs()
		chunks := make([]filestore.FileDownloadChunkTarget, 0, len(output.FileRef.Chunks))
		for _, chunk := range output.FileRef.Chunks {
			var downloadURL string
			if usePresigned {
				u, err := fileStore.PresignedDownload(r.Context(), *output.FileRef, chunk.Index, 5*time.Minute)
				if err != nil {
					writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
					return
				}
				downloadURL = u
			} else {
				token, err := proxyTargets.IssueDownloadTarget(
					r.PathValue("uuid"),
					output.CipherVersion,
					chunk.Index,
					chunk.StorageKey,
					chunk.CiphertextHash,
					proxyDownloadTargetTTL,
				)
				if err != nil {
					writeError(logger, w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to issue download target")
					return
				}
				downloadURL = buildProxyDownloadURL(token)
			}
			chunks = append(chunks, filestore.FileDownloadChunkTarget{
				Index:       chunk.Index,
				DownloadURL: downloadURL,
			})
		}

		writeJSON(logger, w, http.StatusOK, filestore.FileFetchResponse{
			OK:     true,
			Chunks: chunks,
		})
	}
}

func fileChunkProxyHandler(
	fileStore FileStore,
	filePolicy FilePolicy,
	proxyTargets *proxyTargetAuthorizer,
	logger *slog.Logger,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if fileStore == nil {
			writeError(logger, w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "file storage backend is not configured")
			return
		}
		if !filePolicy.MultipartSupported {
			writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", "multipart file delivery is disabled")
			return
		}
		target, ok := proxyTargets.UploadTarget(r.PathValue("token"))
		if !ok {
			writeError(logger, w, http.StatusNotFound, "NOT_FOUND", "upload target not found")
			return
		}
		session, ok := proxyTargets.UploadSession(target.uploadID)
		if !ok || target.index >= session.chunkCount {
			writeError(logger, w, http.StatusNotFound, "NOT_FOUND", "upload target not found")
			return
		}
		body := http.MaxBytesReader(w, r.Body, filePolicy.ChunkSizeBytes+aesGCMTagBytes)
		defer body.Close()
		payload, err := io.ReadAll(body)
		if err != nil {
			writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", "chunk exceeds deployment file policy")
			return
		}
		if len(payload) == 0 {
			writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", "chunk body is required")
			return
		}
		etag, err := fileStore.PutChunk(
			r.Context(),
			target.uploadID,
			target.index,
			bytes.NewReader(payload),
			int64(len(payload)),
		)
		if err != nil {
			if errors.Is(err, filestore.ErrUploadCompleted) {
				writeError(logger, w, http.StatusNotFound, "NOT_FOUND", "upload target not found")
				return
			}
			writeError(logger, w, http.StatusBadGateway, "STORAGE_ERROR", err.Error())
			return
		}
		w.Header().Set("ETag", etag)
		writeJSON(logger, w, http.StatusOK, map[string]any{"ok": true, "etag": etag})
	}
}

func fileDownloadProxyHandler(
	protocolService service.Protocol,
	fileStore FileStore,
	proxyTargets *proxyTargetAuthorizer,
	logger *slog.Logger,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if protocolService == nil {
			writeError(logger, w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "protocol service is not configured")
			return
		}
		if fileStore == nil {
			writeError(logger, w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "file storage backend is not configured")
			return
		}
		target, ok := proxyTargets.DownloadTarget(r.PathValue("token"))
		if !ok {
			writeError(logger, w, http.StatusNotFound, "NOT_FOUND", "download target not found")
			return
		}

		output, err := protocolService.DecryptFetch(r.Context(), target.channelUUID)
		if err != nil || output.FileRef == nil || output.CipherVersion != target.cipherVersion {
			writeError(logger, w, http.StatusNotFound, "NOT_FOUND", "download target not found")
			return
		}
		if target.index >= len(output.FileRef.Chunks) {
			writeError(logger, w, http.StatusNotFound, "NOT_FOUND", "download target not found")
			return
		}
		chunk := output.FileRef.Chunks[target.index]
		if chunk.StorageKey != target.storageKey || chunk.CiphertextHash != target.ciphertextHash {
			writeError(logger, w, http.StatusNotFound, "NOT_FOUND", "download target not found")
			return
		}

		rc, err := fileStore.GetChunk(r.Context(), chunk.StorageKey)
		if err != nil {
			writeError(logger, w, http.StatusBadGateway, "STORAGE_ERROR", err.Error())
			return
		}
		defer rc.Close()
		buffered := bufio.NewReader(rc)
		if _, err := buffered.Peek(1); err != nil {
			writeError(logger, w, http.StatusBadGateway, "STORAGE_ERROR", err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		if _, err := io.Copy(w, buffered); err != nil {
			logger.Error("stream download chunk", "error", err)
		}
	}
}

func websocketPlaceholder(logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !isWebSocketUpgrade(r) {
			w.Header().Set("Connection", "Upgrade")
			w.Header().Set("Upgrade", "websocket")
			writeError(logger, w, http.StatusUpgradeRequired, "BAD_REQUEST", "websocket upgrade required")
			return
		}

		writeError(logger, w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "realtime websocket endpoint is not implemented yet")
	}
}

func notFound(logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeError(logger, w, http.StatusNotFound, "NOT_FOUND", "route not found")
	}
}

func methodOnly(method string, logger *slog.Logger, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != method {
			w.Header().Set("Allow", method)
			writeError(logger, w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "method not allowed")
			return
		}
		next(w, r)
	}
}

func writeError(logger *slog.Logger, w http.ResponseWriter, status int, code, message string) {
	writeJSON(logger, w, status, errorResponse{
		OK:      false,
		Code:    code,
		Message: message,
	})
}

func writeJSON(logger *slog.Logger, w http.ResponseWriter, status int, payload any) {
	if logger == nil {
		logger = slog.Default()
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		logger.Error("encode json response", "error", err)
	}
}

func createBeginHandler(
	protocolService service.Protocol,
	logger *slog.Logger,
	trustedProxyCIDRs []netip.Prefix,
	rateLimiter *requestRateLimiter,
	maxProtocolBodyBytes int64,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var input service.CreateBeginInput
		if !decodeJSONBody(w, r, &input, logger, maxProtocolBodyBytes) {
			return
		}

		if input.UUID != r.PathValue("uuid") {
			writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", "path/body uuid mismatch")
			return
		}
		// Channel creation abuse is caller-scoped, so enforce before the request reaches per-UUID service state.
		rateLimitSubject := buildCallerRateLimitSubject(r, trustedProxyCIDRs)
		if retryAfterSeconds, limited := rateLimiter.Enforce(rateLimitSubject, time.Now(), createBeginRateLimitConfig); limited {
			w.Header().Set("Retry-After", strconv.Itoa(retryAfterSeconds))
			writeError(logger, w, http.StatusTooManyRequests, "RATE_LIMITED", "create begin rate limit exceeded")
			return
		}

		output, err := protocolService.CreateBegin(r.Context(), input)
		if err != nil {
			writeProtocolError(logger, w, err)
			return
		}

		writeJSON(logger, w, http.StatusOK, output)
	}
}

func createFinishHandler(protocolService service.Protocol, logger *slog.Logger, maxProtocolBodyBytes int64) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var input service.CreateFinishInput
		if !decodeJSONBody(w, r, &input, logger, maxProtocolBodyBytes) {
			return
		}

		if input.UUID != r.PathValue("uuid") {
			writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", "path/body uuid mismatch")
			return
		}

		output, err := protocolService.CreateFinish(r.Context(), input)
		if err != nil {
			writeProtocolError(logger, w, err)
			return
		}

		writeJSON(logger, w, http.StatusOK, output)
	}
}

func publicStatusHandler(protocolService service.Protocol, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		output, err := protocolService.PublicStatus(r.Context(), r.PathValue("uuid"))
		if err != nil {
			writeProtocolError(logger, w, err)
			return
		}

		writeJSON(logger, w, http.StatusOK, output)
	}
}

func lockBeginHandler(
	protocolService service.Protocol,
	logger *slog.Logger,
	trustedProxyCIDRs []netip.Prefix,
	maxProtocolBodyBytes int64,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var input service.LockBeginInput
		if !decodeJSONBody(w, r, &input, logger, maxProtocolBodyBytes) {
			return
		}

		if input.UUID != r.PathValue("uuid") {
			writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", "path/body uuid mismatch")
			return
		}
		input.RateLimitSubject = buildCallerRateLimitSubject(r, trustedProxyCIDRs)
		secure := isSecureRequest(r, trustedProxyCIDRs)

		output, err := protocolService.LockBegin(r.Context(), input)
		if err != nil {
			writeProtocolErrorWithCommitCookie(logger, w, err, input.UUID, secure)
			return
		}
		applyCommitCookieSignal(w, output.CommitCookieSignal, input.UUID, secure)

		writeJSON(logger, w, http.StatusOK, output)
	}
}

func lockCommitHandler(
	protocolService service.Protocol,
	logger *slog.Logger,
	trustedProxyCIDRs []netip.Prefix,
	maxProtocolBodyBytes int64,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var input service.LockCommitInput
		if !decodeJSONBody(w, r, &input, logger, maxProtocolBodyBytes) {
			return
		}

		if input.UUID != r.PathValue("uuid") {
			writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", "path/body uuid mismatch")
			return
		}
		input.RateLimitSubject = buildCallerRateLimitSubject(r, trustedProxyCIDRs)
		input.CommitToken = service.ReadCommitToken(r, service.CommitCookieKindLock)
		secure := isSecureRequest(r, trustedProxyCIDRs)

		output, err := protocolService.LockCommit(r.Context(), input)
		if err != nil {
			writeProtocolErrorWithCommitCookie(logger, w, err, input.UUID, secure)
			return
		}
		applyCommitCookieSignal(w, output.CommitCookieSignal, input.UUID, secure)

		writeJSON(logger, w, http.StatusOK, output)
	}
}

func compoundBeginHandler(
	protocolService service.Protocol,
	logger *slog.Logger,
	trustedProxyCIDRs []netip.Prefix,
	maxProtocolBodyBytes int64,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var input service.CompoundBeginInput
		if !decodeJSONBody(w, r, &input, logger, maxProtocolBodyBytes) {
			return
		}

		if input.UUID != r.PathValue("uuid") {
			writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", "path/body uuid mismatch")
			return
		}
		input.RateLimitSubject = buildCallerRateLimitSubject(r, trustedProxyCIDRs)
		secure := isSecureRequest(r, trustedProxyCIDRs)

		output, err := protocolService.CompoundBegin(r.Context(), input)
		if err != nil {
			writeProtocolErrorWithCommitCookie(logger, w, err, input.UUID, secure)
			return
		}
		applyCommitCookieSignal(w, output.CommitCookieSignal, input.UUID, secure)

		writeJSON(logger, w, http.StatusOK, output)
	}
}

func compoundCommitHandler(
	protocolService service.Protocol,
	logger *slog.Logger,
	trustedProxyCIDRs []netip.Prefix,
	deleteOnly bool,
	maxProtocolBodyBytes int64,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var input service.CompoundCommitInput
		if !decodeJSONBody(w, r, &input, logger, maxProtocolBodyBytes) {
			return
		}

		if input.UUID != r.PathValue("uuid") || input.Intent.UUID != r.PathValue("uuid") {
			writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", "path/body uuid mismatch")
			return
		}
		if deleteOnly && input.Intent.Op != "delete" {
			writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", "delete alias requires delete intent")
			return
		}
		input.RateLimitSubject = buildCallerRateLimitSubject(r, trustedProxyCIDRs)
		input.CommitToken = service.ReadCommitToken(r, service.CommitCookieKindCompound)
		secure := isSecureRequest(r, trustedProxyCIDRs)

		output, err := protocolService.CompoundCommit(r.Context(), input)
		if err != nil {
			writeProtocolErrorWithCommitCookie(logger, w, err, input.UUID, secure)
			return
		}
		applyCommitCookieSignal(w, output.CommitCookieSignal, input.UUID, secure)

		writeJSON(logger, w, http.StatusOK, output)
	}
}

func decryptFetchHandler(protocolService service.Protocol, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		output, err := protocolService.DecryptFetch(r.Context(), r.PathValue("uuid"))
		if err != nil {
			writeProtocolError(logger, w, err)
			return
		}

		writeJSON(logger, w, http.StatusOK, output)
	}
}

func writeProtocolError(logger *slog.Logger, w http.ResponseWriter, err error) {
	if logger == nil {
		logger = slog.Default()
	}

	var protocolErr *service.ProtocolError
	if errors.As(err, &protocolErr) {
		if protocolErr.Status >= http.StatusInternalServerError {
			cause := err
			if protocolErr.Cause != nil {
				cause = protocolErr.Cause
			}
			logger.Error(
				"protocol request failed",
				"code", protocolErr.Code,
				"status", protocolErr.Status,
				"error", cause,
			)
		}
		if protocolErr.RetryAfterSeconds > 0 {
			w.Header().Set("Retry-After", strconv.Itoa(protocolErr.RetryAfterSeconds))
		}
		writeError(logger, w, protocolErr.Status, protocolErr.Code, protocolErr.Message)
		return
	}

	logger.Error("protocol request failed", "status", http.StatusInternalServerError, "error", err)
	writeError(logger, w, http.StatusInternalServerError, "INTERNAL_ERROR", "unexpected internal error")
}

func writeProtocolErrorWithCommitCookie(
	logger *slog.Logger,
	w http.ResponseWriter,
	err error,
	uuid string,
	secure bool,
) {
	var protocolErr *service.ProtocolError
	if errors.As(err, &protocolErr) && protocolErr.CommitCookieSignal != nil && uuid != "" {
		applyCommitCookieSignal(w, protocolErr.CommitCookieSignal, uuid, secure)
	}
	writeProtocolError(logger, w, err)
}

func decodeJSONBody(w http.ResponseWriter, r *http.Request, dst any, logger *slog.Logger, maxBytes int64) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	defer r.Body.Close()

	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(dst); err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			writeError(logger, w, http.StatusRequestEntityTooLarge, "BAD_REQUEST", "request body too large")
			return false
		}
		writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", "invalid json body")
		return false
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		writeError(logger, w, http.StatusBadRequest, "BAD_REQUEST", "invalid json body")
		return false
	}
	return true
}

func securityHeadersMiddleware(next http.Handler, allowedOrigin string) http.Handler {
	allowedOrigin = normalizeOrigin(allowedOrigin)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")

		requestOrigin := normalizeOrigin(r.Header.Get("Origin"))
		if allowedOrigin != "" && requestOrigin == allowedOrigin {
			w.Header().Set("Access-Control-Allow-Origin", allowedOrigin)
			w.Header().Set("Access-Control-Allow-Methods", accessControlAllowMethods)
			w.Header().Set("Access-Control-Allow-Headers", accessControlAllowHeaders)
			w.Header().Add("Vary", "Origin")
		}

		if r.Method == http.MethodOptions && allowedOrigin != "" && strings.HasPrefix(r.URL.Path, "/api/") && requestOrigin == allowedOrigin {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func normalizeOrigin(value string) string {
	return strings.TrimRight(strings.TrimSpace(value), "/")
}

func isWebSocketUpgrade(r *http.Request) bool {
	return headerContainsToken(r.Header, "Connection", "upgrade") &&
		strings.EqualFold(strings.TrimSpace(r.Header.Get("Upgrade")), "websocket")
}

func headerContainsToken(header http.Header, key, expected string) bool {
	for _, part := range strings.Split(header.Get(key), ",") {
		if strings.EqualFold(strings.TrimSpace(part), expected) {
			return true
		}
	}
	return false
}
