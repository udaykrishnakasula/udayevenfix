import crypto from "crypto";
import { getSupabaseAdmin } from "./supabaseAdmin";

export interface PromotionMediaItem {
  id: string;
  title: string;
  subtitle: string;
  media_type: "image" | "video";
  media_url: string;
  thumbnail_url?: string;
  badge_text?: string;
  badge_color?: "amber" | "emerald" | "violet" | "sky" | "rose" | "indigo";
  cta_text?: string;
  cta_link?: string;
  status: "PUBLISHED" | "DRAFT" | "ARCHIVED";
  order: number;
  created_at: string;
  updated_at: string;
}

export class PromotionsService {
  private getClient() {
    return getSupabaseAdmin();
  }

  private mapRow(row: any): PromotionMediaItem {
    return {
      id: row.id,
      title: row.title || "",
      subtitle: row.subtitle || "",
      media_type: row.media_type === "video" ? "video" : "image",
      media_url: row.media_url || "/coin.png",
      thumbnail_url: row.thumbnail_url || undefined,
      badge_text: row.badge_text || undefined,
      badge_color: row.badge_color || "violet",
      cta_text: row.cta_text || undefined,
      cta_link: row.cta_link || undefined,
      status: row.status || "PUBLISHED",
      order: typeof row.sort_order === "number" ? row.sort_order : 0,
      created_at: row.created_at || new Date().toISOString(),
      updated_at: row.updated_at || new Date().toISOString(),
    };
  }

  public async getActivePromotions(): Promise<PromotionMediaItem[]> {
    const supabase = this.getClient();
    const { data, error } = await supabase
      .from("promotions")
      .select("*")
      .eq("status", "PUBLISHED")
      .order("sort_order", { ascending: true });

    if (error) {
      console.error("[PromotionsService] Error fetching active promotions:", error.message);
      throw new Error("Failed to fetch active promotions: " + error.message);
    }

    return (data || []).map(this.mapRow);
  }

  public async getAllPromotions(): Promise<PromotionMediaItem[]> {
    const supabase = this.getClient();
    const { data, error } = await supabase
      .from("promotions")
      .select("*")
      .order("sort_order", { ascending: true });

    if (error) {
      console.error("[PromotionsService] Error fetching all promotions:", error.message);
      throw new Error("Failed to fetch promotions: " + error.message);
    }

    return (data || []).map(this.mapRow);
  }

  public async getPromotionById(id: string): Promise<PromotionMediaItem | null> {
    const supabase = this.getClient();
    const { data, error } = await supabase
      .from("promotions")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      console.error("[PromotionsService] Error fetching promotion by id:", error.message);
      throw new Error("Failed to fetch promotion: " + error.message);
    }

    return data ? this.mapRow(data) : null;
  }

  public async createPromotion(data: Partial<PromotionMediaItem>): Promise<PromotionMediaItem> {
    const supabase = this.getClient();
    // varchar(32) compatible id
    const id = `promo_${crypto.randomBytes(6).toString("hex")}`;
    const now = new Date().toISOString();

    let sortOrder = 1;
    if (typeof data.order === "number") {
      sortOrder = data.order;
    } else {
      const { data: maxRow } = await supabase
        .from("promotions")
        .select("sort_order")
        .order("sort_order", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (maxRow && typeof maxRow.sort_order === "number") {
        sortOrder = maxRow.sort_order + 1;
      }
    }

    const payload = {
      id,
      title: (data.title || "New Promotion").trim(),
      subtitle: (data.subtitle || "").trim() || null,
      media_type: data.media_type === "video" ? "video" : "image",
      media_url: (data.media_url || "/coin.png").trim(),
      badge_text: data.badge_text?.trim() || "Featured",
      badge_color: data.badge_color || "violet",
      cta_text: data.cta_text?.trim() || "Learn More",
      cta_link: data.cta_link?.trim() || "/dashboard",
      status: data.status === "DRAFT" ? "DRAFT" : "PUBLISHED",
      sort_order: sortOrder,
      created_at: now,
      updated_at: now,
    };

    const { data: created, error } = await supabase
      .from("promotions")
      .insert(payload)
      .select()
      .single();

    if (error || !created) {
      console.error("[PromotionsService] Error creating promotion:", error?.message);
      throw new Error("Failed to create promotion: " + (error?.message || "Unknown error"));
    }

    return this.mapRow(created);
  }

  public async updatePromotion(id: string, patch: Partial<PromotionMediaItem>): Promise<PromotionMediaItem | null> {
    const supabase = this.getClient();
    const updatePayload: any = {
      updated_at: new Date().toISOString(),
    };

    if (patch.title !== undefined) updatePayload.title = patch.title.trim();
    if (patch.subtitle !== undefined) updatePayload.subtitle = patch.subtitle.trim() || null;
    if (patch.media_type !== undefined) updatePayload.media_type = patch.media_type;
    if (patch.media_url !== undefined) updatePayload.media_url = patch.media_url.trim();
    if (patch.badge_text !== undefined) updatePayload.badge_text = patch.badge_text.trim() || null;
    if (patch.badge_color !== undefined) updatePayload.badge_color = patch.badge_color;
    if (patch.cta_text !== undefined) updatePayload.cta_text = patch.cta_text.trim() || null;
    if (patch.cta_link !== undefined) updatePayload.cta_link = patch.cta_link.trim() || null;
    if (patch.status !== undefined) updatePayload.status = patch.status;
    if (typeof patch.order === "number") updatePayload.sort_order = patch.order;

    const { data, error } = await supabase
      .from("promotions")
      .update(updatePayload)
      .eq("id", id)
      .select()
      .maybeSingle();

    if (error) {
      console.error("[PromotionsService] Error updating promotion:", error.message);
      throw new Error("Failed to update promotion: " + error.message);
    }

    return data ? this.mapRow(data) : null;
  }

  public async setStatus(id: string, status: "PUBLISHED" | "DRAFT" | "ARCHIVED"): Promise<PromotionMediaItem | null> {
    return this.updatePromotion(id, { status });
  }

  public async deletePromotion(id: string): Promise<boolean> {
    const supabase = this.getClient();
    const { error, count } = await supabase
      .from("promotions")
      .delete({ count: "exact" })
      .eq("id", id);

    if (error) {
      console.error("[PromotionsService] Error deleting promotion:", error.message);
      throw new Error("Failed to delete promotion: " + error.message);
    }

    return (count || 0) > 0;
  }

  public async reorder(orderedIds: string[]): Promise<PromotionMediaItem[]> {
    const supabase = this.getClient();
    for (let index = 0; index < orderedIds.length; index++) {
      const id = orderedIds[index];
      await supabase
        .from("promotions")
        .update({ sort_order: index + 1, updated_at: new Date().toISOString() })
        .eq("id", id);
    }
    return this.getAllPromotions();
  }

  public async resetToDefaults(): Promise<PromotionMediaItem[]> {
    const supabase = this.getClient();
    // Delete all current promotions from Supabase
    await supabase.from("promotions").delete().neq("id", "none");
    return this.getAllPromotions();
  }
}

export const promotionsService = new PromotionsService();
