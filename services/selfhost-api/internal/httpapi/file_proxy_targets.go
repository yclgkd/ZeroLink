package httpapi

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/yclgkd/ZeroLink/services/selfhost-api/internal/store/filestore"
)

const (
	proxyUploadTargetTTL    = 15 * time.Minute
	proxyDownloadTargetTTL  = 5 * time.Minute
	uploadSessionTokenV1    = "1"
	uploadSessionDomain     = "zerolink:selfhost:file-upload:"
	uploadTargetTokenV1     = "1"
	uploadTargetTokenDomain = "zerolink:selfhost:file-upload-target:"
	downloadTargetTokenV1   = "1"
	downloadTargetDomain    = "zerolink:selfhost:file-download-target:"
)

type proxyUploadTarget struct {
	uploadID    string
	channelUUID string
	index       int
	issuedAt    time.Time
	expiresAt   time.Time
}

type uploadSession struct {
	channelUUID          string
	chunkCount           int
	totalCiphertextBytes int64
	issuedAt             time.Time
	expiresAt            time.Time
	nonce                string
}

type uploadSessionToken struct {
	V                    string `json:"v"`
	ChannelUUID          string `json:"channelUuid"`
	ChunkCount           int    `json:"chunkCount"`
	TotalCiphertextBytes int64  `json:"totalCiphertextBytes"`
	IssuedAt             int64  `json:"issuedAt"`
	ExpiresAt            int64  `json:"expiresAt"`
	Nonce                string `json:"nonce"`
}

type proxyUploadTargetToken struct {
	V           string `json:"v"`
	UploadID    string `json:"uploadId"`
	ChannelUUID string `json:"channelUuid"`
	Index       int    `json:"index"`
	IssuedAt    int64  `json:"issuedAt"`
	ExpiresAt   int64  `json:"expiresAt"`
}

type proxyDownloadTarget struct {
	channelUUID    string
	cipherVersion  int64
	index          int
	storageKey     string
	ciphertextHash string
	issuedAt       time.Time
	expiresAt      time.Time
}

type proxyDownloadTargetToken struct {
	V              string `json:"v"`
	ChannelUUID    string `json:"channelUuid"`
	CipherVersion  int64  `json:"cipherVersion"`
	Index          int    `json:"index"`
	StorageKey     string `json:"storageKey"`
	CiphertextHash string `json:"ciphertextHash"`
	IssuedAt       int64  `json:"issuedAt"`
	ExpiresAt      int64  `json:"expiresAt"`
}

type proxyTargetAuthorizer struct {
	now            func() time.Time
	secret         []byte
	revokedMu      sync.Mutex
	revokedUploads map[string]time.Time
}

func newProxyTargetAuthorizer(secret string) *proxyTargetAuthorizer {
	return &proxyTargetAuthorizer{
		now:            time.Now,
		secret:         []byte(secret),
		revokedUploads: make(map[string]time.Time),
	}
}

func (a *proxyTargetAuthorizer) IssueUploadSession(
	channelUUID string,
	chunkCount int,
	totalCiphertextBytes int64,
	ttl time.Duration,
) (string, error) {
	nonce, err := filestore.NewUploadID()
	if err != nil {
		return "", err
	}

	session := uploadSession{
		channelUUID:          channelUUID,
		chunkCount:           chunkCount,
		totalCiphertextBytes: totalCiphertextBytes,
		issuedAt:             a.now().UTC(),
		expiresAt:            a.expiresAt(ttl, proxyUploadTargetTTL),
		nonce:                nonce,
	}
	return a.signUploadSession(session)
}

func (a *proxyTargetAuthorizer) IssueUploadTarget(uploadID string, index int, ttl time.Duration) (string, error) {
	if a.isUploadRevoked(uploadID) {
		return "", errors.New("upload session revoked")
	}

	session, ok := a.parseUploadSession(uploadID)
	if !ok {
		return "", errors.New("upload session invalid")
	}

	expiresAt := a.expiresAt(ttl, proxyUploadTargetTTL)
	if expiresAt.After(session.expiresAt) {
		expiresAt = session.expiresAt
	}

	target := proxyUploadTarget{
		uploadID:    uploadID,
		channelUUID: session.channelUUID,
		index:       index,
		issuedAt:    a.now().UTC(),
		expiresAt:   expiresAt,
	}
	return a.signUploadTarget(target)
}

func (a *proxyTargetAuthorizer) IssueDownloadTarget(
	channelUUID string,
	cipherVersion int64,
	index int,
	storageKey string,
	ciphertextHash string,
	ttl time.Duration,
) (string, error) {
	target := proxyDownloadTarget{
		channelUUID:    channelUUID,
		cipherVersion:  cipherVersion,
		index:          index,
		storageKey:     storageKey,
		ciphertextHash: ciphertextHash,
		issuedAt:       a.now().UTC(),
		expiresAt:      a.expiresAt(ttl, proxyDownloadTargetTTL),
	}
	return a.signDownloadTarget(target)
}

