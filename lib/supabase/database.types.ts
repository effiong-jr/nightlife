
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "invites": {
                  Row: {
                    "accepted_at": string | null,"accepted_by": string | null,"created_at": string,"created_by": string | null,"expires_at": string,"id": string,"role": Database["public"]['Enums']["staff_role"],"token_hash": string,"venue_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"created_at"?: string,"created_by"?: string | null,"expires_at": string,"id"?: string,"role": Database["public"]['Enums']["staff_role"],"token_hash": string,"venue_id": string
                  }
                  Update: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"created_at"?: string,"created_by"?: string | null,"expires_at"?: string,"id"?: string,"role"?: Database["public"]['Enums']["staff_role"],"token_hash"?: string,"venue_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "invites_accepted_by_fkey"
      columns: ["accepted_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "invites_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "invites_venue_id_fkey"
      columns: ["venue_id"]
isOneToOne: false
      referencedRelation: "venues"
      referencedColumns: ["id"]
    }
                  ]
                },"ledger_entries": {
                  Row: {
                    "amount": number,"created_at": string,"currency": string,"id": string,"kind": Database["public"]['Enums']["ledger_kind"],"order_id": string,"party": Database["public"]['Enums']["ledger_party"],"profile_id": string | null,"refund_id": string | null,"venue_id": string,"venue_night_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount": number,"created_at"?: string,"currency": string,"id"?: string,"kind": Database["public"]['Enums']["ledger_kind"],"order_id": string,"party": Database["public"]['Enums']["ledger_party"],"profile_id"?: string | null,"refund_id"?: string | null,"venue_id": string,"venue_night_id": string
                  }
                  Update: {
                    "amount"?: number,"created_at"?: string,"currency"?: string,"id"?: string,"kind"?: Database["public"]['Enums']["ledger_kind"],"order_id"?: string,"party"?: Database["public"]['Enums']["ledger_party"],"profile_id"?: string | null,"refund_id"?: string | null,"venue_id"?: string,"venue_night_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "ledger_entries_order_id_venue_id_fkey"
      columns: ["order_id","venue_id"]
isOneToOne: false
      referencedRelation: "orders"
      referencedColumns: ["id","venue_id"]
    },{
      foreignKeyName: "ledger_entries_profile_id_fkey"
      columns: ["profile_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "ledger_entries_refund_id_fkey"
      columns: ["refund_id"]
isOneToOne: false
      referencedRelation: "refunds"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "ledger_entries_venue_id_fkey"
      columns: ["venue_id"]
isOneToOne: false
      referencedRelation: "venues"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "ledger_entries_venue_night_id_venue_id_fkey"
      columns: ["venue_night_id","venue_id"]
isOneToOne: false
      referencedRelation: "venue_nights"
      referencedColumns: ["id","venue_id"]
    }
                  ]
                },"orders": {
                  Row: {
                    "amount": number,"created_at": string,"currency": string,"decided_at": string | null,"decided_by": string | null,"id": string,"message": string | null,"nickname": string,"paid_at": string | null,"show_on_leaderboard": boolean,"song_artist": string | null,"song_title": string | null,"spray_target": Database["public"]['Enums']["spray_target"] | null,"status": Database["public"]['Enums']["order_status"],"table_label": string | null,"type": Database["public"]['Enums']["order_type"],"venue_id": string,"venue_night_id": string,"screen_display_name": string | null
                  }
                  ComputedFields: "screen_display_name"
                  Insert: {
                    "amount": number,"created_at"?: string,"currency"?: string,"decided_at"?: string | null,"decided_by"?: string | null,"id"?: string,"message"?: string | null,"nickname": string,"paid_at"?: string | null,"show_on_leaderboard"?: boolean,"song_artist"?: string | null,"song_title"?: string | null,"spray_target"?: Database["public"]['Enums']["spray_target"] | null,"status"?: Database["public"]['Enums']["order_status"],"table_label"?: string | null,"type": Database["public"]['Enums']["order_type"],"venue_id": string,"venue_night_id": string
                  }
                  Update: {
                    "amount"?: number,"created_at"?: string,"currency"?: string,"decided_at"?: string | null,"decided_by"?: string | null,"id"?: string,"message"?: string | null,"nickname"?: string,"paid_at"?: string | null,"show_on_leaderboard"?: boolean,"song_artist"?: string | null,"song_title"?: string | null,"spray_target"?: Database["public"]['Enums']["spray_target"] | null,"status"?: Database["public"]['Enums']["order_status"],"table_label"?: string | null,"type"?: Database["public"]['Enums']["order_type"],"venue_id"?: string,"venue_night_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "orders_decided_by_fkey"
      columns: ["decided_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "orders_venue_id_fkey"
      columns: ["venue_id"]
isOneToOne: false
      referencedRelation: "venues"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "orders_venue_night_id_venue_id_fkey"
      columns: ["venue_night_id","venue_id"]
isOneToOne: false
      referencedRelation: "venue_nights"
      referencedColumns: ["id","venue_id"]
    }
                  ]
                },"payments": {
                  Row: {
                    "amount": number,"created_at": string,"currency": string,"id": string,"order_id": string,"provider": string,"provider_checkout_id": string | null,"provider_collection_id": string | null,"raw": Json | null,"status": Database["public"]['Enums']["payment_status"],"updated_at": string,"venue_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount": number,"created_at"?: string,"currency": string,"id"?: string,"order_id": string,"provider": string,"provider_checkout_id"?: string | null,"provider_collection_id"?: string | null,"raw"?: Json | null,"status"?: Database["public"]['Enums']["payment_status"],"updated_at"?: string,"venue_id": string
                  }
                  Update: {
                    "amount"?: number,"created_at"?: string,"currency"?: string,"id"?: string,"order_id"?: string,"provider"?: string,"provider_checkout_id"?: string | null,"provider_collection_id"?: string | null,"raw"?: Json | null,"status"?: Database["public"]['Enums']["payment_status"],"updated_at"?: string,"venue_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "payments_order_id_venue_id_fkey"
      columns: ["order_id","venue_id"]
isOneToOne: false
      referencedRelation: "orders"
      referencedColumns: ["id","venue_id"]
    },{
      foreignKeyName: "payments_venue_id_fkey"
      columns: ["venue_id"]
isOneToOne: false
      referencedRelation: "venues"
      referencedColumns: ["id"]
    }
                  ]
                },"payout_accounts": {
                  Row: {
                    "created_at": string,"id": string,"profile_id": string | null,"provider": string,"recipient_id": string,"status": Database["public"]['Enums']["payout_account_status"],"updated_at": string,"venue_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"profile_id"?: string | null,"provider": string,"recipient_id": string,"status"?: Database["public"]['Enums']["payout_account_status"],"updated_at"?: string,"venue_id"?: string | null
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"profile_id"?: string | null,"provider"?: string,"recipient_id"?: string,"status"?: Database["public"]['Enums']["payout_account_status"],"updated_at"?: string,"venue_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "payout_accounts_profile_id_fkey"
      columns: ["profile_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "payout_accounts_venue_id_fkey"
      columns: ["venue_id"]
isOneToOne: false
      referencedRelation: "venues"
      referencedColumns: ["id"]
    }
                  ]
                },"payouts": {
                  Row: {
                    "amount": number,"created_at": string,"currency": string,"id": string,"idempotency_key": string,"party": Database["public"]['Enums']["ledger_party"],"profile_id": string | null,"provider": string,"provider_payout_id": string | null,"status": Database["public"]['Enums']["payout_status"],"updated_at": string,"venue_id": string,"venue_night_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount": number,"created_at"?: string,"currency": string,"id"?: string,"idempotency_key": string,"party": Database["public"]['Enums']["ledger_party"],"profile_id"?: string | null,"provider": string,"provider_payout_id"?: string | null,"status"?: Database["public"]['Enums']["payout_status"],"updated_at"?: string,"venue_id": string,"venue_night_id": string
                  }
                  Update: {
                    "amount"?: number,"created_at"?: string,"currency"?: string,"id"?: string,"idempotency_key"?: string,"party"?: Database["public"]['Enums']["ledger_party"],"profile_id"?: string | null,"provider"?: string,"provider_payout_id"?: string | null,"status"?: Database["public"]['Enums']["payout_status"],"updated_at"?: string,"venue_id"?: string,"venue_night_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "payouts_profile_id_fkey"
      columns: ["profile_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "payouts_venue_id_fkey"
      columns: ["venue_id"]
isOneToOne: false
      referencedRelation: "venues"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "payouts_venue_night_id_venue_id_fkey"
      columns: ["venue_night_id","venue_id"]
isOneToOne: false
      referencedRelation: "venue_nights"
      referencedColumns: ["id","venue_id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "created_at": string,"display_name": string,"id": string,"is_admin": boolean
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"display_name"?: string,"id": string,"is_admin"?: boolean
                  }
                  Update: {
                    "created_at"?: string,"display_name"?: string,"id"?: string,"is_admin"?: boolean
                  }
                  Relationships: [
                    
                  ]
                },"refunds": {
                  Row: {
                    "amount": number,"created_at": string,"currency": string,"id": string,"idempotency_key": string,"order_id": string,"provider": string,"provider_refund_id": string | null,"reason": string,"status": Database["public"]['Enums']["refund_status"],"updated_at": string,"venue_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount": number,"created_at"?: string,"currency": string,"id"?: string,"idempotency_key": string,"order_id": string,"provider": string,"provider_refund_id"?: string | null,"reason": string,"status"?: Database["public"]['Enums']["refund_status"],"updated_at"?: string,"venue_id": string
                  }
                  Update: {
                    "amount"?: number,"created_at"?: string,"currency"?: string,"id"?: string,"idempotency_key"?: string,"order_id"?: string,"provider"?: string,"provider_refund_id"?: string | null,"reason"?: string,"status"?: Database["public"]['Enums']["refund_status"],"updated_at"?: string,"venue_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "refunds_order_id_venue_id_fkey"
      columns: ["order_id","venue_id"]
isOneToOne: false
      referencedRelation: "orders"
      referencedColumns: ["id","venue_id"]
    },{
      foreignKeyName: "refunds_venue_id_fkey"
      columns: ["venue_id"]
isOneToOne: false
      referencedRelation: "venues"
      referencedColumns: ["id"]
    }
                  ]
                },"venue_nights": {
                  Row: {
                    "closed_at": string | null,"created_at": string,"dj_profile_id": string | null,"id": string,"mc_profile_id": string | null,"night_date": string,"opened_at": string | null,"settled_at": string | null,"venue_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "closed_at"?: string | null,"created_at"?: string,"dj_profile_id"?: string | null,"id"?: string,"mc_profile_id"?: string | null,"night_date": string,"opened_at"?: string | null,"settled_at"?: string | null,"venue_id": string
                  }
                  Update: {
                    "closed_at"?: string | null,"created_at"?: string,"dj_profile_id"?: string | null,"id"?: string,"mc_profile_id"?: string | null,"night_date"?: string,"opened_at"?: string | null,"settled_at"?: string | null,"venue_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "venue_nights_dj_profile_id_fkey"
      columns: ["dj_profile_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "venue_nights_mc_profile_id_fkey"
      columns: ["mc_profile_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "venue_nights_venue_id_fkey"
      columns: ["venue_id"]
isOneToOne: false
      referencedRelation: "venues"
      referencedColumns: ["id"]
    }
                  ]
                },"venue_pricing": {
                  Row: {
                    "enabled": boolean,"min_amount": number,"order_type": Database["public"]['Enums']["order_type"],"venue_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "enabled"?: boolean,"min_amount": number,"order_type": Database["public"]['Enums']["order_type"],"venue_id": string
                  }
                  Update: {
                    "enabled"?: boolean,"min_amount"?: number,"order_type"?: Database["public"]['Enums']["order_type"],"venue_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "venue_pricing_venue_id_fkey"
      columns: ["venue_id"]
isOneToOne: false
      referencedRelation: "venues"
      referencedColumns: ["id"]
    }
                  ]
                },"venue_splits": {
                  Row: {
                    "club_bps": number,"dj_bps": number,"mc_bps": number,"order_type": Database["public"]['Enums']["order_type"],"platform_bps": number,"venue_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "club_bps": number,"dj_bps": number,"mc_bps": number,"order_type": Database["public"]['Enums']["order_type"],"platform_bps": number,"venue_id": string
                  }
                  Update: {
                    "club_bps"?: number,"dj_bps"?: number,"mc_bps"?: number,"order_type"?: Database["public"]['Enums']["order_type"],"platform_bps"?: number,"venue_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "venue_splits_venue_id_fkey"
      columns: ["venue_id"]
isOneToOne: false
      referencedRelation: "venues"
      referencedColumns: ["id"]
    }
                  ]
                },"venue_staff": {
                  Row: {
                    "created_at": string,"id": string,"invited_by": string | null,"profile_id": string,"role": Database["public"]['Enums']["staff_role"],"status": Database["public"]['Enums']["staff_status"],"venue_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"invited_by"?: string | null,"profile_id": string,"role": Database["public"]['Enums']["staff_role"],"status"?: Database["public"]['Enums']["staff_status"],"venue_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"invited_by"?: string | null,"profile_id"?: string,"role"?: Database["public"]['Enums']["staff_role"],"status"?: Database["public"]['Enums']["staff_status"],"venue_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "venue_staff_invited_by_fkey"
      columns: ["invited_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "venue_staff_profile_id_fkey"
      columns: ["profile_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "venue_staff_venue_id_fkey"
      columns: ["venue_id"]
isOneToOne: false
      referencedRelation: "venues"
      referencedColumns: ["id"]
    }
                  ]
                },"venues": {
                  Row: {
                    "address": string | null,"created_at": string,"currency": string,"id": string,"name": string,"request_timeout_minutes": number,"slug": string,"status": Database["public"]['Enums']["venue_status"]
                  }
                  ComputedFields: never
                  Insert: {
                    "address"?: string | null,"created_at"?: string,"currency"?: string,"id"?: string,"name": string,"request_timeout_minutes"?: number,"slug": string,"status"?: Database["public"]['Enums']["venue_status"]
                  }
                  Update: {
                    "address"?: string | null,"created_at"?: string,"currency"?: string,"id"?: string,"name"?: string,"request_timeout_minutes"?: number,"slug"?: string,"status"?: Database["public"]['Enums']["venue_status"]
                  }
                  Relationships: [
                    
                  ]
                },"webhook_events": {
                  Row: {
                    "error": string | null,"id": string,"payload": NonNullable<Json>,"processed_at": string | null,"provider": string,"provider_event_id": string,"received_at": string,"type": string
                  }
                  ComputedFields: never
                  Insert: {
                    "error"?: string | null,"id"?: string,"payload": NonNullable<Json>,"processed_at"?: string | null,"provider": string,"provider_event_id": string,"received_at"?: string,"type": string
                  }
                  Update: {
                    "error"?: string | null,"id"?: string,"payload"?: NonNullable<Json>,"processed_at"?: string | null,"provider"?: string,"provider_event_id"?: string,"received_at"?: string,"type"?: string
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "can_decide_order":
{ Args: { "p_type": Database["public"]['Enums']["order_type"],"p_venue_id": string }; Returns: boolean
                           },
"can_join_venue_topic":
{ Args: { "p_topic": string }; Returns: boolean
                           },
"can_place_order":
{ Args: { "p_amount": number,"p_currency": string,"p_night_id": string,"p_type": Database["public"]['Enums']["order_type"],"p_venue_id": string }; Returns: boolean
                           },
"compute_split":
{ Args: { "p_amount": number,"p_club_bps": number,"p_dj_bps": number,"p_has_dj": boolean,"p_has_mc": boolean,"p_mc_bps": number,"p_platform_bps": number }; Returns: {
              "amount": number,"party": Database["public"]['Enums']["ledger_party"]
            }[]
                           },
"has_venue_role":
{ Args: { "p_roles": (Database["public"]['Enums']["staff_role"])[],"p_venue_id": string }; Returns: boolean
                           },
"is_admin":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"is_venue_staff":
{ Args: { "p_venue_id": string }; Returns: boolean
                           },
"record_paid_order":
{ Args: { "p_amount": number,"p_checkout_id": string,"p_collection_id": string,"p_currency": string,"p_event_id": string,"p_event_type": string,"p_order_id": string,"p_payload": Json,"p_provider": string }; Returns: string
                           },
"record_webhook_failure":
{ Args: { "p_error": string,"p_event_id": string,"p_event_type": string,"p_payload": Json,"p_provider": string }; Returns: undefined
                           },
"screen_display_name":
{ Args: { "p_order": Omit<Database["public"]['Tables']["orders"]['Row'], Database["public"]['Tables']["orders"]['ComputedFields']> }; Returns: string
                           },
"screen_snapshot":
{ Args: { "p_venue_id": string }; Returns: Json
                           },
"shares_venue_with":
{ Args: { "p_profile_id": string }; Returns: boolean
                           }
          }
          Enums: {
            "ledger_kind": "share"|"refund_reversal","ledger_party": "club"|"dj"|"mc"|"platform","order_status": "pending_payment"|"paid"|"approved"|"rejected"|"fulfilled"|"refunded"|"expired","order_type": "spray"|"screen_shoutout"|"mc_shoutout"|"song_request","payment_status": "pending"|"succeeded"|"failed","payout_account_status": "pending"|"active"|"restricted","payout_status": "pending"|"processing"|"paid"|"failed","refund_status": "pending"|"succeeded"|"failed","spray_target": "dj"|"mc"|"celebrant","staff_role": "club_manager"|"dj"|"mc","staff_status": "active"|"revoked","venue_status": "pending"|"active"|"suspended"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            "ledger_kind": ["share", "refund_reversal"],"ledger_party": ["club", "dj", "mc", "platform"],"order_status": ["pending_payment", "paid", "approved", "rejected", "fulfilled", "refunded", "expired"],"order_type": ["spray", "screen_shoutout", "mc_shoutout", "song_request"],"payment_status": ["pending", "succeeded", "failed"],"payout_account_status": ["pending", "active", "restricted"],"payout_status": ["pending", "processing", "paid", "failed"],"refund_status": ["pending", "succeeded", "failed"],"spray_target": ["dj", "mc", "celebrant"],"staff_role": ["club_manager", "dj", "mc"],"staff_status": ["active", "revoked"],"venue_status": ["pending", "active", "suspended"]
          }
        }
} as const
