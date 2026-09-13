export type BudgetCategoryKey = 'transport' | 'lodging' | 'food' | 'other';

export interface BudgetCategoryItem {
  id: number;
  tripId: number;
  category: BudgetCategoryKey;
  categoryLabel: string;
  planned: number;
  spent: number;
  /** 实际支出 - 计划，正数表示超支 */
  diff: number;
  overBudget: boolean;
}

export interface BudgetSummary {
  categories: BudgetCategoryItem[];
  totalPlanned: number;
  totalSpent: number;
  totalDiff: number;
  overBudget: boolean;
}

export interface TripItem {
  id: number;
  destination: string;
  departDate: string;
  days: number;
  transport?: string;
}
