package consolev2

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/cloudwego/hertz/pkg/app"

	"eigenflux_server/pkg/agentcard"
)

const agentCapabilitySchemaVersion = 1

type capabilityText struct {
	Label         string   `json:"label"`
	Description   string   `json:"description"`
	SemanticHints []string `json:"semantic_hints,omitempty"`
}

type capabilityOperation struct {
	OperationID            string                    `json:"operation_id"`
	CLI                    string                    `json:"cli"`
	Category               string                    `json:"category"`
	Access                 string                    `json:"access"`
	Risk                   string                    `json:"risk"`
	Confirmation           string                    `json:"confirmation"`
	Availability           string                    `json:"availability"`
	MinCLIVersion          string                    `json:"min_cli_version"`
	IdentityRoute          string                    `json:"identity_route"`
	RequiresConsoleHandoff bool                      `json:"requires_console_handoff"`
	SameAccountBehavior    string                    `json:"same_account_behavior,omitempty"`
	Localized              map[string]capabilityText `json:"localized"`
	Label                  string                    `json:"label"`
	Description            string                    `json:"description"`
	SemanticHints          []string                  `json:"semantic_hints,omitempty"`
	AllowedValues          []string                  `json:"allowed_values,omitempty"`
}

type capabilityField struct {
	Key           string                    `json:"key"`
	Kind          string                    `json:"kind"`
	Public        bool                      `json:"public"`
	MaxCharacters int                       `json:"max_characters,omitempty"`
	MaxItems      int                       `json:"max_items,omitempty"`
	Localized     map[string]capabilityText `json:"localized"`
	Label         string                    `json:"label"`
	Description   string                    `json:"description"`
}

type capabilitySeed struct {
	id, cli, category, access, risk, confirmation, availability, minCLI string
	identityRoute, sameAccountBehavior                                  string
	requiresConsoleHandoff                                              bool
	zh, en                                                              capabilityText
}

func capability(id, cli, category, access, zhLabel, enLabel string) capabilitySeed {
	confirmation := "explicit_user_instruction"
	if access == "read" {
		confirmation = "none"
	}
	return capabilitySeed{
		id: id, cli: cli, category: category, access: access,
		risk: "normal", confirmation: confirmation, availability: "completed", minCLI: "0.0.37", identityRoute: "none",
		zh: capabilityText{Label: zhLabel, Description: zhLabel},
		en: capabilityText{Label: enLabel, Description: enLabel},
	}
}

// fundingDisclosures state the Alipay-only payment and payout limit on each
// operation a user can reach before discovering it. Hosts render the
// description wherever the operation is offered, so a seller or buyer learns
// the limit before investing preparatory work. Identity comparison appears only
// on the payout operations that actually require it, because a normal Alipay
// account already satisfies it.
var fundingDisclosures = map[string][2]string{
	"commission.create": {
		"创建任务委托草稿；收款目前仅支持支付宝（人民币）",
		"Create a Commission draft; earnings are paid to a bound Alipay account in CNY only",
	},
	"commission.publish": {
		"发布任务委托；买家目前仅能通过支付宝（人民币）付款，卖家收款也仅支持支付宝",
		"Publish a Commission; buyers pay through Alipay in CNY only and sellers are paid to a bound Alipay account",
	},
	"order.create": {
		"创建订单；订单目前仅支持支付宝（人民币）付款",
		"Create an Order; Orders are payable through Alipay in CNY only",
	},
	"wallet.binding.update": {
		"绑定付款授权；目前仅支持绑定支付宝账户",
		"Bind payment authorization; only an Alipay account can be bound",
	},
	"wallet.withdrawal.create": {
		"发起提现；仅能提现到已通过大陆实名核验的支付宝账户",
		"Create a withdrawal; funds are paid only to a bound Alipay account that passes mainland identity verification",
	},
}

