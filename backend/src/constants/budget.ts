/** 预算分类，取值在同一行程内唯一，标签用于界面展示 */
export enum BudgetCategory {
  Transport = 'transport',
  Lodging = 'lodging',
  Food = 'food',
  Other = 'other'
}

export const BUDGET_CATEGORY_LABELS: Record<BudgetCategory, string> = {
  [BudgetCategory.Transport]: '交通',
  [BudgetCategory.Lodging]: '住宿',
  [BudgetCategory.Food]: '餐饮',
  [BudgetCategory.Other]: '其他'
};

export const BUDGET_CATEGORIES = Object.values(BudgetCategory);
