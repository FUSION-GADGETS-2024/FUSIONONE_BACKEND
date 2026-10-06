/**
 * Purchases domain types.
 */
import type { Party } from './common';

export interface PurchaseItem {
  id?: string;
  purchase_id?: string;
  cost_price?: number;
  inventory_item_id?: string;
  inventory_items?: {
    brand?: string;
    model?: string;
    imei?: string;
    ram_rom?: string;
    color?: string;
  };
}

export interface Purchase {
  id: string;
  bill_number: string;
  date: string;
  financial_year_id: string;
  party_id: string;
  parties?: Pick<Party, 'name' | 'number'>;
  subtotal: number;
  discount: number;
  final_total: number;
  paid: number;
  due: number;
  status: 'active' | 'cancelled';
  notes?: string;
}
