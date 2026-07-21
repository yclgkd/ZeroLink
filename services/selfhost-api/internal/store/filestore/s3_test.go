package filestore

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

type fakeS3Object struct {
	etag string
	size int64
}

type fakeS3Server struct {
	t                      *testing.T
	mu                     sync.Mutex
	objects                map[string]fakeS3Object
	mutateSourceBeforeCopy bool
	copySourceIfMatches    []string
}

func newFakeS3Server(t *testing.T) *fakeS3Server {
	t.Helper()
	return &fakeS3Server{
		t:       t,
		objects: make(map[string]fakeS3Object),
	}
}

func (s *fakeS3Server) objectKey(r *http.Request) string {
	const bucketPrefix = "/bucket/"
	encodedKey := strings.TrimPrefix(r.URL.EscapedPath(), bucketPrefix)
	key, err := url.PathUnescape(encodedKey)
	if err != nil {
		s.t.Fatalf("decode object key %q: %v", encodedKey, err)
	}
	return key
}

func (s *fakeS3Server) sourceObjectKey(r *http.Request) string {
	source := strings.TrimPrefix(r.Header.Get("X-Amz-Copy-Source"), "/")
	source = strings.TrimPrefix(source, "bucket/")
	key, err := url.PathUnescape(source)
	if err != nil {
		s.t.Fatalf("decode copy source %q: %v", source, err)
	}
	return key
}