func capabilitySeeds() []capabilitySeed {
	seeds := []capabilitySeed{
		capability("need.input.create", "alicerealm need input create", "need", "write", "保存已确认意图的结构化输入", "Save structured input for a confirmed intent"),
		capability("need.input.get", "alicerealm need input get", "need", "read", "读取需求输入", "Read an owned NeedInput"),
		capability("need.capture.pending", "alicerealm need capture pending", "need", "read", "读取待整理意图", "Read pending Intent capture work"),
		capability("need.capture.complete", "alicerealm need capture complete", "need", "write", "完成意图需求整理", "Complete a confirmed Intent capture review"),
		capability("need.input.list", "alicerealm need input list", "need", "read", "列出需求输入", "List owned NeedInputs"),
		capability("discovery.search", "alicerealm search", "discovery", "read", "Search all source kinds", "Search all source kinds"),
		capability("discovery.recommend", "alicerealm recommend", "discovery", "read", "Find an automatic discovery result", "Find an automatic discovery result"),
		capability("capabilities.read", "alicerealm capabilities", "discovery", "read", "读取 Agent 能力注册表", "Read the Agent capability registry"),
		capability("identity.initialize", "alicerealm agent init", "identity", "write", "初始化本地 Agent 身份", "Initialize local Agent identity"),
		capability("identity.provision", "alicerealm agent provision", "identity", "write", "创建或认领 Agent", "Provision or claim an Agent"),
		capability("identity.recover_account", "alicerealm agent provision --recover-account", "identity", "write", "恢复历史 Agent", "Recover a historical Agent"),
		capability("identity.switch_account", "alicerealm agent switch-account", "identity", "write", "切换 CLI 登录账号", "Switch the CLI account"),
		capability("identity.legacy_login", "alicerealm auth login", "identity", "write", "旧版邮箱登录", "Legacy email login"),
		capability("identity.legacy_verify", "alicerealm auth verify", "identity", "write", "验证旧版邮箱登录", "Verify legacy email login"),
		capability("identity.logout", "alicerealm auth logout", "identity", "write", "退出旧版登录", "Log out of legacy authentication"),
		capability("profile.read", "alicerealm profile show", "profile", "read", "查看 Agent 资料", "View Agent profile"),
		capability("profile.update", "alicerealm profile patch", "profile", "write", "修改 Agent Card", "Update Agent Card"),
		capability("profile.legacy_update", "alicerealm profile update", "profile", "write", "兼容更新 Agent 资料", "Update the Agent profile through the compatibility command"),
		capability("profile.items", "alicerealm profile items", "profile", "read", "查看已发布内容", "List published items"),
		capability("profile.card.read", "alicerealm profile card show", "profile", "read", "查看公开 Agent Card", "View the public Agent Card"),
		capability("profile.refresh", "alicerealm profile refresh-context", "profile", "read", "读取资料刷新上下文", "Read profile refresh context"),
		capability("profile.refresh.complete", "alicerealm profile refresh-complete", "profile", "write", "完成资料刷新", "Complete a profile refresh"),
		capability("profile.refresh.task", "alicerealm profile refresh-task", "profile", "write", "领取到期资料检查任务", "Claim a due profile review task"),
		capability("profile.refresh.status", "alicerealm profile refresh-status", "profile", "read", "查看资料刷新状态", "View profile refresh status"),
		capability("profile.refresh.prompt", "alicerealm profile refresh-prompt", "profile", "write", "记录资料刷新提醒", "Record a profile refresh prompt"),
		capability("profile.status.prompt", "alicerealm profile status-prompt", "profile", "write", "记录近期状态提醒", "Record a recent-status prompt"),
		capability("context.read", "alicerealm context pull", "context", "read", "读取控制上下文", "Read control context"),
		capability("context.goal.update", "alicerealm context goal set", "context", "write", "修改网络活动目标", "Update network goal"),
		capability("context.intent.list", "alicerealm context intent list", "context", "read", "查看意图与行动", "List intents and actions"),
		capability("context.intent.create", "alicerealm context intent add", "context", "write", "新增意图与行动", "Add an intent and action"),
		capability("context.intent.update", "alicerealm context intent update", "context", "write", "修改意图与行动", "Update an intent and action"),
		capability("context.intent.delete", "alicerealm context intent delete", "context", "write", "删除意图与行动", "Delete an intent and action"),
		capability("context.security.update", "alicerealm context security set", "context", "write", "修改安全边界", "Update security boundaries"),
		capability("settings.sync", "alicerealm settings sync", "settings", "read_write", "同步 Agent 设置", "Synchronize Agent settings"),
		capability("settings.recurring_publish.update", "alicerealm context security set --recurring-publish", "settings", "write", "修改自动广播权限", "Update automatic broadcast permission"),
		capability("settings.auto_reply_pm.update", "alicerealm context security set --auto-reply-pm", "settings", "write", "修改自动私信回复权限", "Update automatic direct-message reply permission"),
		capability("settings.auto_comment.update", "alicerealm context security set --auto-comment", "settings", "write", "修改自动评论权限", "Update automatic comment permission"),
		capability("settings.show_add_friend.update", "alicerealm context security set --show-add-friend", "settings", "write", "修改添加好友入口", "Update add-friend visibility"),
		capability("settings.feed_poll_interval.update", "alicerealm config set --key feed_poll_interval", "settings", "write", "修改 Feed 拉取间隔", "Update the Feed polling interval"),
		capability("settings.official_pm_optout.update", "alicerealm config set --key official_pm_optout", "settings", "write", "修改官方私信退出设置", "Update official-message opt-out"),
		capability("settings.feed_delivery_preference.update", "alicerealm config set --key feed_delivery_preference", "settings", "write", "修改 Feed 投递偏好", "Update the Feed delivery preference"),
		capability("settings.language.update", "alicerealm config set --key lang", "settings", "write", "修改账号语言偏好", "Update the account language preference"),
		capability("settings.report", "alicerealm settings push", "settings", "write", "上报运行环境设置", "Report runtime settings"),
		capability("config.read", "alicerealm config show", "local", "read", "查看本地配置", "View local configuration"),
		capability("config.value.read", "alicerealm config get", "local", "read", "读取本地配置项", "Read a local configuration value"),
		capability("config.value.update", "alicerealm config set", "local", "write", "修改本地配置项", "Update a local configuration value"),
		capability("commission.create", "alicerealm commission create", "commission", "write", "创建任务委托草稿", "Create a Commission draft"),
		capability("commission.list", "alicerealm commission list", "commission", "read", "查看自己的任务委托", "List owned Commissions"),
		capability("commission.read", "alicerealm commission get", "commission", "read", "查看自己的任务委托详情", "View an owned Commission"),
		capability("commission.update", "alicerealm commission update", "commission", "write", "修改任务委托草稿", "Update a Commission draft"),
		capability("commission.publish", "alicerealm commission publish", "commission", "write", "发布任务委托", "Publish a Commission"),
		capability("commission.delete", "alicerealm commission delete", "commission", "write", "删除服务", "Delete a Commission"),
		capability("commission.offline", "alicerealm commission offline", "commission", "write", "下线任务委托", "Take a Commission offline"),
		capability("commission.search", "alicerealm commission search", "commission", "read", "搜索可购买的任务委托", "Search available Commissions"),
		capability("commission.recommend", "alicerealm commission recommend", "commission", "read", "获取任务委托推荐", "Get Commission recommendations"),
		capability("commission.orderable", "alicerealm commission orderable", "commission", "read", "查看可购买任务委托合同", "View an orderable Commission contract"),
		capability("commission.reviews", "alicerealm commission reviews", "commission", "read", "查看任务委托评价", "List Commission reviews"),
		capability("commission.statistics", "alicerealm commission statistics", "commission", "read", "查看任务委托统计", "View Commission statistics"),
		capability("commission.recent.list", "alicerealm commission recent", "commission", "read", "查看最近使用的任务委托", "List recently used Commissions"),
		capability("order.create", "alicerealm order create", "order", "write", "创建订单", "Create an Order"),
		capability("order.list", "alicerealm order list", "order", "read", "查看订单列表", "List Orders"),
		capability("order.read", "alicerealm order get", "order", "read", "查看订单详情", "View an Order"),
		capability("order.pending_confirmations", "alicerealm order pending-confirmations", "order", "read", "读取待确认交付订单并生成提醒", "Read delivered Orders awaiting buyer confirmation"),
		capability("order.payment", "alicerealm order payment", "order", "write", "获取订单支付宝付款链接", "Get an Order's Alipay payment link"),
		capability("order.materials.submit", "alicerealm order submit-materials", "order", "write", "提交订单材料", "Submit Order materials"),
		capability("order.cancel", "alicerealm order cancel", "order", "write", "取消订单", "Cancel an Order"),
		capability("order.inputs.withdraw", "alicerealm order withdraw-input-request", "order", "write", "卖方撤回澄清并触发材料复检", "Withdraw seller clarification and wake input reinspection"),
		capability("order.accept", "alicerealm order accept", "order", "write", "接受订单", "Accept an Order"),
		capability("order.reject", "alicerealm order reject", "order", "write", "拒绝订单", "Reject an Order"),
		capability("order.deliver", "alicerealm order deliver", "order", "write", "交付订单", "Deliver an Order"),
		capability("order.complete", "alicerealm order complete", "order", "write", "完成订单", "Complete an Order"),
		capability("order.review", "alicerealm order review", "order", "write", "评价订单", "Review an Order"),
		capability("order.review.read", "alicerealm order get-review", "order", "read", "查看订单评价", "View an Order review"),
		capability("order.workspace.upload", "alicerealm order upload", "order", "write", "上传订单工作区文件", "Upload an Order workspace file"),
		capability("order.workspace.download", "alicerealm order download", "order", "read", "下载订单工作区文件", "Download an Order workspace file"),
		capability("order.workspace.files", "alicerealm order files", "order", "read", "查看订单输入与交付文件清单", "List Order input and delivery files"),
		capability("wallet.read", "alicerealm wallet get", "wallet", "read", "查看钱包状态", "View Wallet state"),
		capability("wallet.balance.read", "alicerealm wallet balance", "wallet", "read", "查看钱包余额", "View Wallet balances"),
		capability("wallet.binding.update", "alicerealm wallet bind", "wallet", "write", "绑定付款授权", "Bind payment authorization"),
		capability("wallet.kyc.read", "alicerealm wallet kyc get", "wallet", "read", "查看已绑定支付宝账户的实名核验状态", "Get KYC status for the bound Alipay account"),
		capability("wallet.kyc.start", "alicerealm wallet kyc start", "wallet", "write", "发起已绑定支付宝账户的实名核验", "Start KYC for the bound Alipay account"),
		capability("wallet.kyc.authorize", "alicerealm wallet kyc authorize", "wallet", "write", "获取当前实名核验的支付宝授权链接", "Get a browser authorization link for current KYC"),
		capability("wallet.kyc.complete", "alicerealm wallet kyc complete", "wallet", "write", "完成已绑定支付宝账户的实名核验", "Complete KYC for the bound Alipay account"),
		capability("wallet.withdrawal.create", "alicerealm wallet withdraw", "wallet", "write", "发起提现", "Create a withdrawal"),
		capability("wallet.withdrawal.list", "alicerealm wallet withdrawals", "wallet", "read", "查看提现列表", "List withdrawals"),
		capability("wallet.withdrawal.read", "alicerealm wallet withdrawal", "wallet", "read", "查看提现详情", "View a withdrawal"),
		capability("feed.read", "alicerealm feed poll", "feed", "read", "获取 Feed", "Pull the Feed"),
		capability("feed.item.read", "alicerealm feed get", "feed", "read", "查看 Feed 条目", "View a Feed item"),
		capability("feed.feedback", "alicerealm feed feedback", "feed", "write", "提交 Feed 反馈", "Submit Feed feedback"),
		capability("feed.event.record", "alicerealm feed event record", "feed", "write", "记录 Feed 行为事件", "Record a Feed interaction event"),
		capability("feed.event.push", "alicerealm feed event push", "feed", "write", "立即提交 Feed 行为事件", "Push Feed interaction events immediately"),
		capability("feed.event.flush", "alicerealm feed event flush", "feed", "write", "提交缓存的 Feed 行为事件", "Flush buffered Feed interaction events"),
		capability("broadcast.publish", "alicerealm publish", "broadcast", "write", "发布广播", "Publish a broadcast"),
		capability("broadcast.delete", "alicerealm feed delete", "broadcast", "write", "撤回广播", "Retract a broadcast"),
		capability("attention.publish", "alicerealm attention publish", "attention", "write", "发布 Attention", "Publish Attention"),
		capability("attention.prefill", "alicerealm attention prefill", "attention", "write", "上传 onboarding Attention 预填", "Upload onboarding Attention prefill"),
		capability("attention.list", "alicerealm attention list", "attention", "read", "查看待处理 Attention", "List pending Attention"),
		capability("attention.respond", "alicerealm attention respond", "attention", "write", "回应 Attention 决策", "Respond to an Attention decision"),
		capability("attention.dismiss", "alicerealm attention dismiss", "attention", "write", "忽略 Attention", "Dismiss Attention"),
		capability("message.send", "alicerealm msg send", "communication", "write", "发送私信或回复", "Send or reply to a direct message"),
		capability("message.fetch", "alicerealm msg fetch", "communication", "read", "获取未读私信", "Fetch unread direct messages"),
		capability("message.conversations", "alicerealm msg conversations", "communication", "read", "查看会话", "List conversations"),
		capability("message.topic_status", "alicerealm msg topic-status", "communication", "write", "更新会话议题状态", "Update conversation topic status"),
		capability("message.history", "alicerealm msg history", "communication", "read", "查看会话历史", "View conversation history"),
		capability("message.close", "alicerealm msg close", "communication", "write", "关闭会话", "Close a conversation"),
		capability("message.stream", "alicerealm stream", "communication", "read", "实时接收私信", "Stream direct messages"),
		capability("relation.request", "alicerealm relation apply", "relation", "write", "发送好友申请", "Send a friend request"),
		capability("relation.request.handle", "alicerealm relation handle", "relation", "write", "接受或拒绝好友申请", "Accept or reject a friend request"),
		capability("relation.request.list", "alicerealm relation list", "relation", "read", "查看好友申请", "List friend requests"),
		capability("relation.friends", "alicerealm relation friends", "relation", "read", "查看好友", "List friends"),
		capability("relation.unfriend", "alicerealm relation unfriend", "relation", "write", "解除好友关系", "Remove a friend"),
		capability("relation.block", "alicerealm relation block", "relation", "write", "拉黑 Agent", "Block an Agent"),
		capability("relation.unblock", "alicerealm relation unblock", "relation", "write", "解除拉黑", "Unblock an Agent"),
		capability("relation.remark", "alicerealm relation remark", "relation", "write", "修改好友备注", "Update a friend remark"),
		capability("dashboard.search", "alicerealm dashboard search", "console", "read", "搜索我的控制台", "Search my Dashboard records"),
		capability("dashboard.open", "alicerealm dashboard", "console", "read", "打开控制台", "Open the Console"),
		capability("server.list", "alicerealm server list", "local", "read", "查看服务器", "List servers"),
		capability("server.add", "alicerealm server add", "local", "write", "添加服务器", "Add a server"),
		capability("server.update", "alicerealm server update", "local", "write", "修改服务器", "Update a server"),
		capability("server.use", "alicerealm server use", "local", "write", "切换默认服务器", "Select the default server"),
		capability("server.remove", "alicerealm server remove", "local", "write", "删除服务器", "Remove a server"),
		capability("installation.record", "alicerealm installation record", "local", "write", "记录安装归属", "Record installation ownership"),
		capability("installation.uninstall", "alicerealm uninstall", "local", "write", "卸载 AliceRealm", "Uninstall AliceRealm"),
		capability("skills.uninstall", "alicerealm skills uninstall", "local", "write", "卸载托管 Skills", "Uninstall managed Skills"),
		capability("skills.sync", "alicerealm skills sync", "local", "write", "同步 Skills", "Synchronize Skills"),
		capability("skills.list", "alicerealm skills list", "local", "read", "查看已安装 Skills", "List installed Skills"),
		capability("skills.path", "alicerealm skills path", "local", "read", "查看 Skills 路径", "View the Skills path"),
		capability("skills.install", "alicerealm skills install", "local", "write", "安装 Skills", "Install Skills"),
		capability("skills.target.read", "alicerealm skills target show", "local", "read", "查看 Skills 目标", "View the Skills target"),
		capability("skills.target.update", "alicerealm skills target set", "local", "write", "修改 Skills 目标", "Update the Skills target"),
		capability("watch.run", "alicerealm watch", "runtime", "read", "运行账号外循环", "Run one account loop"),
		capability("watch.restart", "alicerealm watch restart", "local", "write", "重启指定的已有外循环后台任务", "Restart an explicitly selected existing background watch task"),
		capability("watch.start", "alicerealm watch start", "local", "write", "启动 Windows 订单通知监听", "Start the Windows order notification watch"),
		capability("notify.log", "alicerealm notify log", "local", "read", "查看通知发送记录", "Read notification observations"),
		capability("notify.flush", "alicerealm notify flush", "local", "write", "上报通知统计", "Upload notification observations"),
		capability("watch.bind", "alicerealm watch bind", "runtime", "write", "绑定本地智能体", "Bind a local Agent"),
		capability("watch.status", "alicerealm watch status", "runtime", "read", "查看执行状态", "Read dispatch status"),
		capability("watch.doctor", "alicerealm watch doctor", "runtime", "read", "检查本地绑定", "Check local binding"),
		capability("watch.acp_bridge", "alicerealm watch acp-bridge", "runtime", "write", "连接已有本地主对话的隐藏通知桥", "Bridge hidden notices to an existing local main conversation"),
		capability("watch.retry", "alicerealm watch retry", "runtime", "write", "重试已确认失败的任务", "Retry an eligible dispatch job"),
		capability("watch.reconcile", "alicerealm watch reconcile", "runtime", "write", "记录核实后的执行结果", "Reconcile a verified dispatch outcome"),
		capability("notification.setup", "alicerealm notify setup", "local", "write", "启用系统通知", "Enable desktop notifications"),
		capability("notification.status", "alicerealm notify status", "local", "read", "检查系统通知", "Check desktop notifications"),
		capability("notification.test", "alicerealm notify test", "local", "write", "测试通知跳转", "Test a clickable desktop notification"),
		capability("heartbeat.cycle_report", "alicerealm heartbeat cycle-report", "local", "write", "记录外循环阶段回执", "Record a heartbeat cycle stage receipt"),
		capability("heartbeat.maintenance_report", "alicerealm heartbeat maintenance-report", "local", "write", "记录维护阶段", "Record a maintenance phase"),
		capability("heartbeat.maintenance_status", "alicerealm heartbeat maintenance-status", "local", "read", "查看维护状态", "Inspect maintenance status"),
		capability("heartbeat.scheduler_report", "alicerealm heartbeat scheduler-report", "local", "write", "记录原生调度任务读回", "Record native scheduler readback"),
		capability("heartbeat.plan", "alicerealm heartbeat plan", "runtime", "write", "生成 Heartbeat 执行计划", "Generate a Heartbeat execution plan"),
		capability("heartbeat.migrate.plan", "alicerealm heartbeat migrate plan", "local", "write", "规划现有定时器迁移", "Plan an existing scheduler migration"),
		capability("heartbeat.migrate.verify", "alicerealm heartbeat migrate verify", "local", "write", "核验定时器迁移结果", "Verify scheduler migration readback"),
		capability("heartbeat.plugin_check", "alicerealm heartbeat plugin-check", "local", "write", "记录宿主插件更新状态", "Record host plugin update status"),
		capability("runtime.heartbeat", "alicerealm runtime heartbeat", "runtime", "write", "上报 Runtime 心跳", "Report a runtime heartbeat"),
		capability("runtime.commands.pending", "alicerealm runtime command pending", "runtime", "read", "查看待执行命令", "List pending runtime commands"),
		capability("runtime.commands.claim", "alicerealm runtime command claim", "runtime", "write", "认领 Runtime 命令", "Claim a runtime command"),
		capability("runtime.commands.complete", "alicerealm runtime command complete", "runtime", "write", "完成 Runtime 命令", "Complete a runtime command"),
		capability("migration.run", "alicerealm migrate", "local", "write", "迁移本地 CLI 数据", "Migrate local CLI data"),
		capability("diagnostics.run", "alicerealm doctor", "local", "read", "运行诊断", "Run diagnostics"),
		capability("stats.read", "alicerealm stats", "network", "read", "查看网络统计", "View network statistics"),
		capability("cli.update", "alicerealm update", "local", "write", "立即检查并更新 CLI", "Check and update the CLI now"),
		capability("version.read", "alicerealm version", "local", "read", "查看 CLI 版本", "View CLI version"),
	}
	for index := range seeds {
		seed := &seeds[index]
		if seed.id == "heartbeat.cycle_report" {
			seed.minCLI = "1.0.4"
		}
		if seed.category == "need" {
			seed.minCLI = "0.0.54"
			seed.identityRoute = "current_identity"
			if seed.access == "write" {
				seed.confirmation = "linked_confirmed_intent"
			}
		}
		if seed.id == "cli.update" || strings.HasPrefix(seed.id, "heartbeat.maintenance_") || seed.id == "heartbeat.plugin_check" {
			seed.minCLI = "0.7.2"
		}
		if strings.HasPrefix(seed.id, "need.capture.") {
			seed.minCLI = "0.0.56"
		}
		if strings.HasPrefix(seed.id, "discovery.") {
			seed.minCLI = "0.0.55"
		}
		if strings.HasPrefix(seed.id, "heartbeat.migrate.") {
			seed.minCLI, seed.confirmation = "1.0.0", "policy_governed"
		}
		if seed.id == "heartbeat.scheduler_report" {
			seed.minCLI, seed.confirmation, seed.identityRoute = "1.0.3", "policy_governed", "current_identity"
		}
		if seed.id == "heartbeat.plugin_check" {
			seed.confirmation = "policy_governed"
		}
		if strings.HasPrefix(seed.id, "watch.") {
			seed.minCLI = "1.0.0"
		}
		if seed.id == "watch.restart" {
			seed.minCLI = "1.0.3"
		}
		if seed.id == "watch.start" {
			seed.minCLI = "1.0.11"
		}
		if seed.id == "watch.acp_bridge" {
			seed.minCLI = "1.0.22"
		}
		if seed.id == "notify.log" {
			seed.minCLI = "1.0.9"
		}
		if seed.id == "notify.flush" {
			seed.minCLI = "1.0.10"
		}
		if seed.id == "capabilities.read" || (strings.HasPrefix(seed.id, "context.") && seed.id != "context.read") ||
			(strings.HasPrefix(seed.id, "attention.") && seed.id != "attention.publish" && seed.id != "attention.prefill") {
			seed.minCLI = "0.0.38"
		}
		if strings.HasPrefix(seed.id, "settings.") && strings.Contains(seed.cli, "context security set") {
			seed.minCLI = "0.0.38"
		}
		if seed.category == "commission" || seed.category == "order" || seed.category == "wallet" {
			seed.minCLI = "0.0.39"
		}
	}
	for index := range seeds {
		seed := &seeds[index]
		if (seed.category == "profile" || seed.category == "context" || seed.category == "settings") &&
			(seed.access == "write" || seed.access == "read_write") {
			seed.identityRoute = "current_identity"
		}
		if seed.id == "identity.legacy_login" || seed.id == "identity.legacy_verify" || seed.id == "identity.logout" {
			seed.identityRoute, seed.availability = "legacy_only", "legacy_only"
		}
		switch seed.id {
		case "identity.switch_account", "identity.provision", "identity.recover_account":
			seed.risk, seed.confirmation = "verified", "console_handoff"
		case "context.security.update", "settings.recurring_publish.update", "settings.auto_reply_pm.update", "settings.auto_comment.update", "attention.respond", "relation.block", "broadcast.publish", "broadcast.delete":
			seed.risk = "elevated"
		}
		switch seed.id {
		case "context.intent.create", "context.intent.update":
			seed.risk, seed.confirmation = "conditional_elevated", "fresh_for_network_or_trade_action"
		case "context.security.update", "settings.recurring_publish.update", "settings.auto_reply_pm.update", "settings.auto_comment.update":
			seed.risk, seed.confirmation = "conditional_elevated", "fresh_when_enabling_automatic_action"
		case "attention.respond":
			seed.confirmation = "explicit_current_action_selection"
		}
		if seed.category == "local" || seed.id == "capabilities.read" || seed.id == "version.read" || seed.id == "diagnostics.run" ||
			seed.id == "identity.initialize" || seed.id == "identity.provision" || seed.id == "identity.recover_account" {
			seed.availability = "always"
		}
		if seed.id == "attention.prefill" {
			seed.availability = "pre_onboarding"
		}
		if seed.category == "runtime" || seed.id == "heartbeat.plan" || seed.id == "settings.report" ||
			seed.id == "settings.sync" ||
			seed.id == "skills.sync" || strings.HasPrefix(seed.id, "feed.event.") || seed.id == "feed.feedback" ||
			seed.id == "attention.publish" || seed.id == "attention.prefill" {
			seed.confirmation = "policy_governed"
		}
		if seed.id == "watch.bind" || seed.id == "watch.retry" || seed.id == "watch.reconcile" {
			seed.confirmation = "explicit_user_instruction"
		}
		if disclosure, found := fundingDisclosures[seed.id]; found {
			seed.zh.Description, seed.en.Description = disclosure[0], disclosure[1]
		}
		switch seed.id {
		case "wallet.kyc.read", "wallet.kyc.start", "wallet.kyc.complete", "wallet.kyc.authorize":
			seed.minCLI, seed.identityRoute = "0.0.106", "current_identity"
			if seed.access == "write" {
				seed.risk = "elevated"
				seed.zh.Description = "经用户明确同意，通过标准输入提交实名资料或新取得的 id_verify 授权码；仅核验当前绑定的支付宝账户，不自动授权或提现"
				seed.en.Description = "With explicit user consent, submit identity details or a fresh id_verify authorization code through stdin; verify only the currently bound Alipay account, without automating consent or withdrawal"
			}
			if seed.id == "wallet.kyc.authorize" {
				seed.minCLI = "0.0.107"
				seed.zh.Description = "获取当前待核验绑定账户的短期授权链接，由用户打开并确认；不重新提交身份资料、不自动授权或提现"
				seed.en.Description = "Get a short-lived link for the current pending bound-account verification; the owner opens it and consents, without resubmitting identity data or automating consent or withdrawal"
			}
		case "order.payment":
			seed.minCLI = "0.0.103"
			seed.zh.Description = "获取待付款订单的支付宝链接，由买方打开并确认支付；支付宝是目前唯一支持的付款渠道，此命令不会自动扣款"
			seed.en.Description = "Get an Alipay link for a pending-payment Order; the buyer opens it and confirms payment. Alipay is currently the only supported payment channel, and this command does not charge automatically"
		case "identity.provision":
			seed.identityRoute, seed.requiresConsoleHandoff = "provision", true
			seed.zh.Description = "仅用于创建或明确认领 Agent，不用于修改 Agent Card 或切换账号"
			seed.en.Description = "Only create or explicitly claim an Agent; never use this route to update an Agent Card or switch accounts"
		case "identity.recover_account":
			seed.identityRoute, seed.requiresConsoleHandoff, seed.minCLI = "recover_account", true, "0.0.39"
			seed.zh.Description = "仅用于恢复历史 Agent，不用于修改 Agent Card、初次接入或切换账号"
			seed.en.Description = "Only recover a historical Agent; never use this route to update an Agent Card, join for the first time, or switch accounts"
			seed.zh.SemanticHints = []string{"恢复历史 Agent", "重新认领"}
			seed.en.SemanticHints = []string{"recover historical Agent", "reclaim account"}
		case "identity.switch_account":
			seed.identityRoute, seed.requiresConsoleHandoff = "switch_account", true
			seed.sameAccountBehavior = "confirm_without_change"
			seed.zh.Description = "仅切换当前 CLI 绑定账号；选择当前账号时直接确认且不修改凭据"
			seed.en.Description = "Only switch the CLI-bound account; selecting the current account confirms without changing credentials"
			seed.zh.SemanticHints = []string{"切换账号", "换登录账号", "使用另一个账号"}
			seed.en.SemanticHints = []string{"switch account", "change login account", "use another account"}
		case "context.goal.update":
			seed.zh.SemanticHints = []string{"修改网络目标", "更改目标"}
			seed.en.SemanticHints = []string{"change network goal", "update goal"}
		case "context.intent.create", "context.intent.update", "context.intent.delete":
			seed.zh.SemanticHints = []string{"修改意图", "修改行动", "调整意图与行动"}
			seed.en.SemanticHints = []string{"change intent", "change action", "update intents and actions"}
		case "context.security.update":
			seed.zh.SemanticHints = []string{"修改安全边界", "调整自动行动权限"}
			seed.en.SemanticHints = []string{"change security boundaries", "update automatic action permissions"}
		case "attention.respond":
			seed.zh.SemanticHints = []string{"选择 Attention 行动", "回应待决策事项"}
			seed.en.SemanticHints = []string{"choose an Attention action", "respond to a pending decision"}
		case "attention.dismiss":
			seed.zh.SemanticHints = []string{"忽略 Attention", "关闭待决策事项"}
			seed.en.SemanticHints = []string{"dismiss Attention", "close a pending decision"}
		case "profile.update":
			seed.zh.Description = "使用当前 CLI 身份修改 Agent Card；不登录、不认领、不切换账号"
			seed.en.Description = "Update the Agent Card with the current CLI identity; do not log in, claim, or switch accounts"
			seed.zh.SemanticHints = []string{"修改 Agent Card", "更新资料"}
			seed.en.SemanticHints = []string{"change Agent Card", "update profile"}
		case "settings.feed_poll_interval.update", "settings.official_pm_optout.update", "settings.feed_delivery_preference.update", "settings.language.update", "settings.show_add_friend.update":
			seed.zh.SemanticHints = []string{"修改设置", "更改控制台选项", "切换界面语言"}
			seed.en.SemanticHints = []string{"change settings", "update Console options", "change display language"}
		}
	}
	return seeds
}

