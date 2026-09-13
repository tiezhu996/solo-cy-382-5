import { Check, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 行程预算：同一行程内每个分类一条记录（trip_id + category 唯一）。
 * planned 为计划金额，spent 为实际支出，均不允许为负（见 @Check 约束与服务层校验）。
 */
@Entity('budgets')
@Index('uq_budget_trip_category', ['tripId', 'category'], { unique: true })
@Check('chk_budget_non_negative', 'planned >= 0 AND spent >= 0')
export class BudgetEntity {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ name: 'trip_id' }) tripId!: number;
  @Column({ length: 40 }) category!: string;
  @Column({ type: 'decimal', precision: 10, scale: 2, transformer: { to: (v: number) => v, from: (v: string | null) => (v === null ? 0 : Number(v)) } })
  planned!: number;
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0, transformer: { to: (v: number) => v, from: (v: string | null) => (v === null ? 0 : Number(v)) } })
  spent!: number;
}
