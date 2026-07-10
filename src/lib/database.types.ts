// Generated from Supabase STAGING project (azjxprewycygsocusxjn) via generate_typescript_types.
// Read-only type definitions. Do NOT hand-edit; regenerate when the staging schema changes.
// No secrets: this file contains only schema shapes (table/column/enum names).

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      activity_logs: {
        Row: {
          action: string
          actor_role: string | null
          actor_user_id: string | null
          after_json: Json | null
          before_json: Json | null
          created_at: string
          id: string
          ip_address: unknown
          module: string | null
          record_id: string | null
          record_table: string | null
          tenant_id: string | null
          user_agent: string | null
        }
        Insert: {
          action: string
          actor_role?: string | null
          actor_user_id?: string | null
          after_json?: Json | null
          before_json?: Json | null
          created_at?: string
          id?: string
          ip_address?: unknown
          module?: string | null
          record_id?: string | null
          record_table?: string | null
          tenant_id?: string | null
          user_agent?: string | null
        }
        Update: {
          action?: string
          actor_role?: string | null
          actor_user_id?: string | null
          after_json?: Json | null
          before_json?: Json | null
          created_at?: string
          id?: string
          ip_address?: unknown
          module?: string | null
          record_id?: string | null
          record_table?: string | null
          tenant_id?: string | null
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "activity_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      branch_approval_requests: {
        Row: {
          branch_address: string | null
          branch_area: string | null
          branch_city: string | null
          branch_code_id: string | null
          branch_id: string | null
          branch_name: string
          branch_phone: string | null
          created_at: string
          id: string
          reason: string | null
          requested_at: string
          requested_by: string | null
          review_note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          branch_address?: string | null
          branch_area?: string | null
          branch_city?: string | null
          branch_code_id?: string | null
          branch_id?: string | null
          branch_name: string
          branch_phone?: string | null
          created_at?: string
          id?: string
          reason?: string | null
          requested_at?: string
          requested_by?: string | null
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          branch_address?: string | null
          branch_area?: string | null
          branch_city?: string | null
          branch_code_id?: string | null
          branch_id?: string | null
          branch_name?: string
          branch_phone?: string | null
          created_at?: string
          id?: string
          reason?: string | null
          requested_at?: string
          requested_by?: string | null
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "branch_approval_requests_branch_code_id_fkey"
            columns: ["branch_code_id"]
            isOneToOne: false
            referencedRelation: "branch_codes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "branch_approval_requests_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "branch_approval_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      branch_codes: {
        Row: {
          code: string
          created_at: string
          expires_at: string | null
          generated_at: string
          generated_by: string | null
          id: string
          max_uses: number
          note: string | null
          status: string
          tenant_id: string | null
          updated_at: string
          used_at: string | null
          used_by_tenant_id: string | null
          used_by_user_id: string | null
          used_count: number
          used_for_branch_id: string | null
        }
        Insert: {
          code: string
          created_at?: string
          expires_at?: string | null
          generated_at?: string
          generated_by?: string | null
          id?: string
          max_uses?: number
          note?: string | null
          status?: string
          tenant_id?: string | null
          updated_at?: string
          used_at?: string | null
          used_by_tenant_id?: string | null
          used_by_user_id?: string | null
          used_count?: number
          used_for_branch_id?: string | null
        }
        Update: {
          code?: string
          created_at?: string
          expires_at?: string | null
          generated_at?: string
          generated_by?: string | null
          id?: string
          max_uses?: number
          note?: string | null
          status?: string
          tenant_id?: string | null
          updated_at?: string
          used_at?: string | null
          used_by_tenant_id?: string | null
          used_by_user_id?: string | null
          used_count?: number
          used_for_branch_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "branch_codes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "branch_codes_used_by_tenant_id_fkey"
            columns: ["used_by_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "branch_codes_used_for_branch_id_fkey"
            columns: ["used_for_branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      branches: {
        Row: {
          address: string | null
          approved_at: string | null
          approved_by: string | null
          archived_at: string | null
          area: string | null
          branch_number: number | null
          city: string | null
          created_at: string
          created_by: string | null
          id: string
          is_main: boolean
          logo_url: string | null
          name: string
          phone: string | null
          rejected_at: string | null
          rejection_reason: string | null
          requested_by: string | null
          status: Database["public"]["Enums"]["branch_status"]
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          address?: string | null
          approved_at?: string | null
          approved_by?: string | null
          archived_at?: string | null
          area?: string | null
          branch_number?: number | null
          city?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_main?: boolean
          logo_url?: string | null
          name: string
          phone?: string | null
          rejected_at?: string | null
          rejection_reason?: string | null
          requested_by?: string | null
          status?: Database["public"]["Enums"]["branch_status"]
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          address?: string | null
          approved_at?: string | null
          approved_by?: string | null
          archived_at?: string | null
          area?: string | null
          branch_number?: number | null
          city?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_main?: boolean
          logo_url?: string | null
          name?: string
          phone?: string | null
          rejected_at?: string | null
          rejection_reason?: string | null
          requested_by?: string | null
          status?: Database["public"]["Enums"]["branch_status"]
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "branches_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      cost_material_categories: {
        Row: {
          color: string | null
          created_at: string
          created_by: string | null
          description: string | null
          icon: string | null
          id: string
          is_active: boolean
          is_global: boolean
          is_system: boolean
          name: string
          slug: string | null
          sort_order: number
          tenant_id: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          color?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          icon?: string | null
          id?: string
          is_active?: boolean
          is_global?: boolean
          is_system?: boolean
          name: string
          slug?: string | null
          sort_order?: number
          tenant_id?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          color?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          icon?: string | null
          id?: string
          is_active?: boolean
          is_global?: boolean
          is_system?: boolean
          name?: string
          slug?: string | null
          sort_order?: number
          tenant_id?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cost_material_categories_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_material_categories_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_material_categories_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      cost_materials: {
        Row: {
          accounting_type: string
          archived_at: string | null
          base_unit_id: string
          branch_id: string | null
          category: string | null
          cost_method: string
          created_at: string
          created_by: string | null
          current_cost_per_base_unit: number
          has_expiry: boolean
          id: string
          last_batch_total_cost: number | null
          last_purchase_price: number | null
          material_category_id: string | null
          material_type: string
          minimum_stock_quantity: number
          name: string
          notes: string | null
          prep_waste_percent: number
          purchase_unit_id: string | null
          purchase_unit_quantity: number | null
          recipe_unit_label: string | null
          status: string
          stock_tracked: boolean
          tenant_id: string
          updated_at: string
          updated_by: string | null
          yield_quantity: number | null
          yield_unit_id: string | null
        }
        Insert: {
          accounting_type?: string
          archived_at?: string | null
          base_unit_id: string
          branch_id?: string | null
          category?: string | null
          cost_method?: string
          created_at?: string
          created_by?: string | null
          current_cost_per_base_unit?: number
          has_expiry?: boolean
          id?: string
          last_batch_total_cost?: number | null
          last_purchase_price?: number | null
          material_category_id?: string | null
          material_type: string
          minimum_stock_quantity?: number
          name: string
          notes?: string | null
          prep_waste_percent?: number
          purchase_unit_id?: string | null
          purchase_unit_quantity?: number | null
          recipe_unit_label?: string | null
          status?: string
          stock_tracked?: boolean
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
          yield_quantity?: number | null
          yield_unit_id?: string | null
        }
        Update: {
          accounting_type?: string
          archived_at?: string | null
          base_unit_id?: string
          branch_id?: string | null
          category?: string | null
          cost_method?: string
          created_at?: string
          created_by?: string | null
          current_cost_per_base_unit?: number
          has_expiry?: boolean
          id?: string
          last_batch_total_cost?: number | null
          last_purchase_price?: number | null
          material_category_id?: string | null
          material_type?: string
          minimum_stock_quantity?: number
          name?: string
          notes?: string | null
          prep_waste_percent?: number
          purchase_unit_id?: string | null
          purchase_unit_quantity?: number | null
          recipe_unit_label?: string | null
          status?: string
          stock_tracked?: boolean
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
          yield_quantity?: number | null
          yield_unit_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cost_materials_base_unit_id_fkey"
            columns: ["base_unit_id"]
            isOneToOne: false
            referencedRelation: "cost_units"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_materials_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_materials_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_materials_material_category_id_fkey"
            columns: ["material_category_id"]
            isOneToOne: false
            referencedRelation: "cost_material_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_materials_purchase_unit_id_fkey"
            columns: ["purchase_unit_id"]
            isOneToOne: false
            referencedRelation: "cost_units"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_materials_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_materials_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_materials_yield_unit_id_fkey"
            columns: ["yield_unit_id"]
            isOneToOne: false
            referencedRelation: "cost_units"
            referencedColumns: ["id"]
          },
        ]
      }
      cost_prepared_recipe_lines: {
        Row: {
          archived_at: string | null
          branch_id: string | null
          component_material_id: string
          created_at: string
          created_by: string | null
          id: string
          prepared_material_id: string
          quantity: number
          sort_order: number
          status: string
          tenant_id: string
          unit_id: string
          updated_at: string
          updated_by: string | null
          waste_percent: number
        }
        Insert: {
          archived_at?: string | null
          branch_id?: string | null
          component_material_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          prepared_material_id: string
          quantity: number
          sort_order?: number
          status?: string
          tenant_id: string
          unit_id: string
          updated_at?: string
          updated_by?: string | null
          waste_percent?: number
        }
        Update: {
          archived_at?: string | null
          branch_id?: string | null
          component_material_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          prepared_material_id?: string
          quantity?: number
          sort_order?: number
          status?: string
          tenant_id?: string
          unit_id?: string
          updated_at?: string
          updated_by?: string | null
          waste_percent?: number
        }
        Relationships: [
          {
            foreignKeyName: "cost_prepared_recipe_lines_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_prepared_recipe_lines_component_material_id_fkey"
            columns: ["component_material_id"]
            isOneToOne: false
            referencedRelation: "cost_materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_prepared_recipe_lines_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_prepared_recipe_lines_prepared_material_id_fkey"
            columns: ["prepared_material_id"]
            isOneToOne: false
            referencedRelation: "cost_materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_prepared_recipe_lines_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_prepared_recipe_lines_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "cost_units"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_prepared_recipe_lines_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      cost_price_update_batches: {
        Row: {
          archived_at: string | null
          branch_id: string | null
          created_at: string
          created_by: string | null
          id: string
          invoice_reference: string | null
          notes: string | null
          purchase_date: string
          status: string
          supplier_name: string | null
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          archived_at?: string | null
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          invoice_reference?: string | null
          notes?: string | null
          purchase_date: string
          status?: string
          supplier_name?: string | null
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          archived_at?: string | null
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          invoice_reference?: string | null
          notes?: string | null
          purchase_date?: string
          status?: string
          supplier_name?: string | null
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cost_price_update_batches_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_price_update_batches_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_price_update_batches_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_price_update_batches_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      cost_price_update_items: {
        Row: {
          batch_id: string
          calculated_cost_per_base_unit: number
          created_at: string
          created_by: string | null
          currency_code: string
          exchange_rate_usd_to_lbp: number | null
          id: string
          material_id: string
          original_total_price: number | null
          previous_cost_per_base_unit: number | null
          purchased_quantity: number
          purchased_unit_id: string
          tenant_id: string
          total_price: number
        }
        Insert: {
          batch_id: string
          calculated_cost_per_base_unit: number
          created_at?: string
          created_by?: string | null
          currency_code?: string
          exchange_rate_usd_to_lbp?: number | null
          id?: string
          material_id: string
          original_total_price?: number | null
          previous_cost_per_base_unit?: number | null
          purchased_quantity: number
          purchased_unit_id: string
          tenant_id: string
          total_price: number
        }
        Update: {
          batch_id?: string
          calculated_cost_per_base_unit?: number
          created_at?: string
          created_by?: string | null
          currency_code?: string
          exchange_rate_usd_to_lbp?: number | null
          id?: string
          material_id?: string
          original_total_price?: number | null
          previous_cost_per_base_unit?: number | null
          purchased_quantity?: number
          purchased_unit_id?: string
          tenant_id?: string
          total_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "cost_price_update_items_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "cost_price_update_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_price_update_items_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_price_update_items_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "cost_materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_price_update_items_purchased_unit_id_fkey"
            columns: ["purchased_unit_id"]
            isOneToOne: false
            referencedRelation: "cost_units"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_price_update_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      cost_units: {
        Row: {
          base_key: string
          created_at: string
          id: string
          key: string
          name: string
          sort_order: number
          to_base_factor: number
          unit_type: string
        }
        Insert: {
          base_key: string
          created_at?: string
          id?: string
          key: string
          name: string
          sort_order?: number
          to_base_factor: number
          unit_type: string
        }
        Update: {
          base_key?: string
          created_at?: string
          id?: string
          key?: string
          name?: string
          sort_order?: number
          to_base_factor?: number
          unit_type?: string
        }
        Relationships: []
      }
      e_menu_analytics_events: {
        Row: {
          branch_id: string | null
          category_id: string | null
          created_at: string
          device_type: string | null
          event_type: string
          id: string
          menu_item_id: string | null
          metadata: Json | null
          session_id: string | null
          tenant_id: string
        }
        Insert: {
          branch_id?: string | null
          category_id?: string | null
          created_at?: string
          device_type?: string | null
          event_type: string
          id?: string
          menu_item_id?: string | null
          metadata?: Json | null
          session_id?: string | null
          tenant_id: string
        }
        Update: {
          branch_id?: string | null
          category_id?: string | null
          created_at?: string
          device_type?: string | null
          event_type?: string
          id?: string
          menu_item_id?: string | null
          metadata?: Json | null
          session_id?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "e_menu_analytics_events_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "e_menu_analytics_events_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "menu_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "e_menu_analytics_events_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "menu_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "e_menu_analytics_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      e_menu_lead_items: {
        Row: {
          base_price_snapshot: number | null
          branch_id: string | null
          created_at: string
          id: string
          item_name_snapshot: string | null
          lead_id: string
          line_total: number | null
          menu_item_id: string | null
          modifiers_snapshot: Json | null
          notes: string | null
          quantity: number
          tenant_id: string
        }
        Insert: {
          base_price_snapshot?: number | null
          branch_id?: string | null
          created_at?: string
          id?: string
          item_name_snapshot?: string | null
          lead_id: string
          line_total?: number | null
          menu_item_id?: string | null
          modifiers_snapshot?: Json | null
          notes?: string | null
          quantity?: number
          tenant_id: string
        }
        Update: {
          base_price_snapshot?: number | null
          branch_id?: string | null
          created_at?: string
          id?: string
          item_name_snapshot?: string | null
          lead_id?: string
          line_total?: number | null
          menu_item_id?: string | null
          modifiers_snapshot?: Json | null
          notes?: string | null
          quantity?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "e_menu_lead_items_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "e_menu_lead_items_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "e_menu_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "e_menu_lead_items_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "menu_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "e_menu_lead_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      e_menu_leads: {
        Row: {
          branch_id: string | null
          cart_summary: Json
          created_at: string
          currency: string
          customer_name: string | null
          customer_phone: string | null
          delivery_address: string | null
          delivery_notes: string | null
          id: string
          lead_number: string | null
          order_notes: string | null
          session_id: string | null
          source: string
          status: string
          subtotal: number | null
          tenant_id: string
          total: number | null
          whatsapp_message: string | null
          whatsapp_number_used: string | null
        }
        Insert: {
          branch_id?: string | null
          cart_summary?: Json
          created_at?: string
          currency?: string
          customer_name?: string | null
          customer_phone?: string | null
          delivery_address?: string | null
          delivery_notes?: string | null
          id?: string
          lead_number?: string | null
          order_notes?: string | null
          session_id?: string | null
          source?: string
          status?: string
          subtotal?: number | null
          tenant_id: string
          total?: number | null
          whatsapp_message?: string | null
          whatsapp_number_used?: string | null
        }
        Update: {
          branch_id?: string | null
          cart_summary?: Json
          created_at?: string
          currency?: string
          customer_name?: string | null
          customer_phone?: string | null
          delivery_address?: string | null
          delivery_notes?: string | null
          id?: string
          lead_number?: string | null
          order_notes?: string | null
          session_id?: string | null
          source?: string
          status?: string
          subtotal?: number | null
          tenant_id?: string
          total?: number | null
          whatsapp_message?: string | null
          whatsapp_number_used?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "e_menu_leads_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "e_menu_leads_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      e_menu_settings: {
        Row: {
          allow_item_notes: boolean
          analytics_config: Json
          branch_id: string | null
          checkout_field_config: Json
          cover_image_url: string | null
          created_at: string
          created_by: string | null
          default_language: string
          delivery_enabled: boolean
          delivery_fee: number | null
          dine_in_enabled: boolean
          id: string
          include_address: boolean
          include_customer_name: boolean
          include_item_notes: boolean
          include_modifiers: boolean
          include_phone: boolean
          is_enabled: boolean
          lead_tracking_enabled: boolean
          opening_hours: Json | null
          ordering_enabled: boolean
          promo_image_url: string | null
          promo_link: string | null
          show_allergens: boolean
          show_ingredients: boolean
          show_item_images: boolean
          show_prices: boolean
          social_links: Json
          takeaway_enabled: boolean
          template_key: string
          tenant_id: string
          timezone: string
          updated_at: string
          updated_by: string | null
          whatsapp_checkout_enabled: boolean
          whatsapp_number: string | null
        }
        Insert: {
          allow_item_notes?: boolean
          analytics_config?: Json
          branch_id?: string | null
          checkout_field_config?: Json
          cover_image_url?: string | null
          created_at?: string
          created_by?: string | null
          default_language?: string
          delivery_enabled?: boolean
          delivery_fee?: number | null
          dine_in_enabled?: boolean
          id?: string
          include_address?: boolean
          include_customer_name?: boolean
          include_item_notes?: boolean
          include_modifiers?: boolean
          include_phone?: boolean
          is_enabled?: boolean
          lead_tracking_enabled?: boolean
          opening_hours?: Json | null
          ordering_enabled?: boolean
          promo_image_url?: string | null
          promo_link?: string | null
          show_allergens?: boolean
          show_ingredients?: boolean
          show_item_images?: boolean
          show_prices?: boolean
          social_links?: Json
          takeaway_enabled?: boolean
          template_key?: string
          tenant_id: string
          timezone?: string
          updated_at?: string
          updated_by?: string | null
          whatsapp_checkout_enabled?: boolean
          whatsapp_number?: string | null
        }
        Update: {
          allow_item_notes?: boolean
          analytics_config?: Json
          branch_id?: string | null
          checkout_field_config?: Json
          cover_image_url?: string | null
          created_at?: string
          created_by?: string | null
          default_language?: string
          delivery_enabled?: boolean
          delivery_fee?: number | null
          dine_in_enabled?: boolean
          id?: string
          include_address?: boolean
          include_customer_name?: boolean
          include_item_notes?: boolean
          include_modifiers?: boolean
          include_phone?: boolean
          is_enabled?: boolean
          lead_tracking_enabled?: boolean
          opening_hours?: Json | null
          ordering_enabled?: boolean
          promo_image_url?: string | null
          promo_link?: string | null
          show_allergens?: boolean
          show_ingredients?: boolean
          show_item_images?: boolean
          show_prices?: boolean
          social_links?: Json
          takeaway_enabled?: boolean
          template_key?: string
          tenant_id?: string
          timezone?: string
          updated_at?: string
          updated_by?: string | null
          whatsapp_checkout_enabled?: boolean
          whatsapp_number?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "e_menu_settings_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "e_menu_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      emenu_slug_aliases: {
        Row: {
          branch_id: string
          created_at: string
          slug: string
          tenant_id: string
        }
        Insert: {
          branch_id: string
          created_at?: string
          slug: string
          tenant_id: string
        }
        Update: {
          branch_id?: string
          created_at?: string
          slug?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "emenu_slug_aliases_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emenu_slug_aliases_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_categories: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          is_active: boolean
          is_system: boolean
          name: string
          sort_order: number
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          is_system?: boolean
          name: string
          sort_order?: number
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          is_system?: boolean
          name?: string
          sort_order?: number
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "expense_categories_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      expenses: {
        Row: {
          amount: number
          amount_usd: number | null
          attachment_url: string | null
          branch_id: string | null
          category: string
          category_id: string | null
          created_at: string
          created_by: string | null
          currency_code: string
          description: string | null
          exchange_rate_usd_to_lbp: number | null
          expense_date: string
          id: string
          notes: string | null
          original_amount: number | null
          paid_amount: number
          payee: string | null
          payment_method: string | null
          payment_status: string
          status: string
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          amount?: number
          amount_usd?: number | null
          attachment_url?: string | null
          branch_id?: string | null
          category?: string
          category_id?: string | null
          created_at?: string
          created_by?: string | null
          currency_code?: string
          description?: string | null
          exchange_rate_usd_to_lbp?: number | null
          expense_date?: string
          id?: string
          notes?: string | null
          original_amount?: number | null
          paid_amount?: number
          payee?: string | null
          payment_method?: string | null
          payment_status?: string
          status?: string
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          amount?: number
          amount_usd?: number | null
          attachment_url?: string | null
          branch_id?: string | null
          category?: string
          category_id?: string | null
          created_at?: string
          created_by?: string | null
          currency_code?: string
          description?: string | null
          exchange_rate_usd_to_lbp?: number | null
          expense_date?: string
          id?: string
          notes?: string | null
          original_amount?: number | null
          paid_amount?: number
          payee?: string | null
          payment_method?: string | null
          payment_status?: string
          status?: string
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "expenses_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "expense_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_batches: {
        Row: {
          available_quantity: number
          base_unit_id: string | null
          batch_number: string | null
          branch_id: string
          created_at: string
          created_by: string | null
          expiry_date: string | null
          has_expiry: boolean
          id: string
          initial_quantity: number
          material_id: string
          purchase_invoice_id: string | null
          purchase_invoice_item_id: string | null
          received_at: string
          status: string
          tenant_id: string
          unit_cost: number
          updated_at: string
        }
        Insert: {
          available_quantity?: number
          base_unit_id?: string | null
          batch_number?: string | null
          branch_id: string
          created_at?: string
          created_by?: string | null
          expiry_date?: string | null
          has_expiry?: boolean
          id?: string
          initial_quantity?: number
          material_id: string
          purchase_invoice_id?: string | null
          purchase_invoice_item_id?: string | null
          received_at?: string
          status?: string
          tenant_id: string
          unit_cost?: number
          updated_at?: string
        }
        Update: {
          available_quantity?: number
          base_unit_id?: string | null
          batch_number?: string | null
          branch_id?: string
          created_at?: string
          created_by?: string | null
          expiry_date?: string | null
          has_expiry?: boolean
          id?: string
          initial_quantity?: number
          material_id?: string
          purchase_invoice_id?: string | null
          purchase_invoice_item_id?: string | null
          received_at?: string
          status?: string
          tenant_id?: string
          unit_cost?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_batches_base_unit_id_fkey"
            columns: ["base_unit_id"]
            isOneToOne: false
            referencedRelation: "cost_units"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_batches_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_batches_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "cost_materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_batches_purchase_invoice_id_fkey"
            columns: ["purchase_invoice_id"]
            isOneToOne: false
            referencedRelation: "purchase_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_batches_purchase_invoice_item_id_fkey"
            columns: ["purchase_invoice_item_id"]
            isOneToOne: false
            referencedRelation: "purchase_invoice_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_batches_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_movements: {
        Row: {
          accounting_impact: string | null
          avg_cost_after: number
          balance_after: number
          base_unit_id: string | null
          branch_id: string
          consumption_type: string | null
          created_at: string
          created_by: string | null
          id: string
          material_id: string
          movement_type: string
          notes: string | null
          quantity_in: number
          quantity_out: number
          reference_id: string | null
          reference_table: string | null
          tenant_id: string
          total_cost: number
          unit_cost: number
        }
        Insert: {
          accounting_impact?: string | null
          avg_cost_after?: number
          balance_after?: number
          base_unit_id?: string | null
          branch_id: string
          consumption_type?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          material_id: string
          movement_type: string
          notes?: string | null
          quantity_in?: number
          quantity_out?: number
          reference_id?: string | null
          reference_table?: string | null
          tenant_id: string
          total_cost?: number
          unit_cost?: number
        }
        Update: {
          accounting_impact?: string | null
          avg_cost_after?: number
          balance_after?: number
          base_unit_id?: string | null
          branch_id?: string
          consumption_type?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          material_id?: string
          movement_type?: string
          notes?: string | null
          quantity_in?: number
          quantity_out?: number
          reference_id?: string | null
          reference_table?: string | null
          tenant_id?: string
          total_cost?: number
          unit_cost?: number
        }
        Relationships: [
          {
            foreignKeyName: "inventory_movements_base_unit_id_fkey"
            columns: ["base_unit_id"]
            isOneToOne: false
            referencedRelation: "cost_units"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_movements_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_movements_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "cost_materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_movements_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_settings: {
        Row: {
          allow_negative_stock_mode: string
          auto_popup_alerts_enabled: boolean
          branch_id: string | null
          created_at: string
          expiry_alert_days: number
          fefo_enabled: boolean
          id: string
          low_stock_basis: string
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          allow_negative_stock_mode?: string
          auto_popup_alerts_enabled?: boolean
          branch_id?: string | null
          created_at?: string
          expiry_alert_days?: number
          fefo_enabled?: boolean
          id?: string
          low_stock_basis?: string
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          allow_negative_stock_mode?: string
          auto_popup_alerts_enabled?: boolean
          branch_id?: string | null
          created_at?: string
          expiry_alert_days?: number
          fefo_enabled?: boolean
          id?: string
          low_stock_basis?: string
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_settings_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_stock: {
        Row: {
          avg_cost_per_base_unit: number
          branch_id: string
          created_at: string
          id: string
          material_id: string
          minimum_stock_quantity: number
          quantity_base: number
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          avg_cost_per_base_unit?: number
          branch_id: string
          created_at?: string
          id?: string
          material_id: string
          minimum_stock_quantity?: number
          quantity_base?: number
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          avg_cost_per_base_unit?: number
          branch_id?: string
          created_at?: string
          id?: string
          material_id?: string
          minimum_stock_quantity?: number
          quantity_base?: number
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_stock_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_stock_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "cost_materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_stock_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      loyalty_branch_accounts: {
        Row: {
          branch_id: string
          created_at: string
          id: string
          last_activity_at: string | null
          lifetime_points_earned: number
          lifetime_points_redeemed: number
          lifetime_stamps_earned: number
          lifetime_stamps_redeemed: number
          loyalty_member_id: string
          points_balance: number
          stamps_balance: number
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          branch_id: string
          created_at?: string
          id?: string
          last_activity_at?: string | null
          lifetime_points_earned?: number
          lifetime_points_redeemed?: number
          lifetime_stamps_earned?: number
          lifetime_stamps_redeemed?: number
          loyalty_member_id: string
          points_balance?: number
          stamps_balance?: number
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          branch_id?: string
          created_at?: string
          id?: string
          last_activity_at?: string | null
          lifetime_points_earned?: number
          lifetime_points_redeemed?: number
          lifetime_stamps_earned?: number
          lifetime_stamps_redeemed?: number
          loyalty_member_id?: string
          points_balance?: number
          stamps_balance?: number
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "loyalty_branch_accounts_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_branch_accounts_loyalty_member_id_fkey"
            columns: ["loyalty_member_id"]
            isOneToOne: false
            referencedRelation: "loyalty_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_branch_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      loyalty_counters: {
        Row: {
          last_seq: number
          tenant_id: string
        }
        Insert: {
          last_seq?: number
          tenant_id: string
        }
        Update: {
          last_seq?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "loyalty_counters_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      loyalty_ledger: {
        Row: {
          branch_id: string
          created_at: string
          created_by: string | null
          entry_type: string
          id: string
          loyalty_branch_account_id: string
          loyalty_member_id: string
          metadata: Json
          order_id: string | null
          order_total: number | null
          points_delta: number
          program_type: string
          reason: string | null
          redemption_id: string | null
          stamps_delta: number
          tenant_id: string
        }
        Insert: {
          branch_id: string
          created_at?: string
          created_by?: string | null
          entry_type: string
          id?: string
          loyalty_branch_account_id: string
          loyalty_member_id: string
          metadata?: Json
          order_id?: string | null
          order_total?: number | null
          points_delta?: number
          program_type: string
          reason?: string | null
          redemption_id?: string | null
          stamps_delta?: number
          tenant_id: string
        }
        Update: {
          branch_id?: string
          created_at?: string
          created_by?: string | null
          entry_type?: string
          id?: string
          loyalty_branch_account_id?: string
          loyalty_member_id?: string
          metadata?: Json
          order_id?: string | null
          order_total?: number | null
          points_delta?: number
          program_type?: string
          reason?: string | null
          redemption_id?: string | null
          stamps_delta?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "loyalty_ledger_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_ledger_loyalty_branch_account_id_fkey"
            columns: ["loyalty_branch_account_id"]
            isOneToOne: false
            referencedRelation: "loyalty_branch_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_ledger_loyalty_member_id_fkey"
            columns: ["loyalty_member_id"]
            isOneToOne: false
            referencedRelation: "loyalty_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_ledger_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "pos_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_ledger_redemption_id_fkey"
            columns: ["redemption_id"]
            isOneToOne: false
            referencedRelation: "loyalty_redemptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_ledger_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      loyalty_members: {
        Row: {
          created_at: string
          created_by: string | null
          customer_id: string | null
          email: string | null
          id: string
          loyalty_id: string
          name: string
          notes: string | null
          phone: string | null
          preferred_branch_id: string | null
          status: string
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          email?: string | null
          id?: string
          loyalty_id: string
          name: string
          notes?: string | null
          phone?: string | null
          preferred_branch_id?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          email?: string | null
          id?: string
          loyalty_id?: string
          name?: string
          notes?: string | null
          phone?: string | null
          preferred_branch_id?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "loyalty_members_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "pos_customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_members_preferred_branch_id_fkey"
            columns: ["preferred_branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_members_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      loyalty_program_settings: {
        Row: {
          amount_unit: number | null
          branch_id: string
          card_label: string | null
          created_at: string
          created_by: string | null
          expiry_days: number | null
          id: string
          is_active: boolean
          min_order_amount: number | null
          point_value_amount: number | null
          points_per_amount: number | null
          program_name: string | null
          program_type: string
          reward_description: string | null
          reward_type: string | null
          reward_value: number | null
          settings_json: Json
          stamps_per_order: number | null
          stamps_required: number | null
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          amount_unit?: number | null
          branch_id: string
          card_label?: string | null
          created_at?: string
          created_by?: string | null
          expiry_days?: number | null
          id?: string
          is_active?: boolean
          min_order_amount?: number | null
          point_value_amount?: number | null
          points_per_amount?: number | null
          program_name?: string | null
          program_type?: string
          reward_description?: string | null
          reward_type?: string | null
          reward_value?: number | null
          settings_json?: Json
          stamps_per_order?: number | null
          stamps_required?: number | null
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          amount_unit?: number | null
          branch_id?: string
          card_label?: string | null
          created_at?: string
          created_by?: string | null
          expiry_days?: number | null
          id?: string
          is_active?: boolean
          min_order_amount?: number | null
          point_value_amount?: number | null
          points_per_amount?: number | null
          program_name?: string | null
          program_type?: string
          reward_description?: string | null
          reward_type?: string | null
          reward_value?: number | null
          settings_json?: Json
          stamps_per_order?: number | null
          stamps_required?: number | null
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "loyalty_program_settings_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_program_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      loyalty_redemptions: {
        Row: {
          branch_id: string
          discount_amount: number
          id: string
          loyalty_branch_account_id: string
          loyalty_member_id: string
          metadata: Json
          order_id: string | null
          points_used: number
          redeemed_at: string
          redeemed_by: string | null
          redemption_status: string
          reward_id: string | null
          stamps_used: number
          tenant_id: string
        }
        Insert: {
          branch_id: string
          discount_amount?: number
          id?: string
          loyalty_branch_account_id: string
          loyalty_member_id: string
          metadata?: Json
          order_id?: string | null
          points_used?: number
          redeemed_at?: string
          redeemed_by?: string | null
          redemption_status?: string
          reward_id?: string | null
          stamps_used?: number
          tenant_id: string
        }
        Update: {
          branch_id?: string
          discount_amount?: number
          id?: string
          loyalty_branch_account_id?: string
          loyalty_member_id?: string
          metadata?: Json
          order_id?: string | null
          points_used?: number
          redeemed_at?: string
          redeemed_by?: string | null
          redemption_status?: string
          reward_id?: string | null
          stamps_used?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "loyalty_redemptions_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_redemptions_loyalty_branch_account_id_fkey"
            columns: ["loyalty_branch_account_id"]
            isOneToOne: false
            referencedRelation: "loyalty_branch_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_redemptions_loyalty_member_id_fkey"
            columns: ["loyalty_member_id"]
            isOneToOne: false
            referencedRelation: "loyalty_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_redemptions_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "pos_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_redemptions_reward_id_fkey"
            columns: ["reward_id"]
            isOneToOne: false
            referencedRelation: "loyalty_rewards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_redemptions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      loyalty_rewards: {
        Row: {
          branch_id: string
          created_at: string
          created_by: string | null
          id: string
          is_active: boolean
          points_required: number | null
          program_setting_id: string | null
          program_type: string
          reward_description: string | null
          reward_name: string
          reward_type: string | null
          reward_value: number | null
          stamps_required: number | null
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          branch_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          points_required?: number | null
          program_setting_id?: string | null
          program_type: string
          reward_description?: string | null
          reward_name: string
          reward_type?: string | null
          reward_value?: number | null
          stamps_required?: number | null
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          branch_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          points_required?: number | null
          program_setting_id?: string | null
          program_type?: string
          reward_description?: string | null
          reward_name?: string
          reward_type?: string | null
          reward_value?: number | null
          stamps_required?: number | null
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "loyalty_rewards_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_rewards_program_setting_id_fkey"
            columns: ["program_setting_id"]
            isOneToOne: false
            referencedRelation: "loyalty_program_settings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_rewards_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      menu_categories: {
        Row: {
          archived_at: string | null
          branch_id: string | null
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          name: string
          name_ar: string | null
          sort_order: number
          status: Database["public"]["Enums"]["category_status"]
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          archived_at?: string | null
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name: string
          name_ar?: string | null
          sort_order?: number
          status?: Database["public"]["Enums"]["category_status"]
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          archived_at?: string | null
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name?: string
          name_ar?: string | null
          sort_order?: number
          status?: Database["public"]["Enums"]["category_status"]
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "menu_categories_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "menu_categories_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      menu_item_branch_availability: {
        Row: {
          branch_id: string
          created_at: string
          id: string
          is_available: boolean
          menu_item_id: string
          price_override: number | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          branch_id: string
          created_at?: string
          id?: string
          is_available?: boolean
          menu_item_id: string
          price_override?: number | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          branch_id?: string
          created_at?: string
          id?: string
          is_available?: boolean
          menu_item_id?: string
          price_override?: number | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "menu_item_branch_availability_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "menu_item_branch_availability_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "menu_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "menu_item_branch_availability_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      menu_item_cost_snapshots: {
        Row: {
          branch_id: string | null
          calculation_json: Json
          created_at: string
          created_by: string | null
          food_cost_percentage: number
          gross_profit: number
          id: string
          menu_item_id: string
          overhead_cost: number
          packaging_cost: number
          raw_material_cost: number
          selling_price: number
          snapshot_reason: string
          tenant_id: string
          total_cost: number
        }
        Insert: {
          branch_id?: string | null
          calculation_json?: Json
          created_at?: string
          created_by?: string | null
          food_cost_percentage?: number
          gross_profit?: number
          id?: string
          menu_item_id: string
          overhead_cost?: number
          packaging_cost?: number
          raw_material_cost?: number
          selling_price?: number
          snapshot_reason: string
          tenant_id: string
          total_cost?: number
        }
        Update: {
          branch_id?: string | null
          calculation_json?: Json
          created_at?: string
          created_by?: string | null
          food_cost_percentage?: number
          gross_profit?: number
          id?: string
          menu_item_id?: string
          overhead_cost?: number
          packaging_cost?: number
          raw_material_cost?: number
          selling_price?: number
          snapshot_reason?: string
          tenant_id?: string
          total_cost?: number
        }
        Relationships: [
          {
            foreignKeyName: "menu_item_cost_snapshots_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "menu_item_cost_snapshots_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "menu_item_cost_snapshots_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "menu_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "menu_item_cost_snapshots_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      menu_item_modifier_groups: {
        Row: {
          created_at: string
          id: string
          menu_item_id: string
          modifier_group_id: string
          sort_order: number
          tenant_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          menu_item_id: string
          modifier_group_id: string
          sort_order?: number
          tenant_id: string
        }
        Update: {
          created_at?: string
          id?: string
          menu_item_id?: string
          modifier_group_id?: string
          sort_order?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "menu_item_modifier_groups_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "menu_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "menu_item_modifier_groups_modifier_group_id_fkey"
            columns: ["modifier_group_id"]
            isOneToOne: false
            referencedRelation: "modifier_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "menu_item_modifier_groups_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      menu_item_recipe_lines: {
        Row: {
          archived_at: string | null
          branch_id: string | null
          created_at: string
          created_by: string | null
          id: string
          line_type: string
          material_id: string
          menu_item_id: string
          quantity: number
          sort_order: number
          status: string
          tenant_id: string
          unit_id: string
          updated_at: string
          updated_by: string | null
          waste_percent: number
        }
        Insert: {
          archived_at?: string | null
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          line_type: string
          material_id: string
          menu_item_id: string
          quantity: number
          sort_order?: number
          status?: string
          tenant_id: string
          unit_id: string
          updated_at?: string
          updated_by?: string | null
          waste_percent?: number
        }
        Update: {
          archived_at?: string | null
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          line_type?: string
          material_id?: string
          menu_item_id?: string
          quantity?: number
          sort_order?: number
          status?: string
          tenant_id?: string
          unit_id?: string
          updated_at?: string
          updated_by?: string | null
          waste_percent?: number
        }
        Relationships: [
          {
            foreignKeyName: "menu_item_recipe_lines_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "menu_item_recipe_lines_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "menu_item_recipe_lines_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "cost_materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "menu_item_recipe_lines_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "menu_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "menu_item_recipe_lines_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "menu_item_recipe_lines_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "cost_units"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "menu_item_recipe_lines_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      menu_items: {
        Row: {
          allergens: string[] | null
          archived_at: string | null
          branch_id: string | null
          category_id: string | null
          created_at: string
          created_by: string | null
          description: string | null
          description_ar: string | null
          id: string
          image_alt_text: string | null
          image_url: string | null
          ingredients: string[] | null
          is_available: boolean
          name: string
          name_ar: string | null
          price: number | null
          sort_order: number
          status: Database["public"]["Enums"]["item_status"]
          tenant_id: string
          thumbnail_url: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          allergens?: string[] | null
          archived_at?: string | null
          branch_id?: string | null
          category_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          description_ar?: string | null
          id?: string
          image_alt_text?: string | null
          image_url?: string | null
          ingredients?: string[] | null
          is_available?: boolean
          name: string
          name_ar?: string | null
          price?: number | null
          sort_order?: number
          status?: Database["public"]["Enums"]["item_status"]
          tenant_id: string
          thumbnail_url?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          allergens?: string[] | null
          archived_at?: string | null
          branch_id?: string | null
          category_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          description_ar?: string | null
          id?: string
          image_alt_text?: string | null
          image_url?: string | null
          ingredients?: string[] | null
          is_available?: boolean
          name?: string
          name_ar?: string | null
          price?: number | null
          sort_order?: number
          status?: Database["public"]["Enums"]["item_status"]
          tenant_id?: string
          thumbnail_url?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "menu_items_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "menu_items_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "menu_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "menu_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      modifier_groups: {
        Row: {
          archived_at: string | null
          created_at: string
          created_by: string | null
          id: string
          is_required: boolean
          max_select: number
          min_select: number
          name: string
          name_ar: string | null
          selection_type: string
          status: Database["public"]["Enums"]["category_status"]
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_required?: boolean
          max_select?: number
          min_select?: number
          name: string
          name_ar?: string | null
          selection_type?: string
          status?: Database["public"]["Enums"]["category_status"]
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_required?: boolean
          max_select?: number
          min_select?: number
          name?: string
          name_ar?: string | null
          selection_type?: string
          status?: Database["public"]["Enums"]["category_status"]
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "modifier_groups_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      modifier_options: {
        Row: {
          archived_at: string | null
          created_at: string
          extra_price: number
          id: string
          modifier_group_id: string
          name: string
          name_ar: string | null
          sort_order: number
          status: Database["public"]["Enums"]["category_status"]
          tenant_id: string
          updated_at: string
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          extra_price?: number
          id?: string
          modifier_group_id: string
          name: string
          name_ar?: string | null
          sort_order?: number
          status?: Database["public"]["Enums"]["category_status"]
          tenant_id: string
          updated_at?: string
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          extra_price?: number
          id?: string
          modifier_group_id?: string
          name?: string
          name_ar?: string | null
          sort_order?: number
          status?: Database["public"]["Enums"]["category_status"]
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "modifier_options_modifier_group_id_fkey"
            columns: ["modifier_group_id"]
            isOneToOne: false
            referencedRelation: "modifier_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "modifier_options_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      payroll_adjustments: {
        Row: {
          amount: number
          amount_usd: number | null
          branch_id: string | null
          created_at: string
          created_by: string | null
          currency_code: string
          entry_date: string
          entry_id: string
          entry_type: string
          exchange_rate_usd_to_lbp: number | null
          id: string
          note: string | null
          original_amount: number | null
          status: string
          tenant_id: string
          updated_at: string
          updated_by: string | null
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          amount: number
          amount_usd?: number | null
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          currency_code?: string
          entry_date?: string
          entry_id: string
          entry_type: string
          exchange_rate_usd_to_lbp?: number | null
          id?: string
          note?: string | null
          original_amount?: number | null
          status?: string
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          amount?: number
          amount_usd?: number | null
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          currency_code?: string
          entry_date?: string
          entry_id?: string
          entry_type?: string
          exchange_rate_usd_to_lbp?: number | null
          id?: string
          note?: string | null
          original_amount?: number | null
          status?: string
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payroll_adjustments_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payroll_adjustments_entry_id_fkey"
            columns: ["entry_id"]
            isOneToOne: false
            referencedRelation: "payroll_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payroll_adjustments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      payroll_entries: {
        Row: {
          additions: number
          advances_total: number
          branch_id: string | null
          created_at: string
          created_by: string | null
          currency_code: string
          deductions: number
          employee_name: string
          exchange_rate_usd_to_lbp: number | null
          extra_deductions_total: number
          gross_amount: number
          id: string
          net_amount: number
          notes: string | null
          original_amount: number | null
          payment_date: string | null
          payment_method: string | null
          period_month: string
          position: string | null
          status: string
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          additions?: number
          advances_total?: number
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          currency_code?: string
          deductions?: number
          employee_name: string
          exchange_rate_usd_to_lbp?: number | null
          extra_deductions_total?: number
          gross_amount?: number
          id?: string
          net_amount?: number
          notes?: string | null
          original_amount?: number | null
          payment_date?: string | null
          payment_method?: string | null
          period_month?: string
          position?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          additions?: number
          advances_total?: number
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          currency_code?: string
          deductions?: number
          employee_name?: string
          exchange_rate_usd_to_lbp?: number | null
          extra_deductions_total?: number
          gross_amount?: number
          id?: string
          net_amount?: number
          notes?: string | null
          original_amount?: number | null
          payment_date?: string | null
          payment_method?: string | null
          period_month?: string
          position?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payroll_entries_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payroll_entries_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      plan_feature_rules: {
        Row: {
          created_at: string
          feature_key: string
          id: string
          is_enabled: boolean
          plan_id: string
          sub_feature_key: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          feature_key: string
          id?: string
          is_enabled?: boolean
          plan_id: string
          sub_feature_key?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          feature_key?: string
          id?: string
          is_enabled?: boolean
          plan_id?: string
          sub_feature_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "plan_feature_rules_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "subscription_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_backup_destinations: {
        Row: {
          config: Json
          created_at: string
          created_by: string | null
          enabled: boolean
          id: string
          name: string
          type: string
          updated_at: string
        }
        Insert: {
          config?: Json
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          id?: string
          name: string
          type: string
          updated_at?: string
        }
        Update: {
          config?: Json
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          id?: string
          name?: string
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_backup_destinations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_backup_schedules: {
        Row: {
          created_at: string
          created_by: string | null
          cron_expression: string | null
          destination_id: string | null
          enabled: boolean
          frequency: string
          id: string
          last_run_at: string | null
          last_status: string | null
          name: string
          next_run_at: string | null
          notify_on_failure: boolean
          retention_count: number | null
          retention_days: number | null
          scope: Json
          time_of_day: string | null
          timezone: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          cron_expression?: string | null
          destination_id?: string | null
          enabled?: boolean
          frequency?: string
          id?: string
          last_run_at?: string | null
          last_status?: string | null
          name: string
          next_run_at?: string | null
          notify_on_failure?: boolean
          retention_count?: number | null
          retention_days?: number | null
          scope?: Json
          time_of_day?: string | null
          timezone?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          cron_expression?: string | null
          destination_id?: string | null
          enabled?: boolean
          frequency?: string
          id?: string
          last_run_at?: string | null
          last_status?: string | null
          name?: string
          next_run_at?: string | null
          notify_on_failure?: boolean
          retention_count?: number | null
          retention_days?: number | null
          scope?: Json
          time_of_day?: string | null
          timezone?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_backup_schedules_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "platform_backup_schedules_destination_id_fkey"
            columns: ["destination_id"]
            isOneToOne: false
            referencedRelation: "platform_backup_destinations"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_backups: {
        Row: {
          app_version: string | null
          backup_ref: string
          backup_version: string | null
          checksum: string | null
          created_at: string
          created_by: string | null
          destination: string
          destination_id: string | null
          duration_ms: number | null
          entity_counts: Json
          error: string | null
          id: string
          manifest: Json | null
          modules: string[]
          notes: string | null
          schedule_id: string | null
          scope: string
          size_bytes: number | null
          status: string
          storage_path: string | null
          tenant_ids: string[]
        }
        Insert: {
          app_version?: string | null
          backup_ref: string
          backup_version?: string | null
          checksum?: string | null
          created_at?: string
          created_by?: string | null
          destination?: string
          destination_id?: string | null
          duration_ms?: number | null
          entity_counts?: Json
          error?: string | null
          id?: string
          manifest?: Json | null
          modules?: string[]
          notes?: string | null
          schedule_id?: string | null
          scope?: string
          size_bytes?: number | null
          status?: string
          storage_path?: string | null
          tenant_ids?: string[]
        }
        Update: {
          app_version?: string | null
          backup_ref?: string
          backup_version?: string | null
          checksum?: string | null
          created_at?: string
          created_by?: string | null
          destination?: string
          destination_id?: string | null
          duration_ms?: number | null
          entity_counts?: Json
          error?: string | null
          id?: string
          manifest?: Json | null
          modules?: string[]
          notes?: string | null
          schedule_id?: string | null
          scope?: string
          size_bytes?: number | null
          status?: string
          storage_path?: string | null
          tenant_ids?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "platform_backups_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "platform_backups_destination_id_fkey"
            columns: ["destination_id"]
            isOneToOne: false
            referencedRelation: "platform_backup_destinations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "platform_backups_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "platform_backup_schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_restore_batches: {
        Row: {
          backup_ref: string | null
          completed_at: string | null
          created_at: string
          created_count: number
          error: string | null
          error_rows: number
          filename: string | null
          id: string
          manifest: Json | null
          mode: string
          ready_rows: number
          scope: string | null
          skipped_count: number
          started_at: string | null
          status: string
          target_tenant_id: string | null
          total_rows: number
          updated_count: number
          uploaded_by: string | null
          warning_rows: number
        }
        Insert: {
          backup_ref?: string | null
          completed_at?: string | null
          created_at?: string
          created_count?: number
          error?: string | null
          error_rows?: number
          filename?: string | null
          id?: string
          manifest?: Json | null
          mode?: string
          ready_rows?: number
          scope?: string | null
          skipped_count?: number
          started_at?: string | null
          status?: string
          target_tenant_id?: string | null
          total_rows?: number
          updated_count?: number
          uploaded_by?: string | null
          warning_rows?: number
        }
        Update: {
          backup_ref?: string | null
          completed_at?: string | null
          created_at?: string
          created_count?: number
          error?: string | null
          error_rows?: number
          filename?: string | null
          id?: string
          manifest?: Json | null
          mode?: string
          ready_rows?: number
          scope?: string | null
          skipped_count?: number
          started_at?: string | null
          status?: string
          target_tenant_id?: string | null
          total_rows?: number
          updated_count?: number
          uploaded_by?: string | null
          warning_rows?: number
        }
        Relationships: [
          {
            foreignKeyName: "platform_restore_batches_target_tenant_id_fkey"
            columns: ["target_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "platform_restore_batches_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_restore_rows: {
        Row: {
          action: string
          batch_id: string
          created_at: string
          entity_type: string
          errors: Json
          id: string
          normalized_data: Json | null
          raw_data: Json | null
          source_record_id: string | null
          status: string
          target_record_id: string | null
          warnings: Json
        }
        Insert: {
          action?: string
          batch_id: string
          created_at?: string
          entity_type: string
          errors?: Json
          id?: string
          normalized_data?: Json | null
          raw_data?: Json | null
          source_record_id?: string | null
          status?: string
          target_record_id?: string | null
          warnings?: Json
        }
        Update: {
          action?: string
          batch_id?: string
          created_at?: string
          entity_type?: string
          errors?: Json
          id?: string
          normalized_data?: Json | null
          raw_data?: Json | null
          source_record_id?: string | null
          status?: string
          target_record_id?: string | null
          warnings?: Json
        }
        Relationships: [
          {
            foreignKeyName: "platform_restore_rows_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "platform_restore_batches"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_users: {
        Row: {
          created_at: string
          email: string
          full_name: string | null
          id: string
          role: Database["public"]["Enums"]["platform_role"]
          status: Database["public"]["Enums"]["user_status"]
          two_factor_enabled: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email: string
          full_name?: string | null
          id?: string
          role?: Database["public"]["Enums"]["platform_role"]
          status?: Database["public"]["Enums"]["user_status"]
          two_factor_enabled?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          role?: Database["public"]["Enums"]["platform_role"]
          status?: Database["public"]["Enums"]["user_status"]
          two_factor_enabled?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      pos_customer_addresses: {
        Row: {
          address_label: string | null
          area: string | null
          building: string | null
          created_at: string
          customer_id: string
          floor: string | null
          id: string
          is_default: boolean
          notes: string | null
          street: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          address_label?: string | null
          area?: string | null
          building?: string | null
          created_at?: string
          customer_id: string
          floor?: string | null
          id?: string
          is_default?: boolean
          notes?: string | null
          street?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          address_label?: string | null
          area?: string | null
          building?: string | null
          created_at?: string
          customer_id?: string
          floor?: string | null
          id?: string
          is_default?: boolean
          notes?: string | null
          street?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_customer_addresses_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "pos_customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_customer_addresses_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_customers: {
        Row: {
          branch_id: string | null
          created_at: string
          created_by: string | null
          id: string
          name: string | null
          notes: string | null
          phone: string | null
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string | null
          notes?: string | null
          phone?: string | null
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string | null
          notes?: string | null
          phone?: string | null
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pos_customers_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_customers_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_customers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_customers_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_order_counters: {
        Row: {
          branch_id: string
          day: string
          seq: number
          tenant_id: string
        }
        Insert: {
          branch_id: string
          day: string
          seq?: number
          tenant_id: string
        }
        Update: {
          branch_id?: string
          day?: string
          seq?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_order_counters_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_order_item_modifiers: {
        Row: {
          branch_id: string | null
          created_at: string
          id: string
          modifier_group_id: string | null
          modifier_option_id: string | null
          name_snapshot: string
          order_item_id: string
          price_delta: number
          quantity: number
          tenant_id: string
        }
        Insert: {
          branch_id?: string | null
          created_at?: string
          id?: string
          modifier_group_id?: string | null
          modifier_option_id?: string | null
          name_snapshot: string
          order_item_id: string
          price_delta?: number
          quantity?: number
          tenant_id: string
        }
        Update: {
          branch_id?: string | null
          created_at?: string
          id?: string
          modifier_group_id?: string | null
          modifier_option_id?: string | null
          name_snapshot?: string
          order_item_id?: string
          price_delta?: number
          quantity?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_order_item_modifiers_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_order_item_modifiers_modifier_group_id_fkey"
            columns: ["modifier_group_id"]
            isOneToOne: false
            referencedRelation: "modifier_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_order_item_modifiers_modifier_option_id_fkey"
            columns: ["modifier_option_id"]
            isOneToOne: false
            referencedRelation: "modifier_options"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_order_item_modifiers_order_item_id_fkey"
            columns: ["order_item_id"]
            isOneToOne: false
            referencedRelation: "pos_order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_order_item_modifiers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_order_items: {
        Row: {
          base_price: number
          branch_id: string | null
          created_at: string
          customization_json: Json
          final_cost_snapshot: number | null
          final_unit_price: number
          id: string
          kitchen_note: string | null
          line_total: number
          menu_item_id: string | null
          modifiers_total: number
          name_snapshot: string
          order_id: string
          overhead_cost_snapshot: number | null
          quantity: number
          status: string
          tenant_id: string
          total_final_cost_snapshot: number | null
        }
        Insert: {
          base_price?: number
          branch_id?: string | null
          created_at?: string
          customization_json?: Json
          final_cost_snapshot?: number | null
          final_unit_price?: number
          id?: string
          kitchen_note?: string | null
          line_total?: number
          menu_item_id?: string | null
          modifiers_total?: number
          name_snapshot: string
          order_id: string
          overhead_cost_snapshot?: number | null
          quantity?: number
          status?: string
          tenant_id: string
          total_final_cost_snapshot?: number | null
        }
        Update: {
          base_price?: number
          branch_id?: string | null
          created_at?: string
          customization_json?: Json
          final_cost_snapshot?: number | null
          final_unit_price?: number
          id?: string
          kitchen_note?: string | null
          line_total?: number
          menu_item_id?: string | null
          modifiers_total?: number
          name_snapshot?: string
          order_id?: string
          overhead_cost_snapshot?: number | null
          quantity?: number
          status?: string
          tenant_id?: string
          total_final_cost_snapshot?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pos_order_items_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_order_items_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "menu_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "pos_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_order_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_orders: {
        Row: {
          address_id: string | null
          branch_id: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          cashier_user_id: string | null
          created_at: string
          created_by: string | null
          customer_id: string | null
          discount_amount: number
          discount_type: string | null
          discount_value: number | null
          id: string
          inventory_consumed_at: string | null
          loyalty_member_id: string | null
          net_profit_snapshot: number | null
          notes: string | null
          order_number: string | null
          order_type: string
          payment_method: string | null
          payment_status: string
          primary_currency_snapshot: string | null
          shift_id: string | null
          status: string
          subtotal: number
          table_id: string | null
          tenant_id: string
          total_amount: number
          total_amount_usd: number | null
          total_final_cost_snapshot: number | null
          updated_at: string
          updated_by: string | null
          usd_to_lbp_rate_snapshot: number | null
        }
        Insert: {
          address_id?: string | null
          branch_id?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          cashier_user_id?: string | null
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          discount_amount?: number
          discount_type?: string | null
          discount_value?: number | null
          id?: string
          inventory_consumed_at?: string | null
          loyalty_member_id?: string | null
          net_profit_snapshot?: number | null
          notes?: string | null
          order_number?: string | null
          order_type: string
          payment_method?: string | null
          payment_status?: string
          primary_currency_snapshot?: string | null
          shift_id?: string | null
          status?: string
          subtotal?: number
          table_id?: string | null
          tenant_id: string
          total_amount?: number
          total_amount_usd?: number | null
          total_final_cost_snapshot?: number | null
          updated_at?: string
          updated_by?: string | null
          usd_to_lbp_rate_snapshot?: number | null
        }
        Update: {
          address_id?: string | null
          branch_id?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          cashier_user_id?: string | null
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          discount_amount?: number
          discount_type?: string | null
          discount_value?: number | null
          id?: string
          inventory_consumed_at?: string | null
          loyalty_member_id?: string | null
          net_profit_snapshot?: number | null
          notes?: string | null
          order_number?: string | null
          order_type?: string
          payment_method?: string | null
          payment_status?: string
          primary_currency_snapshot?: string | null
          shift_id?: string | null
          status?: string
          subtotal?: number
          table_id?: string | null
          tenant_id?: string
          total_amount?: number
          total_amount_usd?: number | null
          total_final_cost_snapshot?: number | null
          updated_at?: string
          updated_by?: string | null
          usd_to_lbp_rate_snapshot?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pos_orders_address_id_fkey"
            columns: ["address_id"]
            isOneToOne: false
            referencedRelation: "pos_customer_addresses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_orders_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_orders_cashier_user_id_fkey"
            columns: ["cashier_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_orders_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_orders_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "pos_customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_orders_loyalty_member_id_fkey"
            columns: ["loyalty_member_id"]
            isOneToOne: false
            referencedRelation: "loyalty_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_orders_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "pos_shifts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_orders_table_id_fkey"
            columns: ["table_id"]
            isOneToOne: false
            referencedRelation: "pos_tables"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_orders_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_orders_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_payments: {
        Row: {
          amount: number
          amount_usd: number | null
          branch_id: string | null
          created_at: string
          currency_code: string
          exchange_rate_usd_to_lbp: number | null
          id: string
          method: string
          order_id: string
          original_amount: number | null
          paid_at: string
          received_by_user_id: string | null
          shift_id: string | null
          tenant_id: string
        }
        Insert: {
          amount?: number
          amount_usd?: number | null
          branch_id?: string | null
          created_at?: string
          currency_code?: string
          exchange_rate_usd_to_lbp?: number | null
          id?: string
          method: string
          order_id: string
          original_amount?: number | null
          paid_at?: string
          received_by_user_id?: string | null
          shift_id?: string | null
          tenant_id: string
        }
        Update: {
          amount?: number
          amount_usd?: number | null
          branch_id?: string | null
          created_at?: string
          currency_code?: string
          exchange_rate_usd_to_lbp?: number | null
          id?: string
          method?: string
          order_id?: string
          original_amount?: number | null
          paid_at?: string
          received_by_user_id?: string | null
          shift_id?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_payments_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_payments_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "pos_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_payments_received_by_user_id_fkey"
            columns: ["received_by_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_payments_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "pos_shifts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_printer_settings: {
        Row: {
          assigned_category_ids: Json
          branch_id: string | null
          created_at: string
          id: string
          is_active: boolean
          name: string
          printer_type: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          assigned_category_ids?: Json
          branch_id?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          printer_type?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          assigned_category_ids?: Json
          branch_id?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          printer_type?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_printer_settings_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_printer_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_receipt_settings: {
        Row: {
          auto_print_customer: boolean
          auto_print_kitchen: boolean
          branch_id: string | null
          business_code: string | null
          created_at: string
          customer_template_config: Json | null
          footer_message: string | null
          header_address: string | null
          header_phone: string | null
          id: string
          kitchen_template_config: Json | null
          logo_url: string | null
          paper_size: string
          show_logo: boolean
          slogan: string | null
          tenant_id: string
          updated_at: string
          updated_by: string | null
          welcome_message: string | null
        }
        Insert: {
          auto_print_customer?: boolean
          auto_print_kitchen?: boolean
          branch_id?: string | null
          business_code?: string | null
          created_at?: string
          customer_template_config?: Json | null
          footer_message?: string | null
          header_address?: string | null
          header_phone?: string | null
          id?: string
          kitchen_template_config?: Json | null
          logo_url?: string | null
          paper_size?: string
          show_logo?: boolean
          slogan?: string | null
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
          welcome_message?: string | null
        }
        Update: {
          auto_print_customer?: boolean
          auto_print_kitchen?: boolean
          branch_id?: string | null
          business_code?: string | null
          created_at?: string
          customer_template_config?: Json | null
          footer_message?: string | null
          header_address?: string | null
          header_phone?: string | null
          id?: string
          kitchen_template_config?: Json | null
          logo_url?: string | null
          paper_size?: string
          show_logo?: boolean
          slogan?: string | null
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
          welcome_message?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pos_receipt_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_shifts: {
        Row: {
          actual_cash_counted: number | null
          branch_id: string | null
          cashier_user_id: string | null
          closed_at: string | null
          closed_by: string | null
          closing_note: string | null
          created_at: string
          difference_amount: number | null
          expected_cash_amount: number | null
          id: string
          manager_note: string | null
          manager_reviewed_at: string | null
          manager_user_id: string | null
          opened_at: string
          opening_cash_amount: number | null
          report_json: Json | null
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          actual_cash_counted?: number | null
          branch_id?: string | null
          cashier_user_id?: string | null
          closed_at?: string | null
          closed_by?: string | null
          closing_note?: string | null
          created_at?: string
          difference_amount?: number | null
          expected_cash_amount?: number | null
          id?: string
          manager_note?: string | null
          manager_reviewed_at?: string | null
          manager_user_id?: string | null
          opened_at?: string
          opening_cash_amount?: number | null
          report_json?: Json | null
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          actual_cash_counted?: number | null
          branch_id?: string | null
          cashier_user_id?: string | null
          closed_at?: string | null
          closed_by?: string | null
          closing_note?: string | null
          created_at?: string
          difference_amount?: number | null
          expected_cash_amount?: number | null
          id?: string
          manager_note?: string | null
          manager_reviewed_at?: string | null
          manager_user_id?: string | null
          opened_at?: string
          opening_cash_amount?: number | null
          report_json?: Json | null
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_shifts_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_shifts_cashier_user_id_fkey"
            columns: ["cashier_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_shifts_manager_user_id_fkey"
            columns: ["manager_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_shifts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_tables: {
        Row: {
          branch_id: string | null
          created_at: string
          created_by: string | null
          id: string
          name: string
          seats: number | null
          status: string
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          seats?: number | null
          status?: string
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          seats?: number | null
          status?: string
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pos_tables_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_tables_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_tables_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_tables_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          locale: string
          must_change_password: boolean
          phone: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id: string
          locale?: string
          must_change_password?: boolean
          phone?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          locale?: string
          must_change_password?: boolean
          phone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      public_menu_themes: {
        Row: {
          config_json: Json
          created_at: string
          id: string
          is_default: boolean
          name: string
          updated_at: string
        }
        Insert: {
          config_json?: Json
          created_at?: string
          id?: string
          is_default?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          config_json?: Json
          created_at?: string
          id?: string
          is_default?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      purchase_invoice_counters: {
        Row: {
          seq: number
          tenant_id: string
          year: number
        }
        Insert: {
          seq?: number
          tenant_id: string
          year: number
        }
        Update: {
          seq?: number
          tenant_id?: string
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "purchase_invoice_counters_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_invoice_items: {
        Row: {
          batch_number: string | null
          cost_material_id: string | null
          created_at: string
          expiry_date: string | null
          has_expiry: boolean
          id: string
          invoice_id: string
          line_total: number
          name: string
          quantity: number
          tenant_id: string
          unit: string | null
          unit_price: number
        }
        Insert: {
          batch_number?: string | null
          cost_material_id?: string | null
          created_at?: string
          expiry_date?: string | null
          has_expiry?: boolean
          id?: string
          invoice_id: string
          line_total?: number
          name: string
          quantity?: number
          tenant_id: string
          unit?: string | null
          unit_price?: number
        }
        Update: {
          batch_number?: string | null
          cost_material_id?: string | null
          created_at?: string
          expiry_date?: string | null
          has_expiry?: boolean
          id?: string
          invoice_id?: string
          line_total?: number
          name?: string
          quantity?: number
          tenant_id?: string
          unit?: string | null
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "purchase_invoice_items_cost_material_id_fkey"
            columns: ["cost_material_id"]
            isOneToOne: false
            referencedRelation: "cost_materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_invoice_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "purchase_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_invoice_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_invoices: {
        Row: {
          amount_usd: number | null
          attachment_url: string | null
          branch_id: string | null
          created_at: string
          created_by: string | null
          currency_code: string
          exchange_rate_usd_to_lbp: number | null
          id: string
          invoice_date: string
          invoice_number: string | null
          notes: string | null
          original_amount: number | null
          paid_amount: number
          status: string
          supplier_id: string
          tenant_id: string
          total_amount: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          amount_usd?: number | null
          attachment_url?: string | null
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          currency_code?: string
          exchange_rate_usd_to_lbp?: number | null
          id?: string
          invoice_date?: string
          invoice_number?: string | null
          notes?: string | null
          original_amount?: number | null
          paid_amount?: number
          status?: string
          supplier_id: string
          tenant_id: string
          total_amount?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          amount_usd?: number | null
          attachment_url?: string | null
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          currency_code?: string
          exchange_rate_usd_to_lbp?: number | null
          id?: string
          invoice_date?: string
          invoice_number?: string | null
          notes?: string | null
          original_amount?: number | null
          paid_amount?: number
          status?: string
          supplier_id?: string
          tenant_id?: string
          total_amount?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "purchase_invoices_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_invoices_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_invoices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      qr_menu_settings: {
        Row: {
          branch_id: string | null
          created_at: string
          created_by: string | null
          default_language: string
          id: string
          is_public: boolean
          public_slug: string | null
          qr_color: string | null
          qr_logo_url: string | null
          seo_description: string | null
          seo_title: string | null
          show_prices: boolean
          tenant_id: string
          theme_id: string | null
          theme_json: Json
          updated_at: string
          updated_by: string | null
          welcome_text: string | null
        }
        Insert: {
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          default_language?: string
          id?: string
          is_public?: boolean
          public_slug?: string | null
          qr_color?: string | null
          qr_logo_url?: string | null
          seo_description?: string | null
          seo_title?: string | null
          show_prices?: boolean
          tenant_id: string
          theme_id?: string | null
          theme_json?: Json
          updated_at?: string
          updated_by?: string | null
          welcome_text?: string | null
        }
        Update: {
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          default_language?: string
          id?: string
          is_public?: boolean
          public_slug?: string | null
          qr_color?: string | null
          qr_logo_url?: string | null
          seo_description?: string | null
          seo_title?: string | null
          show_prices?: boolean
          tenant_id?: string
          theme_id?: string | null
          theme_json?: Json
          updated_at?: string
          updated_by?: string | null
          welcome_text?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "qr_menu_settings_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "qr_menu_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "qr_menu_settings_theme_id_fkey"
            columns: ["theme_id"]
            isOneToOne: false
            referencedRelation: "public_menu_themes"
            referencedColumns: ["id"]
          },
        ]
      }
      subscription_code_redemptions: {
        Row: {
          code: string
          code_id: string
          created_at: string
          id: string
          plan_id: string
          redeemed_at: string
          redeemed_by: string | null
          tenant_id: string
        }
        Insert: {
          code: string
          code_id: string
          created_at?: string
          id?: string
          plan_id: string
          redeemed_at?: string
          redeemed_by?: string | null
          tenant_id: string
        }
        Update: {
          code?: string
          code_id?: string
          created_at?: string
          id?: string
          plan_id?: string
          redeemed_at?: string
          redeemed_by?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscription_code_redemptions_code_id_fkey"
            columns: ["code_id"]
            isOneToOne: false
            referencedRelation: "subscription_codes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscription_code_redemptions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "subscription_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscription_code_redemptions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      subscription_codes: {
        Row: {
          code: string
          created_at: string
          created_by: string | null
          expires_at: string | null
          id: string
          max_uses: number
          plan_id: string
          redeemed_at: string | null
          redeemed_by_tenant_id: string | null
          status: Database["public"]["Enums"]["code_status"]
          updated_at: string
          used_count: number
        }
        Insert: {
          code: string
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          max_uses?: number
          plan_id: string
          redeemed_at?: string | null
          redeemed_by_tenant_id?: string | null
          status?: Database["public"]["Enums"]["code_status"]
          updated_at?: string
          used_count?: number
        }
        Update: {
          code?: string
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          max_uses?: number
          plan_id?: string
          redeemed_at?: string | null
          redeemed_by_tenant_id?: string | null
          status?: Database["public"]["Enums"]["code_status"]
          updated_at?: string
          used_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "subscription_codes_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "subscription_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscription_codes_redeemed_by_tenant_id_fkey"
            columns: ["redeemed_by_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      subscription_plans: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          max_branches: number | null
          max_extra_users: number
          name: string
          price_monthly: number
          requires_code: boolean
          sort_order: number
          tier: Database["public"]["Enums"]["plan_tier"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          max_branches?: number | null
          max_extra_users?: number
          name: string
          price_monthly?: number
          requires_code?: boolean
          sort_order?: number
          tier: Database["public"]["Enums"]["plan_tier"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          max_branches?: number | null
          max_extra_users?: number
          name?: string
          price_monthly?: number
          requires_code?: boolean
          sort_order?: number
          tier?: Database["public"]["Enums"]["plan_tier"]
          updated_at?: string
        }
        Relationships: []
      }
      supplier_payments: {
        Row: {
          amount: number
          amount_usd: number | null
          branch_id: string | null
          created_at: string
          created_by: string | null
          currency_code: string
          exchange_rate_usd_to_lbp: number | null
          id: string
          invoice_id: string | null
          method: string | null
          notes: string | null
          original_amount: number | null
          payment_date: string
          supplier_id: string
          tenant_id: string
        }
        Insert: {
          amount: number
          amount_usd?: number | null
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          currency_code?: string
          exchange_rate_usd_to_lbp?: number | null
          id?: string
          invoice_id?: string | null
          method?: string | null
          notes?: string | null
          original_amount?: number | null
          payment_date?: string
          supplier_id: string
          tenant_id: string
        }
        Update: {
          amount?: number
          amount_usd?: number | null
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          currency_code?: string
          exchange_rate_usd_to_lbp?: number | null
          id?: string
          invoice_id?: string | null
          method?: string | null
          notes?: string | null
          original_amount?: number | null
          payment_date?: string
          supplier_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "supplier_payments_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_payments_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "purchase_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_payments_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      suppliers: {
        Row: {
          address: string | null
          branch_id: string | null
          category: string | null
          created_at: string
          created_by: string | null
          email: string | null
          id: string
          name: string
          notes: string | null
          phone: string | null
          status: string
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          address?: string | null
          branch_id?: string | null
          category?: string | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          id?: string
          name: string
          notes?: string | null
          phone?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          address?: string | null
          branch_id?: string | null
          category?: string | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          id?: string
          name?: string
          notes?: string | null
          phone?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "suppliers_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "suppliers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_approval_logs: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          id: string
          reason: string | null
          tenant_id: string
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          id?: string
          reason?: string | null
          tenant_id: string
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          id?: string
          reason?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_approval_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_cost_settings: {
        Row: {
          created_at: string
          created_by: string | null
          estimated_monthly_sold_items: number
          id: string
          monthly_overhead_amount: number
          overhead_enabled: boolean
          target_food_cost_percentage: number | null
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          estimated_monthly_sold_items?: number
          id?: string
          monthly_overhead_amount?: number
          overhead_enabled?: boolean
          target_food_cost_percentage?: number | null
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          estimated_monthly_sold_items?: number
          id?: string
          monthly_overhead_amount?: number
          overhead_enabled?: boolean
          target_food_cost_percentage?: number | null
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_cost_settings_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_cost_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_cost_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_currency_change_logs: {
        Row: {
          changed_at: string
          changed_by: string | null
          converted_menu_prices: boolean
          id: string
          menu_items_converted: number
          new_primary_currency: string | null
          new_usd_to_lbp_rate: number | null
          old_primary_currency: string | null
          old_usd_to_lbp_rate: number | null
          tenant_id: string
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          converted_menu_prices?: boolean
          id?: string
          menu_items_converted?: number
          new_primary_currency?: string | null
          new_usd_to_lbp_rate?: number | null
          old_primary_currency?: string | null
          old_usd_to_lbp_rate?: number | null
          tenant_id: string
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          converted_menu_prices?: boolean
          id?: string
          menu_items_converted?: number
          new_primary_currency?: string | null
          new_usd_to_lbp_rate?: number | null
          old_primary_currency?: string | null
          old_usd_to_lbp_rate?: number | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_currency_change_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_currency_settings: {
        Row: {
          base_currency: string
          created_at: string
          created_by: string | null
          default_display_currency: string
          default_payment_currency: string
          enabled_currencies: string[]
          id: string
          primary_currency: string
          rate_updated_at: string | null
          rate_updated_by: string | null
          tenant_id: string
          updated_at: string
          updated_by: string | null
          usd_to_lbp_rate: number | null
        }
        Insert: {
          base_currency?: string
          created_at?: string
          created_by?: string | null
          default_display_currency?: string
          default_payment_currency?: string
          enabled_currencies?: string[]
          id?: string
          primary_currency?: string
          rate_updated_at?: string | null
          rate_updated_by?: string | null
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
          usd_to_lbp_rate?: number | null
        }
        Update: {
          base_currency?: string
          created_at?: string
          created_by?: string | null
          default_display_currency?: string
          default_payment_currency?: string
          enabled_currencies?: string[]
          id?: string
          primary_currency?: string
          rate_updated_at?: string | null
          rate_updated_by?: string | null
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
          usd_to_lbp_rate?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_currency_settings_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_currency_settings_rate_updated_by_fkey"
            columns: ["rate_updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_currency_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_currency_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_exchange_rate_history: {
        Row: {
          created_at: string
          created_by: string | null
          effective_at: string
          id: string
          note: string | null
          previous_rate: number | null
          tenant_id: string
          usd_to_lbp_rate: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          effective_at?: string
          id?: string
          note?: string | null
          previous_rate?: number | null
          tenant_id: string
          usd_to_lbp_rate: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          effective_at?: string
          id?: string
          note?: string | null
          previous_rate?: number | null
          tenant_id?: string
          usd_to_lbp_rate?: number
        }
        Relationships: [
          {
            foreignKeyName: "tenant_exchange_rate_history_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_exchange_rate_history_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_feature_overrides: {
        Row: {
          created_at: string
          created_by: string | null
          feature_key: string
          id: string
          is_enabled: boolean
          reason: string | null
          sub_feature_key: string
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          feature_key: string
          id?: string
          is_enabled: boolean
          reason?: string | null
          sub_feature_key?: string
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          feature_key?: string
          id?: string
          is_enabled?: boolean
          reason?: string | null
          sub_feature_key?: string
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_feature_overrides_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_import_batches: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          branch_id: string | null
          created_at: string
          created_count: number
          duplicate_rows: number
          error_rows: number
          filename: string | null
          id: string
          import_type: string
          mode: string
          ready_rows: number
          skipped_count: number
          status: string
          tenant_id: string
          total_rows: number
          updated_at: string
          updated_count: number
          uploaded_by: string | null
          warning_rows: number
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          branch_id?: string | null
          created_at?: string
          created_count?: number
          duplicate_rows?: number
          error_rows?: number
          filename?: string | null
          id?: string
          import_type: string
          mode?: string
          ready_rows?: number
          skipped_count?: number
          status?: string
          tenant_id: string
          total_rows?: number
          updated_at?: string
          updated_count?: number
          uploaded_by?: string | null
          warning_rows?: number
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          branch_id?: string | null
          created_at?: string
          created_count?: number
          duplicate_rows?: number
          error_rows?: number
          filename?: string | null
          id?: string
          import_type?: string
          mode?: string
          ready_rows?: number
          skipped_count?: number
          status?: string
          tenant_id?: string
          total_rows?: number
          updated_at?: string
          updated_count?: number
          uploaded_by?: string | null
          warning_rows?: number
        }
        Relationships: [
          {
            foreignKeyName: "tenant_import_batches_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_import_batches_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_import_rows: {
        Row: {
          action: string | null
          batch_id: string
          created_at: string
          created_record_id: string | null
          entity_type: string | null
          errors: Json
          id: string
          normalized_data: Json | null
          raw_data: Json
          resolved_refs: Json | null
          row_number: number | null
          sheet_name: string | null
          status: string
          tenant_id: string
          warnings: Json
        }
        Insert: {
          action?: string | null
          batch_id: string
          created_at?: string
          created_record_id?: string | null
          entity_type?: string | null
          errors?: Json
          id?: string
          normalized_data?: Json | null
          raw_data?: Json
          resolved_refs?: Json | null
          row_number?: number | null
          sheet_name?: string | null
          status?: string
          tenant_id: string
          warnings?: Json
        }
        Update: {
          action?: string | null
          batch_id?: string
          created_at?: string
          created_record_id?: string | null
          entity_type?: string | null
          errors?: Json
          id?: string
          normalized_data?: Json | null
          raw_data?: Json
          resolved_refs?: Json | null
          row_number?: number | null
          sheet_name?: string | null
          status?: string
          tenant_id?: string
          warnings?: Json
        }
        Relationships: [
          {
            foreignKeyName: "tenant_import_rows_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "tenant_import_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_import_rows_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_role_permissions: {
        Row: {
          created_at: string
          id: string
          is_enabled: boolean
          permission_key: string
          tenant_role_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_enabled?: boolean
          permission_key: string
          tenant_role_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_enabled?: boolean
          permission_key?: string
          tenant_role_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_role_permissions_tenant_role_id_fkey"
            columns: ["tenant_role_id"]
            isOneToOne: false
            referencedRelation: "tenant_roles"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_roles: {
        Row: {
          base_role: Database["public"]["Enums"]["tenant_role"]
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          is_active: boolean
          is_base_default: boolean
          is_system: boolean
          key: string
          label: string
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          base_role: Database["public"]["Enums"]["tenant_role"]
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          is_base_default?: boolean
          is_system?: boolean
          key: string
          label: string
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          base_role?: Database["public"]["Enums"]["tenant_role"]
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          is_base_default?: boolean
          is_system?: boolean
          key?: string
          label?: string
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_roles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_subscriptions: {
        Row: {
          code_id: string | null
          created_at: string
          created_by: string | null
          expires_at: string | null
          id: string
          plan_id: string
          source: string
          started_at: string
          status: Database["public"]["Enums"]["subscription_status"]
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          code_id?: string | null
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          plan_id: string
          source?: string
          started_at?: string
          status?: Database["public"]["Enums"]["subscription_status"]
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          code_id?: string | null
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          plan_id?: string
          source?: string
          started_at?: string
          status?: Database["public"]["Enums"]["subscription_status"]
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_subscriptions_code_id_fkey"
            columns: ["code_id"]
            isOneToOne: false
            referencedRelation: "subscription_codes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_subscriptions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "subscription_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_subscriptions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_user_permissions: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          is_enabled: boolean
          permission_key: string
          tenant_id: string
          tenant_user_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          is_enabled?: boolean
          permission_key: string
          tenant_id: string
          tenant_user_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          is_enabled?: boolean
          permission_key?: string
          tenant_id?: string
          tenant_user_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_user_permissions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_user_permissions_tenant_user_id_fkey"
            columns: ["tenant_user_id"]
            isOneToOne: false
            referencedRelation: "tenant_users"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_users: {
        Row: {
          all_branches: boolean
          branch_id: string | null
          created_at: string
          created_by: string | null
          id: string
          invited_email: string | null
          invited_name: string | null
          invited_phone: string | null
          role: Database["public"]["Enums"]["tenant_role"]
          status: Database["public"]["Enums"]["user_status"]
          tenant_id: string
          tenant_role_id: string | null
          updated_at: string
          updated_by: string | null
          user_id: string | null
        }
        Insert: {
          all_branches?: boolean
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          invited_email?: string | null
          invited_name?: string | null
          invited_phone?: string | null
          role?: Database["public"]["Enums"]["tenant_role"]
          status?: Database["public"]["Enums"]["user_status"]
          tenant_id: string
          tenant_role_id?: string | null
          updated_at?: string
          updated_by?: string | null
          user_id?: string | null
        }
        Update: {
          all_branches?: boolean
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          invited_email?: string | null
          invited_name?: string | null
          invited_phone?: string | null
          role?: Database["public"]["Enums"]["tenant_role"]
          status?: Database["public"]["Enums"]["user_status"]
          tenant_id?: string
          tenant_role_id?: string | null
          updated_at?: string
          updated_by?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_users_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_users_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_users_tenant_role_id_fkey"
            columns: ["tenant_role_id"]
            isOneToOne: false
            referencedRelation: "tenant_roles"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_verification_checks: {
        Row: {
          approved: boolean
          business_setup_complete: boolean
          created_at: string
          email_verified: boolean
          id: string
          plan_selected: boolean
          tenant_id: string
          updated_at: string
        }
        Insert: {
          approved?: boolean
          business_setup_complete?: boolean
          created_at?: string
          email_verified?: boolean
          id?: string
          plan_selected?: boolean
          tenant_id: string
          updated_at?: string
        }
        Update: {
          approved?: boolean
          business_setup_complete?: boolean
          created_at?: string
          email_verified?: boolean
          id?: string
          plan_selected?: boolean
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_verification_checks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          business_name: string
          business_type: string | null
          created_at: string
          id: string
          main_branch_id: string | null
          max_branches_override: number | null
          max_extra_users_override: number | null
          owner_user_id: string | null
          rejection_reason: string | null
          requested_branch_count: number | null
          selected_plan_id: string | null
          subscription_status: Database["public"]["Enums"]["subscription_status"]
          tenant_display_number: number
          tenant_status: Database["public"]["Enums"]["tenant_status"]
          updated_at: string
          verification_status: Database["public"]["Enums"]["verification_status"]
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          business_name: string
          business_type?: string | null
          created_at?: string
          id?: string
          main_branch_id?: string | null
          max_branches_override?: number | null
          max_extra_users_override?: number | null
          owner_user_id?: string | null
          rejection_reason?: string | null
          requested_branch_count?: number | null
          selected_plan_id?: string | null
          subscription_status?: Database["public"]["Enums"]["subscription_status"]
          tenant_display_number?: number
          tenant_status?: Database["public"]["Enums"]["tenant_status"]
          updated_at?: string
          verification_status?: Database["public"]["Enums"]["verification_status"]
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          business_name?: string
          business_type?: string | null
          created_at?: string
          id?: string
          main_branch_id?: string | null
          max_branches_override?: number | null
          max_extra_users_override?: number | null
          owner_user_id?: string | null
          rejection_reason?: string | null
          requested_branch_count?: number | null
          selected_plan_id?: string | null
          subscription_status?: Database["public"]["Enums"]["subscription_status"]
          tenant_display_number?: number
          tenant_status?: Database["public"]["Enums"]["tenant_status"]
          updated_at?: string
          verification_status?: Database["public"]["Enums"]["verification_status"]
        }
        Relationships: [
          {
            foreignKeyName: "tenants_main_branch_fk"
            columns: ["main_branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenants_selected_plan_id_fkey"
            columns: ["selected_plan_id"]
            isOneToOne: false
            referencedRelation: "subscription_plans"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      _acc_require_expenses: { Args: { p_tenant: string }; Returns: undefined }
      _acc_require_payroll: { Args: { p_tenant: string }; Returns: undefined }
      _acc_require_procurement: {
        Args: { p_tenant: string }
        Returns: undefined
      }
      _acct_type_default_tracked: { Args: { p_type: string }; Returns: boolean }
      _currency_assert_manager: { Args: never; Returns: string }
      _emenu_resolve: {
        Args: { p_slug: string }
        Returns: {
          branch_id: string
          tenant_id: string
        }[]
      }
      _emenu_slugify: { Args: { p_text: string }; Returns: string }
      _extra_user_limit: { Args: { p_tenant: string }; Returns: number }
      _extra_users_used: { Args: { p_tenant: string }; Returns: number }
      _inv_require: {
        Args: { p_key: string; p_tenant: string }
        Returns: undefined
      }
      _loyalty_assert_perm: { Args: { p_key: string }; Returns: undefined }
      _loyalty_current_member: { Args: never; Returns: string }
      _loyalty_get_account: {
        Args: { p_branch: string; p_member: string; p_tenant: string }
        Returns: string
      }
      _loyalty_resolve_branch: { Args: { p_branch: string }; Returns: string }
      _next_purchase_invoice_number: {
        Args: { p_branch?: string; p_tenant: string }
        Returns: string
      }
      _permission_feature: { Args: { p_key: string }; Returns: string }
      _pos_amount_usd: {
        Args: { p_amount: number; p_primary: string; p_rate: number }
        Returns: number
      }
      _pos_require: {
        Args: { p_key: string; p_tenant: string }
        Returns: undefined
      }
      _pos_tenant_rate: { Args: { p_tenant: string }; Returns: number }
      _recompute_payroll_entry_totals: {
        Args: { p_entry: string }
        Returns: undefined
      }
      _seed_expense_categories: {
        Args: { p_tenant: string }
        Returns: undefined
      }
      accounting_create_expense_category: {
        Args: { p_payload: Json }
        Returns: Json
      }
      accounting_create_purchasable_material: {
        Args: { p_payload: Json }
        Returns: Json
      }
      accounting_financial_report: {
        Args: { p_branch?: string; p_from: string; p_to: string }
        Returns: Json
      }
      accounting_list_expense_categories: { Args: never; Returns: Json }
      accounting_mark_payroll_paid: { Args: { p_payload: Json }; Returns: Json }
      accounting_opex_per_item: {
        Args: { p_branch?: string; p_from: string; p_to: string }
        Returns: Json
      }
      accounting_pay_supplier_invoice: {
        Args: { p_payload: Json }
        Returns: Json
      }
      accounting_save_expense: { Args: { p_payload: Json }; Returns: Json }
      accounting_save_payroll_adjustment: {
        Args: { p_payload: Json }
        Returns: Json
      }
      accounting_save_payroll_entry: {
        Args: { p_payload: Json }
        Returns: Json
      }
      accounting_save_purchase_invoice: {
        Args: { p_payload: Json }
        Returns: Json
      }
      accounting_save_supplier: { Args: { p_payload: Json }; Returns: Json }
      accounting_void_expense: { Args: { p_payload: Json }; Returns: Json }
      accounting_void_payroll_adjustment: {
        Args: { p_payload: Json }
        Returns: Json
      }
      accounting_void_payroll_entry: {
        Args: { p_payload: Json }
        Returns: Json
      }
      adjust_loyalty_balance: { Args: { p_payload: Json }; Returns: Json }
      admin_attach_login_to_member: {
        Args: { p_membership: string; p_user_id: string }
        Returns: Json
      }
      admin_attach_staff: { Args: { p_payload: Json }; Returns: Json }
      admin_loyalty_overview: { Args: never; Returns: Json }
      admin_set_branch_status: {
        Args: {
          p_branch: string
          p_reason?: string
          p_status: Database["public"]["Enums"]["branch_status"]
        }
        Returns: Json
      }
      admin_upsert_tenant_user: { Args: { p_payload: Json }; Returns: Json }
      apply_loyalty_settings_to_all_branches: {
        Args: { p_source_branch: string }
        Returns: Json
      }
      approve_branch_request: {
        Args: { p_note?: string; p_request_id: string }
        Returns: Json
      }
      approve_tenant: { Args: { p_tenant: string }; Returns: undefined }
      assert_branch_access: { Args: { p_branch: string }; Returns: undefined }
      assert_feature_access: {
        Args: { p_feature: string; p_sub?: string }
        Returns: boolean
      }
      assert_owner_or_same_branch: {
        Args: { p_branch: string }
        Returns: undefined
      }
      assign_tenant_user_role: {
        Args: { p_member: string; p_role: string }
        Returns: Json
      }
      branch_display_id: { Args: { p_branch: string }; Returns: string }
      branch_save: { Args: { p_payload: Json }; Returns: Json }
      branch_set_status: {
        Args: {
          p_branch: string
          p_status: Database["public"]["Enums"]["branch_status"]
        }
        Returns: Json
      }
      calculate_menu_item_cost: { Args: { p_menu_item: string }; Returns: Json }
      calculate_prepared_material_cost: {
        Args: { p_prepared: string }
        Returns: Json
      }
      can_access_branch: { Args: { p_branch: string }; Returns: boolean }
      can_access_operational_branch: {
        Args: { p_branch: string }
        Returns: boolean
      }
      can_add_staff: { Args: { p_tenant: string }; Returns: Json }
      can_manage_branches: { Args: never; Returns: boolean }
      can_manage_tenant_users: { Args: { p_tenant: string }; Returns: boolean }
      can_manage_user_permissions: {
        Args: { p_tenant: string }
        Returns: boolean
      }
      can_reset_staff_password: {
        Args: { p_tenant: string; p_user: string }
        Returns: Json
      }
      can_user_permission: {
        Args: { p_key: string; p_tenant: string; p_tenant_user: string }
        Returns: boolean
      }
      change_tenant_primary_currency: {
        Args: { p_new_primary: string; p_rate: number }
        Returns: Json
      }
      claim_user_invites: { Args: never; Returns: Json }
      clear_must_change_password: { Args: never; Returns: undefined }
      complete_business_setup: {
        Args: {
          p_address?: string
          p_area?: string
          p_branch_count?: number
          p_branch_name: string
          p_business_type?: string
          p_city?: string
          p_locale?: string
          p_logo_url?: string
          p_phone?: string
          p_tenant: string
        }
        Returns: undefined
      }
      cost_to_base: {
        Args: { p_base: string; p_from: string; p_qty: number }
        Returns: number
      }
      create_activity_log: {
        Args: {
          p_action: string
          p_after?: Json
          p_before?: Json
          p_module: string
          p_record_id?: string
          p_record_table?: string
          p_tenant: string
        }
        Returns: undefined
      }
      create_loyalty_member: { Args: { p_payload: Json }; Returns: Json }
      create_menu_item_cost_snapshot: {
        Args: { p_menu_item: string; p_reason: string }
        Returns: string
      }
      create_tenant_after_signup: {
        Args: {
          p_business_name: string
          p_business_type?: string
          p_owner_name?: string
          p_phone?: string
        }
        Returns: Json
      }
      current_tenant_id: { Args: never; Returns: string }
      current_tenant_role: {
        Args: never
        Returns: Database["public"]["Enums"]["tenant_role"]
      }
      current_user_branch_id: { Args: never; Returns: string }
      current_user_can: { Args: { p_key: string }; Returns: boolean }
      current_user_is_owner: { Args: never; Returns: boolean }
      current_user_permissions: { Args: { p_tenant: string }; Returns: Json }
      delete_tenant_role: { Args: { p_role: string }; Returns: Json }
      earn_loyalty_for_order: { Args: { p_order: string }; Returns: Json }
      emenu_analytics_summary: {
        Args: { p_branch?: string; p_from?: string; p_to?: string }
        Returns: Json
      }
      emenu_apply_clean_slug: { Args: { p_branch: string }; Returns: Json }
      emenu_create_lead: {
        Args: { p_payload: Json; p_slug: string }
        Returns: Json
      }
      emenu_recent_leads: {
        Args: { p_branch?: string; p_limit?: number }
        Returns: Json
      }
      emenu_save_settings: { Args: { p_payload: Json }; Returns: Json }
      emenu_set_save_orders: {
        Args: { p_enabled: boolean; p_tenant: string }
        Returns: undefined
      }
      emenu_track_event: {
        Args: {
          p_category_id?: string
          p_device_type?: string
          p_event_type: string
          p_menu_item_id?: string
          p_metadata?: Json
          p_session_id?: string
          p_slug: string
        }
        Returns: undefined
      }
      ensure_tenant_default_roles: {
        Args: { p_tenant: string }
        Returns: undefined
      }
      generate_branch_code: {
        Args: {
          p_expires_at?: string
          p_max_uses?: number
          p_note?: string
          p_tenant?: string
        }
        Returns: Json
      }
      generate_subscription_code: {
        Args: {
          p_expires_at?: string
          p_tier: Database["public"]["Enums"]["plan_tier"]
        }
        Returns: string
      }
      get_cost_comparison_items: {
        Args: {
          p_branch_id?: string
          p_period_end?: string
          p_period_start?: string
        }
        Returns: Json
      }
      get_emenu: { Args: { p_slug: string }; Returns: Json }
      get_public_menu: { Args: { p_slug: string }; Returns: Json }
      get_tenant_currency_settings: { Args: never; Returns: Json }
      get_tenant_effective_features: {
        Args: { p_tenant: string }
        Returns: Json
      }
      get_tenant_roles: { Args: { p_tenant: string }; Returns: Json }
      get_user_effective_permissions: {
        Args: { p_tenant: string; p_tenant_user: string }
        Returns: Json
      }
      inventory_consume_pos_order: { Args: { p_order: string }; Returns: Json }
      inventory_create_adjustment: { Args: { p_payload: Json }; Returns: Json }
      inventory_get_alerts: { Args: { p_branch?: string }; Returns: Json }
      inventory_get_settings: { Args: never; Returns: Json }
      inventory_list_categories: { Args: never; Returns: Json }
      inventory_save_category: { Args: { p_payload: Json }; Returns: Json }
      inventory_save_item: { Args: { p_payload: Json }; Returns: Json }
      inventory_save_settings: { Args: { p_payload: Json }; Returns: Json }
      is_super_admin: { Args: never; Returns: boolean }
      is_tenant_owner: { Args: { p_tenant: string }; Returns: boolean }
      is_tenant_owner_caller: { Args: { p_tenant: string }; Returns: boolean }
      log_staff_password_reset: {
        Args: { p_tenant: string; p_user: string }
        Returns: undefined
      }
      lookup_loyalty_member: {
        Args: { p_branch?: string; p_query: string }
        Returns: Json
      }
      loyalty_next_id: { Args: { p_tenant: string }; Returns: string }
      loyalty_pause_program: { Args: { p_branch: string }; Returns: Json }
      loyalty_resume_program: { Args: { p_branch: string }; Returns: Json }
      loyalty_set_program_active: {
        Args: { p_active: boolean; p_branch: string }
        Returns: Json
      }
      loyalty_set_reward_active: {
        Args: { p_active: boolean; p_reward: string }
        Returns: Json
      }
      mark_email_verified: { Args: { p_tenant: string }; Returns: undefined }
      permission_catalog: { Args: never; Returns: string[] }
      pos_assert_operator: { Args: { p_tenant: string }; Returns: string }
      pos_attach_loyalty_member: {
        Args: { p_member: string; p_order: string }
        Returns: Json
      }
      pos_cash_box_shift: { Args: { p_shift?: string }; Returns: Json }
      pos_cash_box_today: {
        Args: { p_branch?: string; p_day?: string }
        Returns: Json
      }
      pos_clear_table: {
        Args: { p_reason: string; p_table: string }
        Returns: Json
      }
      pos_close_table: { Args: { p_table: string }; Returns: Json }
      pos_daily_report: {
        Args: { p_branch?: string; p_day: string }
        Returns: Json
      }
      pos_earn_loyalty_safe: { Args: { p_order: string }; Returns: Json }
      pos_edit_order: { Args: { p_payload: Json }; Returns: Json }
      pos_end_shift: { Args: { p_payload: Json }; Returns: Json }
      pos_item_sales_report: {
        Args: { p_branch?: string; p_from: string; p_to: string }
        Returns: Json
      }
      pos_move_table: { Args: { p_from: string; p_to: string }; Returns: Json }
      pos_net_profit_report: {
        Args: {
          p_branch?: string
          p_from: string
          p_route?: string
          p_to: string
        }
        Returns: Json
      }
      pos_open_shift: { Args: { p_payload: Json }; Returns: Json }
      pos_open_table: { Args: { p_payload: Json }; Returns: Json }
      pos_pay_order: { Args: { p_payload: Json }; Returns: Json }
      pos_pay_table: { Args: { p_payload: Json }; Returns: Json }
      pos_range_report: {
        Args: { p_branch?: string; p_from: string; p_to: string }
        Returns: Json
      }
      pos_remove_order_item: {
        Args: { p_item: string; p_order: string }
        Returns: Json
      }
      pos_review_shift: { Args: { p_payload: Json }; Returns: Json }
      pos_save_order: { Args: { p_payload: Json }; Returns: Json }
      pos_shift_expected: { Args: { p_shift: string }; Returns: Json }
      pos_upsert_customer: { Args: { p_payload: Json }; Returns: Json }
      pos_void_order: {
        Args: { p_order: string; p_reason: string }
        Returns: Json
      }
      prepared_would_cycle: {
        Args: { p_component: string; p_prepared: string }
        Returns: boolean
      }
      recalc_prepared_chain: {
        Args: { p_materials: string[]; p_reason: string; p_tenant: string }
        Returns: number
      }
      recalculate_menu_items_for_material: {
        Args: { p_material: string; p_reason: string }
        Returns: number
      }
      redeem_loyalty_reward: { Args: { p_payload: Json }; Returns: Json }
      redeem_subscription_code: {
        Args: { p_code: string; p_tenant: string }
        Returns: Json
      }
      reject_branch_request: {
        Args: { p_reason: string; p_request_id: string }
        Returns: Json
      }
      reject_tenant: {
        Args: { p_reason?: string; p_tenant: string }
        Returns: undefined
      }
      reverse_loyalty_for_order: { Args: { p_order: string }; Returns: Json }
      revoke_branch_code: {
        Args: { p_code_id: string; p_note?: string }
        Returns: Json
      }
      role_default_true_keys: {
        Args: { p_role: Database["public"]["Enums"]["tenant_role"] }
        Returns: string[]
      }
      role_template_keys: { Args: { p_key: string }; Returns: string[] }
      save_loyalty_program_settings: {
        Args: { p_payload: Json }
        Returns: Json
      }
      save_loyalty_reward: { Args: { p_payload: Json }; Returns: Json }
      save_pos_receipt_settings: { Args: { p_payload: Json }; Returns: Json }
      save_prepared_material: { Args: { p_payload: Json }; Returns: Json }
      save_price_update_batch: { Args: { p_payload: Json }; Returns: Json }
      save_tenant_cost_settings: { Args: { p_payload: Json }; Returns: Json }
      save_tenant_currency_settings: {
        Args: { p_payload: Json }
        Returns: Json
      }
      save_tenant_role: { Args: { p_payload: Json }; Returns: Json }
      save_user_permissions: { Args: { p_payload: Json }; Returns: Json }
      select_free_plan: { Args: { p_tenant: string }; Returns: Json }
      set_plan_max_extra_users: {
        Args: { p_tier: string; p_value: number }
        Returns: Json
      }
      set_tenant_exchange_rate: {
        Args: { p_note?: string; p_rate: number }
        Returns: Json
      }
      set_tenant_status: {
        Args: {
          p_reason?: string
          p_status: Database["public"]["Enums"]["tenant_status"]
          p_tenant: string
        }
        Returns: undefined
      }
      set_tenant_user_limit_override: {
        Args: { p_tenant: string; p_value: number }
        Returns: Json
      }
      set_tenant_user_status: {
        Args: { p_membership: string; p_status: string }
        Returns: Json
      }
      submit_branch_request: { Args: { p_payload: Json }; Returns: Json }
      tenant_effective_max_branches: {
        Args: { p_tenant: string }
        Returns: number
      }
      tenant_multi_branch_enabled: {
        Args: { p_tenant: string }
        Returns: boolean
      }
      tenant_user_limit: { Args: { p_tenant: string }; Returns: Json }
      update_business_profile: { Args: { p_payload: Json }; Returns: Json }
      update_menu_item_selling_price: {
        Args: {
          p_branch_id?: string
          p_menu_item: string
          p_new_price?: number
        }
        Returns: Json
      }
    }
    Enums: {
      branch_status: "active" | "disabled" | "archived"
      category_status: "active" | "hidden" | "archived"
      code_status: "unused" | "used" | "expired" | "revoked"
      item_status:
        | "draft"
        | "published"
        | "hidden"
        | "out_of_stock"
        | "scheduled"
        | "archived"
      plan_tier: "free" | "basic" | "pro" | "enterprise"
      platform_role: "super_admin"
      subscription_status: "none" | "active" | "expired" | "cancelled"
      tenant_role:
        | "owner"
        | "manager"
        | "staff"
        | "admin"
        | "cashier"
        | "kitchen_staff"
      tenant_status:
        | "draft"
        | "pending_approval"
        | "active"
        | "disabled"
        | "rejected"
        | "expired"
      user_status:
        | "active"
        | "invited"
        | "suspended"
        | "frozen"
        | "inactive"
        | "removed"
      verification_status:
        | "pending"
        | "email_verified"
        | "setup_complete"
        | "approved"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

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
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
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
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      branch_status: ["active", "disabled", "archived"],
      category_status: ["active", "hidden", "archived"],
      code_status: ["unused", "used", "expired", "revoked"],
      item_status: [
        "draft",
        "published",
        "hidden",
        "out_of_stock",
        "scheduled",
        "archived",
      ],
      plan_tier: ["free", "basic", "pro", "enterprise"],
      platform_role: ["super_admin"],
      subscription_status: ["none", "active", "expired", "cancelled"],
      tenant_role: [
        "owner",
        "manager",
        "staff",
        "admin",
        "cashier",
        "kitchen_staff",
      ],
      tenant_status: [
        "draft",
        "pending_approval",
        "active",
        "disabled",
        "rejected",
        "expired",
      ],
      user_status: [
        "active",
        "invited",
        "suspended",
        "frozen",
        "inactive",
        "removed",
      ],
      verification_status: [
        "pending",
        "email_verified",
        "setup_complete",
        "approved",
      ],
    },
  },
} as const
