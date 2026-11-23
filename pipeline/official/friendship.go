package official

import (
	"errors"
	"fmt"
	"time"

	pmdal "eigenflux_server/rpc/pm/dal"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const FriendRemark = "AliceRealm 官方"

var (
	ErrOfficialAccountInvalid = errors.New("official account is missing or not marked official")
	ErrOfficialFriendBlocked  = errors.New("official friendship is blocked")
)

// ConnectionResult describes the durable, one-time official friendship.
// Processed means this pair has already been handled. Active reports whether
// the friendship still exists; it may be false after a member unfriends the
// official Agent, and callers must not recreate it in that case.
type ConnectionResult struct {
	Processed bool
	Active    bool
	Created   bool
}

// EnsureFriendship establishes a member's one-time friendship with an
// official Agent. It is safe to call repeatedly and under concurrency.
//
// A durable marker prevents later profile updates or Redis resets from
// re-adding a friendship the member removed. A block in either direction is a
// hard boundary and no marker is written, so an operator can retry after
// resolving an accidental pre-provisioning block.
func EnsureFriendship(gdb *gorm.DB, officialID, agentID int64) (ConnectionResult, error) {
	var result ConnectionResult
	if gdb == nil || officialID <= 0 || agentID <= 0 || officialID == agentID {
		return result, ErrOfficialAccountInvalid
	}

	err := gdb.Transaction(func(tx *gorm.DB) error {
		if err := pmdal.LockRelationPair(tx, officialID, agentID); err != nil {
			return err
		}

		var official struct {
			AgentID    int64 `gorm:"column:agent_id"`
			IsOfficial bool  `gorm:"column:is_official"`
		}
		if err := tx.Raw(`SELECT agent_id, is_official FROM agents WHERE agent_id = ?`, officialID).Scan(&official).Error; err != nil {
			return err
		}
		if official.AgentID == 0 || !official.IsOfficial {
			return ErrOfficialAccountInvalid
		}

		var markerCount int64
		if err := tx.Raw(`SELECT COUNT(*) FROM official_agent_connections
			WHERE official_agent_id = ? AND agent_id = ?`, officialID, agentID).Scan(&markerCount).Error; err != nil {
			return err
		}
		if markerCount > 0 {
			result.Processed = true
			active, err := hasSymmetricFriendship(tx, officialID, agentID)
			result.Active = active
			return err
		}

		var blocked bool
		if err := tx.Raw(`SELECT EXISTS (
			SELECT 1 FROM user_relations
			WHERE rel_type = ? AND ((from_uid = ? AND to_uid = ?) OR (from_uid = ? AND to_uid = ?))
		)`, pmdal.RelTypeBlock, officialID, agentID, agentID, officialID).Scan(&blocked).Error; err != nil {
			return err
		}
		if blocked {
			return ErrOfficialFriendBlocked
		}

		active, err := hasSymmetricFriendship(tx, officialID, agentID)
		if err != nil {
			return err
		}
		if !active {
			now := time.Now().UnixMilli()
			relations := []pmdal.UserRelation{
				{FromUID: officialID, ToUID: agentID, RelType: pmdal.RelTypeFriend, CreatedAt: now, Remark: FriendRemark},
				{FromUID: agentID, ToUID: officialID, RelType: pmdal.RelTypeFriend, CreatedAt: now, Remark: ""},
			}
			if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&relations).Error; err != nil {
				return err
			}
			active, err = hasSymmetricFriendship(tx, officialID, agentID)
			if err != nil {
				return err
			}
			if !active {
				return fmt.Errorf("official friendship is not symmetric after creation")
			}
			result.Created = true
		}

		now := time.Now().UnixMilli()
		if err := tx.Model(&pmdal.FriendRequest{}).
			Where("status = ? AND ((from_uid = ? AND to_uid = ?) OR (from_uid = ? AND to_uid = ?))",
				pmdal.RequestStatusPending, officialID, agentID, agentID, officialID).
			Updates(map[string]any{"status": pmdal.RequestStatusAccepted, "updated_at": now}).Error; err != nil {
			return err
		}
		if err := tx.Exec(`INSERT INTO official_agent_connections (official_agent_id, agent_id, connected_at)
			VALUES (?, ?, ?) ON CONFLICT (official_agent_id, agent_id) DO NOTHING`, officialID, agentID, now).Error; err != nil {
			return err
		}
		result.Processed = true
		result.Active = true
		return nil
	})
	return result, err
}

func hasSymmetricFriendship(gdb *gorm.DB, officialID, agentID int64) (bool, error) {
	var count int64
	err := gdb.Model(&pmdal.UserRelation{}).
		Where("rel_type = ? AND ((from_uid = ? AND to_uid = ?) OR (from_uid = ? AND to_uid = ?))",
			pmdal.RelTypeFriend, officialID, agentID, agentID, officialID).
		Count(&count).Error
	return count == 2, err
}
