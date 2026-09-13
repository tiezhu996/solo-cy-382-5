import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppException } from '../../common/errors/app.exception';
import { BUDGET_CATEGORIES, BUDGET_CATEGORY_LABELS, BudgetCategory } from '../../constants/budget';
import { ERROR_CODES } from '../../constants/errors';
import { TripEntity } from '../trip/trip.entity';
import { BudgetEntity } from './budget.entity';

export interface BudgetSummary {
  categories: Array<{
    id: number;
    tripId: number;
    category: string;
    categoryLabel: string;
    planned: number;
    spent: number;
    diff: number;
    overBudget: boolean;
  }>;
  totalPlanned: number;
  totalSpent: number;
  totalDiff: number;
  overBudget: boolean;
}

@Injectable()
export class BudgetService {
  constructor(
    @InjectRepository(BudgetEntity) private readonly budgets: Repository<BudgetEntity>,
    @InjectRepository(TripEntity) private readonly trips: Repository<TripEntity>
  ) {}

  /** 列出某行程的分类预算与汇总（不同行程以 tripId 严格隔离） */
  async list(tripId: number): Promise<BudgetSummary> {
    await this.assertTripExists(tripId);
    const rows = await this.budgets.find({ where: { tripId }, order: { id: 'ASC' } });
    return this.buildSummary(rows);
  }

  /** 录入（或重复录入时覆盖）某行程某分类的计划金额/实际支出 */
  async upsert(tripId: number, category: unknown, planned?: number, spent?: number): Promise<BudgetSummary> {
    await this.assertTripExists(tripId);
    const validCategory = this.parseCategory(category);
    const plannedValue = this.parseAmount(planned ?? 0, 'planned');
    const spentValue = this.parseAmount(spent ?? 0, 'spent');

    let budget = await this.budgets.findOne({ where: { tripId, category: validCategory } });
    if (!budget) {
      budget = this.budgets.create({ tripId, category: validCategory });
    }
    budget.planned = plannedValue;
    budget.spent = spentValue;
    await this.budgets.save(budget);

    return this.list(tripId);
  }

  /** 按记录 id 修改，且记录必须属于该行程 —— 防止不同行程数据被串改 */
  async update(tripId: number, id: number, input: { planned?: number; spent?: number }): Promise<BudgetSummary> {
    await this.assertTripExists(tripId);
    const budget = await this.budgets.findOne({ where: { id } });
    if (!budget || budget.tripId !== tripId) {
      throw new AppException(ERROR_CODES.BUDGET_NOT_FOUND, '该预算记录不存在或不属于当前行程', 404);
    }
    if (input.planned !== undefined) budget.planned = this.parseAmount(input.planned, 'planned');
    if (input.spent !== undefined) budget.spent = this.parseAmount(input.spent, 'spent');
    await this.budgets.save(budget);
    return this.list(tripId);
  }

  private async assertTripExists(tripId: number): Promise<void> {
    const trip = await this.trips.findOne({ where: { id: tripId }, select: { id: true } });
    if (!trip) throw new AppException(ERROR_CODES.TRIP_NOT_FOUND, '行程不存在', 404);
  }

  private parseCategory(category: unknown): BudgetCategory {
    if (typeof category === 'string' && BUDGET_CATEGORIES.includes(category as BudgetCategory)) {
      return category as BudgetCategory;
    }
    throw new AppException(
      ERROR_CODES.VALIDATION_FAILED,
      `预算分类必须是以下之一：${BUDGET_CATEGORIES.join('、')}`
    );
  }

  /** 金额必须是非负有限数字，统一保留两位小数 */
  private parseAmount(value: unknown, field: string): number {
    const num = typeof value === 'string' ? Number(value) : (value as number);
    if (value === undefined || value === null || value === '' || Number.isNaN(num) || !Number.isFinite(num)) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, `${field} 金额必须是数字`);
    }
    if (num < 0) {
      throw new AppException(ERROR_CODES.NEGATIVE_AMOUNT, '金额不能为负');
    }
    return Math.round(num * 100) / 100;
  }

  private buildSummary(rows: BudgetEntity[]): BudgetSummary {
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const categories = rows.map(row => {
      const planned = round2(Number(row.planned) || 0);
      const spent = round2(Number(row.spent) || 0);
      const diff = round2(spent - planned);
      return {
        id: row.id,
        tripId: row.tripId,
        category: row.category,
        categoryLabel: BUDGET_CATEGORY_LABELS[row.category as BudgetCategory] ?? row.category,
        planned,
        spent,
        diff,
        overBudget: diff > 0
      };
    });
    const totalPlanned = round2(categories.reduce((sum, item) => sum + item.planned, 0));
    const totalSpent = round2(categories.reduce((sum, item) => sum + item.spent, 0));
    const totalDiff = round2(totalSpent - totalPlanned);
    return { categories, totalPlanned, totalSpent, totalDiff, overBudget: totalDiff > 0 };
  }
}
