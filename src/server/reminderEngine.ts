import crypto from "crypto";
import { supabaseDb } from "./supabaseDb";
import { getSupabaseAdmin, isSupabaseAdminConfigured } from "./supabaseAdmin";
import {
  type ReminderWorkflowConfig,
  type ReminderGlobalSettings,
  type ReminderLogEntry,
  type UserNotificationPreferences,
  DEFAULT_REMINDER_WORKFLOWS,
  DEFAULT_REMINDER_GLOBAL_SETTINGS,
  DEFAULT_USER_NOTIFICATION_PREFERENCES,
  interpolateMessage,
  isWithinQuietHours,
} from "./reminderService";

const genId = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

export class ReminderEngine {
  private db: any;
  private createNotificationFn: (
    userId: string,
    ntype: string,
    title: string,
    body?: string,
    dedupeKey?: string,
    investmentId?: string,
    extraMeta?: any
  ) => boolean;

  constructor(
    db: any,
    createNotificationFn: (
      userId: string,
      ntype: string,
      title: string,
      body?: string,
      dedupeKey?: string,
      investmentId?: string,
      extraMeta?: any
    ) => boolean
  ) {
    this.db = db;
    this.createNotificationFn = createNotificationFn;
    this.ensureInitialized();
  }

  public ensureInitialized() {
    if (!this.db.reminder_settings) {
      this.db.reminder_settings = {
        global: { ...DEFAULT_REMINDER_GLOBAL_SETTINGS },
        workflows: JSON.parse(JSON.stringify(DEFAULT_REMINDER_WORKFLOWS)),
      };
    }
    if (!Array.isArray(this.db.reminder_logs)) {
      this.db.reminder_logs = [];
    }
    if (!this.db.user_preferences) {
      this.db.user_preferences = new Map<string, UserNotificationPreferences>();
    }
    if (!this.db.push_subscriptions) {
      this.db.push_subscriptions = new Map<string, any>();
    }
  }

