package httpapi

import (
	"testing"
	"time"
)

func TestProxyTargetAuthorizerRejectsRevokedUploadTargets(t *testing.T) {
	authorizer := newProxyTargetAuthorizer("test-secret")
	authorizer.now = func() time.Time {
		return time.Unix(1_700_000_000, 0).UTC()
	}

	session, err := authorizer.IssueUploadSession("aaaaaaaaaaaaaaaaaaaaa", 1, 4, time.Minute)
	if err != nil {
		t.Fatalf("IssueUploadSession() error = %v", err)
	}
	target, err := authorizer.IssueUploadTarget(session, 0, time.Minute)
	if err != nil {
		t.Fatalf("IssueUploadTarget() error = %v", err)
	}

	authorizer.RevokeUpload(session)

	if _, ok := authorizer.UploadSession(session); ok {
		t.Fatal("UploadSession() accepted a revoked upload")
	}
	if _, ok := authorizer.UploadTarget(target); ok {
		t.Fatal("UploadTarget() accepted a revoked upload")
	}
}
