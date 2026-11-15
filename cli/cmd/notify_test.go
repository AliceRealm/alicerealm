package cmd

import (
	"testing"

	"github.com/AliceRealm/alicerealm/cli/internal/desktopnotify"
)

func TestNotificationTestMessageLanguages(t *testing.T) {
	for _, language := range []string{"zh", "en", "de", ""} {
		message := notificationTestMessage(language, "test:1", "https://example.com/page")
		wantTitle, wantBody := "AliceRealm notification test", "Click this notification to check that the page opens."
		if language == "zh" {
			wantTitle, wantBody = "AliceRealm 通知测试", "点击这条通知，看看能否正常打开页面。"
		}
		if message.Title != wantTitle || message.Body != wantBody || message.ID != "test:1" || message.URL != "https://example.com/page" {
			t.Fatalf("%s: %+v", language, message)
		}
		if err := desktopnotify.Validate(message); err != nil {
			t.Fatal(err)
		}
	}
}
