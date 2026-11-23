package pet

import (
	"strings"
	"testing"
)

func TestDeviceTokenIsOpaqueAndHashable(t *testing.T) {
	token, hash, err := NewDeviceToken()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(token, DeviceTokenPrefix) || len(token) != len(DeviceTokenPrefix)+64 {
		t.Fatalf("unexpected token shape: %q", token)
	}
	if len(hash) != 64 || hash != HashToken(token) || strings.Contains(hash, token) {
		t.Fatal("token hash contract failed")
	}
}

func TestValidateInteractionWhitelistAndBounds(t *testing.T) {
	valid := CreateInteractionInput{RequestID: "req-1", ReceiverAgentID: 2, EventType: "wave", Payload: InteractionPayload{Message: "hello"}}
	if err := ValidateInteraction(valid); err != nil {
		t.Fatalf("valid interaction rejected: %v", err)
	}
	invalid := []CreateInteractionInput{
		{RequestID: "req-2", ReceiverAgentID: 2, EventType: "run_command"},
		{RequestID: "req-3", ReceiverAgentID: 2, EventType: "gift"},
		{RequestID: "req-4", ReceiverAgentID: 2, EventType: "emote", Payload: InteractionPayload{EmoteID: "../../bad"}},
		{RequestID: "req-5", ReceiverAgentID: 2, EventType: "wave", Payload: InteractionPayload{Message: strings.Repeat("界", 201)}},
		{RequestID: "req-6", ReceiverAgentID: 2, EventType: "visit_accept", Payload: InteractionPayload{ReplyToInteractionID: "not-an-id"}},
	}
	for _, input := range invalid {
		if err := ValidateInteraction(input); err == nil {
			t.Fatalf("invalid interaction accepted: %#v", input)
		}
	}
}