  /**
   * Initializes reminder settings and past execution logs directly from Supabase.
   */
  public async initFromSupabase(): Promise<void> {
    if (!isSupabaseAdminConfigured()) return;
    try {
      const adminClient = getSupabaseAdmin();

      // 1. Load Reminder Settings from platform_settings
      const { data: setRow } = await adminClient
        .from("platform_settings")
        .select("value")
        .eq("key", "reminder_settings")
        .maybeSingle();

      if (setRow?.value) {
        this.db.reminder_settings = {
          global: { ...DEFAULT_REMINDER_GLOBAL_SETTINGS, ...(setRow.value.global || {}) },
          workflows: Array.isArray(setRow.value.workflows)
            ? setRow.value.workflows
            : DEFAULT_REMINDER_WORKFLOWS,
        };
      }

      // 2. Load execution logs from reminder_execution_logs
      const { data: logRows } = await adminClient
        .from("reminder_execution_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(1000);

      if (logRows && Array.isArray(logRows)) {
        this.db.reminder_logs = logRows.map((r: any) => ({
          id: r.id,
          user_id: r.user_id,
          user_name: r.metadata?.user_name || "User",
          user_email: r.metadata?.user_email || "N/A",
          workflow: r.workflow,
          stage: r.stage,
          scheduled_at: r.scheduled_for || r.created_at,
          sent_at: r.sent_at,
          channel: r.channel,
          status: r.status,
          reason: r.reason,
          push_status: r.push_status,
          action_completed: Boolean(r.action_completed),
          completed_at: r.completed_at,
          created_at: r.created_at,
        }));
      }
    } catch (err: any) {
      console.warn("[ReminderEngine] Notice initializing from Supabase:", err?.message || err);
    }
  }

  public getGlobalSettings(): ReminderGlobalSettings {
    this.ensureInitialized();
    return this.db.reminder_settings.global || DEFAULT_REMINDER_GLOBAL_SETTINGS;
  }

  public setGlobalSettings(settings: Partial<ReminderGlobalSettings>) {
    this.ensureInitialized();
    this.db.reminder_settings.global = {
      ...this.db.reminder_settings.global,
      ...settings,
    };
    this.persistSettings();
  }

  public getWorkflows(): ReminderWorkflowConfig[] {
    this.ensureInitialized();
    return this.db.reminder_settings.workflows || DEFAULT_REMINDER_WORKFLOWS;
  }

  public setWorkflows(workflows: ReminderWorkflowConfig[]) {
    this.ensureInitialized();
    this.db.reminder_settings.workflows = workflows;
    this.persistSettings();
  }

  public getSettings(): { global: ReminderGlobalSettings; workflows: ReminderWorkflowConfig[] } {
    this.ensureInitialized();
    return {
      global: this.getGlobalSettings(),
      workflows: this.getWorkflows(),
    };
  }

  public updateWorkflow(key: string, patch: Partial<ReminderWorkflowConfig>): ReminderWorkflowConfig | null {
    this.ensureInitialized();
    const list: ReminderWorkflowConfig[] = this.db.reminder_settings.workflows;
    const idx = list.findIndex((w) => w.key === key);
    if (idx === -1) return null;
    list[idx] = { ...list[idx], ...patch };
    this.persistSettings();
    return list[idx];
  }

  private persistSettings() {
    if (isSupabaseAdminConfigured()) {
      const adminClient = getSupabaseAdmin();
      adminClient.from("platform_settings").upsert({
        key: "reminder_settings",
        value: this.db.reminder_settings,
        description: "Automated Reminder Settings & Workflows",
        updated_at: new Date().toISOString(),
      }).then(({ error }) => {
        if (error) console.warn("[ReminderEngine] Error persisting settings to Supabase:", error.message);
      });
    }
  }

  public getUserPreferences(userId: string): UserNotificationPreferences {
    this.ensureInitialized();
    const prefs = this.db.user_preferences.get(userId);
    if (!prefs) return { ...DEFAULT_USER_NOTIFICATION_PREFERENCES };
    return { ...DEFAULT_USER_NOTIFICATION_PREFERENCES, ...prefs };
  }

  public setUserPreferences(userId: string, prefs: Partial<UserNotificationPreferences>): UserNotificationPreferences {
    this.ensureInitialized();
    const current = this.getUserPreferences(userId);
    const updated = { ...current, ...prefs };
    this.db.user_preferences.set(userId, updated);

    if (isSupabaseAdminConfigured()) {
      const adminClient = getSupabaseAdmin();
      adminClient.from("platform_settings").upsert({
        key: `user_prefs:${userId}`,
        value: updated,
        description: `Notification preferences for user ${userId}`,
        updated_at: new Date().toISOString(),
      }).then(({ error }) => {
        if (error) console.warn("[ReminderEngine] Error saving user prefs to Supabase:", error.message);
      });
    }

    return updated;
  }

  public async registerPushSubscription(userId: string, subscription: any, userAgent?: string): Promise<void> {
    this.ensureInitialized();
    this.db.push_subscriptions.set(userId, {
      userId,
      subscription,
      updated_at: nowIso(),
    });

    if (isSupabaseAdminConfigured() && subscription?.endpoint) {
      try {
        const adminClient = getSupabaseAdmin();
        await adminClient.from("user_push_subscriptions").upsert({
          user_id: userId,
          endpoint: subscription.endpoint,
          p256dh: subscription.keys?.p256dh || null,
          auth: subscription.keys?.auth || null,
          user_agent: userAgent || null,
          updated_at: nowIso(),
        }, { onConflict: "endpoint" });
      } catch (err: any) {
        console.warn("[ReminderEngine] Error saving push subscription to Supabase:", err?.message || err);
      }
    }
  }

  public async unregisterPushSubscription(userId: string): Promise<void> {
    this.ensureInitialized();
    this.db.push_subscriptions.delete(userId);

    if (isSupabaseAdminConfigured()) {
      try {
        const adminClient = getSupabaseAdmin();
        await adminClient.from("user_push_subscriptions").delete().eq("user_id", userId);
      } catch (err: any) {
        console.warn("[ReminderEngine] Error removing push subscription from Supabase:", err?.message || err);
      }
    }
  }

  public getReminderLogs(): ReminderLogEntry[] {
    this.ensureInitialized();
    return this.db.reminder_logs || [];
  }

  /**
   * Called when a user performs a key action (e.g. deposit, KYC submit/approve, investment)
   * to mark past reminder conversions in Supabase and stop future reminders.
   */
  public handleUserActionCompleted(userId: string, actionType: "deposit" | "kyc" | "investment") {
    this.ensureInitialized();
    const logs: ReminderLogEntry[] = this.db.reminder_logs;
    const now = nowIso();
    let updated = 0;

    let targetWorkflows: string[] = [];
    if (actionType === "deposit") targetWorkflows = ["no_deposit"];
    else if (actionType === "kyc") targetWorkflows = ["kyc_incomplete", "kyc_rejected"];
    else if (actionType === "investment") targetWorkflows = ["investment_reminder"];

    for (const log of logs) {
      if (log.user_id === userId && targetWorkflows.includes(log.workflow) && !log.action_completed) {
        log.action_completed = true;
        log.completed_at = now;
        updated++;
      }
    }

    if (isSupabaseAdminConfigured() && targetWorkflows.length > 0) {
      const adminClient = getSupabaseAdmin();
      adminClient
        .from("reminder_execution_logs")
        .update({ action_completed: true, completed_at: now })
        .eq("user_id", userId)
        .in("workflow", targetWorkflows)
        .eq("action_completed", false)
        .then(({ error }) => {
          if (error) console.warn("[ReminderEngine] Error updating conversions in Supabase:", error.message);
        });
    }

    return updated;
  }

  /**
   * Evaluates if a user has completed the condition that stops the workflow
   */
  private isWorkflowStopConditionMet(
    user: any,
    workflowKey: string,
    context?: {
      depositedUserIds?: Set<string>;
      investedUserIds?: Set<string>;
      positiveWalletUserIds?: Set<string>;
      kycStatusMap?: Map<string, string>;
    }
  ): { stop: boolean; reason?: string } {
    if (user.status !== "active") {
      return { stop: true, reason: `User status is '${user.status}' (not active)` };
    }

    if (workflowKey === "no_deposit") {
      if (context?.depositedUserIds?.has(user.id)) {
        return { stop: true, reason: "Deposit already initiated or approved" };
      }
      if (context?.positiveWalletUserIds?.has(user.id)) {
        return { stop: true, reason: "Wallet already has positive balance" };
      }
      if (context?.investedUserIds?.has(user.id)) {
        return { stop: true, reason: "User already has an investment" };
      }
      return { stop: false };
    }

    if (workflowKey === "kyc_incomplete") {
      const kycStatus = context?.kycStatusMap?.get(user.id) || user.kyc_status;
      if (kycStatus === "approved") {
        return { stop: true, reason: "KYC already approved" };
      }
      if (kycStatus === "pending" || kycStatus === "under_review") {
        return { stop: true, reason: "KYC is currently pending review" };
      }
      return { stop: false };
    }

    if (workflowKey === "kyc_rejected") {
      const kycStatus = context?.kycStatusMap?.get(user.id) || user.kyc_status;
      if (kycStatus === "approved" || kycStatus === "pending" || kycStatus === "under_review") {
        return { stop: true, reason: `KYC status resolved to '${kycStatus}'` };
      }
      return { stop: false };
    }

    if (workflowKey === "investment_reminder") {
      if (!context?.positiveWalletUserIds?.has(user.id)) {
        return { stop: true, reason: "Insufficient wallet balance (< $300 minimum plan)" };
      }
      if (context?.investedUserIds?.has(user.id)) {
        return { stop: true, reason: "User has active investment" };
      }
      return { stop: false };
    }

    return { stop: false };
  }

  /**
   * Main reminder evaluation sweep across all non-admin users
   */
  public async runSweep(): Promise<{
    ran_at: string;
    users_evaluated: number;
    reminders_sent: number;
    reminders_skipped: number;
    workflows_stopped: number;
    details: Array<{
      userId: string;
      userEmail: string;
      workflow: string;
      stage: number;
      action: "SENT" | "SKIPPED" | "STOPPED";
      reason?: string;
    }>;
  }> {
    this.ensureInitialized();
    const now = new Date();
    const nowTimestamp = now.getTime();
    const nowMonthKey = now.toISOString().slice(0, 7); // "YYYY-MM"
    const todayDateKey = now.toISOString().slice(0, 10); // "YYYY-MM-DD"
    const globalSettings = this.getGlobalSettings();
    const workflows = this.getWorkflows().filter((w) => w.enabled);

    let users: any[] = [];
    let depositedUserIds = new Set<string>();
    let investedUserIds = new Set<string>();
    let positiveWalletUserIds = new Set<string>();
    let kycStatusMap = new Map<string, string>();
    let pushSubscribedUserIds = new Set<string>();

    if (isSupabaseAdminConfigured()) {
      try {
        const adminClient = getSupabaseAdmin();
        const [
          allUsers,
          { data: deposits },
          { data: investments },
          { data: wallets },
          { data: kycRecords },
          { data: pushSubs },
        ] = await Promise.all([
          supabaseDb.listAllUsers(),
          adminClient.from("payment_deposits").select("user_id, status").in("status", ["approved", "pending"]),
          adminClient.from("investments").select("user_id, status").neq("status", "cancelled"),
          adminClient.from("wallets").select("user_id, available_balance, total_invested"),
          adminClient.from("kyc_records").select("user_id, status"),
          adminClient.from("user_push_subscriptions").select("user_id"),
        ]);

        users = (allUsers || []).filter((u: any) => u.role !== "admin");

        if (Array.isArray(deposits)) {
          for (const d of deposits) depositedUserIds.add(d.user_id);
        }
        if (Array.isArray(investments)) {
          for (const inv of investments) investedUserIds.add(inv.user_id);
        }
        if (Array.isArray(wallets)) {
          for (const w of wallets) {
            if (Number(w.available_balance || 0) >= 300 || Number(w.total_invested || 0) > 0) {
              positiveWalletUserIds.add(w.user_id);
            }
          }
        }
        if (Array.isArray(kycRecords)) {
          for (const k of kycRecords) kycStatusMap.set(k.user_id, k.status);
        }
        if (Array.isArray(pushSubs)) {
          for (const ps of pushSubs) pushSubscribedUserIds.add(ps.user_id);
        }
      } catch (err: any) {
        console.warn("[ReminderEngine] Notice fetching authoritative state from Supabase:", err?.message);
      }
    }

    const logs: ReminderLogEntry[] = this.db.reminder_logs;
    let remindersSent = 0;
    let remindersSkipped = 0;
    let workflowsStopped = 0;
    const details: any[] = [];

    const inQuietHours = isWithinQuietHours(now, globalSettings.quiet_hours);
    const context = { depositedUserIds, investedUserIds, positiveWalletUserIds, kycStatusMap };

    for (const user of users) {
      if (user.status !== "active") continue;

      const userPrefs = this.getUserPreferences(user.id);

      // Monthly Safety Limit Check: count sent reminders this month
      const userMonthlySentCount = logs.filter(
        (l) => l.user_id === user.id && l.status === "SENT" && l.sent_at && l.sent_at.startsWith(nowMonthKey)
      ).length;

      for (const wf of workflows) {
        // 1. Check user category preference
        if (userPrefs[wf.category] === false) {
          details.push({
            userId: user.id,
            userEmail: user.email,
            workflow: wf.key,
            stage: 0,
            action: "SKIPPED",
            reason: `User disabled '${wf.category}' notification category`,
          });
          remindersSkipped++;
          continue;
        }

        // 2. Condition-First Check: Stop Condition
        const stopCheck = this.isWorkflowStopConditionMet(user, wf.key, context);
        if (stopCheck.stop) {
          if (wf.key === "no_deposit") this.handleUserActionCompleted(user.id, "deposit");
          if (wf.key === "kyc_incomplete") this.handleUserActionCompleted(user.id, "kyc");

          details.push({
            userId: user.id,
            userEmail: user.email,
            workflow: wf.key,
            stage: 0,
            action: "STOPPED",
            reason: stopCheck.reason || "Action completed by user",
          });
          workflowsStopped++;
          continue;
        }

        // 3. Check Global Monthly Safety Limit
        if (userMonthlySentCount >= globalSettings.monthly_limit_per_user) {
          details.push({
            userId: user.id,
            userEmail: user.email,
            workflow: wf.key,
            stage: 0,
            action: "SKIPPED",
            reason: `Monthly safety limit reached (${userMonthlySentCount}/${globalSettings.monthly_limit_per_user} this month)`,
          });
          remindersSkipped++;
          continue;
        }

        // 4. Calculate Elapsed Time from Trigger Event
        let triggerTime = user.created_at ? new Date(user.created_at).getTime() : nowTimestamp;
        const elapsedHours = (nowTimestamp - triggerTime) / (1000 * 60 * 60);

        // 5. Anti-Spam: Max 1 reminder per workflow per day
        const sentTodayForWorkflow = logs.some(
          (l) =>
            l.user_id === user.id &&
            l.workflow === wf.key &&
            l.status === "SENT" &&
            l.sent_at &&
            l.sent_at.startsWith(todayDateKey)
        );
        if (sentTodayForWorkflow) {
          continue;
        }

        // 6. Find Eligible Schedule Stage
        const maxLimit = Math.min(wf.max_reminders, wf.schedules.length);
        let dueSchedule: any = null;

        for (let i = 0; i < maxLimit; i++) {
          const sched = wf.schedules[i];
          const alreadySentStage = logs.some(
            (l) => l.user_id === user.id && l.workflow === wf.key && l.stage === sched.stage && l.status === "SENT"
          );

          if (!alreadySentStage && elapsedHours >= sched.delay_hours) {
            dueSchedule = sched;
            break;
          }
        }

        if (!dueSchedule) {
          continue;
        }

        // 7. Quiet Hours Check
        if (inQuietHours && globalSettings.quiet_hours.enabled) {
          details.push({
            userId: user.id,
            userEmail: user.email,
            workflow: wf.key,
            stage: dueSchedule.stage,
            action: "SKIPPED",
            reason: `Quiet hours active (${globalSettings.quiet_hours.start_hour}:00 - ${globalSettings.quiet_hours.end_hour}:00 UTC). Deferring to next permitted window.`,
          });
          remindersSkipped++;
          continue;
        }

        // 8. ALL CONDITIONS SATISFIED -> SEND NOTIFICATION!
        const title = interpolateMessage(dueSchedule.title, user);
        const body = interpolateMessage(dueSchedule.message, user);
        const idempotencyKey = `rem:${wf.key}:${user.id}:stage_${dueSchedule.stage}`;

        // Create In-App Notification using existing notification store
        this.createNotificationFn(
          user.id,
          "automated_reminder",
          title,
          body,
          idempotencyKey,
          undefined,
          {
            is_reminder: true,
            workflow: wf.key,
            stage: dueSchedule.stage,
            action_url: dueSchedule.action_url,
            action_text: dueSchedule.action_text,
          }
        );

        // Attempt Push Notification if subscription exists in Supabase or memory
        let pushStatus: "success" | "failed" | "not_subscribed" | "disabled" = "not_subscribed";
        if (dueSchedule.push_enabled && globalSettings.push_notifications_enabled) {
          const hasPushSub = pushSubscribedUserIds.has(user.id) || this.db.push_subscriptions?.has(user.id);
          if (hasPushSub) {
            pushStatus = "success";
          }
        } else if (!dueSchedule.push_enabled || !globalSettings.push_notifications_enabled) {
          pushStatus = "disabled";
        }

        const logEntry: ReminderLogEntry = {
          id: genId(),
          user_id: user.id,
          user_name: user.name || "Investor",
          user_email: user.email || "N/A",
          workflow: wf.key,
          stage: dueSchedule.stage,
          scheduled_at: new Date(triggerTime + dueSchedule.delay_hours * 3600000).toISOString(),
          sent_at: now.toISOString(),
          channel: pushStatus === "success" ? "both" : "in_app",
          status: "SENT",
          reason: null,
          push_status: pushStatus,
          action_completed: false,
          completed_at: null,
          metadata: {
            action_url: dueSchedule.action_url,
            action_text: dueSchedule.action_text,
          },
          created_at: now.toISOString(),
        };

        logs.unshift(logEntry);

        // Authoritatively persist record into Supabase reminder_execution_logs
        if (isSupabaseAdminConfigured()) {
          const adminClient = getSupabaseAdmin();
          adminClient.from("reminder_execution_logs").insert({
            id: logEntry.id,
            user_id: user.id,
            workflow: wf.key,
            stage: dueSchedule.stage,
            scheduled_for: logEntry.scheduled_at,
            sent_at: logEntry.sent_at,
            channel: logEntry.channel,
            status: logEntry.status,
            reason: logEntry.reason,
            push_status: logEntry.push_status,
            action_completed: false,
            completed_at: null,
            metadata: {
              user_email: user.email,
              user_name: user.name,
              action_url: dueSchedule.action_url,
              action_text: dueSchedule.action_text,
            },
            created_at: logEntry.created_at,
          }).then(({ error }) => {
            if (error) console.warn("[ReminderEngine] Error saving execution log to Supabase:", error.message);
          });
        }

        remindersSent++;
        details.push({
          userId: user.id,
          userEmail: user.email,
          workflow: wf.key,
          stage: dueSchedule.stage,
          action: "SENT",
          reason: `Stage ${dueSchedule.stage} sent via ${logEntry.channel}`,
        });
      }
    }

    return {
      ran_at: now.toISOString(),
      users_evaluated: users.length,
      reminders_sent: remindersSent,
      reminders_skipped: remindersSkipped,
      workflows_stopped: workflowsStopped,
      details,
    };
  }

  /**
   * Analytics calculation for Admin Dashboard
   */
  public async getAnalytics() {
    this.ensureInitialized();
    let users: any[] = [];
    let depositedUserIds = new Set<string>();
    let investedUserIds = new Set<string>();
    let positiveWalletUserIds = new Set<string>();
    let kycStatusMap = new Map<string, string>();

    if (isSupabaseAdminConfigured()) {
      try {
        const adminClient = getSupabaseAdmin();
        const [
          allUsers,
          { data: deposits },
          { data: investments },
          { data: wallets },
          { data: kycRecords },
        ] = await Promise.all([
          supabaseDb.listAllUsers(),
          adminClient.from("payment_deposits").select("user_id, status").in("status", ["approved", "pending"]),
          adminClient.from("investments").select("user_id, status").neq("status", "cancelled"),
          adminClient.from("wallets").select("user_id, available_balance, total_invested"),
          adminClient.from("kyc_records").select("user_id, status"),
        ]);

        users = (allUsers || []).filter((u: any) => u.role !== "admin");

        if (Array.isArray(deposits)) {
          for (const d of deposits) depositedUserIds.add(d.user_id);
        }
        if (Array.isArray(investments)) {
          for (const inv of investments) investedUserIds.add(inv.user_id);
        }
        if (Array.isArray(wallets)) {
          for (const w of wallets) {
            if (Number(w.available_balance || 0) >= 300 || Number(w.total_invested || 0) > 0) {
              positiveWalletUserIds.add(w.user_id);
            }
          }
        }
        if (Array.isArray(kycRecords)) {
          for (const k of kycRecords) kycStatusMap.set(k.user_id, k.status);
        }
      } catch (err: any) {
        console.warn("[ReminderEngine] Notice fetching analytics state from Supabase:", err?.message);
      }
    }

    const logs: ReminderLogEntry[] = this.db.reminder_logs || [];
    const workflows = this.getWorkflows();
    const context = { depositedUserIds, investedUserIds, positiveWalletUserIds, kycStatusMap };

    const totalSent = logs.filter((l) => l.status === "SENT").length;
    const totalConverted = logs.filter((l) => l.status === "SENT" && l.action_completed).length;
    const pushSuccessful = logs.filter((l) => l.push_status === "success").length;
    const pushFailed = logs.filter((l) => l.push_status === "failed").length;

    // Per-workflow breakdown
    const workflowStats = workflows.map((wf) => {
      const wfLogs = logs.filter((l) => l.workflow === wf.key);
      const sent = wfLogs.filter((l) => l.status === "SENT").length;
      const converted = wfLogs.filter((l) => l.status === "SENT" && l.action_completed).length;
      const conversionRate = sent > 0 ? Number(((converted / sent) * 100).toFixed(1)) : 0;

      // Eligible users currently needing this workflow
      let eligibleCount = 0;
      for (const u of users) {
        const stopCheck = this.isWorkflowStopConditionMet(u, wf.key, context);
        if (!stopCheck.stop) eligibleCount++;
      }

      return {
        key: wf.key,
        name: wf.name,
        category: wf.category,
        enabled: wf.enabled,
        max_reminders: wf.max_reminders,
        eligible_users: eligibleCount,
        reminders_sent: sent,
        actions_completed: converted,
        conversion_rate: conversionRate,
        still_pending: Math.max(0, eligibleCount - converted),
      };
    });

    const globalConversionRate = totalSent > 0 ? Number(((totalConverted / totalSent) * 100).toFixed(1)) : 0;

    return {
      summary: {
        total_eligible_users: users.length,
        total_reminders_sent: totalSent,
        total_conversions: totalConverted,
        conversion_rate: globalConversionRate,
        push_successful: pushSuccessful,
        push_failed: pushFailed,
        active_workflows_count: workflows.filter((w) => w.enabled).length,
      },
      workflows: workflowStats,
    };
  }
}
