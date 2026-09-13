import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../constants/errors';
import { BudgetService } from './budget.service';

@Controller('api/trips/:tripId/budgets')
export class BudgetController {
  constructor(private readonly service: BudgetService) {}

  @Get()
  list(@Param('tripId') tripId: string) {
    return this.service.list(this.parseTripId(tripId));
  }

  @Post()
  upsert(
    @Param('tripId') tripId: string,
    @Body() body: { category?: string; planned?: number; spent?: number }
  ) {
    return this.service.upsert(this.parseTripId(tripId), body.category, body.planned, body.spent);
  }

  @Patch(':id')
  update(
    @Param('tripId') tripId: string,
    @Param('id') id: string,
    @Body() body: { planned?: number; spent?: number }
  ) {
    return this.service.update(this.parseTripId(tripId), this.parseBudgetId(id), body);
  }

  private parseTripId(value: string): number {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, '行程 ID 非法');
    }
    return id;
  }

  private parseBudgetId(value: string): number {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, '预算记录 ID 非法');
    }
    return id;
  }
}