func (s *fakeS3Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if r.URL.Query().Has("location") {
		w.Header().Set("Content-Type", "application/xml")
		_, _ = fmt.Fprint(w, "<LocationConstraint>us-east-1</LocationConstraint>")
		return
	}

	switch r.Method {
	case http.MethodHead, http.MethodGet:
		object, ok := s.objects[s.objectKey(r)]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("ETag", fmt.Sprintf("%q", object.etag))
		w.Header().Set("Content-Length", fmt.Sprintf("%d", object.size))
		w.Header().Set("Last-Modified", time.Now().UTC().Format(http.TimeFormat))
		w.WriteHeader(http.StatusOK)
	case http.MethodPut:
		if r.Header.Get("X-Amz-Copy-Source") == "" {
			key := s.objectKey(r)
			if r.Header.Get("If-None-Match") == "*" && s.objects[key].etag != "" {
				w.WriteHeader(http.StatusPreconditionFailed)
				return
			}
			body, err := io.ReadAll(r.Body)
			if err != nil {
				s.t.Fatalf("read put body: %v", err)
			}
			s.objects[key] = fakeS3Object{etag: "marker-etag", size: int64(len(body))}
			w.Header().Set("ETag", `"marker-etag"`)
			w.WriteHeader(http.StatusOK)
			return
		}
		sourceKey := s.sourceObjectKey(r)
		source, ok := s.objects[sourceKey]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if s.mutateSourceBeforeCopy {
			source.etag = "changed-etag"
			s.objects[sourceKey] = source
			s.mutateSourceBeforeCopy = false
		}
		match := r.Header.Get("X-Amz-Copy-Source-If-Match")
		s.copySourceIfMatches = append(s.copySourceIfMatches, match)
		if match != "" && strings.Trim(match, "\"") != source.etag {
			w.WriteHeader(http.StatusPreconditionFailed)
			return
		}
		destinationKey := s.objectKey(r)
		s.objects[destinationKey] = source
		w.Header().Set("Content-Type", "application/xml")
		_, _ = fmt.Fprintf(
			w,
			"<CopyObjectResult><ETag>\"%s\"</ETag><LastModified>%s</LastModified></CopyObjectResult>",
			source.etag,
			time.Now().UTC().Format(time.RFC3339),
		)
	case http.MethodDelete:
		delete(s.objects, s.objectKey(r))
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func newTestS3Store(t *testing.T, fake *fakeS3Server) (*Store, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(fake)
	serverURL, err := url.Parse(server.URL)
	if err != nil {
		server.Close()
		t.Fatalf("parse fake s3 server url: %v", err)
	}
	client, err := minio.New(serverURL.Host, &minio.Options{
		Creds:  credentials.NewStaticV4("access", "secret", ""),
		Secure: false,
	})
	if err != nil {
		server.Close()
		t.Fatalf("create minio client: %v", err)
	}
	return &Store{client: client, bucket: "bucket"}, server
}

func testCompleteUploadRequest() FileUploadCompleteRequest {
	return FileUploadCompleteRequest{
		UploadID:             "upload-1",
		BaseIV:               "YmFzZS1pdg",
		EncContentKey:        "ZW5jLWtleQ",
		ChunkSizeBytes:       8,
		TotalPlaintextBytes:  8,
		TotalCiphertextBytes: 24,
		Chunks: []FileUploadCompleteChunk{
			{
				Index:           0,
				ETag:            "etag-0",
				CiphertextBytes: 24,
				CiphertextHash:  strings.Repeat("a", 64),
			},
		},
	}
}

func TestCompleteUploadRequiresSourceETagToRemainStable(t *testing.T) {
	fake := newFakeS3Server(t)
	fake.objects[uploadObjectKey("upload-1", 0)] = fakeS3Object{etag: "etag-0", size: 24}
	fake.mutateSourceBeforeCopy = true
	store, server := newTestS3Store(t, fake)
	defer server.Close()

	_, err := store.CompleteUpload(context.Background(), testCompleteUploadRequest())
	if err == nil {
		t.Fatal("CompleteUpload() error = nil, want source precondition failure")
	}
	if len(fake.copySourceIfMatches) != 1 || fake.copySourceIfMatches[0] != "etag-0" {
		t.Fatalf("copy source If-Match = %v, want [etag-0]", fake.copySourceIfMatches)
	}
}

func TestCompleteUploadIsIdempotentAfterFinalization(t *testing.T) {
	fake := newFakeS3Server(t)
	fake.objects[uploadObjectKey("upload-1", 0)] = fakeS3Object{etag: "etag-0", size: 24}
	store, server := newTestS3Store(t, fake)
	defer server.Close()

	request := testCompleteUploadRequest()
	first, err := store.CompleteUpload(context.Background(), request)
	if err != nil {
		t.Fatalf("first CompleteUpload() error = %v", err)
	}
	second, err := store.CompleteUpload(context.Background(), request)
	if err != nil {
		t.Fatalf("retry CompleteUpload() error = %v", err)
	}
	if len(fake.copySourceIfMatches) != 1 {
		t.Fatalf("copy calls = %d, want 1", len(fake.copySourceIfMatches))
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("file refs differ: first=%#v second=%#v", first, second)
	}
}

func TestFileUploadInitiateRequestValidateAcceptsNanoIDUUID(t *testing.T) {
	t.Parallel()

	req := FileUploadInitiateRequest{
		ChannelUUID:          "aaaaaaaaaaaaaaaaaaaaa",
		ChunkCount:           1,
		TotalCiphertextBytes: 32,
	}

	if err := req.Validate(); err != nil {
		t.Fatalf("Validate() error = %v, want nil", err)
	}
}

func TestFileUploadInitiateRequestValidateRejectsWrongLengthUUID(t *testing.T) {
	t.Parallel()

	req := FileUploadInitiateRequest{
		ChannelUUID:          "short",
		ChunkCount:           1,
		TotalCiphertextBytes: 32,
	}

	if err := req.Validate(); err == nil {
		t.Fatal("Validate() error = nil, want invalid uuid error")
	}
}

func TestParseS3EndpointAcceptsHostWithoutScheme(t *testing.T) {
	t.Parallel()

	endpoint, useSSL, err := parseS3Endpoint("garage:3900", false)
	if err != nil {
		t.Fatalf("parseS3Endpoint() error = %v, want nil", err)
	}
	if endpoint != "garage:3900" {
		t.Fatalf("endpoint = %q, want garage:3900", endpoint)
	}
	if useSSL {
		t.Fatal("useSSL = true, want false")
	}
}

func TestParseS3EndpointAcceptsHTTPSURL(t *testing.T) {
	t.Parallel()

	endpoint, useSSL, err := parseS3Endpoint("https://files.example.com", false)
	if err != nil {
		t.Fatalf("parseS3Endpoint() error = %v, want nil", err)
	}
	if endpoint != "files.example.com" {
		t.Fatalf("endpoint = %q, want files.example.com", endpoint)
	}
	if !useSSL {
		t.Fatal("useSSL = false, want true")
	}
}

func TestParseS3EndpointRejectsPath(t *testing.T) {
	t.Parallel()

	if _, _, err := parseS3Endpoint("https://files.example.com/storage", true); err == nil {
		t.Fatal("parseS3Endpoint() error = nil, want invalid path error")
	}
}