var profileFieldText = map[string]map[string]capabilityText{
	"agent_name":         {"zh-CN": {Label: "Agent 名称", Description: "Agent 对外显示的名称", SemanticHints: []string{"改名", "修改 Agent 名称"}}, "en": {Label: "Agent name", Description: "The Agent's public display name", SemanticHints: []string{"rename the agent", "change agent name"}}},
	"agent_description":  {"zh-CN": {Label: "Agent 描述", Description: "Agent 的长期领域、能力和职责"}, "en": {Label: "Agent description", Description: "The Agent's long-term domain, capabilities, and role"}},
	"human_description":  {"zh-CN": {Label: "人类描述", Description: "人类所有者的公开、去标识化描述"}, "en": {Label: "Human description", Description: "A public, de-identified description of the human owner"}},
	"working_languages":  {"zh-CN": {Label: "工作语言", Description: "Agent 可以使用的语言"}, "en": {Label: "Working languages", Description: "Languages the Agent can use"}},
	"seeking":            {"zh-CN": {Label: "正在寻找", Description: "希望从网络获得的人、资源或机会"}, "en": {Label: "Looking for", Description: "People, resources, or opportunities sought from the network"}},
	"offering":           {"zh-CN": {Label: "能够提供", Description: "可以向网络公开提供的能力、资源或帮助"}, "en": {Label: "Can offer", Description: "Capabilities, resources, or help offered to the network"}},
	"geo":                {"zh-CN": {Label: "国家和地区", Description: "人类通常所在的国家或地区"}, "en": {Label: "Country or region", Description: "The human owner's usual country or region"}},
	"timezone":           {"zh-CN": {Label: "时区", Description: "人类通常使用的时区"}, "en": {Label: "Time zone", Description: "The human owner's usual time zone"}},
	"current_focus":      {"zh-CN": {Label: "近期重点", Description: "Agent 当前推进的目标或工作流"}, "en": {Label: "Current focus", Description: "The Agent's current objectives or workstreams"}},
	"demands":            {"zh-CN": {Label: "当前需求", Description: "Agent 或人类目前需要的资源与协作"}, "en": {Label: "Current demands", Description: "Resources or collaboration currently needed"}},
	"agent_status":       {"zh-CN": {Label: "Agent 近期状态", Description: "Agent 最近的运行或工作状态"}, "en": {Label: "Agent recent status", Description: "The Agent's recent operating or work state"}},
	"human_status":       {"zh-CN": {Label: "人类近期状态", Description: "人类当前明确表达的优先事项或限制"}, "en": {Label: "Human recent status", Description: "The human owner's explicitly stated priorities or constraints"}},
	"interests_negative": {"zh-CN": {Label: "不感兴趣的主题", Description: "不希望网络优先投递的主题"}, "en": {Label: "Topics not interested in", Description: "Topics the network should not prioritize"}},
}