func (a *proxyTargetAuthorizer) UploadSession(uploadID string) (uploadSession, bool) {
	if a.isUploadRevoked(uploadID) {
		return uploadSession{}, false
	}

	session, ok := a.parseUploadSession(uploadID)
	if !ok || !session.expiresAt.After(a.now()) {
		return uploadSession{}, false
	}
	return session, true
}

func (a *proxyTargetAuthorizer) UploadSessionForCompletion(uploadID string) (uploadSession, bool) {
	session, ok := a.parseUploadSession(uploadID)
	if !ok || !session.expiresAt.After(a.now()) {
		return uploadSession{}, false
	}
	return session, true
}

func (a *proxyTargetAuthorizer) UploadTarget(token string) (proxyUploadTarget, bool) {
	target, ok := a.parseUploadTarget(token)
	if !ok || a.isUploadRevoked(target.uploadID) || !target.expiresAt.After(a.now()) {
		return proxyUploadTarget{}, false
	}
	return target, true
}

func (a *proxyTargetAuthorizer) DownloadTarget(token string) (proxyDownloadTarget, bool) {
	target, ok := a.parseDownloadTarget(token)
	if !ok || !target.expiresAt.After(a.now()) {
		return proxyDownloadTarget{}, false
	}
	return target, true
}

func (a *proxyTargetAuthorizer) RevokeUpload(uploadID string) {
	now := a.now().UTC()
	expiresAt := now.Add(proxyUploadTargetTTL)
	if session, ok := a.parseUploadSession(uploadID); ok {
		expiresAt = session.expiresAt
	}

	a.revokedMu.Lock()
	defer a.revokedMu.Unlock()
	for revokedUploadID, revokedUntil := range a.revokedUploads {
		if !revokedUntil.After(now) {
			delete(a.revokedUploads, revokedUploadID)
		}
	}
	a.revokedUploads[uploadID] = expiresAt
}

func (a *proxyTargetAuthorizer) isUploadRevoked(uploadID string) bool {
	now := a.now().UTC()
	a.revokedMu.Lock()
	defer a.revokedMu.Unlock()

	expiresAt, ok := a.revokedUploads[uploadID]
	if !ok {
		return false
	}
	if !expiresAt.After(now) {
		delete(a.revokedUploads, uploadID)
		return false
	}
	return true
}

func (a *proxyTargetAuthorizer) expiresAt(ttl time.Duration, fallback time.Duration) time.Time {
	if ttl <= 0 {
		ttl = fallback
	}
	return a.now().Add(ttl).UTC()
}

func (a *proxyTargetAuthorizer) signUploadSession(session uploadSession) (string, error) {
	tokenPayload := uploadSessionToken{
		V:                    uploadSessionTokenV1,
		ChannelUUID:          session.channelUUID,
		ChunkCount:           session.chunkCount,
		TotalCiphertextBytes: session.totalCiphertextBytes,
		IssuedAt:             session.issuedAt.UnixMilli(),
		ExpiresAt:            session.expiresAt.UnixMilli(),
		Nonce:                session.nonce,
	}
	return a.signToken(uploadSessionDomain, tokenPayload)
}

func (a *proxyTargetAuthorizer) signUploadTarget(target proxyUploadTarget) (string, error) {
	tokenPayload := proxyUploadTargetToken{
		V:           uploadTargetTokenV1,
		UploadID:    target.uploadID,
		ChannelUUID: target.channelUUID,
		Index:       target.index,
		IssuedAt:    target.issuedAt.UnixMilli(),
		ExpiresAt:   target.expiresAt.UnixMilli(),
	}
	return a.signToken(uploadTargetTokenDomain, tokenPayload)
}

func (a *proxyTargetAuthorizer) signDownloadTarget(target proxyDownloadTarget) (string, error) {
	tokenPayload := proxyDownloadTargetToken{
		V:              downloadTargetTokenV1,
		ChannelUUID:    target.channelUUID,
		CipherVersion:  target.cipherVersion,
		Index:          target.index,
		StorageKey:     target.storageKey,
		CiphertextHash: target.ciphertextHash,
		IssuedAt:       target.issuedAt.UnixMilli(),
		ExpiresAt:      target.expiresAt.UnixMilli(),
	}
	return a.signToken(downloadTargetDomain, tokenPayload)
}

func (a *proxyTargetAuthorizer) parseUploadSession(uploadID string) (uploadSession, bool) {
	var token uploadSessionToken
	if !a.parseToken(uploadSessionDomain, uploadID, &token) {
		return uploadSession{}, false
	}
	if token.V != uploadSessionTokenV1 ||
		!isChannelUUIDToken(token.ChannelUUID) ||
		token.ChunkCount <= 0 ||
		token.TotalCiphertextBytes <= 0 ||
		token.ExpiresAt <= token.IssuedAt ||
		!isBase64URLToken(token.Nonce) {
		return uploadSession{}, false
	}

	return uploadSession{
		channelUUID:          token.ChannelUUID,
		chunkCount:           token.ChunkCount,
		totalCiphertextBytes: token.TotalCiphertextBytes,
		issuedAt:             time.UnixMilli(token.IssuedAt).UTC(),
		expiresAt:            time.UnixMilli(token.ExpiresAt).UTC(),
		nonce:                token.Nonce,
	}, true
}

func (a *proxyTargetAuthorizer) parseUploadTarget(token string) (proxyUploadTarget, bool) {
	var payload proxyUploadTargetToken
	if !a.parseToken(uploadTargetTokenDomain, token, &payload) {
		return proxyUploadTarget{}, false
	}
	if payload.V != uploadTargetTokenV1 ||
		!isChannelUUIDToken(payload.ChannelUUID) ||
		payload.Index < 0 ||
		payload.ExpiresAt <= payload.IssuedAt {
		return proxyUploadTarget{}, false
	}

	uploadSession, ok := a.parseUploadSession(payload.UploadID)
	if !ok ||
		uploadSession.channelUUID != payload.ChannelUUID ||
		payload.Index >= uploadSession.chunkCount ||
		time.UnixMilli(payload.ExpiresAt).UTC().After(uploadSession.expiresAt) {
		return proxyUploadTarget{}, false
	}

	return proxyUploadTarget{
		uploadID:    payload.UploadID,
		channelUUID: payload.ChannelUUID,
		index:       payload.Index,
		issuedAt:    time.UnixMilli(payload.IssuedAt).UTC(),
		expiresAt:   time.UnixMilli(payload.ExpiresAt).UTC(),
	}, true
}

func (a *proxyTargetAuthorizer) parseDownloadTarget(token string) (proxyDownloadTarget, bool) {
	var payload proxyDownloadTargetToken
	if !a.parseToken(downloadTargetDomain, token, &payload) {
		return proxyDownloadTarget{}, false
	}
	if payload.V != downloadTargetTokenV1 ||
		!isChannelUUIDToken(payload.ChannelUUID) ||
		payload.CipherVersion < 0 ||
		payload.Index < 0 ||
		payload.StorageKey == "" ||
		!isHexStringToken(payload.CiphertextHash, 64) ||
		payload.ExpiresAt <= payload.IssuedAt {
		return proxyDownloadTarget{}, false
	}

	return proxyDownloadTarget{
		channelUUID:    payload.ChannelUUID,
		cipherVersion:  payload.CipherVersion,
		index:          payload.Index,
		storageKey:     payload.StorageKey,
		ciphertextHash: payload.CiphertextHash,
		issuedAt:       time.UnixMilli(payload.IssuedAt).UTC(),
		expiresAt:      time.UnixMilli(payload.ExpiresAt).UTC(),
	}, true
}

func (a *proxyTargetAuthorizer) signToken(domain string, payload any) (string, error) {
	if len(a.secret) == 0 {
		return "", errors.New("upload token secret is required")
	}
	tokenPayload, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}

	mac := hmac.New(sha256.New, a.secret)
	_, _ = mac.Write([]byte(domain))
	_, _ = mac.Write(tokenPayload)
	signature := mac.Sum(nil)

	tokenBytes := make([]byte, len(tokenPayload)+1+len(signature))
	copy(tokenBytes, tokenPayload)
	tokenBytes[len(tokenPayload)] = 0
	copy(tokenBytes[len(tokenPayload)+1:], signature)
	return base64.RawURLEncoding.EncodeToString(tokenBytes), nil
}

func (a *proxyTargetAuthorizer) parseToken(domain string, token string, payload any) bool {
	if len(a.secret) == 0 {
		return false
	}

	tokenBytes, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return false
	}

	separatorIndex := -1
	for index, value := range tokenBytes {
		if value == 0 {
			separatorIndex = index
			break
		}
	}
	if separatorIndex <= 0 || separatorIndex >= len(tokenBytes)-1 {
		return false
	}

	encodedPayload := tokenBytes[:separatorIndex]
	signature := tokenBytes[separatorIndex+1:]
	mac := hmac.New(sha256.New, a.secret)
	_, _ = mac.Write([]byte(domain))
	_, _ = mac.Write(encodedPayload)
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return false
	}

	return json.Unmarshal(encodedPayload, payload) == nil
}

func isBase64URLToken(value string) bool {
	if value == "" {
		return false
	}
	_, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil
}

func isChannelUUIDToken(value string) bool {
	if len(value) != 21 {
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

func isHexStringToken(value string, length int) bool {
	if len(value) != length {
		return false
	}
	for _, r := range value {
		switch {
		case r >= '0' && r <= '9':
		case r >= 'a' && r <= 'f':
		default:
			return false
		}
	}
	return true
}

func buildProxyUploadURL(token string) string {
	return "file/chunk/" + token
}

func buildProxyDownloadURL(token string) string {
	return "file/download/" + token
}