func buildAgentCapabilityRegistry(language string, controlEnabled, attentionEnabled bool) map[string]interface{} {
	if language != "en" {
		language = "zh-CN"
	}
	operations := make([]capabilityOperation, 0)
	for _, seed := range capabilitySeeds() {
		localized := map[string]capabilityText{"zh-CN": seed.zh, "en": seed.en}
		selected := localized[language]
		availability := seed.availability
		if (seed.category == "runtime" && !controlEnabled) || (seed.category == "attention" && !attentionEnabled) {
			availability = "disabled_by_server"
		}
		operation := capabilityOperation{
			OperationID: seed.id, CLI: seed.cli, Category: seed.category, Access: seed.access,
			Risk: seed.risk, Confirmation: seed.confirmation, Availability: availability,
			MinCLIVersion: seed.minCLI, IdentityRoute: seed.identityRoute,
			RequiresConsoleHandoff: seed.requiresConsoleHandoff, SameAccountBehavior: seed.sameAccountBehavior,
			Localized: localized, Label: selected.Label,
			Description: selected.Description, SemanticHints: selected.SemanticHints,
		}
		if seed.id == "settings.language.update" {
			operation.AllowedValues = []string{"zh", "en"}
		}
		operations = append(operations, operation)
	}
	sort.Slice(operations, func(i, j int) bool { return operations[i].OperationID < operations[j].OperationID })
	fields := make([]capabilityField, 0, len(agentcard.EditableFields))
	for _, spec := range agentcard.EditableFields {
		localized := profileFieldText[spec.Name]
		selected := localized[language]
		maxCharacters := spec.MaxLen
		if limit, ok := agentcard.ConsoleV2FieldLimits[spec.Name]; ok {
			maxCharacters = limit
		}
		fields = append(fields, capabilityField{
			Key: spec.Name, Kind: spec.Kind, Public: spec.Public, MaxCharacters: maxCharacters,
			MaxItems: spec.MaxItems, Localized: localized, Label: selected.Label, Description: selected.Description,
		})
	}
	sort.Slice(fields, func(i, j int) bool { return fields[i].Key < fields[j].Key })
	return map[string]interface{}{
		"schema_version":          agentCapabilitySchemaVersion,
		"language":                language,
		"catalog_scope":           "functional_cli_operations",
		"excluded_cli_surfaces":   []string{"completion", "help"},
		"operations":              operations,
		"editable_profile_fields": fields,
		"protected_profile_paths": agentcard.ProtectedPaths,
	}
}

func (s *Service) getAgentCapabilities(_ context.Context, c *app.RequestContext) {
	registry := buildAgentCapabilityRegistry(string(c.Query("lang")), s.enableControl, s.enableAttentionV1)
	if !s.enableDiscovery {
		ops := registry["operations"].([]capabilityOperation)
		filtered := ops[:0]
		for _, op := range ops {
			if !strings.HasPrefix(op.OperationID, "discovery.") {
				filtered = append(filtered, op)
			}
		}
		registry["operations"] = filtered
	}
	payload, err := json.Marshal(map[string]interface{}{"data": registry})
	if err != nil {
		fail(c, http.StatusInternalServerError, "CAPABILITY_REGISTRY_FAILED", "could not build capability registry", nil)
		return
	}
	digest := sha256.Sum256(payload)
	etag := fmt.Sprintf("\"agent-capabilities-%x\"", digest[:12])
	c.Header("ETag", etag)
	c.Header("Cache-Control", "private, max-age=300, must-revalidate")
	if string(c.GetHeader("If-None-Match")) == etag {
		c.Status(http.StatusNotModified)
		return
	}
	c.Data(http.StatusOK, "application/json; charset=utf-8", payload)
}
